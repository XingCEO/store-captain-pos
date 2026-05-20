'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const metrics = require('./metrics');

const SCHEMA_VERSION = 4;

function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'store.db');
  const db = new Database(file);
  // Restrict file mode on POSIX so the DB (which holds session tokens, PIN
  // hashes, MFA secrets, PII) isn't world-readable. Windows ACLs require
  // a separate install-time icacls step.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    // Lock the WAL companion files when they exist.
    for (const suffix of ['-wal', '-shm']) {
      try { fs.chmodSync(`${file}${suffix}`, 0o600); } catch { /* may not yet exist */ }
    }
  }
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
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      tenant_id TEXT,
      namespace TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idempotency_created_idx ON idempotency_keys(created_at);
    CREATE INDEX IF NOT EXISTS idempotency_tenant_idx ON idempotency_keys(tenant_id);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      store_id TEXT,
      payload_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS auth_sessions_tenant_idx ON auth_sessions(tenant_id);
    CREATE TABLE IF NOT EXISTS entities (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      tenant_id TEXT,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS entities_collection_tenant_idx ON entities(collection, tenant_id);
  `);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  const prev = row ? Number(row.value) : 0;
  if (!row) {
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  } else if (prev < SCHEMA_VERSION) {
    // v2 → v3: idempotency + sessions moved out of the snapshot blob into
    // their own indexed tables. Clear the stale blob copies on first boot
    // so we don't double-hydrate from snapshot + table.
    if (prev < 3) {
      db.prepare("DELETE FROM state WHERE name IN ('idempotency', 'orderIdempotency', 'sessions', 'refreshTokens')").run();
    }
    // v3 → v4: operational collections move out of the per-collection JSON
    // snapshot blobs in `state` into row-level `entities`, so persist() writes
    // only changed rows instead of rewriting every collection. Migrate each
    // remaining blob (anything that isn't a `__special__` key) into entities,
    // then drop the blob. `__counters__` stays in `state`.
    if (prev < 4) {
      migrateSnapshotBlobsToEntities(db);
    }
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
  }
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// One-time v3 → v4 data move: each `state` blob (a JSON array of [id, obj]
// entries written by the old persistSnapshot) becomes individual rows in
// `entities`. `__counters__` / `__auditLogs__` are not collections and stay put
// (auditLogs is handled separately on load). Idempotent: re-running upserts.
function migrateSnapshotBlobsToEntities(db) {
  const SPECIAL = new Set(['__counters__', '__auditLogs__']);
  const stateRows = db.prepare('SELECT name, value FROM state').all();
  const insert = db.prepare(`
    INSERT INTO entities(collection, id, tenant_id, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(collection, id) DO UPDATE SET
      tenant_id = excluded.tenant_id, data_json = excluded.data_json, updated_at = excluded.updated_at
  `);
  const dropBlob = db.prepare('DELETE FROM state WHERE name = ?');
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    let migrated = 0;
    for (const r of stateRows) {
      if (SPECIAL.has(r.name)) continue;
      const entries = safeParseJson(r.value);
      if (!Array.isArray(entries)) continue;
      for (const [id, obj] of entries) {
        const tenantId = obj && typeof obj === 'object' ? (obj.tenantId || null) : null;
        insert.run(r.name, String(id), tenantId, JSON.stringify(obj), now);
        migrated += 1;
      }
      dropBlob.run(r.name);
    }
    return migrated;
  });
  tx();
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

function insertAuditRows(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO audit_logs(tenant_id, action, resource_type, resource_id, actor, user_id, user_role, before_json, after_json, ip, device_id, user_agent, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
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
  }
}

function persistSnapshot(db, { maps, counters, auditRows = [] }) {
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
      insertAuditRows(db, auditRows);
      upsertMeta.run('saved_at', now);
    });
    tx();
  });
}

// Hydrate one operational collection from row-level storage (replaces reading
// a per-collection blob out of the snapshot).
function entityList(db, collection) {
  return timed('entity_list', () => {
    const rows = db.prepare('SELECT id, data_json FROM entities WHERE collection = ?').all(collection);
    return rows.map((r) => [r.id, safeParseJson(r.data_json)]);
  });
}

// Phase B persist: write ONLY the changed rows for each collection (plus the
// counters blob and any buffered audit rows) inside a single transaction.
// `changes` = [{ collection, upserts: [[id, obj]], deletes: [id] }]. This keeps
// the same response-time atomicity the old full-snapshot path had, without
// rewriting unchanged rows.
function persistEntities(db, { changes = [], counters, auditRows = [] }) {
  return timed('persist_entities', () => {
    const up = db.prepare(`
      INSERT INTO entities(collection, id, tenant_id, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET
        tenant_id = excluded.tenant_id, data_json = excluded.data_json, updated_at = excluded.updated_at
    `);
    const del = db.prepare('DELETE FROM entities WHERE collection = ? AND id = ?');
    const upsertMeta = db.prepare(`
      INSERT INTO state(name, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const upsertMetaTable = db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const { collection, upserts = [], deletes = [] } of changes) {
        for (const [id, obj] of upserts) {
          const tenantId = obj && typeof obj === 'object' ? (obj.tenantId || null) : null;
          up.run(collection, String(id), tenantId, JSON.stringify(obj), now);
        }
        for (const id of deletes) del.run(collection, String(id));
      }
      upsertMeta.run('__counters__', JSON.stringify(counters), now);
      insertAuditRows(db, auditRows);
      upsertMetaTable.run('saved_at', now);
    });
    tx();
  });
}

function appendAuditLog(db, row) {
  return timed('audit_insert', () => {
    insertAuditRows(db, [row]);
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

// ---------------------------------------------------------------------------
// Idempotency-key store (SQLite-backed, indexed, TTL-pruneable)
// ---------------------------------------------------------------------------
function idempotencyGet(db, key) {
  return timed('idempotency_get', () => {
    const row = db.prepare('SELECT fingerprint, response_json, created_at FROM idempotency_keys WHERE key = ?').get(key);
    if (!row) return undefined;
    try {
      return { fingerprint: row.fingerprint, response: JSON.parse(row.response_json), createdAt: new Date(row.created_at).toISOString() };
    } catch { return undefined; }
  });
}
function idempotencyPut(db, key, value, { tenantId = null, namespace = 'default' } = {}) {
  return timed('idempotency_put', () => {
    db.prepare(`
      INSERT INTO idempotency_keys(key, tenant_id, namespace, fingerprint, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        response_json = excluded.response_json,
        created_at = excluded.created_at
    `).run(key, tenantId, namespace, value.fingerprint, JSON.stringify(value.response || value), Date.now());
  });
}
function idempotencyDelete(db, key) {
  return timed('idempotency_delete', () => {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
  });
}
function idempotencyPrune(db, ttlMs) {
  return timed('idempotency_prune', () => {
    const cutoff = Date.now() - ttlMs;
    const result = db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff);
    return result.changes;
  });
}

// ---------------------------------------------------------------------------
// Session store (SQLite-backed, indexed, TTL-pruneable, multi-worker safe)
// ---------------------------------------------------------------------------
function sessionGet(db, tokenHash) {
  return timed('session_get', () => {
    const row = db.prepare('SELECT payload_json, expires_at FROM auth_sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) {
      db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
      return undefined;
    }
    try { return JSON.parse(row.payload_json); } catch { return undefined; }
  });
}
function sessionPut(db, tokenHash, session) {
  return timed('session_put', () => {
    const expiresAt = new Date(session.expiresAt).getTime();
    // Refresh-token records do not carry a role — coalesce so the NOT NULL
    // constraint is satisfied and the row stays distinguishable from a true
    // session row (which always has user_role like CASHIER / MANAGER / etc).
    db.prepare(`
      INSERT INTO auth_sessions(token_hash, tenant_id, user_id, role, store_id, payload_json, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at
    `).run(
      tokenHash,
      session.tenantId || 'unknown',
      session.userId || 'unknown',
      session.role || 'REFRESH',
      session.storeId || null,
      JSON.stringify(session),
      expiresAt,
      Date.now(),
    );
  });
}
function sessionDelete(db, tokenHash) {
  return timed('session_delete', () => {
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  });
}
function sessionPrune(db) {
  return timed('session_prune', () => {
    const result = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    return result.changes;
  });
}
function sessionCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n;
}

module.exports = {
  openDatabase, loadSnapshot, persistSnapshot,
  entityList, persistEntities,
  appendAuditLog, queryAuditLogs,
  closeDatabase, SCHEMA_VERSION,
  idempotencyGet, idempotencyPut, idempotencyDelete, idempotencyPrune,
  sessionGet, sessionPut, sessionDelete, sessionPrune, sessionCount,
};
