/*
 * Store Captain — Service Worker
 * Strategy:
 *   - Pre-cache static shell on install.
 *   - For navigation + static GETs: cache-first with background revalidate (stale-while-revalidate).
 *   - For /api/* GETs: network-first with cache fallback.
 *   - For /api/* mutations (POST/PATCH): network-first; on failure, enqueue in IndexedDB
 *     and respond with synthetic 202 `{ queued: true, reason: 'offline' }` so the UI can
 *     continue operating. Background Sync (when available) or the first online event
 *     drains the queue.
 *
 * Note on idempotency: the server-side runtime already de-duplicates by `idempotencyKey`
 * and `clientRef`, so replaying queued mutations is safe.
 */
const VERSION = 'sc-v26';
const STATIC_CACHE = 'sc-static-' + VERSION;
const RUNTIME_CACHE = 'sc-runtime-' + VERSION;
const SHELL = [
  '/',
  '/product.html',
  '/pricing.html',
  '/login.html',
  '/app.html',
  '/o.html',
  '/terms.html',
  '/privacy.html',
  '/site.css',
  '/site.js',
  '/app.css',
  '/app.js',
  '/lib/qrcode.js',
  '/lib/pos-extras.js',
  '/lib/topbar.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ---------------- IndexedDB queue ----------------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('store-captain-sw', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function enqueue(payload) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').add(payload);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
function readAllQueued(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readonly');
    const req = tx.objectStore('outbox').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function deleteQueued(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite');
    const req = tx.objectStore('outbox').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
function bumpAttempts(db, item) {
  return new Promise((resolve) => {
    const tx = db.transaction('outbox', 'readwrite');
    const next = { ...item, attempts: (item.attempts || 0) + 1, lastError: item.lastError || 'failed' };
    tx.objectStore('outbox').put(next);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
const MAX_ATTEMPTS = 6;

async function drainQueue() {
  const db = await openDb();
  const items = await readAllQueued(db);
  let succeeded = 0;
  let dropped = 0;
  for (const item of items) {
    if ((item.attempts || 0) >= MAX_ATTEMPTS) {
      await deleteQueued(db, item.id);
      dropped += 1;
      continue;
    }
    try {
      const res = await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body,
      });
      if (res.ok) {
        await deleteQueued(db, item.id);
        succeeded += 1;
      } else if (res.status === 401 || res.status === 403) {
        // stale auth — surface to UI and stop draining
        broadcast({ type: 'queue-auth-expired' });
        return;
      } else {
        await bumpAttempts(db, item);
      }
    } catch (e) {
      await bumpAttempts(db, item);
    }
  }
  broadcast({ type: 'queue-drained', succeeded, dropped });
}
function broadcast(msg) {
  self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage(msg)));
}

// ---------------- Fetch routing ----------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'GET') {
      event.respondWith(networkFirst(req));
    } else {
      event.respondWith(mutateWithQueue(req));
    }
    return;
  }
  // Navigations (HTML) → network-first so users always get fresh HTML on reload.
  // Hashed assets / scripts / styles → stale-while-revalidate.
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    event.respondWith(networkFirstNav(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirstNav(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response('<!doctype html><meta charset="utf-8"><title>離線</title><body style="font-family:system-ui;padding:2rem;text-align:center"><h1>目前離線</h1><p>請檢查網路後再試。</p></body>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network || new Response('離線中', { status: 503 });
}

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ errorCode: 'OFFLINE', message: '目前離線且未快取此資源' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}

async function mutateWithQueue(req) {
  try {
    const res = await fetch(req.clone());
    return res;
  } catch (e) {
    // capture body
    let body = null;
    try { body = await req.clone().text(); } catch (_) {}
    const headers = {};
    for (const [k, v] of req.headers.entries()) headers[k] = v;
    await enqueue({ url: req.url, method: req.method, headers, body, queuedAt: Date.now() });
    broadcast({ type: 'queued' });
    return new Response(JSON.stringify({
      queued: true,
      reason: 'offline',
      message: '本機已離線，操作已排入補傳佇列，重新連線後會自動送出。',
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}

// ---------------- Sync ----------------
self.addEventListener('sync', (event) => {
  if (event.tag === 'store-captain-drain') event.waitUntil(drainQueue());
});
self.addEventListener('message', (event) => {
  // Only accept messages from same-origin clients controlled by this SW.
  // Prevents cross-origin pages from triggering queue drains.
  const origin = event.origin || (event.source && event.source.url ? new URL(event.source.url).origin : null);
  if (origin && origin !== self.location.origin) return;
  if (!event.source) return;
  if (event.data && event.data.type === 'drain-now') {
    event.waitUntil(drainQueue());
  }
});
