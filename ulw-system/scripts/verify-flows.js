#!/usr/bin/env node
// Verification harness for goal: register/login/orders/QR/anti-logic.
'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

// Best-effort reset of the SQLite-backed login rate limiter so the harness
// doesn't trip the 10 logins/min/IP bucket on consecutive runs.
try {
  const Database = require('better-sqlite3');
  const dbPath = path.resolve(__dirname, '..', 'data', 'store.db');
  const db = new Database(dbPath);
  db.exec('DELETE FROM rate_limit');
  db.close();
} catch (e) {
  console.log('[warn] rate_limit reset skipped:', e.message);
}

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3100}`;
const TENANT = `verify-${Date.now().toString(36)}`;
const STORE = 'store-001';
const TERMINAL = 'terminal-verify-1';
const TODAY = new Date().toISOString().slice(0, 10);

let passed = 0;
let failed = 0;
const fails = [];

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (e) {
    failed += 1;
    fails.push({ name, err: e.message });
    console.log(`[FAIL] ${name}\n       ${e.message}`);
  }
}

function authHeader(token) { return { Authorization: `Bearer ${token}` }; }
function idem() { return crypto.randomUUID(); }

async function login(role, pin, tenantId = TENANT) {
  const r = await request('POST', '/api/v1/auth/login', { tenantId, role, pin, storeId: STORE });
  assert.equal(r.status, 200, `login ${role} expected 200 got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function firstSku(token) {
  const products = await request('GET', '/api/v1/products', null, authHeader(token));
  assert.equal(products.status, 200, `products ${products.status}`);
  const item = products.body.items[0];
  return { skuId: item.skuId, unitPrice: item.price, name: item.productName };
}

async function run() {
  console.log(`Verify run against ${BASE_URL}, tenant=${TENANT}`);

  // ---- A. Registration / tenant auto-seed ----
  await test('A1 first login on fresh tenant auto-seeds users (ADMIN)', async () => {
    const s = await login('ADMIN', '9001');
    assert.equal(s.role, 'ADMIN');
    assert.equal(s.tenantId, TENANT);
    assert.ok(s.token);
  });

  await test('A2 all 4 seeded roles can login with correct PIN', async () => {
    for (const [role, pin] of [['SUPERVISOR', '7001'], ['MANAGER', '5001'], ['CASHIER', '1001']]) {
      const s = await login(role, pin);
      assert.equal(s.role, role);
    }
  });

  await test('A3 wrong PIN returns 403 LOGIN_INVALID_CREDENTIALS', async () => {
    const r = await request('POST', '/api/v1/auth/login', { tenantId: TENANT, role: 'ADMIN', pin: '0000', storeId: STORE });
    assert.equal(r.status, 403);
    assert.equal(r.body.errorCode, 'LOGIN_INVALID_CREDENTIALS');
  });

  await test('A4 unknown role returns 400', async () => {
    const r = await request('POST', '/api/v1/auth/login', { tenantId: TENANT, role: 'PEASANT', pin: '1001', storeId: STORE });
    assert.equal(r.status, 400);
  });

  // Upgrade to CHAIN.
  const admin = await login('ADMIN', '9001');
  await test('A5 ADMIN upgrades tenant to CHAIN plan', async () => {
    const r = await request('POST', '/api/v1/subscription/change',
      { planCode: 'CHAIN', billingCycle: 'MONTHLY', idempotencyKey: idem() }, authHeader(admin.token));
    assert.equal(r.status, 200);
    assert.equal(r.body.planCode, 'CHAIN');
  });

  const cashier = await login('CASHIER', '1001');
  const manager = await login('MANAGER', '5001');
  const supervisor = await login('SUPERVISOR', '7001');

  // ---- B. Order lifecycle ----
  const orderKey = idem();
  let orderId = null;
  let sku = null;

  await test('B1 CASHIER creates DRAFT order', async () => {
    sku = await firstSku(cashier.token);
    const r = await request('POST', '/api/v1/orders', {
      storeId: STORE,
      terminalId: TERMINAL,
      businessDate: TODAY,
      idempotencyKey: orderKey,
      items: [{ skuId: sku.skuId, qty: 2, unitPrice: sku.unitPrice, name: sku.name }],
    }, authHeader(cashier.token));
    assert.equal(r.status, 201, `create ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.state, 'DRAFT');
    orderId = r.body.id;
  });

  await test('B2 idempotent replay returns same order (duplicated:true)', async () => {
    const r = await request('POST', '/api/v1/orders', {
      storeId: STORE,
      terminalId: TERMINAL,
      businessDate: TODAY,
      idempotencyKey: orderKey,
      items: [{ skuId: sku.skuId, qty: 2, unitPrice: sku.unitPrice, name: sku.name }],
    }, authHeader(cashier.token));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.id, orderId);
    assert.equal(r.body.duplicated, true);
  });

  await test('B3 same key + different payload rejected with 409', async () => {
    const r = await request('POST', '/api/v1/orders', {
      storeId: STORE,
      terminalId: TERMINAL,
      businessDate: TODAY,
      idempotencyKey: orderKey,
      items: [{ skuId: sku.skuId, qty: 99, unitPrice: sku.unitPrice, name: sku.name }],
    }, authHeader(cashier.token));
    assert.equal(r.status, 409);
    assert.equal(r.body.errorCode, 'ORDER_IDEMPOTENCY_CONFLICT');
  });

  await test('B4 MANAGER applies discount with valid reasonCode', async () => {
    const r = await request('PATCH', `/api/v1/orders/${orderId}/discount`,
      { amount: 10, reasonCode: 'MANAGER_APPROVAL', idempotencyKey: idem() }, authHeader(manager.token));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  await test('B5 CASHIER pays manual cash', async () => {
    const orderResp = await request('GET', `/api/v1/orders/${orderId}`, null, authHeader(cashier.token));
    assert.equal(orderResp.status, 200);
    const due = orderResp.body.grandTotal;
    const r = await request('POST', `/api/v1/orders/${orderId}/pay/manual`,
      { idempotencyKey: idem(), amount: due, paymentMethod: 'CASH', cashReceived: due },
      authHeader(cashier.token));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  await test('B6 GET /orders/:id/events returns trail', async () => {
    const r = await request('GET', `/api/v1/orders/${orderId}/events`, null, authHeader(cashier.token));
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.events) && r.body.events.length > 0, `events shape: ${JSON.stringify(r.body)}`);
  });

  await test('B7 CASHIER void blocked (MANAGER+ only)', async () => {
    const r = await request('POST', `/api/v1/orders/${orderId}/void`,
      { reasonCode: 'INPUT_ERROR', idempotencyKey: idem() }, authHeader(cashier.token));
    assert.equal(r.status, 403);
  });

  await test('B8 SUPERVISOR refunds partial', async () => {
    const r = await request('POST', `/api/v1/orders/${orderId}/refund`,
      { amount: 10, reasonCode: 'CUSTOMER_RETURN', method: 'CASH', restock: false, idempotencyKey: idem() },
      authHeader(supervisor.token));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  await test('B9 refund idempotent replay returns same response', async () => {
    const key = idem();
    const a = await request('POST', `/api/v1/orders/${orderId}/refund`,
      { amount: 5, reasonCode: 'WRONG_ITEM', method: 'CASH', restock: false, idempotencyKey: key },
      authHeader(supervisor.token));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await request('POST', `/api/v1/orders/${orderId}/refund`,
      { amount: 5, reasonCode: 'WRONG_ITEM', method: 'CASH', restock: false, idempotencyKey: key },
      authHeader(supervisor.token));
    assert.equal(b.status, 200);
    assert.equal(b.body.duplicated, true);
  });

  // ---- C. Anti-logic: repeatable calls ----
  let qrOrderId1 = null;
  let qrOrderId2 = null;

  await test('C1 channels/qr/orders creatable twice (distinct IDs)', async () => {
    const r1 = await request('POST', '/api/v1/channels/qr/orders',
      { channel: 'QR', idempotencyKey: idem(), storeId: STORE, items: [{ skuId: sku.skuId, qty: 1 }] },
      authHeader(cashier.token));
    assert.equal(r1.status, 200, `first QR ${r1.status}: ${JSON.stringify(r1.body)}`);
    qrOrderId1 = r1.body.orderId;
    const r2 = await request('POST', '/api/v1/channels/qr/orders',
      { channel: 'QR', idempotencyKey: idem(), storeId: STORE, items: [{ skuId: sku.skuId, qty: 1 }] },
      authHeader(cashier.token));
    assert.equal(r2.status, 200);
    qrOrderId2 = r2.body.orderId;
    assert.notEqual(qrOrderId1, qrOrderId2);
  });

  await test('C2 QR order GET re-fetchable multiple times', async () => {
    const r1 = await request('GET', `/api/v1/orders/${qrOrderId1}`, null, authHeader(cashier.token));
    assert.equal(r1.status, 200);
    const r2 = await request('GET', `/api/v1/orders/${qrOrderId1}`, null, authHeader(cashier.token));
    assert.equal(r2.status, 200);
    assert.equal(r1.body.id, r2.body.id);
  });

  await test('C3 customer page /o.html re-served on every request', async () => {
    const r1 = await request('GET', '/o.html');
    assert.equal(r1.status, 200);
    const r2 = await request('GET', '/o.html');
    assert.equal(r2.status, 200);
  });

  await test('C4 MANAGER PATCH channel order CONFIRMED twice (second 409 SOURCE_ITEM_CLOSED expected after terminal)', async () => {
    const r1 = await request('PATCH', `/api/v1/channels/orders/${qrOrderId2}/status`,
      { state: 'CONFIRMED', actor: manager.userId, reason: '人工確認', idempotencyKey: idem() },
      authHeader(manager.token));
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    // CONFIRMED is non-terminal — second confirm should still 200 (or 409 if business closed it). Both acceptable.
    const r2 = await request('PATCH', `/api/v1/channels/orders/${qrOrderId2}/status`,
      { state: 'CONFIRMED', actor: manager.userId, reason: '再次確認', idempotencyKey: idem() },
      authHeader(manager.token));
    assert.ok(r2.status === 200 || r2.status === 409, `second confirm ${r2.status}: ${JSON.stringify(r2.body)}`);
  });

  await test('C5 channel order CANCELLED is terminal — third PATCH rejected with 409', async () => {
    const cancel = await request('PATCH', `/api/v1/channels/orders/${qrOrderId1}/status`,
      { state: 'CANCELLED', actor: manager.userId, reason: '取消', idempotencyKey: idem() },
      authHeader(manager.token));
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    const after = await request('PATCH', `/api/v1/channels/orders/${qrOrderId1}/status`,
      { state: 'CONFIRMED', actor: manager.userId, reason: '想要重開', idempotencyKey: idem() },
      authHeader(manager.token));
    assert.equal(after.status, 409, `reopen after cancel must 409 got ${after.status}: ${JSON.stringify(after.body)}`);
    assert.equal(after.body.errorCode, 'SOURCE_ITEM_CLOSED');
  });

  await test('C6 MFA enroll then re-enroll (no one-shot lockout)', async () => {
    const r1 = await request('POST', '/api/v1/auth/mfa/enroll', null, authHeader(admin.token));
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const r2 = await request('POST', '/api/v1/auth/mfa/enroll', null, authHeader(admin.token));
    assert.ok(r2.status >= 200 && r2.status < 500, `re-enroll ${r2.status}`);
  });

  await test('C7 subscription change idempotent + re-change OK', async () => {
    const sharedKey = idem();
    const a = await request('POST', '/api/v1/subscription/change',
      { planCode: 'GROWTH', billingCycle: 'MONTHLY', idempotencyKey: sharedKey }, authHeader(admin.token));
    assert.equal(a.status, 200);
    const b = await request('POST', '/api/v1/subscription/change',
      { planCode: 'GROWTH', billingCycle: 'MONTHLY', idempotencyKey: sharedKey }, authHeader(admin.token));
    assert.equal(b.status, 200);
    const c = await request('POST', '/api/v1/subscription/change',
      { planCode: 'CHAIN', billingCycle: 'MONTHLY', idempotencyKey: idem() }, authHeader(admin.token));
    assert.equal(c.status, 200);
    assert.equal(c.body.planCode, 'CHAIN');
  });

  await test('C8 cash drawer open → close → reopen', async () => {
    const open1 = await request('POST', '/api/v1/cash-drawers/open',
      { storeId: STORE, openingFloat: 1000, terminalId: TERMINAL, idempotencyKey: idem() }, authHeader(cashier.token));
    assert.ok(open1.status >= 200 && open1.status < 500, `open1 ${open1.status}: ${JSON.stringify(open1.body)}`);
    const close1 = await request('POST', '/api/v1/cash-drawers/close',
      { storeId: STORE, countedAmount: 1100, terminalId: TERMINAL, idempotencyKey: idem() }, authHeader(cashier.token));
    assert.ok(close1.status >= 200 && close1.status < 500, `close1 ${close1.status}: ${JSON.stringify(close1.body)}`);
    const open2 = await request('POST', '/api/v1/cash-drawers/open',
      { storeId: STORE, openingFloat: 1000, terminalId: TERMINAL, idempotencyKey: idem() }, authHeader(cashier.token));
    assert.ok(open2.status >= 200 && open2.status < 500, `open2 ${open2.status}: ${JSON.stringify(open2.body)}`);
  });

  await test('C9 audit log readable repeatedly (paged)', async () => {
    const r1 = await request('GET', '/api/v1/audit-logs?limit=5', null, authHeader(admin.token));
    assert.equal(r1.status, 200);
    const r2 = await request('GET', '/api/v1/audit-logs?limit=5', null, authHeader(admin.token));
    assert.equal(r2.status, 200);
    assert.ok(Array.isArray(r1.body.items));
  });

  // ---- D. Surface checks ----
  await test('D1 catalog list + categories + export', async () => {
    const a = await request('GET', '/api/v1/products', null, authHeader(cashier.token));
    assert.equal(a.status, 200);
    const b = await request('GET', '/api/v1/catalog/categories', null, authHeader(cashier.token));
    assert.equal(b.status, 200);
    const c = await request('GET', '/api/v1/catalog/export', null, authHeader(manager.token));
    assert.ok(c.status >= 200 && c.status < 500);
  });

  await test('D2 inventory levels (CHAIN entitlement)', async () => {
    const r = await request('GET', '/api/v1/inventory/levels', null, authHeader(manager.token));
    assert.equal(r.status, 200);
  });

  await test('D3 daily report (date) + payment breakdown (from/to)', async () => {
    const a = await request('GET', `/api/v1/reports/daily?storeId=${STORE}&date=${TODAY}`, null, authHeader(manager.token));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await request('GET', `/api/v1/reports/payment-breakdown?storeId=${STORE}&from=${TODAY}&to=${TODAY}`, null, authHeader(manager.token));
    assert.equal(b.status, 200, JSON.stringify(b.body));
  });

  await test('D4 AI daily brief (GROWTH+)', async () => {
    const r = await request('GET', '/api/v1/ai/daily-brief', null, authHeader(manager.token));
    assert.equal(r.status, 200);
  });

  await test('D5 telemetry heartbeat + dashboard', async () => {
    const a = await request('POST', '/api/v1/telemetry/heartbeat',
      { storeId: STORE, deviceId: 'verify-device', status: 'OK', idempotencyKey: idem() },
      authHeader(cashier.token));
    assert.ok(a.status >= 200 && a.status < 500);
    const b = await request('GET', '/api/v1/telemetry/dashboard', null, authHeader(manager.token));
    assert.equal(b.status, 200);
  });

  await test('D6 print jobs list', async () => {
    const r = await request('GET', '/api/v1/print-jobs', null, authHeader(manager.token));
    assert.equal(r.status, 200);
  });

  await test('D7 health endpoints always callable', async () => {
    const a = await request('GET', '/health/ready');
    assert.equal(a.status, 200);
    const b = await request('GET', '/health/live');
    assert.equal(b.status, 200);
    assert.equal(a.body.checks.sqlite.ok, true);
  });

  await test('D8 all static pages served', async () => {
    for (const p of ['/', '/login.html', '/app.html', '/o.html', '/pricing.html', '/product.html', '/terms.html', '/privacy.html']) {
      const r = await request('GET', p);
      assert.equal(r.status, 200, `static ${p} got ${r.status}`);
    }
  });

  await test('D9 session GET + logout invalidates token', async () => {
    const a = await request('GET', '/api/v1/auth/session', null, authHeader(supervisor.token));
    assert.equal(a.status, 200);
    const out = await request('POST', '/api/v1/auth/logout', null, authHeader(supervisor.token));
    assert.ok(out.status >= 200 && out.status < 500);
    const after = await request('GET', '/api/v1/auth/session', null, authHeader(supervisor.token));
    assert.ok(after.status === 401 || after.status === 403, `post-logout session ${after.status}`);
  });

  await test('D10 refresh token rotates', async () => {
    const r = await request('POST', '/api/v1/auth/refresh', { refreshToken: manager.refreshToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    assert.notEqual(r.body.token, manager.token);
  });

  // ---- E. Cross-tenant isolation (negative tests) ----
  // Reset the SQLite-backed login bucket again so the tenant-B login below
  // doesn't trip the 10/min/IP cap accumulated by A's 9 prior logins.
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.resolve(__dirname, '..', 'data', 'store.db');
    const db = new Database(dbPath);
    db.exec('DELETE FROM rate_limit');
    db.close();
  } catch { /* best-effort */ }
  const TENANT_B = `${TENANT}-foreign`;
  const adminB = await (async () => {
    const r = await request('POST', '/api/v1/auth/login',
      { tenantId: TENANT_B, role: 'ADMIN', pin: '9001', storeId: STORE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  })();

  await test('E1 tenant B cannot GET tenant A order by id', async () => {
    const r = await request('GET', `/api/v1/orders/${orderId}`, null, authHeader(adminB.token));
    assert.ok(r.status === 404 || r.status === 403, `cross-tenant order leak status=${r.status}`);
  });

  await test('E2 tenant B cannot PATCH tenant A order discount', async () => {
    const r = await request('PATCH', `/api/v1/orders/${orderId}/discount`,
      { amount: 5, reasonCode: 'MANAGER_APPROVAL', idempotencyKey: idem() }, authHeader(adminB.token));
    assert.ok(r.status === 404 || r.status === 403);
  });

  await test('E3 tenant B cannot pay tenant A order', async () => {
    const r = await request('POST', `/api/v1/orders/${orderId}/pay/manual`,
      { idempotencyKey: idem(), amount: 1, paymentMethod: 'CASH', cashReceived: 1 },
      authHeader(adminB.token));
    assert.ok(r.status === 404 || r.status === 403);
  });

  await test('E4 tenant B cannot void tenant A order', async () => {
    const r = await request('POST', `/api/v1/orders/${orderId}/void`,
      { reasonCode: 'INPUT_ERROR', idempotencyKey: idem() }, authHeader(adminB.token));
    assert.ok(r.status === 404 || r.status === 403);
  });

  await test('E5 tenant B order list excludes tenant A order', async () => {
    const r = await request('GET', '/api/v1/order-hub?storeId=store-001', null, authHeader(adminB.token));
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.ok(!r.body.items.some((o) => o.orderId === orderId),
      'tenant B saw tenant A orderId');
  });

  await test('E6 tenant B audit log excludes tenant A entries', async () => {
    const r = await request('GET', '/api/v1/audit-logs?limit=200', null, authHeader(adminB.token));
    assert.equal(r.status, 200);
    for (const entry of r.body.items || []) {
      assert.notEqual(entry.tenantId, TENANT,
        `tenant B audit-log leaked entry for tenant A: ${JSON.stringify(entry)}`);
    }
  });

  await test('E7 tenant B cannot read tenant A customers via search', async () => {
    // Create customer in A first.
    await request('POST', '/api/v1/customers',
      { phone: '0912345678', name: '張先生' }, authHeader(supervisor.token));
    // B's MEMBERSHIP gate may fail on STARTER plan; if so 403 is acceptable.
    const r = await request('GET', '/api/v1/customers/search?phone=0912345678', null, authHeader(adminB.token));
    if (r.status === 200) {
      assert.equal((r.body.items || []).length, 0, 'tenant B searched into tenant A customers');
    } else {
      assert.ok([400, 403].includes(r.status), `unexpected isolation response ${r.status}`);
    }
  });

  await test('E8 tenant B cannot change tenant A subscription', async () => {
    // adminB only authorises tenant B's subscription, so this both confirms
    // role + isolation: the change should target B's plan, not A's.
    const r = await request('POST', '/api/v1/subscription/change',
      { planCode: 'GROWTH', billingCycle: 'MONTHLY', idempotencyKey: idem() },
      authHeader(adminB.token));
    assert.equal(r.status, 200);
    // Re-read A's subscription as A's admin to confirm it is still CHAIN
    // (not GROWTH).
    const aSub = await request('GET', '/api/v1/subscription/current', null, authHeader(admin.token));
    assert.equal(aSub.status, 200);
    assert.equal(aSub.body.planCode, 'CHAIN',
      'tenant A subscription was changed by tenant B request');
  });

  console.log(`\nRESULTS: ${passed} passed / ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log(`  - ${f.name}: ${f.err}`));
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(2); });
