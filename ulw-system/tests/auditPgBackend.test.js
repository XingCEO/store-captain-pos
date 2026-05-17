'use strict';

// End-to-end test: with AUDIT_BACKEND=pg + AUDIT_PG_URL set, audit writes
// mirror to Postgres and audit-logs queries are served from PG with RLS
// applying via `SET LOCAL app.tenant_id` per request transaction.
//
// Skipped when AUDIT_PG_URL (or PG_URL) is not set so default `npm test`
// doesn't require a running Postgres instance.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const PG = process.env.AUDIT_PG_URL || process.env.PG_URL;
const BACKEND = process.env.AUDIT_BACKEND;

if (!PG || BACKEND !== 'pg') {
  test('audit pg-backend suite skipped (AUDIT_PG_URL + AUDIT_BACKEND=pg not set)', () => {});
  return;
}

const { Client } = require('pg');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

// Helper to seed isolated table state at test start.
async function clearAuditFor(tenantId) {
  const c = new Client({ connectionString: PG });
  await c.connect();
  try {
    await c.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId]);
  } finally {
    await c.end();
  }
}

test('order create writes ORDER_CREATED audit row to PG with tenant_id', async () => {
  await clearAuditFor('pg-audit-1');
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'pg-audit-1', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const r = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'pg-aud-1',
    }, auth);
    assert.equal(r.status, 201);

    // Drain outstanding fire-and-forget mirrors deterministically.
    const auditPg = require('../src/core/auditPg');
    await auditPg.drain();

    const c = new Client({ connectionString: PG });
    await c.connect();
    try {
      const count = (await c.query(
        "SELECT COUNT(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'ORDER_CREATED'",
        ['pg-audit-1'],
      )).rows[0].n;
      assert.ok(count >= 1, `expected ORDER_CREATED in PG audit_logs, got ${count}`);
    } finally {
      await c.end();
    }
  } finally {
    await stopTestServer(ctx);
  }
});

test('audit-logs query path returns rows via PG RLS-enforced path', async () => {
  await clearAuditFor('pg-audit-q');
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'pg-audit-q', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'pg-q-1',
    }, auth);
    await new Promise((r) => setTimeout(r, 250));

    const res = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=ORDER_CREATED', null, auth);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 1, 'expected at least one audit row');
    // All rows must be tenant-scoped — RLS enforces, the handler trusts the policy.
    for (const item of res.body.items) {
      assert.equal(item.tenantId, 'pg-audit-q', `cross-tenant leak via PG path: ${JSON.stringify(item)}`);
    }
  } finally {
    await stopTestServer(ctx);
  }
});

test('two tenants writing concurrently stay isolated in PG audit_logs', async () => {
  await clearAuditFor('pg-iso-A');
  await clearAuditFor('pg-iso-B');
  const ctx = await startTestServer();
  try {
    const tA = await loginAs(ctx.port, 'pg-iso-A', 'ADMIN');
    const tB = await loginAs(ctx.port, 'pg-iso-B', 'ADMIN');
    const skuA = await firstSkuId(ctx.port, tA);
    const skuB = await firstSkuId(ctx.port, tB);
    await Promise.all([
      request(ctx.port, 'POST', '/api/v1/orders', {
        storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
        items: [{ skuId: skuA, name: 'A', qty: 1, unitPrice: 55 }], idempotencyKey: 'pg-iso-A-1',
      }, { Authorization: `Bearer ${tA}` }),
      request(ctx.port, 'POST', '/api/v1/orders', {
        storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
        items: [{ skuId: skuB, name: 'B', qty: 1, unitPrice: 55 }], idempotencyKey: 'pg-iso-B-1',
      }, { Authorization: `Bearer ${tB}` }),
    ]);
    await new Promise((r) => setTimeout(r, 300));

    const aRows = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=ORDER_CREATED', null, { Authorization: `Bearer ${tA}` });
    const bRows = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=ORDER_CREATED', null, { Authorization: `Bearer ${tB}` });
    assert.ok(aRows.body.items.every((i) => i.tenantId === 'pg-iso-A'));
    assert.ok(bRows.body.items.every((i) => i.tenantId === 'pg-iso-B'));
  } finally {
    await stopTestServer(ctx);
  }
});
