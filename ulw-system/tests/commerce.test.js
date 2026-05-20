'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

test('order create rejects invalid businessDate format', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-tz', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const res = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: '17 May 2026',
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'tz-1',
    }, auth);
    assert.equal(res.status, 400);
    assert.equal(res.body.errorCode, 'ORDER_ITEM_INVALID');
  } finally {
    await stopTestServer(ctx);
  }
});

test('client-supplied correlationId is ignored by server', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-corr', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'corr-k',
    }, auth);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55,
      correlationId: 'attacker-injected-id',
    }, auth);
    assert.equal(pay.status, 200);
    // Fetch the order; payment correlation id should be server-generated and
    // start with `corr-payment-` (the suffix is random base64url for
    // non-enumerable ids, see runtime.nextId).
    const ord = await request(ctx.port, 'GET', `/api/v1/orders/${create.body.id}`, null, auth);
    assert.equal(ord.status, 200);
    const payment = ord.body.payments[0];
    assert.notEqual(payment.correlationId, 'attacker-injected-id');
    assert.match(payment.correlationId, /^corr-payment-[A-Za-z0-9_-]+$/);
  } finally {
    await stopTestServer(ctx);
  }
});

test('pay/manual is idempotent: replay dedups, payload mismatch conflicts', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-pay-idem', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 4, unitPrice: 55 }], idempotencyKey: 'pay-idem-ord',
    }, auth);
    assert.equal(create.status, 201);
    // Partial payment with an idempotency key.
    const pay1 = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 50, paymentMethod: 'CASH', cashReceived: 50, idempotencyKey: 'PAY-K1',
    }, auth);
    assert.equal(pay1.status, 200);
    assert.equal(pay1.body.paymentSummary.paidTotal, 50);
    // Replay with the same key + same payload: cached response, no second charge.
    const replay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 50, paymentMethod: 'CASH', cashReceived: 50, idempotencyKey: 'PAY-K1',
    }, auth);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicated, true);
    assert.equal(replay.body.paymentSummary.paidTotal, 50);
    // Same key, different payload: conflict.
    const conflict = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 99, paymentMethod: 'CASH', cashReceived: 99, idempotencyKey: 'PAY-K1',
    }, auth);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.errorCode, 'ORDER_IDEMPOTENCY_CONFLICT');
    // Exactly one payment row persisted despite three requests.
    const ord = await request(ctx.port, 'GET', `/api/v1/orders/${create.body.id}`, null, auth);
    assert.equal(ord.body.payments.length, 1);
    assert.equal(ord.body.paymentState, 'PARTIALLY_PAID');
  } finally {
    await stopTestServer(ctx);
  }
});
