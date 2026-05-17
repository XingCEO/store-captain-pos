'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

test('order create writes ORDER_CREATED audit', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'audit-create', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'audit-k',
    }, auth);
    assert.equal(create.status, 201);
    const logs = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=ORDER_CREATED', null, auth);
    assert.equal(logs.status, 200);
    assert.ok(logs.body.items.some((row) => row.resourceId === create.body.id));
  } finally {
    await stopTestServer(ctx);
  }
});

test('audit-logs filter is tenant-scoped: other tenants cannot read', async () => {
  const ctx = await startTestServer();
  try {
    const tA = await loginAs(ctx.port, 'audit-tA', 'ADMIN');
    const tB = await loginAs(ctx.port, 'audit-tB', 'ADMIN');
    const skuA = await firstSkuId(ctx.port, tA);
    await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId: skuA, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'iso-a',
    }, { Authorization: `Bearer ${tA}` });
    const fromB = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=ORDER_CREATED', null, { Authorization: `Bearer ${tB}` });
    assert.equal(fromB.status, 200);
    assert.equal(fromB.body.items.length, 0);
  } finally {
    await stopTestServer(ctx);
  }
});

test('failed login writes AUTH_LOGIN_FAILED audit', async () => {
  const ctx = await startTestServer();
  try {
    // First seed tenant with success
    const token = await loginAs(ctx.port, 'audit-fail', 'ADMIN');
    // Then trigger failure (PIN-required path needs a pin set — exercise user-not-found path)
    const bad = await request(ctx.port, 'POST', '/api/v1/auth/login', {
      tenantId: 'audit-fail', role: 'ADMIN', storeId: 'store-001', pin: 'WRONG', userId: 'user-9999',
    });
    assert.ok(bad.status === 403 || bad.status === 400);
    const auth = { Authorization: `Bearer ${token}` };
    const logs = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=AUTH_LOGIN_FAILED', null, auth);
    assert.equal(logs.status, 200);
    assert.ok(logs.body.items.length >= 1, 'expected AUTH_LOGIN_FAILED audit row');
  } finally {
    await stopTestServer(ctx);
  }
});
