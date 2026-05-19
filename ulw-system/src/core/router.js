function createRouter(runtime) {
  const routes = [];

  function add(method, matcher, handler) {
    routes.push({ method, matcher, handler });
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://localhost:${runtime.port || 3100}`);
    const normalizedPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';

    if (req.method === 'GET' && normalizedPath === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && !normalizedPath.startsWith('/api/') && runtime.serveStatic(normalizedPath, res, req)) {
      return;
    }

    if (req.method === 'GET' && (normalizedPath === '/health' || normalizedPath === '/health/live' || normalizedPath === '/health/ready')) {
      const liveOnly = normalizedPath === '/health/live';
      const readyMode = normalizedPath === '/health/ready';
      const startTs = process.hrtime.bigint();
      const checks = {};
      // SQLite ping — single SELECT round-trip.
      try {
        runtime.store.db.prepare('SELECT 1 AS ok').get();
        checks.sqlite = { ok: true };
      } catch (err) {
        checks.sqlite = { ok: false, error: err.message };
      }
      // Audit PG mirror (optional).
      try {
        if (runtime.auditPg && runtime.auditPg.isEnabled && runtime.auditPg.isEnabled()) {
          checks.auditPg = { ok: true, enabled: true };
        } else {
          checks.auditPg = { ok: true, enabled: false };
        }
      } catch (err) {
        checks.auditPg = { ok: false, error: err.message };
      }
      // Worker freshness — sync worker stamps lastTickAt on the store after each tick.
      const lastTickIso = runtime.store.workerLastTickAt || null;
      const tickAgeSeconds = lastTickIso ? Math.floor((Date.now() - new Date(lastTickIso).getTime()) / 1000) : null;
      checks.worker = { lastTickAt: lastTickIso, ageSeconds: tickAgeSeconds };
      const queryMs = Number(process.hrtime.bigint() - startTs) / 1e6;
      const ok = checks.sqlite.ok && (!readyMode || (tickAgeSeconds === null || tickAgeSeconds < 600));
      // Demo profile gate: the POS auth gate ships 3 hardcoded "店主 / 收銀員"
      // shortcut buttons in app.html with cleartext PINs. They must NOT render
      // in production. The flag below drives that hide/show decision client-side.
      const demoProfilesEnabled = process.env.NODE_ENV !== 'production'
        || process.env.OMC_DEMO_PROFILES === '1';
      const payload = liveOnly
        ? { ok: true, time: runtime.nowIso() }
        : {
          ok,
          service: 'store-captain-pos',
          architecture: 'modular-domain-runtime',
          time: runtime.nowIso(),
          uptimeSeconds: Math.floor(process.uptime()),
          memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          checks,
          queryMs: Math.round(queryMs * 100) / 100,
          demoProfilesEnabled,
        };
      runtime.json(res, ok ? 200 : 503, payload);
      return;
    }

    const ctx = runtime.requestContext(req);
    for (const route of routes) {
      if (route.method !== req.method) {
        continue;
      }

      if (typeof route.matcher === 'string' && route.matcher === normalizedPath) {
        await route.handler({ req, res, url, ctx, params: [] });
        return;
      }

      if (route.matcher instanceof RegExp) {
        const match = normalizedPath.match(route.matcher);
        if (match) {
          await route.handler({ req, res, url, ctx, params: match.slice(1) });
          return;
        }
      }
    }

    runtime.json(res, 404, runtime.error('PATH_NOT_FOUND', `no route for ${req.method} ${normalizedPath}`));
  }

  return { add, handle };
}

module.exports = { createRouter };
