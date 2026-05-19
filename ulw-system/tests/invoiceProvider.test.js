'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ip = require('../src/core/invoiceProvider');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

test('mockVatCenter issue returns SANDBOX invoiceNumber + ISSUED_SANDBOX', async () => {
  const provider = ip.active();
  const out = await provider.issue({ orderId: 'order-001' });
  assert.equal(provider.code, 'MOCK_VAT_CENTER');
  assert.equal(out.invoiceNumber, 'SANDBOX-order-001');
  assert.equal(out.lifecycleState, 'ISSUED_SANDBOX');
});

test('mockVatCenter upload default succeeds with ack', async () => {
  const provider = ip.active();
  const out = await provider.upload({ invoiceId: 'inv-1' });
  assert.equal(out.uploadState, 'UPLOADED');
  assert.equal(out.lifecycleState, 'UPLOADED');
  assert.ok(out.ackId.startsWith('vat-ack-'));
});

test('mockVatCenter upload simulate=fail-retryable throws retryable', async () => {
  const provider = ip.active();
  await assert.rejects(
    () => provider.upload({ invoiceId: 'inv-2', metadata: { simulate: 'fail-retryable' } }),
    (err) => err.errorCode === 'INVOICE_UPLOAD_TIMEOUT' && err.retryable === true
  );
});

test('mockVatCenter upload simulate=fail-fatal throws non-retryable', async () => {
  const provider = ip.active();
  await assert.rejects(
    () => provider.upload({ invoiceId: 'inv-3', metadata: { simulate: 'fail-fatal' } }),
    (err) => err.errorCode === 'INVOICE_SIGNATURE_INVALID' && err.retryable === false
  );
});

test('listCapabilities exposes MOCK_VAT_CENTER', () => {
  const caps = ip.listCapabilities();
  const codes = caps.map((c) => c.code);
  assert.ok(codes.includes('MOCK_VAT_CENTER'));
});

test('register rejects invalid provider', () => {
  assert.throws(() => ip.register({}), /invalid/);
  assert.throws(() => ip.register({ code: 'X', capabilities: {} }), /missing issue/);
});

test('end-to-end: paid order issues invoice via provider', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-ip-1', 'CASHIER');
    const skuId = await firstSkuId(ctx.port, token);
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-ip', businessDate: todayBusinessDate(),
      items: [{ skuId, name: '招牌奶茶', qty: 1, unitPrice: 55 }],
      idempotencyKey: `ip-create-${Date.now()}`,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(create.status, 201);
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(pay.status, 200);
    assert.ok(pay.body.invoice);
    assert.ok(pay.body.invoice.invoiceNumber.startsWith('SANDBOX-'));
    assert.equal(pay.body.invoice.uploadState, 'PENDING_UPLOAD');
  } finally { await stopTestServer(ctx); }
});

test('/invoices/:id/upload-attempt succeeds via provider', async () => {
  const ctx = await startTestServer();
  try {
    const cashier = await loginAs(ctx.port, 't-ip-2', 'CASHIER');
    const manager = await loginAs(ctx.port, 't-ip-2', 'MANAGER');
    const skuId = await firstSkuId(ctx.port, cashier);
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-ip', businessDate: todayBusinessDate(),
      items: [{ skuId, name: '招牌奶茶', qty: 1, unitPrice: 55 }],
      idempotencyKey: `ip-upl-${Date.now()}`,
    }, { Authorization: `Bearer ${cashier}` });
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55,
    }, { Authorization: `Bearer ${cashier}` });
    // Issue happens automatically — but ISSUED_SANDBOX is not on PENDING_UPLOAD,
    // so first transition is via the FSM: PENDING_UPLOAD on uploadState meanwhile
    // lifecycleState is ISSUED_SANDBOX → UPLOAD_PENDING simulate first.
    const invoiceId = pay.body.invoice.invoiceId;
    // Transition ISSUED_SANDBOX → UPLOAD_PENDING via simulate=pending
    const pending = await request(ctx.port, 'POST', `/api/v1/invoices/${invoiceId}/upload-attempt`, { simulate: 'pending' }, { Authorization: `Bearer ${manager}` });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.lifecycleState, 'UPLOAD_PENDING');
    // Then UPLOAD_PENDING → UPLOADED via default success path
    const uploaded = await request(ctx.port, 'POST', `/api/v1/invoices/${invoiceId}/upload-attempt`, {}, { Authorization: `Bearer ${manager}` });
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.body.lifecycleState, 'UPLOADED');
    assert.equal(uploaded.body.uploadState, 'UPLOADED');
    assert.ok(uploaded.body.ackId);
  } finally { await stopTestServer(ctx); }
});

test('/invoices/:id/upload-attempt retryable failure returns 503 + UPLOAD_FAILED', async () => {
  const ctx = await startTestServer();
  try {
    const cashier = await loginAs(ctx.port, 't-ip-3', 'CASHIER');
    const manager = await loginAs(ctx.port, 't-ip-3', 'MANAGER');
    const skuId = await firstSkuId(ctx.port, cashier);
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-ip', businessDate: todayBusinessDate(),
      items: [{ skuId, name: '招牌奶茶', qty: 1, unitPrice: 55 }],
      idempotencyKey: `ip-fail-${Date.now()}`,
    }, { Authorization: `Bearer ${cashier}` });
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55,
    }, { Authorization: `Bearer ${cashier}` });
    const invoiceId = pay.body.invoice.invoiceId;
    // Move ISSUED_SANDBOX → UPLOAD_PENDING first
    await request(ctx.port, 'POST', `/api/v1/invoices/${invoiceId}/upload-attempt`, { simulate: 'pending' }, { Authorization: `Bearer ${manager}` });
    const failed = await request(ctx.port, 'POST', `/api/v1/invoices/${invoiceId}/upload-attempt`, { simulate: 'fail-retryable' }, { Authorization: `Bearer ${manager}` });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.errorCode, 'INVOICE_UPLOAD_TIMEOUT');
    assert.equal(failed.body.retryable, true);
  } finally { await stopTestServer(ctx); }
});

test('upload-attempt rejects invalid FSM transition', async () => {
  const ctx = await startTestServer();
  try {
    const cashier = await loginAs(ctx.port, 't-ip-4', 'CASHIER');
    const manager = await loginAs(ctx.port, 't-ip-4', 'MANAGER');
    const skuId = await firstSkuId(ctx.port, cashier);
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-ip', businessDate: todayBusinessDate(),
      items: [{ skuId, name: '招牌奶茶', qty: 1, unitPrice: 55 }],
      idempotencyKey: `ip-fsm-${Date.now()}`,
    }, { Authorization: `Bearer ${cashier}` });
    const pay = await request(ctx.port, 'POST', `/api/v1/orders/${create.body.id}/pay/manual`, {
      amount: 55, paymentMethod: 'CASH', cashReceived: 55,
    }, { Authorization: `Bearer ${cashier}` });
    const invoiceId = pay.body.invoice.invoiceId;
    // ISSUED_SANDBOX → UPLOADED is not allowed (must go via UPLOAD_PENDING)
    const out = await request(ctx.port, 'POST', `/api/v1/invoices/${invoiceId}/upload-attempt`, {}, { Authorization: `Bearer ${manager}` });
    assert.equal(out.status, 409);
    assert.equal(out.body.errorCode, 'INVOICE_FSM_VIOLATION');
  } finally { await stopTestServer(ctx); }
});
