'use strict';

// Postgres RLS integration test. Runs only when PG_URL is set (and points at a
// migrated database with the 0001_rls.sql policies applied). Otherwise the
// suite reports as a single skipped test so the default `npm test` stays
// infra-free.
//
// To run locally:
//   1. npm run pg:up        # starts embedded postgres on :5433
//   2. npm run pg:migrate   # generates + applies migrations + RLS
//   3. PG_URL=postgres://postgres:ulw_local@127.0.0.1:5433/ulw npm test

const { test } = require('node:test');
const assert = require('node:assert/strict');

const PG_URL = process.env.PG_URL;
if (!PG_URL) {
  test('postgres RLS suite skipped (PG_URL not set)', () => {});
  return;
}

const { Client } = require('pg');

const APP_USER = 'ulw_app_test';
const APP_PASS = 'app_pass_test';

async function withClient(url, fn) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function provisionAppRole() {
  await withClient(PG_URL, async (admin) => {
    try { await admin.query(`CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}' NOBYPASSRLS`); }
    catch (err) { if (!/already exists/.test(err.message)) throw err; }
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_USER}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_USER}`);
    await admin.query("INSERT INTO tenants(id, name) VALUES ('rls-test-A','A'), ('rls-test-B','B') ON CONFLICT DO NOTHING");
  });
}

function appUrl() {
  const u = new URL(PG_URL);
  u.username = APP_USER;
  u.password = APP_PASS;
  return u.toString();
}

test('RLS isolates audit_logs reads per tenant context', async () => {
  await provisionAppRole();
  await withClient(PG_URL, async (admin) => {
    await admin.query("DELETE FROM audit_logs WHERE tenant_id IN ('rls-test-A','rls-test-B')");
    await admin.query(`
      INSERT INTO audit_logs(id, tenant_id, action, resource_type, resource_id, actor, user_id, user_role, timestamp)
      VALUES ('rls-t-a','rls-test-A','ORDER_CREATED','order','o1','sysA','uA','ADMIN', now()),
             ('rls-t-b','rls-test-B','ORDER_CREATED','order','o2','sysB','uB','ADMIN', now())
    `);
  });

  await withClient(appUrl(), async (app) => {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', 'rls-test-A', true)");
    const a = (await app.query('SELECT tenant_id FROM audit_logs WHERE id IN ($1,$2)', ['rls-t-a','rls-t-b'])).rows;
    assert.deepEqual(a.map((r) => r.tenant_id), ['rls-test-A']);
    await app.query('COMMIT');

    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', 'rls-test-B', true)");
    const b = (await app.query('SELECT tenant_id FROM audit_logs WHERE id IN ($1,$2)', ['rls-t-a','rls-t-b'])).rows;
    assert.deepEqual(b.map((r) => r.tenant_id), ['rls-test-B']);
    await app.query('COMMIT');
  });
});

test('RLS hides all rows when no tenant context is set', async () => {
  await provisionAppRole();
  await withClient(appUrl(), async (app) => {
    await app.query('BEGIN');
    const rows = (await app.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id IN ('rls-test-A','rls-test-B')")).rows[0];
    assert.equal(rows.n, 0, 'FORCE ROW LEVEL SECURITY should block when app.tenant_id is unset');
    await app.query('ROLLBACK');
  });
});

test('RLS blocks cross-tenant INSERT via WITH CHECK', async () => {
  await provisionAppRole();
  await withClient(appUrl(), async (app) => {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', 'rls-test-B', true)");
    let blocked = false;
    try {
      await app.query(`
        INSERT INTO audit_logs(id, tenant_id, action, resource_type, resource_id, actor, user_id, user_role, timestamp)
        VALUES ('rls-attack','rls-test-A','FORBIDDEN','x','x','x','x','x', now())
      `);
    } catch (err) {
      blocked = err.code === '42501' && /row-level security/i.test(err.message);
    }
    await app.query('ROLLBACK');
    assert.equal(blocked, true, 'cross-tenant insert must be rejected by RLS WITH CHECK');
  });
});
