'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

const authH = (token) => ({ Authorization: `Bearer ${token}` });

async function createOrder(port, token, skuId, key) {
  const res = await request(port, 'POST', '/api/v1/orders', {
    storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
    items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: key,
  }, authH(token));
  return res;
}

// --- Cash drawer (開錢櫃) — financial, SUPERVISOR+ -------------------------

test('cash-drawer open: SUPERVISOR succeeds, CASHIER denied', async () => {
  const ctx = await startTestServer();
  try {
    const sup = await loginAs(ctx.port, 'ops-cd', 'SUPERVISOR');
    const open = await request(ctx.port, 'POST', '/api/v1/cash-drawers/open', { storeId: 'store-001', terminalId: 'term-001', expectedOpeningCash: 1000 }, authH(sup));
    assert.equal(open.status, 200);
    assert.equal(open.body.state, 'OPEN');

    const cashier = await loginAs(ctx.port, 'ops-cd', 'CASHIER');
    const denied = await request(ctx.port, 'POST', '/api/v1/cash-drawers/open', { storeId: 'store-001', terminalId: 'term-002', expectedOpeningCash: 0 }, authH(cashier));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.errorCode, 'PERMISSION_DENIED');
  } finally { await stopTestServer(ctx); }
});

test('cash-drawer open: second open on same terminal returns CASHBOX_ALREADY_OPEN', async () => {
  const ctx = await startTestServer();
  try {
    const sup = await loginAs(ctx.port, 'ops-cd2', 'SUPERVISOR');
    await request(ctx.port, 'POST', '/api/v1/cash-drawers/open', { storeId: 'store-001', terminalId: 'term-001', expectedOpeningCash: 0 }, authH(sup));
    const again = await request(ctx.port, 'POST', '/api/v1/cash-drawers/open', { storeId: 'store-001', terminalId: 'term-001', expectedOpeningCash: 0 }, authH(sup));
    assert.equal(again.status, 409);
    assert.equal(again.body.errorCode, 'CASHBOX_ALREADY_OPEN');
  } finally { await stopTestServer(ctx); }
});

test('cash-drawer open: negative opening cash is rejected 400', async () => {
  const ctx = await startTestServer();
  try {
    const sup = await loginAs(ctx.port, 'ops-cd3', 'SUPERVISOR');
    const bad = await request(ctx.port, 'POST', '/api/v1/cash-drawers/open', { storeId: 'store-001', terminalId: 'term-001', expectedOpeningCash: -5 }, authH(sup));
    assert.equal(bad.status, 400);
  } finally { await stopTestServer(ctx); }
});

test('cash-drawer close: balanced closes OK; unexplained variance is rejected', async () => {
  const ctx = await startTestServer();
  try {
    const sup = await loginAs(ctx.port, 'ops-cd4', 'SUPERVISOR');
    const open = await request(ctx.port, 'POST', '/api/v1/cash-drawers/open', { storeId: 'store-001', terminalId: 'term-001', expectedOpeningCash: 0 }, authH(sup));
    const drawerId = open.body.cashDrawerId;
    // variance without adjustment → 409
    const bad = await request(ctx.port, 'POST', '/api/v1/cash-drawers/close', { cashDrawerId: drawerId, closingCash: 50 }, authH(sup));
    assert.equal(bad.status, 409);
    assert.equal(bad.body.errorCode, 'CASH_SHORTFALL_UNEXPLAINED');
    // balanced close → 200
    const ok = await request(ctx.port, 'POST', '/api/v1/cash-drawers/close', { cashDrawerId: drawerId, closingCash: 0 }, authH(sup));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.state, 'CLOSED');
    assert.equal(ok.body.cashVariance, 0);
  } finally { await stopTestServer(ctx); }
});

test('cash-drawer open: malformed JSON body returns 400 PAYLOAD_PARSE_ERROR', async () => {
  const ctx = await startTestServer();
  try {
    const sup = await loginAs(ctx.port, 'ops-cd5', 'SUPERVISOR');
    const res = await request(ctx.port, 'POST', '/api/v1/cash-drawers/open', '{ not valid json', authH(sup));
    assert.equal(res.status, 400);
    assert.equal(res.body.errorCode, 'PAYLOAD_PARSE_ERROR');
  } finally { await stopTestServer(ctx); }
});

// --- KDS — production state machine, CASHIER+ ------------------------------

test('kds: list requires auth and returns an items array', async () => {
  const ctx = await startTestServer();
  try {
    const cashier = await loginAs(ctx.port, 'ops-kds', 'CASHIER');
    const res = await request(ctx.port, 'GET', '/api/v1/kds/orders?storeId=store-001', null, authH(cashier));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  } finally { await stopTestServer(ctx); }
});

test('kds: valid forward transition succeeds; illegal jump and bad state rejected', async () => {
  const ctx = await startTestServer();
  try {
    const admin = await loginAs(ctx.port, 'ops-kds2', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, admin);
    const order = await createOrder(ctx.port, admin, skuId, 'kds-ord-1');
    const orderId = order.body.id;

    // bad target state → 400
    const bad = await request(ctx.port, 'PATCH', `/api/v1/kds/orders/${orderId}`, { productionState: 'NONSENSE' }, authH(admin));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.errorCode, 'KDS_TRANSITION_INVALID');

    // illegal jump QUEUED → DONE → 409
    const jump = await request(ctx.port, 'PATCH', `/api/v1/kds/orders/${orderId}`, { productionState: 'DONE' }, authH(admin));
    assert.equal(jump.status, 409);
    assert.equal(jump.body.errorCode, 'KDS_TRANSITION_INVALID');

    // valid QUEUED → IN_PROGRESS → 200
    const ok = await request(ctx.port, 'PATCH', `/api/v1/kds/orders/${orderId}`, { productionState: 'IN_PROGRESS' }, authH(admin));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.productionState, 'IN_PROGRESS');
  } finally { await stopTestServer(ctx); }
});

// --- order-hub pagination ---------------------------------------------------

test('order-hub: paginates with a stable cursor and rejects bad params', async () => {
  const ctx = await startTestServer();
  try {
    const admin = await loginAs(ctx.port, 'ops-hub', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, admin);
    for (let i = 0; i < 3; i += 1) await createOrder(ctx.port, admin, skuId, `hub-ord-${i}`);

    const page1 = await request(ctx.port, 'GET', '/api/v1/order-hub?storeId=store-001&limit=2', null, authH(admin));
    assert.equal(page1.status, 200);
    assert.equal(page1.body.items.length, 2);
    assert.ok(page1.body.nextCursor, 'expected a nextCursor for more pages');

    const page2 = await request(ctx.port, 'GET', `/api/v1/order-hub?storeId=store-001&limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, null, authH(admin));
    assert.equal(page2.status, 200);
    // no overlap between pages
    const ids1 = new Set(page1.body.items.map((i) => i.orderId));
    assert.ok(page2.body.items.every((i) => !ids1.has(i.orderId)), 'pages must not overlap');

    const badLimit = await request(ctx.port, 'GET', '/api/v1/order-hub?storeId=store-001&limit=0', null, authH(admin));
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.body.errorCode, 'INVALID_PARAM');

    const badCursor = await request(ctx.port, 'GET', '/api/v1/order-hub?storeId=store-001&cursor=@@notbase64@@', null, authH(admin));
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.body.errorCode, 'INVALID_CURSOR');
  } finally { await stopTestServer(ctx); }
});
