'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tickOutbox, tickTelemetry } = require('../src/core/syncWorker');

function makeStore() {
  // Minimal Store-like shape
  return {
    data: {
      outboxJobs: new Map(),
      auditLogs: [],
      storeSettings: new Map(),
      telemetrySnapshots: new Map(),
    },
  };
}

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

test('outbox PENDING advances to IN_FLIGHT then RETRYABLE_ERROR by default', () => {
  const store = makeStore();
  store.data.outboxJobs.set('job-1', { id: 'job-1', tenantId: 't1', state: 'PENDING', attempts: 0 });

  tickOutbox(store);
  let job = store.data.outboxJobs.get('job-1');
  assert.equal(job.state, 'IN_FLIGHT');
  assert.equal(job.attempts, 1);

  tickOutbox(store);
  job = store.data.outboxJobs.get('job-1');
  assert.equal(job.state, 'RETRYABLE_ERROR');
});

test('outbox can be auto-completed only when store setting explicitly allows it', () => {
  const store = makeStore();
  store.data.outboxJobs.set('job-4', { id: 'job-4', tenantId: 't1', state: 'IN_FLIGHT', attempts: 1, storeId: 'store-001' });
  store.data.storeSettings.set('t1:store-001', { autoCompleteOutbox: true });
  tickOutbox(store);
  const job = store.data.outboxJobs.get('job-4');
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

test('telemetry: a fresh heartbeat stays OK (not instantly UNREACHABLE)', () => {
  // Regression: the tick used to read snap.lastSeenAt (never written), so age
  // was ~now and every snapshot was flagged UNREACHABLE on the first tick.
  const store = makeStore();
  store.data.telemetrySnapshots.set('t1:term-1', { tenantId: 't1', terminalId: 'term-1', state: 'OK', receivedAt: isoAgo(10 * 1000) });
  const changed = tickTelemetry(store);
  assert.equal(store.data.telemetrySnapshots.get('t1:term-1').state, 'OK');
  assert.equal(changed, false);
});

test('telemetry: a stale terminal (>5min) is flagged UNREACHABLE with one audit row', () => {
  const store = makeStore();
  store.data.telemetrySnapshots.set('t1:term-2', { tenantId: 't1', terminalId: 'term-2', state: 'OK', receivedAt: isoAgo(6 * 60 * 1000) });
  tickTelemetry(store);
  assert.equal(store.data.telemetrySnapshots.get('t1:term-2').state, 'UNREACHABLE');
  const audit = store.data.auditLogs.filter((row) => row.action === 'TELEMETRY_UNREACHABLE');
  assert.equal(audit.length, 1, 'exactly one unreachable alert');
  // Idempotent: a second tick must not re-alert (alertedAt gate).
  tickTelemetry(store);
  assert.equal(store.data.auditLogs.filter((row) => row.action === 'TELEMETRY_UNREACHABLE').length, 1);
});

test('telemetry: an UNREACHABLE terminal recovers to OK after a recent heartbeat', () => {
  const store = makeStore();
  store.data.telemetrySnapshots.set('t1:term-3', { tenantId: 't1', terminalId: 'term-3', state: 'UNREACHABLE', alertedAt: isoAgo(10 * 60 * 1000), receivedAt: isoAgo(5 * 1000) });
  const changed = tickTelemetry(store);
  assert.equal(store.data.telemetrySnapshots.get('t1:term-3').state, 'OK');
  assert.equal(changed, true);
});
