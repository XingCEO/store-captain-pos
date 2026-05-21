'use strict';

// Background workers: outbox sync + telemetry staleness detection + DRAFT order expiry.
// Guard: set DISABLE_BACKGROUND_WORKERS=1 to skip (used by tests).

const { logger } = require('./logger');
const metrics = require('./metrics');
const invoiceProvider = require('./invoiceProvider');
const { invoiceTransitionAllowed } = require('../domains/commerce');

const OUTBOX_INTERVAL_MS = 10_000;   // 10 s
const TELEMETRY_INTERVAL_MS = 30_000; // 30 s
const DRAFT_EXPIRY_INTERVAL_MS = 60_000; // 60 s
const INVOICE_UPLOAD_INTERVAL_MS = 20_000; // 20 s
const PRINT_JOB_INTERVAL_MS = 30_000; // 30 s
const DRAFT_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 h
const TELEMETRY_UNREACHABLE_MS = 5 * 60 * 1000; // 5 min
const TELEMETRY_RECOVERED_MS = 2 * 60 * 1000;   // 2 min
const MAX_ATTEMPTS = 6;
const INVOICE_MAX_ATTEMPTS = 6;
const OUTBOX_BASE_BACKOFF_MS = 60_000;        // 1 min
const OUTBOX_MAX_BACKOFF_MS = 30 * 60_000;    // cap 30 min

// Exponential backoff for outbox retries, capped at 30 min. Mirrors the
// invoice-upload + print-job retry cadence so all three workers behave the same.
function outboxBackoffMs(attempts) {
  return Math.min(OUTBOX_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1)), OUTBOX_MAX_BACKOFF_MS);
}

function nowIso() {
  return new Date().toISOString();
}

function workerCtx() {
  return {
    userId: 'system:syncWorker',
    role: 'ADMIN',
    ip: '127.0.0.1',
    deviceId: 'syncWorker',
    userAgent: 'syncWorker/1.0',
  };
}

function pushAudit(store, tenantId, action, resourceType, resourceId, before, after) {
  const ctx = { ...workerCtx(), tenantId };
  store.data.auditLogs.push({
    actor: ctx.userId,
    userId: ctx.userId,
    userRole: ctx.role,
    tenantId,
    action,
    resourceType,
    resourceId,
    before,
    after,
    ip: ctx.ip,
    deviceId: ctx.deviceId,
    userAgent: ctx.userAgent,
    timestamp: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// Outbox tick
// ---------------------------------------------------------------------------
function tickOutbox(store) {
  let changed = false;

  const now = Date.now();

  for (const [key, job] of store.data.outboxJobs.entries()) {
    const { state } = job;

    if (state === 'RETRYABLE_ERROR') {
      // Backoff gate: a failed job waits for nextRetryAt before re-entering
      // flight. Without this the job looped IN_FLIGHT→RETRYABLE_ERROR every
      // tick with no spacing, and (worse) was never re-tried because no branch
      // moved RETRYABLE_ERROR back to IN_FLIGHT.
      if (job.nextRetryAt && new Date(job.nextRetryAt).getTime() > now) continue;
      const next = { ...job, state: 'IN_FLIGHT', lastTriedAt: nowIso() };
      store.data.outboxJobs.set(key, next);
      pushAudit(store, job.tenantId, 'OUTBOX_ADVANCE', 'OUTBOX_JOB', key,
        { state: job.state, attempts: job.attempts || 0 },
        { state: next.state, attempts: next.attempts || 0 });
      metrics.outboxJobsTotal.inc({ state: 'IN_FLIGHT' });
      changed = true;
      continue;
    }

    if (state === 'PENDING') {
      // Advance to IN_FLIGHT
      const next = { ...job, state: 'IN_FLIGHT', lastTriedAt: nowIso(), attempts: (job.attempts || 0) + 1 };
      store.data.outboxJobs.set(key, next);
      pushAudit(store, job.tenantId, 'OUTBOX_ADVANCE', 'OUTBOX_JOB', key,
        { state: job.state, attempts: job.attempts || 0 },
        { state: next.state, attempts: next.attempts });
      metrics.outboxJobsTotal.inc({ state: 'IN_FLIGHT' });
      changed = true;
      continue;
    }

    if (state === 'IN_FLIGHT') {
      const attempts = (job.attempts || 0) + 1;

      if (attempts >= MAX_ATTEMPTS) {
        // Dead-letter
        const next = { ...job, state: 'DEAD_LETTER', attempts, lastTriedAt: nowIso() };
        store.data.outboxJobs.set(key, next);
        pushAudit(store, job.tenantId, 'OUTBOX_DEAD_LETTER', 'OUTBOX_JOB', key,
          { state: job.state, attempts: job.attempts || 0 },
          { state: next.state, attempts: next.attempts });
        metrics.outboxJobsTotal.inc({ state: 'DEAD_LETTER' });
        metrics.outboxDeadLetterTotal.inc();
        changed = true;
        continue;
      }

      // Read autoCompleteOutbox from storeSettings; default false so jobs do not
      // claim cloud sync success without a real upstream adapter.
      const settingsKey = job.storeId ? `${job.tenantId}:${job.storeId}` : null;
      const settings = settingsKey ? store.data.storeSettings.get(settingsKey) : null;
      const autoComplete = settings && typeof settings.autoCompleteOutbox === 'boolean'
        ? settings.autoCompleteOutbox
        : false;

      const nextState = autoComplete ? 'DONE' : 'RETRYABLE_ERROR';
      const next = {
        ...job,
        state: nextState,
        attempts,
        lastTriedAt: nowIso(),
        nextRetryAt: nextState === 'RETRYABLE_ERROR' ? new Date(now + outboxBackoffMs(attempts)).toISOString() : null,
      };
      store.data.outboxJobs.set(key, next);
      pushAudit(store, job.tenantId, `OUTBOX_${nextState}`, 'OUTBOX_JOB', key,
        { state: job.state, attempts: job.attempts || 0 },
        { state: next.state, attempts: next.attempts });
      metrics.outboxJobsTotal.inc({ state: nextState });
      changed = true;
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Telemetry tick
// ---------------------------------------------------------------------------
function tickTelemetry(store) {
  let changed = false;
  const now = Date.now();

  for (const [key, snap] of store.data.telemetrySnapshots.entries()) {
    // Heartbeats stamp `receivedAt` (ISO string); there is no `lastSeenAt`.
    // The old read of `snap.lastSeenAt || 0` made age ≈ now for every snapshot,
    // so terminals were flagged UNREACHABLE immediately and never recovered.
    const last = snap.receivedAt ? new Date(snap.receivedAt).getTime() : 0;
    const age = now - last;
    const currentState = snap.state || 'OK';

    if (age > TELEMETRY_UNREACHABLE_MS && currentState !== 'UNREACHABLE') {
      // Mark unreachable — only if not already alerted
      if (!snap.alertedAt) {
        const next = { ...snap, state: 'UNREACHABLE', alertedAt: nowIso() };
        store.data.telemetrySnapshots.set(key, next);
        // Single support_alert audit entry (deduped via alertedAt gate above)
        store.data.auditLogs.push({
          actor: 'system:syncWorker',
          userId: 'system:syncWorker',
          userRole: 'ADMIN',
          tenantId: snap.tenantId,
          action: 'TELEMETRY_UNREACHABLE',
          resourceType: 'support_alert',
          resourceId: key,
          before: { state: currentState },
          after: { state: 'UNREACHABLE', alertedAt: next.alertedAt },
          ip: '127.0.0.1',
          deviceId: 'syncWorker',
          userAgent: 'syncWorker/1.0',
          timestamp: nowIso(),
        });
        changed = true;
      }
      continue;
    }

    if (age < TELEMETRY_RECOVERED_MS && currentState === 'UNREACHABLE') {
      const next = { ...snap, state: 'OK', alertedAt: null };
      store.data.telemetrySnapshots.set(key, next);
      pushAudit(store, snap.tenantId, 'TELEMETRY_RECOVERED', 'TELEMETRY_SNAPSHOT', key,
        { state: 'UNREACHABLE' },
        { state: 'OK' });
      changed = true;
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Draft expiry tick
// ---------------------------------------------------------------------------
function tickDraftExpiry(store) {
  let changed = false;
  const now = Date.now();

  const globalSettings = store.data.storeSettings.get('global');
  const ageThresholdMs = (globalSettings && globalSettings.draftAgeThresholdMs) || DRAFT_AGE_THRESHOLD_MS;

  for (const [key, order] of store.data.orders.entries()) {
    if (order.state !== 'DRAFT') continue;
    const age = now - new Date(order.createdAt).getTime();
    if (age <= ageThresholdMs) continue;

    const expiredAt = nowIso();
    const next = { ...order, state: 'AUTO_EXPIRED', expiredAt };
    store.data.orders.set(key, next);
    pushAudit(store, order.tenantId, 'DRAFT_AUTO_EXPIRED', 'order', order.id,
      { state: 'DRAFT' },
      { state: 'AUTO_EXPIRED', expiredAt });
    changed = true;
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Invoice upload tick
// ---------------------------------------------------------------------------
// Picks up invoices with uploadState=PENDING_UPLOAD or UPLOAD_PENDING (post
// ISSUED_SANDBOX transition) and calls invoiceProvider.upload(). The provider
// is responsible for the actual 加值中心 round-trip; the worker enforces the
// FSM and dead-letters after INVOICE_MAX_ATTEMPTS retries.
async function tickInvoiceUpload(store) {
  let changed = false;
  const provider = invoiceProvider.active();
  if (!provider) return false;
  const now = Date.now();

  for (const [key, invoice] of store.data.invoices.entries()) {
    if (invoice.uploadState !== 'PENDING_UPLOAD' && invoice.uploadState !== 'UPLOAD_PENDING') continue;
    if (invoice.nextRetryAt && new Date(invoice.nextRetryAt).getTime() > now) continue;
    const attempts = (invoice.attempts || 0) + 1;

    // Step 1: ensure lifecycleState is UPLOAD_PENDING before attempting upload.
    // ISSUED_SANDBOX → UPLOAD_PENDING is a valid forward transition; provider
    // upload() yields UPLOADED / UPLOAD_FAILED from there.
    if (invoice.lifecycleState === 'ISSUED_SANDBOX' && invoiceTransitionAllowed('ISSUED_SANDBOX', 'UPLOAD_PENDING')) {
      const advanced = { ...invoice, lifecycleState: 'UPLOAD_PENDING', updatedAt: nowIso() };
      store.data.invoices.set(key, advanced);
      pushAudit(store, invoice.tenantId, 'INVOICE_LIFECYCLE_ADVANCED', 'INVOICE', invoice.id,
        { lifecycleState: invoice.lifecycleState },
        { lifecycleState: 'UPLOAD_PENDING' });
      changed = true;
      continue; // pick it up next tick to perform the upload
    }

    if (attempts > INVOICE_MAX_ATTEMPTS) {
      const next = { ...invoice, uploadState: 'DEAD_LETTER', attempts, lastErrorCode: 'RETRY_LIMIT_EXCEEDED', updatedAt: nowIso() };
      store.data.invoices.set(key, next);
      pushAudit(store, invoice.tenantId, 'INVOICE_UPLOAD_DEAD_LETTER', 'INVOICE', invoice.id,
        { uploadState: invoice.uploadState, attempts: invoice.attempts || 0 },
        { uploadState: 'DEAD_LETTER', attempts });
      try { metrics.invoiceUploadsTotal && metrics.invoiceUploadsTotal.inc({ state: 'DEAD_LETTER' }); } catch { /* metric optional */ }
      changed = true;
      continue;
    }

    try {
      const result = await provider.upload({
        invoiceId: invoice.id,
        tenantId: invoice.tenantId,
        invoiceNumber: invoice.invoiceNumber,
        amount: invoice.amount,
        attempts,
      });
      if (!invoiceTransitionAllowed(invoice.lifecycleState, result.lifecycleState)) {
        const next = { ...invoice, attempts, lastErrorCode: 'INVOICE_FSM_VIOLATION', updatedAt: nowIso() };
        store.data.invoices.set(key, next);
        changed = true;
        continue;
      }
      const next = { ...invoice, uploadState: result.uploadState, lifecycleState: result.lifecycleState, attempts, ackId: result.ackId || null, lastErrorCode: null, nextRetryAt: null, providerRaw: result.raw || invoice.providerRaw, updatedAt: nowIso() };
      store.data.invoices.set(key, next);
      pushAudit(store, invoice.tenantId, 'INVOICE_UPLOAD_SUCCESS', 'INVOICE', invoice.id,
        { uploadState: invoice.uploadState, lifecycleState: invoice.lifecycleState, attempts: invoice.attempts || 0 },
        { uploadState: next.uploadState, lifecycleState: next.lifecycleState, attempts });
      try { metrics.invoiceUploadsTotal && metrics.invoiceUploadsTotal.inc({ state: 'UPLOADED' }); } catch { /* metric optional */ }
      changed = true;
    } catch (err) {
      const retryable = err.retryable !== false;
      const backoffMs = Math.min(60_000 * Math.pow(2, attempts - 1), 30 * 60_000);
      const next = {
        ...invoice,
        uploadState: 'UPLOAD_FAILED',
        attempts,
        lastErrorCode: err.errorCode || 'INVOICE_UPLOAD_FAILED',
        nextRetryAt: retryable ? new Date(now + backoffMs).toISOString() : null,
        updatedAt: nowIso(),
      };
      store.data.invoices.set(key, next);
      pushAudit(store, invoice.tenantId, 'INVOICE_UPLOAD_FAILED', 'INVOICE', invoice.id,
        { uploadState: invoice.uploadState, attempts: invoice.attempts || 0 },
        { uploadState: 'UPLOAD_FAILED', attempts, errorCode: next.lastErrorCode, retryable });
      try { metrics.invoiceUploadsTotal && metrics.invoiceUploadsTotal.inc({ state: 'UPLOAD_FAILED' }); } catch { /* metric optional */ }
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Print-job retry tick
// ---------------------------------------------------------------------------
function tickPrintJobs(store) {
  let changed = false;
  const now = Date.now();
  for (const [key, job] of store.data.printJobs.entries()) {
    if (job.state !== 'RETRYING') continue;
    if (job.nextRetryAt && new Date(job.nextRetryAt).getTime() > now) continue;
    const attempts = job.attempts || 0;
    if (attempts >= MAX_ATTEMPTS) {
      const next = { ...job, state: 'DEAD_LETTER', updatedAt: nowIso() };
      store.data.printJobs.set(key, next);
      pushAudit(store, job.tenantId, 'PRINT_JOB_RETRY', 'PRINT_JOB', job.id,
        { attempts, state: job.state },
        { attempts, state: 'DEAD_LETTER' });
      changed = true;
      continue;
    }
    const newAttempts = attempts + 1;
    const nextRetryAt = new Date(now + Math.min(60_000 * Math.pow(2, attempts), 30 * 60_000)).toISOString();
    const next = { ...job, state: 'RETRYING', attempts: newAttempts, nextRetryAt, lastTriedAt: nowIso(), updatedAt: nowIso() };
    store.data.printJobs.set(key, next);
    pushAudit(store, job.tenantId, 'PRINT_JOB_RETRY', 'PRINT_JOB', job.id,
      { attempts, state: job.state },
      { attempts: newAttempts, state: 'RETRYING' });
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function start(runtime, options = {}) {
  if (process.env.DISABLE_BACKGROUND_WORKERS === '1') {
    logger.info('syncWorker disabled via DISABLE_BACKGROUND_WORKERS=1');
    return { stop: () => {} };
  }

  const outboxInterval = options.outboxInterval || OUTBOX_INTERVAL_MS;
  const telemetryInterval = options.telemetryInterval || TELEMETRY_INTERVAL_MS;
  const { store } = runtime;

  const globalSettings = store.data.storeSettings.get('global');
  const draftInterval = (globalSettings && globalSettings.draftExpiryIntervalMs) || DRAFT_EXPIRY_INTERVAL_MS;

  logger.info({ outboxInterval, telemetryInterval, draftInterval }, 'syncWorker starting');

  const outboxTimer = setInterval(() => {
    try {
      const changed = tickOutbox(store);
      store.workerLastTickAt = nowIso();
      if (changed) store.persist();
      logger.debug({ changed }, 'syncWorker outbox tick');
    } catch (err) {
      logger.error({ err: err.message }, 'syncWorker outbox tick error');
    }
  }, outboxInterval);

  const telemetryTimer = setInterval(() => {
    try {
      const changed = tickTelemetry(store);
      if (changed) store.persist();
      logger.debug({ changed }, 'syncWorker telemetry tick');
    } catch (err) {
      logger.error({ err: err.message }, 'syncWorker telemetry tick error');
    }
  }, telemetryInterval);

  const draftTimer = setInterval(() => {
    try {
      const changed = tickDraftExpiry(store);
      if (changed) store.persist();
      logger.debug({ changed }, 'syncWorker draft expiry tick');
    } catch (err) {
      logger.error({ err: err.message }, 'syncWorker draft expiry tick error');
    }
  }, draftInterval);

  const invoiceInterval = options.invoiceInterval || INVOICE_UPLOAD_INTERVAL_MS;
  const printJobInterval = options.printJobInterval || PRINT_JOB_INTERVAL_MS;
  const invoiceTimer = setInterval(async () => {
    try {
      const changed = await tickInvoiceUpload(store);
      if (changed) store.persist();
      logger.debug({ changed }, 'syncWorker invoice upload tick');
    } catch (err) {
      logger.error({ err: err.message }, 'syncWorker invoice upload tick error');
    }
  }, invoiceInterval);

  const printJobTimer = setInterval(() => {
    try {
      const changed = tickPrintJobs(store);
      if (changed) store.persist();
      logger.debug({ changed }, 'syncWorker print job retry tick');
    } catch (err) {
      logger.error({ err: err.message }, 'syncWorker print job retry tick error');
    }
  }, printJobInterval);

  function stop() {
    clearInterval(outboxTimer);
    clearInterval(telemetryTimer);
    clearInterval(draftTimer);
    clearInterval(invoiceTimer);
    clearInterval(printJobTimer);
    logger.info('syncWorker stopped');
  }

  return { stop };
}

module.exports = { start, tickOutbox, tickTelemetry, tickDraftExpiry, tickInvoiceUpload, tickPrintJobs };
