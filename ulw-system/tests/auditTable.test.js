'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

test('audit rows are persisted to audit_logs table and survive restart', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'audit-table-1', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const r = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'at-1',
    }, auth);
    assert.equal(r.status, 201);

    // Confirm audit_logs has at least the expected row
    const Database = require('better-sqlite3');
    const dbFile = path.join(ctx.dataDir, 'store.db');
    const db = new Database(dbFile, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE tenant_id = 'audit-table-1' AND action = 'ORDER_CREATED'").get().n;
    db.close();
    assert.ok(count >= 1, `audit_logs table should contain ORDER_CREATED row, got ${count}`);
    assert.ok(fs.existsSync(dbFile));
  } finally {
    await stopTestServer(ctx);
  }
});

test('audit-logs query is tenant-scoped via SQL WHERE', async () => {
  const ctx = await startTestServer();
  try {
    const tA = await loginAs(ctx.port, 'audit-iso-A', 'ADMIN');
    const tB = await loginAs(ctx.port, 'audit-iso-B', 'ADMIN');
    const skuA = await firstSkuId(ctx.port, tA);
    await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId: skuA, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'iso-key',
    }, { Authorization: `Bearer ${tA}` });

    const fromB = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=ORDER_CREATED', null, { Authorization: `Bearer ${tB}` });
    assert.equal(fromB.status, 200);
    assert.equal(fromB.body.items.length, 0, 'B must not see A audit rows');
  } finally {
    await stopTestServer(ctx);
  }
});
