'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

function orderBody(skuId, idemKey) {
  return {
    storeId: 'store-001',
    terminalId: 'term-001',
    businessDate: todayBusinessDate(),
    items: [{ skuId, name: '招牌奶茶', qty: 1, unitPrice: 55 }],
    idempotencyKey: idemKey,
  };
}

test('order create returns 201 with DRAFT state', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'orders-tenant', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const res = await request(ctx.port, 'POST', '/api/v1/orders', orderBody(skuId, 'k1'), auth);
    assert.equal(res.status, 201);
    assert.equal(res.body.state, 'DRAFT');
    assert.match(res.body.id, /^order-/);
  } finally {
    await stopTestServer(ctx);
  }
});

test('order create is idempotent on replay', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'orders-idem', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const body = orderBody(skuId, 'replay-key');
    const r1 = await request(ctx.port, 'POST', '/api/v1/orders', body, auth);
    const r2 = await request(ctx.port, 'POST', '/api/v1/orders', body, auth);
    assert.equal(r1.body.id, r2.body.id);
    assert.equal(r2.body.duplicated, true);
  } finally {
    await stopTestServer(ctx);
  }
});

test('order create with same key but different body returns 409', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'orders-conflict', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const r1 = await request(ctx.port, 'POST', '/api/v1/orders', orderBody(skuId, 'same-key'), auth);
    assert.equal(r1.status, 201);
    const alt = { ...orderBody(skuId, 'same-key') };
    alt.items = [{ skuId, name: '招牌奶茶', qty: 2, unitPrice: 55 }];
    const r2 = await request(ctx.port, 'POST', '/api/v1/orders', alt, auth);
    assert.equal(r2.status, 409);
    assert.equal(r2.body.errorCode, 'ORDER_IDEMPOTENCY_CONFLICT');
  } finally {
    await stopTestServer(ctx);
  }
});

test('pay/manual transitions order to PAID_CASH', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'orders-pay', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', orderBody(skuId, 'pay-key'), auth);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55,
    }, auth);
    assert.equal(pay.status, 200);
    assert.equal(pay.body.state, 'PAID_CASH');
    assert.equal(pay.body.paymentState, 'PAID');
  } finally {
    await stopTestServer(ctx);
  }
});

test('pay/manual out-of-stock rejection leaves no payment side effect', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'orders-stock-atomic', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    const products = await request(ctx.port, 'GET', '/api/v1/products', null, auth);
    const tracked = products.body.items.find((item) => item.stockTracked);
    assert.ok(tracked, 'expected seeded stock-tracked SKU');
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001',
      terminalId: 'term-001',
      businessDate: todayBusinessDate(),
      items: [{ skuId: tracked.skuId, name: tracked.productName, qty: 31, unitPrice: tracked.price }],
      idempotencyKey: 'stock-atomic-key',
    }, auth);
    assert.equal(create.status, 201);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: create.body.grandTotal, paymentMethod: 'CASH', cashReceived: create.body.grandTotal,
    }, auth);
    assert.equal(pay.status, 409);
    assert.equal(pay.body.errorCode, 'OUT_OF_STOCK');
    const fetched = await request(ctx.port, 'GET', `/api/v1/orders/${create.body.id}`, null, auth);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.paymentState, 'UNPAID');
    assert.equal(fetched.body.payments.length, 0);
  } finally {
    await stopTestServer(ctx);
  }
});

test('void unpaid order returns VOIDED', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'orders-void', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', orderBody(skuId, 'void-key'), auth);
    const v = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/void`, { reasonCode: 'INPUT_ERROR' }, auth);
    assert.equal(v.status, 200);
    assert.equal(v.body.state, 'VOIDED');
  } finally {
    await stopTestServer(ctx);
  }
});

test('order outside store scope returns 403', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'orders-scope', 'CASHIER');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const bad = { ...orderBody(skuId, 'scope-key'), storeId: 'store-evil-999' };
    const res = await request(ctx.port, 'POST', '/api/v1/orders', bad, auth);
    assert.equal(res.status, 403);
    assert.equal(res.body.errorCode, 'TENANT_NOT_AUTHORIZED');
  } finally {
    await stopTestServer(ctx);
  }
});
