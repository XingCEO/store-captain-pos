'use strict';

// Tracing must be required before any instrumented module (http etc.)
require('./core/tracing').init();
require('./core/sentry').init();

const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { createRouter } = require('./core/router');
const { createRuntime } = require('./core/runtime');
const { logger } = require('./core/logger');
const metrics = require('./core/metrics');
const rateLimit = require('./core/rateLimit');
const {
  applySecurityHeaders, applyCors, handleCorsPreflight, parseAllowedOrigins,
} = require('./core/middleware');
const { spec: openapiSpec } = require('./core/openapi');
const identity = require('./domains/identity');
const catalog = require('./domains/catalog');
const subscription = require('./domains/subscription');
const commerce = require('./domains/commerce');
const operations = require('./domains/operations');
const risk = require('./domains/risk');

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10_000);
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 30_000);

function isHexAes256Key(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
}

function validateStartupEnvironment(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProduction = env.NODE_ENV === 'production';
  const isDemo = env.DEMO_MODE === '1';

  if (!isProduction) {
    return { ok: true, serviceMode: 'development', errors, warnings };
  }

  if (!env.METRICS_TOKEN) errors.push('METRICS_TOKEN is required in production');
  if (!env.PIN_PEPPER) errors.push('PIN_PEPPER is required in production');
  if (!isHexAes256Key(env.MFA_KEK)) errors.push('MFA_KEK must be a 32-byte hex key in production');

  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  if (allowedOrigins.length === 0) errors.push('ALLOWED_ORIGINS is required in production');
  if (allowedOrigins.includes('*')) errors.push('ALLOWED_ORIGINS must not include * in production');
  if (env.OMC_BOOTSTRAP_SEED_FIXED_PINS === '1') errors.push('OMC_BOOTSTRAP_SEED_FIXED_PINS is not allowed in production');

  if (isDemo) {
    if (env.ALLOW_MOCK_PAYMENT_PROVIDERS !== '1') errors.push('ALLOW_MOCK_PAYMENT_PROVIDERS=1 is required for production demo mode');
    if (env.INVOICE_NON_PRODUCTION_ACK !== '1') errors.push('INVOICE_NON_PRODUCTION_ACK=1 is required for production demo mode');
    warnings.push('sandbox/demo PoC running in production demo mode; invoice and non-cash payment flows are non-production');
    return { ok: errors.length === 0, serviceMode: 'demo-production', errors, warnings };
  }

  if (env.ALLOW_MOCK_PAYMENT_PROVIDERS === '1') {
    errors.push('ALLOW_MOCK_PAYMENT_PROVIDERS is only allowed with DEMO_MODE=1');
  }
  if (env.INVOICE_NON_PRODUCTION_ACK === '1') {
    warnings.push('sandbox invoice routes are explicitly acknowledged as non-production');
  }
  if (env.ENABLE_HSTS !== '1') {
    warnings.push('ENABLE_HSTS is not set; ensure HSTS is emitted by the TLS reverse proxy');
  }

  return {
    ok: errors.length === 0,
    serviceMode: env.INVOICE_NON_PRODUCTION_ACK === '1' ? 'starter-production-with-sandbox-invoice-ack' : 'starter-production',
    errors,
    warnings,
  };
}

function createApp({ dataDir, publicDir, port }) {
  const runtime = createRuntime({ dataDir, publicDir });
  const router = createRouter(runtime);

  identity.register(router, runtime);
  catalog.register(router, runtime);
  subscription.register(router, runtime);
  commerce.register(router, runtime);
  operations.register(router, runtime);
  risk.register(router, runtime);

  runtime.store.load();
  runtime.pruneExpiredSessions();

  const syncWorker = require('./core/syncWorker').start(runtime);

  const allowedOrigins = parseAllowedOrigins();
  const metricsToken = process.env.METRICS_TOKEN || null;

  const inflight = new Set();

  const server = http.createServer(async (req, res) => {
    inflight.add(res);
    res.on('finish', () => inflight.delete(res));
    res.on('close', () => inflight.delete(res));

    applySecurityHeaders(req, res);
    applyCors(req, res, allowedOrigins);
    if (handleCorsPreflight(req, res, allowedOrigins)) return;

    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('x-request-id', requestId);

    const rlCtx = runtime.requestContext(req);
    if (!rateLimit.middleware(req, res, rlCtx.tenantId)) {
      try {
        const bucket = req.url && req.url.startsWith('/api/v1/auth/login') ? 'login' : 'api';
        metrics.rateLimitRejectsTotal.inc({ bucket });
      } catch { /* metric optional */ }
      return;
    }

    const startNs = process.hrtime.bigint();
    const originalEnd = res.end.bind(res);
    res.end = (...args) => {
      if (res.statusCode < 400 && (req.method !== 'GET' || runtime.store.data.auditLogs.length > 0)) {
        try { runtime.store.persist(); } catch (err) {
          logger.error({ err: err.message, requestId }, 'persist on response failed');
        }
      }
      const route = req.url ? req.url.split('?')[0] : '';
      const durMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      try {
        metrics.httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
      } catch { /* metric optional */ }
      logger.info({
        method: req.method, route, status: res.statusCode, durMs: Math.round(durMs), requestId,
      }, 'http');
      return originalEnd(...args);
    };

    // Per-request timeout
    const timer = setTimeout(() => {
      if (res.writableEnded || res.headersSent) return;
      try {
        res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ errorCode: 'REQUEST_TIMEOUT', message: 'handler exceeded deadline', timeoutMs: REQUEST_TIMEOUT_MS }));
      } catch { /* response already closed */ }
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    res.on('finish', () => clearTimeout(timer));
    res.on('close',  () => clearTimeout(timer));

    // /metrics — bearer-gated. Production MUST set METRICS_TOKEN (enforced at
    // startup below). Comparison is constant-time.
    const urlPath = req.url ? req.url.split('?')[0] : '';
    if (req.method === 'GET' && urlPath === '/metrics') {
      if (metricsToken) {
        const auth = req.headers.authorization || '';
        const match = String(auth).match(/^Bearer\s+(.+)$/i);
        let allowed = false;
        if (match) {
          const provided = Buffer.from(match[1]);
          const expected = Buffer.from(metricsToken);
          allowed = provided.length === expected.length
            && crypto.timingSafeEqual(provided, expected);
        }
        if (!allowed) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ errorCode: 'METRICS_UNAUTHORIZED', message: 'bearer token required' }));
          return;
        }
      }
      try {
        const body = await metrics.renderMetrics();
        res.writeHead(200, { 'Content-Type': metrics.contentType() });
        res.end(body);
      } catch (err) {
        logger.error({ err: err.message }, 'metrics render failed');
        res.writeHead(500); res.end('metrics_error');
      }
      return;
    }

    // OpenAPI spec
    if (req.method === 'GET' && urlPath === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(openapiSpec));
      return;
    }

    router.handle(req, res).catch((err) => {
      logger.error({ err: err.message, requestId, stack: err.stack }, 'unhandled error');
      try { require('./core/sentry').captureException(err, { requestId, route: req.url }); } catch { /* sentry optional */ }
      if (!res.headersSent) {
        runtime.json(res, 500, runtime.error('UNHANDLED', err.message || 'unknown error'));
      }
    });
  });

  async function close() {
    return new Promise((resolve) => {
      try { syncWorker.stop(); } catch { /* worker already stopped */ }
      server.close(() => {
        try { runtime.store.close(); } catch { /* db already closed */ }
        resolve();
      });
      // If clients hold sockets open, force-close after grace.
      const force = setTimeout(() => {
        for (const res of inflight) {
          try { res.socket && res.socket.destroy(); } catch { /* socket already dead */ }
        }
      }, SHUTDOWN_GRACE_MS);
      force.unref();
    });
  }

  return { server, runtime, close, listen: (p, cb) => server.listen(p, cb), port };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3100);
  const startup = validateStartupEnvironment(process.env);
  if (!startup.ok) {
    logger.error({ errors: startup.errors }, 'Refusing to start: production startup preflight failed.');
    process.exit(1);
  }
  for (const warning of startup.warnings) logger.warn({ serviceMode: startup.serviceMode }, warning);

  const app = createApp({
    dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data'),
    publicDir: path.join(__dirname, '..', 'public'),
    port: PORT,
  });

  app.listen(PORT, () => {
    logger.info({ port: PORT, serviceMode: startup.serviceMode }, 'Store Captain POS listening');
  });

  async function shutdown(signal) {
    logger.info({ signal }, 'shutting down');
    try { await app.close(); } catch (err) { logger.error({ err: err.message }, 'shutdown error'); }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports = { createApp, validateStartupEnvironment };
