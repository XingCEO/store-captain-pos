'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId, todayBusinessDate } = require('./helpers');

test('GET /metrics returns Prometheus text', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/metrics');
    assert.equal(res.status, 200);
    assert.match(res.raw, /ulw_http_requests_total/);
    assert.match(res.raw, /process_cpu_user_seconds_total|ulw_process_cpu_user_seconds_total/);
  } finally {
    await stopTestServer(ctx);
  }
});

test('http_requests_total increments after a request', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'metrics-tenant', 'ADMIN');
    const skuId = await firstSkuId(ctx.port, token);
    const auth = { Authorization: `Bearer ${token}` };
    await request(ctx.port, 'POST', '/api/v1/orders', {
      storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
      items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'mk-1',
    }, auth);
    const m = await request(ctx.port, 'GET', '/metrics');
    assert.match(m.raw, /ulw_http_requests_total\{[^}]*method="POST"[^}]*\}\s+\d+/);
  } finally {
    await stopTestServer(ctx);
  }
});
