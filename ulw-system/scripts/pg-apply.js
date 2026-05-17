#!/usr/bin/env node
'use strict';

// Apply generated drizzle schema + RLS policies to the Postgres instance
// pointed at by DATABASE_URL or PG_URL. Idempotent: each migration file is
// applied inside a transaction; failure on existing objects (e.g. duplicate
// CREATE) aborts that file without partial state.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const URL = process.env.DATABASE_URL || process.env.PG_URL;
if (!URL) {
  console.error('DATABASE_URL or PG_URL must be set');
  process.exit(2);
}

async function main() {
  const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (!files.length) {
    console.error('no migration files found at', migrationsDir);
    process.exit(2);
  }

  const c = new Client({ connectionString: URL });
  await c.connect();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    console.log(`[pg-apply] ${f}`);
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      // RLS file uses DO blocks that may throw on "policy already exists" —
      // surface but do not abort the remaining files.
      console.warn(`[pg-apply] ${f} failed: ${err.message}`);
    }
  }
  const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  console.log(`[pg-apply] tables (${tables.length}):`, tables.map((t) => t.tablename).join(', '));
  const policies = (await c.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public'")).rows[0].n;
  console.log(`[pg-apply] policies: ${policies}`);
  await c.end();
}

main().catch((err) => { console.error('[pg-apply] fatal:', err.message); process.exit(1); });
