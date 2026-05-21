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
      correlationId: 'attacker-injected-id', idempotencyKey: 'pay-corr-k1',
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

test('pay/manual rejects a missing idempotencyKey with 400', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-pay-idem-req', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'pay-req-ord',
    }, auth);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55,
    }, auth);
    assert.equal(pay.status, 400);
    assert.equal(pay.body.errorCode, 'IDEMPOTENCY_KEY_MISMATCH');
  } finally {
    await stopTestServer(ctx);
  }
});

test('QR charge pending customer scan does NOT mark order PAID or issue invoice', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-qr-pending', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'qr-pending-ord',
    }, auth);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'QR', cashReceived: 55, idempotencyKey: 'qr-pending-k1',
      providerMetadata: { simulate: 'pending' },
    }, auth);
    assert.equal(pay.status, 200);
    assert.equal(pay.body.pending, true);
    assert.notEqual(pay.body.paymentState, 'PAID');
    assert.equal(pay.body.paymentSummary.settlementState, 'PENDING_CUSTOMER_SCAN');
    // Persisted order must not be PAID and must have no CAPTURED payment.
    const ord = await request(ctx.port, 'GET', `/api/v1/orders/${create.body.id}`, null, auth);
    assert.notEqual(ord.body.paymentState, 'PAID');
    assert.equal(ord.body.payments.filter((p) => p.status !== 'PENDING').length, 0);
  } finally {
    await stopTestServer(ctx);
  }
});

test('refund records a provider refund id (gateway reversal) and dedups on replay', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-refund-prov', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'refund-prov-ord',
    }, auth);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CARD', cashReceived: 55, idempotencyKey: 'refund-prov-pay',
    }, auth);
    assert.equal(pay.body.paymentState, 'PAID');
    const refund = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/refund`, {
      amount: 55, reasonCode: 'CUSTOMER_RETURN', method: 'CARD', idempotencyKey: 'refund-prov-k1',
    }, auth);
    assert.equal(refund.status, 200);
    assert.ok(refund.body.refund.providerRefundId, 'provider refund id missing');
    assert.equal(refund.body.refund.paymentProvider, 'MOCK_CARD_PSP');
    const replay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/refund`, {
      amount: 55, reasonCode: 'CUSTOMER_RETURN', method: 'CARD', idempotencyKey: 'refund-prov-k1',
    }, auth);
    assert.equal(replay.body.duplicated, true);
  } finally {
    await stopTestServer(ctx);
  }
});

test('refund rejects a missing idempotencyKey with 400', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-refund-idem-req', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'refund-req-ord',
    }, auth);
    await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55, idempotencyKey: 'refund-req-pay',
    }, auth);
    const refund = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/refund`, {
      amount: 55, reasonCode: 'CUSTOMER_RETURN',
    }, auth);
    assert.equal(refund.status, 400);
    assert.equal(refund.body.errorCode, 'IDEMPOTENCY_KEY_MISMATCH');
  } finally {
    await stopTestServer(ctx);
  }
});

test('voiding a QR-pending order cancels the orphan PENDING payment', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-void-pending', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'void-pending-ord',
    }, auth);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'QR', cashReceived: 55, idempotencyKey: 'void-pending-pay',
      providerMetadata: { simulate: 'pending' },
    }, auth);
    assert.equal(pay.body.pending, true);
    const v = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/void`, { reasonCode: 'CUST_CANCEL' }, auth);
    assert.equal(v.status, 200);
    assert.equal(v.body.state, 'VOIDED');
    const ord = await request(ctx.port, 'GET', `/api/v1/orders/${create.body.id}`, null, auth);
    assert.equal(ord.body.payments.filter((p) => p.status === 'PENDING').length, 0, 'no PENDING payment may survive a void');
    assert.equal(ord.body.payments.filter((p) => p.status === 'CANCELLED').length, 1);
  } finally {
    await stopTestServer(ctx);
  }
});

test('batch price change writes per-SKU before/after into the audit row', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'commerce-price-audit', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const batch = await request(ctx.port, 'POST', '/api/v1/catalog/prices/batch', {
      productPriceUpdates: [{ skuId, storeId: 'store-001', price: 77 }],
      idempotencyKey: 'price-audit-k1',
    }, auth);
    assert.equal(batch.status, 200);
    assert.equal(batch.body.applied, 1);
    const audit = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=PRICES_BATCH_APPLIED', null, auth);
    assert.equal(audit.status, 200);
    const row = audit.body.items[0];
    const after = typeof row.after === 'string' ? JSON.parse(row.after) : row.after;
    assert.ok(Array.isArray(after.changes), 'audit must carry a per-SKU changes array');
    const change = after.changes.find((c) => c.skuId === skuId);
    assert.ok(change, 'changed SKU missing from audit');
    assert.equal(change.after, 77);
    assert.ok('before' in change, 'before price missing');
  } finally {
    await stopTestServer(ctx);
  }
});
