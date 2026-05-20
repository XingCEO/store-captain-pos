'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

test('order create writes idempotency row into idempotency_keys (not snapshot)', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-sql-1', 'CASHIER');
    const skuId = await firstSkuId(ctx.port, token);
    const idemKey = `sql-${Date.now()}`;
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-sql', businessDate: todayBusinessDate(),
      items: [{ skuId, name: '招牌奶茶', qty: 1, unitPrice: 55 }],
      idempotencyKey: idemKey,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(create.status, 201);

    const db = new Database(path.join(ctx.dataDir, 'store.db'), { readonly: true });
    const rows = db.prepare("SELECT key, namespace FROM idempotency_keys").all();
    db.close();
    assert.ok(rows.length >= 1, 'idempotency_keys should have at least one row');
    const matched = rows.find((r) => r.key.includes(idemKey));
    assert.ok(matched, `expected key containing ${idemKey} in idempotency_keys`);
    assert.equal(matched.namespace, 'order_create');
  } finally { await stopTestServer(ctx); }
});

test('login writes session row to auth_sessions; logout removes it', async () => {
  const ctx = await startTestServer();
  try {
    const login = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: 't-sql-2', role: 'MANAGER', storeId: 'store-001', pin: '5001' });
    assert.equal(login.status, 200);
    const dbFile = path.join(ctx.dataDir, 'store.db');
    let db = new Database(dbFile, { readonly: true });
    let before = db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE role != ?').get('REFRESH').n;
    db.close();
    assert.ok(before >= 1, `expected ≥1 session row, got ${before}`);

    await request(ctx.port, 'POST', '/api/v1/auth/logout', null, { Authorization: `Bearer ${login.body.token}` });
    db = new Database(dbFile, { readonly: true });
    const after = db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE role != ?').get('REFRESH').n;
    db.close();
    assert.equal(after, before - 1, 'logout should remove the session row from auth_sessions');
  } finally { await stopTestServer(ctx); }
});

test('idempotencyPrune deletes rows older than TTL', async () => {
  const ctx = await startTestServer();
  try {
    const { idempotencyPut, idempotencyPrune } = require('../src/core/db');
    const db = ctx.app.runtime.store.db;
    // Write 3 rows: 2 stale (created_at way in the past), 1 fresh
    db.prepare('DELETE FROM idempotency_keys').run();
    db.prepare(`INSERT INTO idempotency_keys(key, tenant_id, namespace, fingerprint, response_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run('k-old-1', 't', 'test', 'fp', '{}', Date.now() - 48 * 60 * 60 * 1000);
    db.prepare(`INSERT INTO idempotency_keys(key, tenant_id, namespace, fingerprint, response_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run('k-old-2', 't', 'test', 'fp', '{}', Date.now() - 48 * 60 * 60 * 1000);
    idempotencyPut(db, 'k-fresh', { fingerprint: 'fp', response: {} }, { tenantId: 't', namespace: 'test' });
    const pruned = idempotencyPrune(db, 24 * 60 * 60 * 1000);
    assert.equal(pruned, 2);
    const remaining = db.prepare('SELECT key FROM idempotency_keys').all().map((r) => r.key);
    assert.deepEqual(remaining.sort(), ['k-fresh']);
  } finally { await stopTestServer(ctx); }
});

test('sessionPrune drops expired sessions', async () => {
  const ctx = await startTestServer();
  try {
    const { sessionPut, sessionPrune } = require('../src/core/db');
    const db = ctx.app.runtime.store.db;
    db.prepare('DELETE FROM auth_sessions').run();
    // Expired
    sessionPut(db, 'sha256:expired', { tenantId: 't', userId: 'u1', role: 'CASHIER', storeId: 's', expiresAt: new Date(Date.now() - 60_000).toISOString() });
    // Live
    sessionPut(db, 'sha256:live', { tenantId: 't', userId: 'u2', role: 'CASHIER', storeId: 's', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const pruned = sessionPrune(db);
    assert.equal(pruned, 1);
    const left = db.prepare('SELECT token_hash FROM auth_sessions').all().map((r) => r.token_hash);
    assert.deepEqual(left, ['sha256:live']);
  } finally { await stopTestServer(ctx); }
});

test('schema_version migration drops legacy sessions/idempotency from state blob', async () => {
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ulw-migr-'));
  // Pre-create the DB with v2 schema + a stale row
  const dbFile = path.join(dataDir, 'store.db');
  {
    const db = new Database(dbFile);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE state (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, tenant_id TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, actor TEXT, user_id TEXT, user_role TEXT, before_json TEXT, after_json TEXT, ip TEXT, device_id TEXT, user_agent TEXT, timestamp TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '2')").run();
    db.prepare("INSERT INTO state(name, value, updated_at) VALUES ('sessions', '[[\"sha256:stale\", {}]]', '2020-01-01')").run();
    db.prepare("INSERT INTO state(name, value, updated_at) VALUES ('idempotency', '[]', '2020-01-01')").run();
    db.close();
  }
  // Open via runtime — should migrate to the current schema version and drop
  // the stale live-table snapshot rows (v2→v3) along the way.
  const { createApp } = require('../src/server');
  const publicDir = path.join(__dirname, '..', 'public');
  const app = createApp({ dataDir, publicDir, port: 0 });
  try {
    const db = new Database(dbFile, { readonly: true });
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
    const stale = db.prepare("SELECT COUNT(*) AS n FROM state WHERE name IN ('sessions', 'idempotency', 'orderIdempotency', 'refreshTokens')").get().n;
    db.close();
    assert.equal(version, String(require('../src/core/db').SCHEMA_VERSION));
    assert.equal(stale, 0, 'legacy live-table snapshots must be removed by v2→v3 migration');
  } finally {
    await app.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});

test('v3→v4 migration moves operational snapshot blobs into entities (no data loss)', async () => {
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ulw-v4-'));
  const dbFile = path.join(dataDir, 'store.db');
  const order = { id: 'order-legacy1', tenantId: 'tenant-001', storeId: 'store-001', grandTotal: 123 };
  {
    // Pre-create a v3 DB with an operational collection still stored as a
    // per-collection blob in `state` (the pre-Phase-B layout).
    const db = new Database(dbFile);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE state (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, tenant_id TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, actor TEXT, user_id TEXT, user_role TEXT, before_json TEXT, after_json TEXT, ip TEXT, device_id TEXT, user_agent TEXT, timestamp TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '3')").run();
    db.prepare("INSERT INTO state(name, value, updated_at) VALUES ('orders', ?, '2020-01-01')")
      .run(JSON.stringify([[order.id, order]]));
    db.prepare("INSERT INTO state(name, value, updated_at) VALUES ('__counters__', ?, '2020-01-01')")
      .run(JSON.stringify({ order: 2 }));
    db.close();
  }
  const { createApp } = require('../src/server');
  const publicDir = path.join(__dirname, '..', 'public');
  const app = createApp({ dataDir, publicDir, port: 0 });
  try {
    const db = new Database(dbFile, { readonly: true });
    const blob = db.prepare("SELECT COUNT(*) AS n FROM state WHERE name = 'orders'").get().n;
    const rows = db.prepare("SELECT id, tenant_id, data_json FROM entities WHERE collection = 'orders'").all();
    db.close();
    assert.equal(blob, 0, 'orders blob must be removed from state after v3→v4 migration');
    assert.equal(rows.length, 1, 'order must be migrated into entities as one row');
    assert.equal(rows[0].id, order.id);
    assert.equal(rows[0].tenant_id, 'tenant-001', 'tenant_id must be denormalised onto the row for indexing');
    assert.deepEqual(JSON.parse(rows[0].data_json), order, 'migrated payload must be byte-for-byte the order');
  } finally {
    await app.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
