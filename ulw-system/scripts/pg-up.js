#!/usr/bin/env node
'use strict';

// Provision a local embedded Postgres instance for development + testing.
// Uses the `embedded-postgres` package which downloads + manages a real
// Postgres binary; no Docker, no admin install required.
//
// CLI:
//   node scripts/pg-up.js [--port=5433] [--password=postgres] [--data=./data/pg]
//
// Idempotent: re-running keeps existing data. Emits PG connection URL on
// stdout for downstream tooling.

const path = require('path');
const fs = require('fs');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const PORT = Number(args.port || process.env.PG_PORT || 5433);
const PASSWORD = String(args.password || process.env.PG_PASSWORD || 'ulw_local');
const USER = String(args.user || process.env.PG_USER || 'postgres');
const DB = String(args.db || process.env.PG_DB || 'ulw');
const DATA = path.resolve(args.data || path.join(__dirname, '..', 'data', 'pg'));

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  // Lazy require so the script still parses even if dep missing
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pg = new EmbeddedPostgres({
    databaseDir: DATA,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  });

  const initialized = fs.existsSync(path.join(DATA, 'postgresql.conf'));
  if (!initialized) {
    console.log('[pg-up] initialising cluster at', DATA);
    await pg.initialise();
  } else {
    console.log('[pg-up] cluster exists at', DATA);
  }
  await pg.start();
  console.log('[pg-up] postgres running on port', PORT);

  // Ensure target DB exists
  try {
    await pg.createDatabase(DB);
    console.log('[pg-up] database created:', DB);
  } catch (err) {
    if (/already exists/i.test(err.message)) {
      console.log('[pg-up] database already exists:', DB);
    } else {
      throw err;
    }
  }

  const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}`;
  console.log('[pg-up] DATABASE_URL=' + url);

  // Detach: keep the embedded server running until SIGINT.
  process.on('SIGINT',  () => pg.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => pg.stop().then(() => process.exit(0)));
  // Print sentinel so callers can grep for readiness
  console.log('[pg-up] ready');
}

main().catch((err) => { console.error('[pg-up] failed:', err); process.exit(1); });
