'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pp = require('../src/core/paymentProvider');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

test('cashDrawer charge returns null txnId and CASH_COUNTED_IN_DRAWER', async () => {
  const provider = pp.defaultProviderFor('CASH');
  const out = await provider.charge({ amount: 100, idempotencyKey: 'k1' });
  assert.equal(provider.code, 'CASH_DRAWER');
  assert.equal(out.providerTransactionId, null);
  assert.equal(out.settlementState, 'CASH_COUNTED_IN_DRAWER');
  assert.equal(out.fee, 0);
  assert.equal(out.netSettledAmount, 100);
});

test('mockCard charge returns provider txn + auth code with 2% fee', async () => {
  const provider = pp.defaultProviderFor('CARD');
  const out = await provider.charge({ amount: 1000, idempotencyKey: 'k2' });
  assert.equal(provider.code, 'MOCK_CARD_PSP');
  assert.ok(out.providerTransactionId.startsWith('psp-card-'));
  assert.ok(out.authorizationCode.startsWith('AUTH-'));
  assert.equal(out.settlementState, 'PENDING_SETTLEMENT');
  assert.equal(out.fee, 20);
  assert.equal(out.netSettledAmount, 980);
});

test('mockCard simulate=decline throws PAYMENT_DECLINED', async () => {
  const provider = pp.defaultProviderFor('CARD');
  await assert.rejects(
    () => provider.charge({ amount: 100, metadata: { simulate: 'decline' } }),
    (err) => err.errorCode === 'PAYMENT_DECLINED'
  );
});

test('mockQr simulate=pending returns PENDING_CUSTOMER_SCAN', async () => {
  const provider = pp.defaultProviderFor('QR');
  const out = await provider.charge({ amount: 100, metadata: { simulate: 'pending' } });
  assert.equal(out.settlementState, 'PENDING_CUSTOMER_SCAN');
  assert.equal(out.netSettledAmount, 0);
});

test('mockMobile (LINE Pay) charge returns 2.5% fee', async () => {
  const provider = pp.defaultProviderFor('MOBILE');
  const out = await provider.charge({ amount: 1000 });
  assert.equal(provider.code, 'MOCK_LINE_PAY');
  assert.equal(out.fee, 25);
  assert.equal(out.netSettledAmount, 975);
});

test('refund returns providerRefundId for each provider', async () => {
  for (const method of ['CASH', 'CARD', 'QR', 'MOBILE']) {
    const provider = pp.defaultProviderFor(method);
    const out = await provider.refund({ amount: 50, originalProviderTransactionId: 'orig-x' });
    assert.ok(out.providerRefundId, `${method} refund missing id`);
    assert.ok(out.status, `${method} refund missing status`);
  }
});

test('listCapabilities exposes built-in providers', () => {
  const caps = pp.listCapabilities();
  const codes = caps.map((c) => c.code).sort();
  assert.deepEqual(codes, ['CASH_DRAWER', 'MOCK_CARD_PSP', 'MOCK_LINE_PAY', 'MOCK_QR_GATEWAY']);
  for (const cap of caps) {
    assert.ok(cap.method, `${cap.code} missing method`);
    assert.ok(cap.settlementMode, `${cap.code} missing settlementMode`);
  }
});

test('register rejects invalid provider', () => {
  assert.throws(() => pp.register({}), /invalid/);
  assert.throws(() => pp.register({ code: 'X', capabilities: {} }), /missing charge/);
});

test('/api/v1/payment-providers returns capabilities (MANAGER+)', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-pp-1', 'MANAGER');
    const res = await request(ctx.port, 'GET', '/api/v1/payment-providers', null, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(res.body.items.length >= 4);
  } finally { await stopTestServer(ctx); }
});

test('/pay/manual via CASH still produces PAID_CASH (provider integration)', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-pp-2', 'CASHIER');
    const skuId = await firstSkuId(ctx.port, token);
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-pp', businessDate: todayBusinessDate(),
      items: [{ skuId, name: '招牌奶茶', qty: 1, unitPrice: 55 }],
      idempotencyKey: `pp-cash-${Date.now()}`,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(create.status, 201);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(pay.status, 200);
    assert.equal(pay.body.state, 'PAID_CASH');
    assert.equal(pay.body.paymentSummary.paymentProvider, 'CASH_DRAWER');
    assert.equal(pay.body.paymentSummary.settlementState, 'CASH_COUNTED_IN_DRAWER');
    assert.equal(pay.body.paymentSummary.fee, 0);
    assert.equal(pay.body.paymentSummary.netSettledAmount, 55);
  } finally { await stopTestServer(ctx); }
});

test('/pay/manual via CARD returns provider txn, auth, fee, netSettled', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-pp-3', 'CASHIER');
    const skuId = await firstSkuId(ctx.port, token);
    // unitPrice in the body is ignored — server derives from sku.price (55).
    // qty 2 => grandTotal 110; fee = ceil(110 * 0.02) = 3; net = 107.
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-pp', businessDate: todayBusinessDate(),
      items: [{ skuId, name: '招牌奶茶', qty: 2 }],
      idempotencyKey: `pp-card-${Date.now()}`,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(create.status, 201);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 110, paymentMethod: 'CARD', cashReceived: 110,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(pay.status, 200);
    assert.equal(pay.body.state, 'PAID_PENDING');
    assert.equal(pay.body.paymentSummary.paymentProvider, 'MOCK_CARD_PSP');
    assert.equal(pay.body.paymentSummary.settlementState, 'PENDING_SETTLEMENT');
    assert.ok(pay.body.paymentSummary.providerTransactionId.startsWith('psp-card-'));
    assert.ok(pay.body.paymentSummary.authorizationCode.startsWith('AUTH-'));
    assert.equal(pay.body.paymentSummary.fee, 3);
    assert.equal(pay.body.paymentSummary.netSettledAmount, 107);
  } finally { await stopTestServer(ctx); }
});

test('/pay/manual CARD with simulate=decline returns 402 PAYMENT_DECLINED', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-pp-4', 'CASHIER');
    const skuId = await firstSkuId(ctx.port, token);
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-pp', businessDate: todayBusinessDate(),
      items: [{ skuId, name: '招牌奶茶', qty: 1, unitPrice: 55 }],
      idempotencyKey: `pp-decline-${Date.now()}`,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(create.status, 201);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CARD', cashReceived: 55,
      providerMetadata: { simulate: 'decline' },
    }, { Authorization: `Bearer ${token}` });
    assert.equal(pay.status, 402);
    assert.equal(pay.body.errorCode, 'PAYMENT_DECLINED');
  } finally { await stopTestServer(ctx); }
});
