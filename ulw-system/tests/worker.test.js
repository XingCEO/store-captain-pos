'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tickOutbox } = require('../src/core/syncWorker');

function makeStore() {
  // Minimal Store-like shape
  return {
    data: {
      outboxJobs: new Map(),
      auditLogs: [],
      storeSettings: new Map(),
    },
  };
}

test('outbox PENDING advances to IN_FLIGHT then DONE', () => {
  const store = makeStore();
  store.data.outboxJobs.set('job-1', { id: 'job-1', tenantId: 't1', state: 'PENDING', attempts: 0 });
  store.data.storeSettings.set('t1:store-001', { autoCompleteOutbox: true });

  tickOutbox(store);
  let job = store.data.outboxJobs.get('job-1');
  assert.equal(job.state, 'IN_FLIGHT');
  assert.equal(job.attempts, 1);

  tickOutbox(store);
  job = store.data.outboxJobs.get('job-1');
  assert.equal(job.state, 'DONE');
});

test('outbox transitions to DEAD_LETTER at MAX_ATTEMPTS', () => {
  const store = makeStore();
  // Already at 5 attempts; next tick should hit MAX_ATTEMPTS=6 and dead-letter
  store.data.outboxJobs.set('job-2', { id: 'job-2', tenantId: 't1', state: 'IN_FLIGHT', attempts: 5, storeId: 'store-001' });
  store.data.storeSettings.set('t1:store-001', { autoCompleteOutbox: false });

  tickOutbox(store);
  const job = store.data.outboxJobs.get('job-2');
  assert.equal(job.state, 'DEAD_LETTER');
  assert.equal(job.attempts, 6);
  const audit = store.data.auditLogs.find((row) => row.action === 'OUTBOX_DEAD_LETTER');
  assert.ok(audit, 'DEAD_LETTER audit row missing');
});

test('outbox retryable state recorded when autoComplete is false', () => {
  const store = makeStore();
  store.data.outboxJobs.set('job-3', { id: 'job-3', tenantId: 't1', state: 'IN_FLIGHT', attempts: 1, storeId: 'store-001' });
  store.data.storeSettings.set('t1:store-001', { autoCompleteOutbox: false });
  tickOutbox(store);
  const job = store.data.outboxJobs.get('job-3');
  assert.equal(job.state, 'RETRYABLE_ERROR');
});
