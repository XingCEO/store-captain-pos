'use strict';

// Background workers: outbox sync + telemetry staleness detection + DRAFT order expiry.
// Guard: set DISABLE_BACKGROUND_WORKERS=1 to skip (used by tests).

const { logger } = require('./logger');
const metrics = require('./metrics');

const OUTBOX_INTERVAL_MS = 10_000;   // 10 s
const TELEMETRY_INTERVAL_MS = 30_000; // 30 s
const DRAFT_EXPIRY_INTERVAL_MS = 60_000; // 60 s
const DRAFT_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 h
const TELEMETRY_UNREACHABLE_MS = 5 * 60 * 1000; // 5 min
const TELEMETRY_RECOVERED_MS = 2 * 60 * 1000;   // 2 min
const MAX_ATTEMPTS = 6;

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

  for (const [key, job] of store.data.outboxJobs.entries()) {
    const { state } = job;

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

      // Read autoCompleteOutbox from storeSettings; default true for demo
      const settingsKey = job.storeId ? `${job.tenantId}:${job.storeId}` : null;
      const settings = settingsKey ? store.data.storeSettings.get(settingsKey) : null;
      const autoComplete = settings && typeof settings.autoCompleteOutbox === 'boolean'
        ? settings.autoCompleteOutbox
        : true;

      const nextState = autoComplete ? 'DONE' : 'RETRYABLE_ERROR';
      const next = { ...job, state: nextState, attempts, lastTriedAt: nowIso() };
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
    const age = now - (snap.lastSeenAt || 0);
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

  function stop() {
    clearInterval(outboxTimer);
    clearInterval(telemetryTimer);
    clearInterval(draftTimer);
    logger.info('syncWorker stopped');
  }

  return { stop };
}

module.exports = { start, tickOutbox, tickTelemetry, tickDraftExpiry };
