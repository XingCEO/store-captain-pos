'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs } = require('./helpers');

// GET /api/v1/print-jobs is management visibility — it must require MANAGER+,
// not merely an authenticated tenant. Regression lock for the role gate.

test('GET /print-jobs denies a CASHIER with PERMISSION_DENIED', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'pj-cashier', 'CASHIER');
    const res = await request(ctx.port, 'GET', '/api/v1/print-jobs?storeId=store-001', null, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 403);
    assert.equal(res.body.errorCode, 'TENANT_NOT_AUTHORIZED');
  } finally {
    await stopTestServer(ctx);
  }
});

test('GET /print-jobs allows a MANAGER', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'pj-manager', 'MANAGER');
    const res = await request(ctx.port, 'GET', '/api/v1/print-jobs?storeId=store-001', null, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  } finally {
    await stopTestServer(ctx);
  }
});
