'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const metrics = require('./metrics');

const SCHEMA_VERSION = 2;

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'store.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      actor TEXT,
      user_id TEXT,
      user_role TEXT,
      before_json TEXT,
      after_json TEXT,
      ip TEXT,
      device_id TEXT,
      user_agent TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_logs_tenant_idx ON audit_logs(tenant_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_tenant_action_idx ON audit_logs(tenant_id, action, timestamp DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_tenant_resource_idx ON audit_logs(tenant_id, resource_type, timestamp DESC);
  `);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!row) {
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  } else if (Number(row.value) < SCHEMA_VERSION) {
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
  }
}

function timed(label, fn) {
  const start = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    try {
      const dur = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.dbQueryDuration.observe({ statement: label }, dur);
    } catch {}
  }
}

function loadSnapshot(db) {
  return timed('load_snapshot', () => {
    const out = { maps: {}, counters: null, savedAt: null };
    const rows = db.prepare('SELECT name, value FROM state').all();
    for (const r of rows) {
      if (r.name === '__counters__') {
        try { out.counters = JSON.parse(r.value); } catch { out.counters = null; }
      } else if (r.name === '__auditLogs__') {
        // Legacy v1 snapshot — auditLogs was stored as a blob. Surface so the
        // caller can migrate them into the audit_logs table on first load.
        try { out.legacyAuditLogs = JSON.parse(r.value); } catch { out.legacyAuditLogs = []; }
      } else {
        try { out.maps[r.name] = JSON.parse(r.value); } catch { out.maps[r.name] = []; }
      }
    }
    const savedAt = db.prepare('SELECT value FROM meta WHERE key = ?').get('saved_at');
    out.savedAt = savedAt ? savedAt.value : null;
    return out;
  });
}

function persistSnapshot(db, { maps, counters }) {
  return timed('persist_snapshot', () => {
    const upsert = db.prepare(`
      INSERT INTO state(name, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const upsertMeta = db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const deleteLegacy = db.prepare('DELETE FROM state WHERE name = ?');
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const [name, entries] of Object.entries(maps)) {
        upsert.run(name, JSON.stringify(entries), now);
      }
      upsert.run('__counters__', JSON.stringify(counters), now);
      deleteLegacy.run('__auditLogs__'); // migrate-away: no longer stored as blob
      upsertMeta.run('saved_at', now);
    });
    tx();
  });
}

function appendAuditLog(db, row) {
  return timed('audit_insert', () => {
    const stmt = db.prepare(`
      INSERT INTO audit_logs(tenant_id, action, resource_type, resource_id, actor, user_id, user_role, before_json, after_json, ip, device_id, user_agent, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.tenantId || null,
      row.action,
      row.resourceType || null,
      row.resourceId || null,
      row.actor || null,
      row.userId || null,
      row.userRole || null,
      row.before == null ? null : JSON.stringify(row.before),
      row.after == null ? null : JSON.stringify(row.after),
      row.ip || null,
      row.deviceId || null,
      row.userAgent || null,
      row.timestamp,
    );
  });
}

function queryAuditLogs(db, { tenantId, action, resourceType, page = 1, pageSize = 20 }) {
  return timed('audit_query', () => {
    const where = ['tenant_id = ?'];
    const args = [tenantId];
    if (action) { where.push('action = ?'); args.push(action); }
    if (resourceType) { where.push('resource_type = ?'); args.push(resourceType); }
    const whereSql = where.join(' AND ');
    const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${whereSql}`);
    const total = countStmt.get(...args).n;
    const offset = (page - 1) * pageSize;
    const rows = db.prepare(`
      SELECT id, tenant_id AS tenantId, action, resource_type AS resourceType, resource_id AS resourceId,
             actor, user_id AS userId, user_role AS userRole, before_json AS beforeJson, after_json AS afterJson,
             ip, device_id AS deviceId, user_agent AS userAgent, timestamp
      FROM audit_logs WHERE ${whereSql}
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...args, pageSize, offset).map((r) => ({
      ...r,
      before: r.beforeJson ? JSON.parse(r.beforeJson) : null,
      after:  r.afterJson  ? JSON.parse(r.afterJson)  : null,
      beforeJson: undefined, afterJson: undefined,
    }));
    return { items: rows, total };
  });
}

function closeDatabase(db) {
  try { db.close(); } catch { /* already closed */ }
}

module.exports = {
  openDatabase, loadSnapshot, persistSnapshot,
  appendAuditLog, queryAuditLogs,
  closeDatabase, SCHEMA_VERSION,
};
