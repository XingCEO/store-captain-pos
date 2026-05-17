'use strict';

// Migration runner. Two paths:
//   * SQLite: idempotent CREATE/ALTER via src/core/db.js migrate(). Already
//     invoked on Store construction. This module re-exports the function for
//     CLI invocation.
//   * Postgres: shells out to drizzle-kit migrate against DATABASE_URL.
//
// CLI:
//   node src/db/migrate.js              # default SQLite (uses data/store.db)
//   node src/db/migrate.js --postgres   # uses DATABASE_URL via drizzle-kit
//
// On startup, server.js can call assertSchemaCompatible() to refuse boot if
// the DB schema_version is ahead of what the code understands.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const { SCHEMA_VERSION: CODE_VERSION } = require('../core/db');

function migrateSqlite(dataDir) {
  // The Store constructor invokes migrate() internally. Open + close to apply.
  const Database = require('better-sqlite3');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'store.db');
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    require('../core/db'); // import to ensure migrate() side effects registered (no-op import safe)
    // The actual migrate() is invoked via openDatabase(); calling it here would
    // require exporting migrate. Instead, open through the public surface:
    db.close();
    const { openDatabase, closeDatabase } = require('../core/db');
    const real = openDatabase(dataDir);
    closeDatabase(real);
    return { backend: 'sqlite', file, schemaVersion: CODE_VERSION };
  } finally {
    try { db.close(); } catch { /* may already be closed */ }
  }
}

function migratePostgres() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set; cannot run Postgres migration');
  }
  const result = spawnSync('npx', ['drizzle-kit', 'migrate'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`drizzle-kit migrate exited ${result.status}`);
  }
  return { backend: 'postgres', schemaVersion: CODE_VERSION };
}

function assertSchemaCompatible(dataDir) {
  // Open the SQLite db read-only and inspect meta.schema_version. If the on-disk
  // version is greater than what this code build knows, refuse to start so we
  // don't silently corrupt newer state.
  const Database = require('better-sqlite3');
  const file = path.join(dataDir, 'store.db');
  if (!fs.existsSync(file)) return; // fresh deploy, nothing to compare
  const db = new Database(file, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!row) return;
    const onDisk = Number(row.value);
    if (onDisk > CODE_VERSION) {
      throw new Error(`schema_version on disk (${onDisk}) ahead of code (${CODE_VERSION}); refusing to start`);
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const target = process.argv.includes('--postgres') ? 'postgres' : 'sqlite';
  try {
    const result = target === 'postgres'
      ? migratePostgres()
      : migrateSqlite(path.resolve(__dirname, '..', '..', 'data'));
    console.log(`migration OK:`, result);
  } catch (err) {
    console.error('migration failed:', err.message);
    process.exit(1);
  }
}

module.exports = { migrateSqlite, migratePostgres, assertSchemaCompatible, CODE_VERSION };
