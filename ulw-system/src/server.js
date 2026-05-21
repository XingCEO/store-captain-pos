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
  const app = createApp({
    dataDir: path.join(__dirname, '..', 'data'),
    publicDir: path.join(__dirname, '..', 'public'),
    port: PORT,
  });

  if (process.env.NODE_ENV === 'production' && process.env.DEMO_MODE !== '1') {
    logger.error('Refusing to start: ulw-system is sandbox/demo PoC. Set DEMO_MODE=1 or unset NODE_ENV=production.');
    process.exit(1);
  }
  // When production + demo, require explicit per-subsystem ack so an operator
  // cannot accidentally serve paying customers from the sandbox payment /
  // invoice stack. Each ack independently signals "I know this is non-prod".
  if (process.env.NODE_ENV === 'production' && process.env.DEMO_MODE === '1') {
    const missingAcks = [];
    if (process.env.ALLOW_MOCK_PAYMENT_PROVIDERS !== '1') missingAcks.push('ALLOW_MOCK_PAYMENT_PROVIDERS=1');
    if (process.env.INVOICE_NON_PRODUCTION_ACK !== '1') missingAcks.push('INVOICE_NON_PRODUCTION_ACK=1');
    if (missingAcks.length > 0) {
      logger.error({ missingAcks },
        'Refusing to start: NODE_ENV=production with DEMO_MODE=1 requires explicit non-production acks for every mock subsystem.');
      process.exit(1);
    }
    logger.warn('WARNING: sandbox/demo PoC running with NODE_ENV=production and DEMO_MODE=1. Invoice and payment flows are stubs.');
  }
  // Metrics endpoint MUST be bearer-gated in production — it returns per-tenant
  // counts that an unauthenticated attacker can scrape for competitive intel.
  if (process.env.NODE_ENV === 'production' && !process.env.METRICS_TOKEN) {
    logger.error('Refusing to start: NODE_ENV=production requires METRICS_TOKEN to protect /metrics.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Store Captain POS listening');
  });

  async function shutdown(signal) {
    logger.info({ signal }, 'shutting down');
    try { await app.close(); } catch (err) { logger.error({ err: err.message }, 'shutdown error'); }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports = { createApp };
