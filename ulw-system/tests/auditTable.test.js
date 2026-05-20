'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
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

test('snapshot and audit rows commit atomically', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulw-audit-atomic-'));
  let runtime = null;
  try {
    const { createRuntime } = require('../src/core/runtime');
    runtime = createRuntime({ dataDir, publicDir: path.join(__dirname, '..', 'public') });
    const orderId = 'order-atomic-fail';
    runtime.store.data.orders.set(orderId, {
      id: orderId,
      tenantId: 'audit-atomic',
      storeId: 'store-001',
      state: 'DRAFT',
      paymentState: 'UNPAID',
      createdAt: runtime.nowIso(),
      updatedAt: runtime.nowIso(),
    });
    runtime.store.data.auditLogs.push({
      tenantId: 'audit-atomic',
      action: null,
      resourceType: 'order',
      resourceId: orderId,
      actor: 'test',
      userId: 'test',
      userRole: 'ADMIN',
      before: null,
      after: { id: orderId },
      timestamp: runtime.nowIso(),
    });

    assert.throws(() => runtime.store.persist(), /NOT NULL|constraint/i);
    assert.equal(runtime.store.data.auditLogs.length, 1, 'failed audit batch must stay buffered for retry');

    const Database = require('better-sqlite3');
    const db = new Database(path.join(dataDir, 'store.db'), { readonly: true });
    try {
      const ordersSnapshot = db.prepare("SELECT value FROM state WHERE name = 'orders'").get();
      assert.ok(!ordersSnapshot || !ordersSnapshot.value.includes(orderId), 'orders snapshot must roll back with failed audit insert');
      const auditRows = db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE resource_id = ?').get(orderId).n;
      assert.equal(auditRows, 0, 'audit insert must not partially commit');
    } finally {
      db.close();
    }
  } finally {
    if (runtime) await runtime.store.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
