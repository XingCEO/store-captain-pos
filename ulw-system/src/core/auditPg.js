'use strict';

// Postgres-backed audit_logs writer/reader. Each operation opens a tx and
// sets `app.tenant_id` so the RLS policies in migrations/0001_rls.sql apply.
//
// Activation: AUDIT_BACKEND=pg + AUDIT_PG_URL=postgres://… (or PG_URL).
// The pool is lazy-initialised on first use; if the URL is missing the
// runtime keeps using the SQLite audit table.

const { logger } = require('./logger');
const metrics = require('./metrics');

let pool = null;
let initFailed = false;

function getPool() {
  if (pool || initFailed) return pool;
  const url = process.env.AUDIT_PG_URL || process.env.PG_URL || process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.AUDIT_PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => logger.error({ err: err.message }, 'audit pg pool error'));
    logger.info({ url: maskUrl(url) }, 'audit pg pool initialised');
  } catch (err) {
    initFailed = true;
    logger.warn({ err: err.message }, 'audit pg init failed; falling back to SQLite');
  }
  return pool;
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch { return '***'; }
}

function isEnabled() {
  return process.env.AUDIT_BACKEND === 'pg' && Boolean(getPool());
}

async function withTenantTx(tenantId, fn) {
  const p = getPool();
  if (!p) throw new Error('audit pg pool not initialised');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection dead */ }
    throw err;
  } finally {
    client.release();
  }
}

let auditSeq = 0;
function generateAuditId() {
  auditSeq = (auditSeq + 1) % 1_000_000;
  return `aud-${Date.now().toString(36)}-${process.pid.toString(36)}-${auditSeq.toString(36)}`;
}

// Track outstanding mirror writes so close() can await them and tests can
// flush deterministically without sleeping.
const pendingWrites = new Set();
function track(promise) {
  pendingWrites.add(promise);
  promise.finally(() => pendingWrites.delete(promise));
  return promise;
}
async function drain() {
  while (pendingWrites.size) {
    const snap = Array.from(pendingWrites);
    await Promise.allSettled(snap);
  }
}

async function appendAuditLog(row) {
  if (!isEnabled()) return;
  const tStart = process.hrtime.bigint();
  try {
    await withTenantTx(row.tenantId, async (client) => {
      await client.query(`
        INSERT INTO audit_logs(id, tenant_id, action, resource_type, resource_id, actor, user_id, user_role, "before", "after", ip, device_id, user_agent, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        row.id || generateAuditId(),
        row.tenantId || null,
        row.action,
        row.resourceType || 'unknown',
        row.resourceId || null,
        row.actor || row.userId || null,
        row.userId || null,
        row.userRole || null,
        row.before == null ? null : JSON.stringify(row.before),
        row.after == null ? null : JSON.stringify(row.after),
        row.ip || null,
        row.deviceId || null,
        row.userAgent || null,
        row.timestamp || new Date().toISOString(),
      ]);
    });
    try {
      const dur = Number(process.hrtime.bigint() - tStart) / 1e9;
      metrics.dbQueryDuration.observe({ statement: 'audit_pg_insert' }, dur);
      metrics.auditLogsTotal.inc({ action: row.action });
    } catch { /* metric optional */ }
  } catch (err) {
    logger.error({ err: err.message, action: row.action }, 'audit pg insert failed');
    throw err;
  }
}

async function appendAuditLogs(rows) {
  if (!rows.length) return;
  const byTenant = new Map();
  for (const r of rows) {
    const key = r.tenantId || '__notenant__';
    if (!byTenant.has(key)) byTenant.set(key, []);
    byTenant.get(key).push(r);
  }
  for (const [tenantId, group] of byTenant) {
    const t = tenantId === '__notenant__' ? null : tenantId;
    await withTenantTx(t, async (client) => {
      for (const row of group) {
        await client.query(`
          INSERT INTO audit_logs(id, tenant_id, action, resource_type, resource_id, actor, user_id, user_role, "before", "after", ip, device_id, user_agent, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
          row.id || generateAuditId(),
          row.tenantId || null,
          row.action,
          row.resourceType || 'unknown',
          row.resourceId || null,
          row.actor || row.userId || null,
          row.userId || null,
          row.userRole || null,
          row.before == null ? null : JSON.stringify(row.before),
          row.after == null ? null : JSON.stringify(row.after),
          row.ip || null,
          row.deviceId || null,
          row.userAgent || null,
          row.timestamp || new Date().toISOString(),
        ]);
        try { metrics.auditLogsTotal.inc({ action: row.action }); } catch { /* metric optional */ }
      }
    });
  }
}

async function queryAuditLogs({ tenantId, action, resourceType, page = 1, pageSize = 20 }) {
  if (!isEnabled()) throw new Error('audit pg backend not enabled');
  return withTenantTx(tenantId, async (client) => {
    const where = ['tenant_id = $1'];
    const args = [tenantId];
    if (action)       { args.push(action); where.push(`action = $${args.length}`); }
    if (resourceType) { args.push(resourceType); where.push(`resource_type = $${args.length}`); }
    const whereSql = where.join(' AND ');
    const total = Number((await client.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE ${whereSql}`, args)).rows[0].n);
    const offset = (page - 1) * pageSize;
    args.push(pageSize); args.push(offset);
    const rows = (await client.query(`
      SELECT id, tenant_id AS "tenantId", action,
             resource_type AS "resourceType", resource_id AS "resourceId",
             actor, user_id AS "userId", user_role AS "userRole",
             "before", "after",
             ip, device_id AS "deviceId", user_agent AS "userAgent",
             timestamp
      FROM audit_logs WHERE ${whereSql}
      ORDER BY timestamp DESC, id DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}
    `, args)).rows.map((r) => ({
      ...r,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    }));
    return { items: rows, total };
  });
}

async function close() {
  await drain();
  if (pool) {
    try { await pool.end(); } catch { /* already closed */ }
    pool = null;
  }
}

module.exports = { isEnabled, getPool, appendAuditLog, appendAuditLogs, queryAuditLogs, close, drain, track };
