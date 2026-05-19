'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tickInvoiceUpload } = require('../src/core/syncWorker');

function makeStore() {
  return {
    data: {
      invoices: new Map(),
      auditLogs: [],
    },
  };
}

test('invoice tick advances ISSUED_SANDBOX → UPLOAD_PENDING first', async () => {
  const store = makeStore();
  store.data.invoices.set('inv-1', {
    id: 'inv-1', tenantId: 't1', uploadState: 'PENDING_UPLOAD',
    lifecycleState: 'ISSUED_SANDBOX', attempts: 0, invoiceNumber: 'SANDBOX-1', amount: 100,
  });
  const changed = await tickInvoiceUpload(store);
  assert.equal(changed, true);
  const inv = store.data.invoices.get('inv-1');
  assert.equal(inv.lifecycleState, 'UPLOAD_PENDING');
  const audit = store.data.auditLogs.find((r) => r.action === 'INVOICE_LIFECYCLE_ADVANCED');
  assert.ok(audit, 'lifecycle audit missing');
});

test('invoice tick transitions UPLOAD_PENDING → UPLOADED via provider success', async () => {
  const store = makeStore();
  store.data.invoices.set('inv-2', {
    id: 'inv-2', tenantId: 't1', uploadState: 'UPLOAD_PENDING',
    lifecycleState: 'UPLOAD_PENDING', attempts: 0, invoiceNumber: 'SANDBOX-2', amount: 100,
  });
  const changed = await tickInvoiceUpload(store);
  assert.equal(changed, true);
  const inv = store.data.invoices.get('inv-2');
  assert.equal(inv.lifecycleState, 'UPLOADED');
  assert.equal(inv.uploadState, 'UPLOADED');
  assert.ok(inv.ackId);
  assert.equal(inv.attempts, 1);
});

test('invoice tick respects nextRetryAt backoff', async () => {
  const store = makeStore();
  const futureIso = new Date(Date.now() + 60_000).toISOString();
  store.data.invoices.set('inv-3', {
    id: 'inv-3', tenantId: 't1', uploadState: 'UPLOAD_PENDING',
    lifecycleState: 'UPLOAD_PENDING', attempts: 1, nextRetryAt: futureIso,
    invoiceNumber: 'SANDBOX-3', amount: 100,
  });
  const changed = await tickInvoiceUpload(store);
  assert.equal(changed, false, 'should not pick up backoff-deferred invoices');
});

test('invoice tick dead-letters after INVOICE_MAX_ATTEMPTS', async () => {
  const store = makeStore();
  store.data.invoices.set('inv-4', {
    id: 'inv-4', tenantId: 't1', uploadState: 'UPLOAD_PENDING',
    lifecycleState: 'UPLOAD_PENDING', attempts: 6, invoiceNumber: 'SANDBOX-4', amount: 100,
  });
  const changed = await tickInvoiceUpload(store);
  assert.equal(changed, true);
  const inv = store.data.invoices.get('inv-4');
  assert.equal(inv.uploadState, 'DEAD_LETTER');
  assert.equal(inv.lastErrorCode, 'RETRY_LIMIT_EXCEEDED');
  const audit = store.data.auditLogs.find((r) => r.action === 'INVOICE_UPLOAD_DEAD_LETTER');
  assert.ok(audit, 'dead-letter audit missing');
});
