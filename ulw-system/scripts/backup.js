#!/usr/bin/env node
'use strict';

// SQLite backup using `VACUUM INTO`. Produces a hot-consistent snapshot
// without blocking writers. Retention prunes oldest beyond MAX_KEEP.
//
// Usage:
//   node scripts/backup.js                # writes to ../data/backups/
//   BACKUP_DIR=/path/to/dir node scripts/backup.js
//
// TODO(infra-todo #23): after producing the snapshot, upload to S3-compatible
// storage. Not implemented here because credentials live in an external
// secrets manager we don't have access to from this PoC.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MAX_KEEP = Number(process.env.BACKUP_KEEP || 10);
const dataDir = path.resolve(__dirname, '..', 'data');
const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');
const sourceDb = path.join(dataDir, 'store.db');

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function main() {
  if (!fs.existsSync(sourceDb)) {
    console.error(`source db not found: ${sourceDb}`);
    process.exit(2);
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `store-${ts()}.db`);
  const db = new Database(sourceDb, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  console.log(`backup -> ${target}`);

  // Retention
  const existing = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith('store-') && f.endsWith('.db'))
    .map((f) => ({ name: f, path: path.join(backupDir, f), mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of existing.slice(MAX_KEEP)) {
    fs.unlinkSync(old.path);
    console.log(`pruned -> ${old.name}`);
  }
}

if (require.main === module) main();
module.exports = { main };
