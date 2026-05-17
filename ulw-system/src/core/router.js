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

    if (req.method === 'GET' && normalizedPath === '/health') {
      runtime.json(res, 200, { ok: true, service: 'store-captain-pos', architecture: 'modular-domain-runtime', time: runtime.nowIso() });
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
