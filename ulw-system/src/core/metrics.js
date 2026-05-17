'use strict';

const client = require('prom-client');

const register = new client.Registry();
register.setDefaultLabels({ svc: 'ulw-system' });
client.collectDefaultMetrics({ register, prefix: 'ulw_' });

const httpRequestsTotal = new client.Counter({
  name: 'ulw_http_requests_total',
  help: 'HTTP requests handled by ulw-system',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const ordersCreatedTotal = new client.Counter({
  name: 'ulw_orders_created_total',
  help: 'POS orders created (excludes idempotent replays)',
  labelNames: ['tenant_id', 'store_id'],
  registers: [register],
});

const paymentsTotal = new client.Counter({
  name: 'ulw_payments_total',
  help: 'Payment events captured',
  labelNames: ['method', 'status'],
  registers: [register],
});

const idempotencyReplaysTotal = new client.Counter({
  name: 'ulw_idempotency_replays_total',
  help: 'Idempotent requests replayed from cache',
  labelNames: ['namespace'],
  registers: [register],
});

const outboxJobsTotal = new client.Counter({
  name: 'ulw_outbox_jobs_total',
  help: 'Outbox job state transitions',
  labelNames: ['state'],
  registers: [register],
});

const outboxDeadLetterTotal = new client.Counter({
  name: 'ulw_outbox_dead_letter_total',
  help: 'Outbox jobs moved to DEAD_LETTER',
  registers: [register],
});

const auditLogsTotal = new client.Counter({
  name: 'ulw_audit_logs_total',
  help: 'Audit rows written',
  labelNames: ['action'],
  registers: [register],
});

const dbQueryDuration = new client.Histogram({
  name: 'ulw_db_query_duration_seconds',
  help: 'SQLite query duration in seconds',
  labelNames: ['statement'],
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

const rateLimitRejectsTotal = new client.Counter({
  name: 'ulw_rate_limit_rejects_total',
  help: 'Requests rejected by rate limiter',
  labelNames: ['bucket'],
  registers: [register],
});

const outboxPending = new client.Gauge({
  name: 'ulw_outbox_pending_jobs',
  help: 'Outbox jobs currently in PENDING or IN_FLIGHT state',
  registers: [register],
});

const telemetryUnreachable = new client.Gauge({
  name: 'ulw_telemetry_unreachable_snapshots',
  help: 'Telemetry snapshots currently marked UNREACHABLE',
  registers: [register],
});

function sampleGauges(store) {
  if (!store || !store.data) return;
  let pending = 0;
  for (const job of store.data.outboxJobs.values()) {
    if (job.state === 'PENDING' || job.state === 'IN_FLIGHT') pending += 1;
  }
  outboxPending.set(pending);

  let unreachable = 0;
  for (const snap of store.data.telemetrySnapshots.values()) {
    if (snap.state === 'UNREACHABLE') unreachable += 1;
  }
  telemetryUnreachable.set(unreachable);
}

async function renderMetrics() {
  return register.metrics();
}

function contentType() {
  return register.contentType;
}

function resetForTests() {
  register.resetMetrics();
}

module.exports = {
  register,
  httpRequestsTotal,
  ordersCreatedTotal,
  paymentsTotal,
  idempotencyReplaysTotal,
  outboxJobsTotal,
  outboxDeadLetterTotal,
  auditLogsTotal,
  outboxPending,
  telemetryUnreachable,
  dbQueryDuration,
  rateLimitRejectsTotal,
  sampleGauges,
  renderMetrics,
  contentType,
  resetForTests,
};
