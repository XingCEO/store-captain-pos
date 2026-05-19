'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  openDatabase, loadSnapshot, persistSnapshot,
  appendAuditLog, queryAuditLogs, closeDatabase,
} = require('./db');
const { logger } = require('./logger');
const metrics = require('./metrics');
const rateLimit = require('./rateLimit');
const auditPg = require('./auditPg');
const { hashPin } = require('./security');

const roleRank = {
  GUEST: 0,
  CASHIER: 1,
  MANAGER: 2,
  SUPERVISOR: 3,
  ADMIN: 4,
};

const persistedMaps = [
  'products', 'skus', 'productPrices',
  'orders', 'orderItems', 'orderEvents',
  'refunds', 'outboxJobs', 'printJobs', 'payments',
  'cashDrawers', 'orderSources',
  'telemetrySnapshots', 'reportExports', 'reportSchedules',
  'users', 'stores', 'storeSettings',
  'subscriptions',
  'invoices', 'invoiceTracks', 'invoiceAllowances', 'invoiceVoids', 'settlements',
  'customers', 'customerPoints', 'coupons', 'couponRedemptions',
  'aiInsights',
  'inventoryLevels', 'inventoryLedger', 'stockCounts', 'transferOrders', 'purchaseOrders',
  'recipes', 'recipeItems',
  'idempotency', 'orderIdempotency',
  'sessions', 'refreshTokens',
];

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function nowIso() {
  return new Date().toISOString();
}

function createData() {
  const data = { auditLogs: [] };
  for (const name of persistedMaps) {
    data[name] = new Map();
  }
  return data;
}

function defaultCounters() {
  return {
    product: 1, sku: 1,
    order: 1, orderItem: 1, orderEvent: 1, refund: 1,
    outbox: 1, job: 1, payment: 1, cashDrawer: 1, source: 1, export: 1, schedule: 1,
    user: 1, store: 1,
    subscription: 1,
    invoice: 1, track: 1, allowance: 1, invoiceVoid: 1, settlement: 1,
    customer: 1, point: 1, coupon: 1, redemption: 1, insight: 1,
    inventoryMove: 1, stockCount: 1, transfer: 1, purchase: 1, recipe: 1, recipeItem: 1,
  };
}

function stableStringify(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function pruneIdempotency(map, nowMs) {
  let pruned = 0;
  for (const [key, value] of map.entries()) {
    const createdAt = value && value.createdAt ? new Date(value.createdAt).getTime() : null;
    if (createdAt && nowMs - createdAt > IDEMPOTENCY_TTL_MS) {
      map.delete(key);
      pruned += 1;
    }
  }
  return pruned;
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.data = createData();
    this.counters = defaultCounters();
    this.db = openDatabase(dataDir);
    rateLimit.init(this.db);
  }

  nextId(prefix) {
    const id = `${prefix}-${String(this.counters[prefix]).padStart(4, '0')}`;
    this.counters[prefix] += 1;
    return id;
  }

  load() {
    const snap = loadSnapshot(this.db);
    if (snap.counters) {
      this.counters = { ...this.counters, ...snap.counters };
    }
    for (const name of persistedMaps) {
      const entries = Array.isArray(snap.maps[name]) ? snap.maps[name] : [];
      this.data[name] = new Map(entries);
    }
    this.data.auditLogs = [];
    // Migrate legacy v1 blob auditLogs into the audit_logs table once.
    if (Array.isArray(snap.legacyAuditLogs) && snap.legacyAuditLogs.length > 0) {
      const tx = this.db.transaction(() => {
        for (const row of snap.legacyAuditLogs) {
          if (!row || !row.action) continue;
          appendAuditLog(this.db, {
            tenantId: row.tenantId || null,
            action: row.action,
            resourceType: row.resourceType || null,
            resourceId: row.resourceId || null,
            actor: row.actor || row.userId || null,
            userId: row.userId || null,
            userRole: row.userRole || null,
            before: row.before == null ? null : row.before,
            after: row.after == null ? null : row.after,
            ip: row.ip || null,
            deviceId: row.deviceId || null,
            userAgent: row.userAgent || null,
            timestamp: row.timestamp || nowIso(),
          });
        }
      });
      tx();
      logger.info({ count: snap.legacyAuditLogs.length }, 'migrated legacy audit log blob to audit_logs table');
    }
  }

  flushAuditBuffer() {
    if (!this.data.auditLogs.length) return 0;
    const rows = this.data.auditLogs;
    this.data.auditLogs = [];
    // Always write to SQLite (canonical local store). When AUDIT_BACKEND=pg
    // also mirror to Postgres so audit-logs queries can be served from PG
    // with RLS enforced — see auditPg.queryAuditLogs.
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        appendAuditLog(this.db, row);
        try { metrics.auditLogsTotal.inc({ action: row.action }); } catch { /* metric optional */ }
      }
    });
    tx();
    if (auditPg.isEnabled()) {
      // Tracked fire-and-forget — PG mirror is best-effort; SQLite remains
      // source of truth. close()/drain() await outstanding writes.
      auditPg.track(
        auditPg.appendAuditLogs(rows).catch((err) => {
          logger.error({ err: err.message, count: rows.length }, 'audit pg mirror failed');
        })
      );
    }
    return rows.length;
  }

  persist() {
    if (this._persistInFlight) { this._persistPending = true; return; }
    this._persistInFlight = true;
    try {
      do {
        this._persistPending = false;
        const nowMs = Date.now();
        pruneIdempotency(this.data.idempotency, nowMs);
        pruneIdempotency(this.data.orderIdempotency, nowMs);
        const maps = {};
        for (const name of persistedMaps) {
          maps[name] = [...this.data[name].entries()];
        }
        try {
          persistSnapshot(this.db, { maps, counters: this.counters });
          this.flushAuditBuffer();
        } catch (err) {
          logger.error({ err: err.message }, 'store persist failed');
          throw err;
        }
        try { metrics.sampleGauges(this); } catch { /* metric optional */ }
      } while (this._persistPending);
    } finally {
      this._persistInFlight = false;
    }
  }

  async queryAuditLogs(params) {
    // Flush any pending writes so reads-after-writes are consistent.
    this.flushAuditBuffer();
    if (auditPg.isEnabled()) {
      await auditPg.drain();
      // PG path: RLS-enforced via `SET LOCAL app.tenant_id` inside the tx.
      // Falls back to SQLite if the pool errors mid-query.
      try {
        return await auditPg.queryAuditLogs(params);
      } catch (err) {
        logger.warn({ err: err.message }, 'audit pg query failed; falling back to sqlite');
      }
    }
    return queryAuditLogs(this.db, params);
  }

  async close() {
    closeDatabase(this.db);
    await auditPg.close();
  }
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch (err) { reject(err); }
    });
  });
}

function checksumFor(payload) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function requestFingerprint(payload) {
  return checksumFor(stableStringify(payload));
}

function error(errorCode, message, details = {}) {
  return { errorCode, message, ...details };
}

function bearerToken(req) {
  const authorization = req.headers.authorization || '';
  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function sessionResponse(session, token) {
  const response = {
    tenantId: session.tenantId,
    userId: session.userId,
    userName: session.userName || session.userId,
    role: session.role,
    storeId: session.storeId,
    storeName: session.storeName || session.storeId,
    storeIds: session.storeIds,
    expiresAt: session.expiresAt,
  };
  if (token) response.token = token;
  return response;
}

function createRuntime({ dataDir, publicDir }) {
  const store = new Store(dataDir);

  function serveStatic(urlPath, res, req = null) {
    const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const root = path.resolve(publicDir);
    const filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return false;
    let stat;
    try { stat = fs.statSync(filePath); } catch { return false; }
    if (stat.isDirectory()) return false;
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const cacheControl = filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=300';
    if (req && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
      res.end();
      return true;
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  function requestContext(req) {
    const rawToken = bearerToken(req);
    const security = require('./security');
    const hashedToken = rawToken ? security.hashToken(rawToken) : null;
    const session = hashedToken ? store.data.sessions.get(hashedToken) : null;
    if (session && new Date(session.expiresAt).getTime() > Date.now()) {
      return {
        tenantId: session.tenantId,
        userId: session.userId,
        role: session.role,
        storeIds: Array.isArray(session.storeIds) ? session.storeIds : [],
        storeId: session.storeId,
        sessionId: hashedToken,
        rawToken,
        userAgent: req.headers['user-agent'] || '',
        ip: req.socket.remoteAddress || '0.0.0.0',
        deviceId: req.headers['x-device-id'] || session.deviceId || 'unknown',
      };
    }
    return {
      tenantId: null,
      userId: 'anonymous',
      role: 'GUEST',
      storeIds: [],
      storeId: null,
      sessionId: null,
      rawToken: null,
      userAgent: req.headers['user-agent'] || '',
      ip: req.socket.remoteAddress || '0.0.0.0',
      deviceId: req.headers['x-device-id'] || 'unknown',
    };
  }

  function requireTenant(res, ctx) {
    if (!ctx.tenantId) {
      json(res, 403, error('TENANT_NOT_AUTHORIZED', 'tenant id required'));
      return false;
    }
    ensureTenantDefaults(ctx.tenantId);
    return true;
  }

  function requireRole(res, ctx, minRole) {
    if ((roleRank[ctx.role] || 0) < roleRank[minRole]) {
      json(res, 403, error('TENANT_NOT_AUTHORIZED', 'role not allowed'));
      return false;
    }
    return true;
  }

  function requireStoreScope(res, ctx, storeId) {
    if (!storeId || ctx.storeIds.length === 0 || ctx.storeIds.includes(storeId)) {
      return true;
    }
    json(res, 403, error('TENANT_NOT_AUTHORIZED', 'storeId not in tenant scope', { tenantId: ctx.tenantId, storeId, scopedStoreIds: ctx.storeIds }));
    return false;
  }

  function addAudit(ctx, action, resourceType, resourceId, before, after) {
    store.data.auditLogs.push({
      actor: ctx.userId,
      userId: ctx.userId,
      userRole: ctx.role,
      tenantId: ctx.tenantId,
      action,
      resourceType,
      resourceId,
      before,
      after,
      ip: ctx.ip,
      deviceId: ctx.deviceId,
      userAgent: ctx.userAgent,
      timestamp: nowIso(),
    });
  }

  function ensureTenantDefaults(tenantId) {
    let changed = false;
    const users = [
      { role: 'ADMIN', name: '系統管理員', emailPrefix: 'admin', pin: '9001' },
      { role: 'SUPERVISOR', name: '班主管', emailPrefix: 'supervisor', pin: '7001' },
      { role: 'MANAGER', name: '店長', emailPrefix: 'manager', pin: '5001' },
      { role: 'CASHIER', name: '收銀員', emailPrefix: 'cashier', pin: '1001' },
    ];
    for (const seed of users) {
      const existing = [...store.data.users.values()].find((user) => user.tenantId === tenantId && user.role === seed.role && user.status !== 'DISABLED');
      if (!existing) {
        const userId = store.nextId('user');
        const at = nowIso();
        store.data.users.set(`${tenantId}:${userId}`, { id: userId, tenantId, role: seed.role, name: seed.name, email: `${seed.emailPrefix}@${tenantId}.local`, pin: hashPin(seed.pin), status: 'ACTIVE', createdAt: at, updatedAt: at });
        changed = true;
      } else if (!existing.pin) {
        store.data.users.set(`${tenantId}:${existing.id}`, { ...existing, pin: hashPin(seed.pin), updatedAt: nowIso() });
        changed = true;
      }
    }
    if (![...store.data.stores.values()].some((item) => item.tenantId === tenantId && item.id === 'store-001')) {
      const at = nowIso();
      store.data.stores.set(`${tenantId}:store-001`, { id: 'store-001', tenantId, name: '一號店', status: 'ACTIVE', address: '待填寫地址', phone: '02-0000-0000', createdAt: at, updatedAt: at });
      store.data.storeSettings.set(`${tenantId}:store-001`, { tenantId, storeId: 'store-001', receiptTitle: '店長 AI POS', taxMode: 'SANDBOX', trainingModeAllowed: true, invoiceSandboxOnly: true, autoCompleteOutbox: false, updatedAt: at });
      changed = true;
    }
    if (!store.data.subscriptions.has(tenantId)) {
      const at = nowIso();
      store.data.subscriptions.set(tenantId, {
        id: store.nextId('subscription'),
        tenantId,
        planCode: 'STARTER',
        status: 'TRIALING',
        billingCycle: 'MONTHLY',
        storeLimit: 1,
        seatLimit: 4,
        billingMode: 'LOCAL_MVP_MANUAL_BILLING',
        paymentState: 'NO_PAYMENT_DUE',
        currentPeriodStart: at,
        currentPeriodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
        createdAt: at,
        updatedAt: at,
      });
      changed = true;
    }
    if (![...store.data.products.values()].some((product) => product.tenantId === tenantId)) {
      const at = nowIso();
      const products = [
        { name: '招牌奶茶', categoryId: 'drink', skuCode: 'DRINK-MILK-500', price: 55, stockTracked: false, stock: 0, modifiers: [{ groupName: '甜度', type: 'single', options: ['正常', '半糖', '無糖'] }, { groupName: '冰量', type: 'single', options: ['正常冰', '少冰', '去冰'] }] },
        { name: '火腿蛋餅', categoryId: 'breakfast', skuCode: 'FOOD-EGG-HAM', price: 45, stockTracked: true, stock: 30, modifiers: [{ groupName: '醬料', type: 'single', options: ['醬油膏', '辣椒', '不要醬'] }] },
        { name: '雞腿便當', categoryId: 'lunchbox', skuCode: 'BOX-CHICKEN', price: 110, stockTracked: true, stock: 20, modifiers: [{ groupName: '配菜', type: 'multi', options: ['青菜', '滷蛋', '豆干'] }] },
      ];
      for (const seed of products) {
        const productId = store.nextId('product');
        const skuId = store.nextId('sku');
        store.data.skus.set(skuId, { id: skuId, tenantId, productId, skuCode: seed.skuCode, name: seed.name, price: seed.price, stockTracked: seed.stockTracked, stock: seed.stock, createdAt: at, updatedAt: at });
        store.data.products.set(productId, { id: productId, tenantId, name: seed.name, categoryId: seed.categoryId, status: 'PUBLISHED', skus: [skuId], modifiers: seed.modifiers, publishToStoreIds: ['store-001'], version: 1, rest: {}, createdAt: at, updatedAt: at });
      }
      changed = true;
    }
    if (![...store.data.coupons.values()].some((coupon) => coupon.tenantId === tenantId)) {
      const at = nowIso();
      const id = store.nextId('coupon');
      store.data.coupons.set(id, { id, tenantId, code: 'WELCOME50', name: '新會員折抵 50 元', type: 'FIXED_AMOUNT', amount: 50, minSpend: 100, status: 'ACTIVE', startsAt: at, endsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), usageLimit: 1000, usedCount: 0, createdAt: at, updatedAt: at });
      changed = true;
    }
    if (changed) {
      store.persist();
    }
  }

  function pruneExpiredSessions() {
    let changed = false;
    for (const [token, session] of store.data.sessions.entries()) {
      if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
        store.data.sessions.delete(token);
        changed = true;
      }
    }
    if (changed) store.persist();
  }

  return {
    store,
    nowIso,
    json,
    parseBody,
    serveStatic,
    error,
    requestFingerprint,
    checksumFor,
    sessionResponse,
    requestContext,
    requireTenant,
    requireRole,
    requireStoreScope,
    addAudit,
    ensureTenantDefaults,
    pruneExpiredSessions,
    queryAuditLogs: (params) => store.queryAuditLogs(params),
    auditPg,
  };
}

module.exports = { createRuntime, roleRank, IDEMPOTENCY_TTL_MS };
