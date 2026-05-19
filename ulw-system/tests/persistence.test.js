'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { request, todayBusinessDate } = require('./helpers');

// This test must NOT use shared helper that auto-disables workers — we do
// our own boot to verify SQLite snapshot survives restart with different
// process instances pointing to the same data dir.
process.env.DISABLE_BACKGROUND_WORKERS = '1';
process.env.LOG_LEVEL = 'silent';

function bootApp(dataDir) {
  // Fresh module instance per boot to ensure clean Store
  delete require.cache[require.resolve('../src/server')];
  delete require.cache[require.resolve('../src/core/runtime')];
  delete require.cache[require.resolve('../src/core/db')];
  const { createApp } = require('../src/server');
  const publicDir = path.join(__dirname, '..', 'public');
  const app = createApp({ dataDir, publicDir, port: 0 });
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve({ app, port: app.server.address().port }));
  });
}

function shutApp({ app }) {
  return new Promise((resolve) => {
    app.close();
    setTimeout(resolve, 80);
  });
}

test('orders survive server restart via SQLite snapshot', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulw-persist-'));
  let createdId = null;
  try {
    {
      const ctx = await bootApp(dataDir);
      const login = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: 'persist-1', role: 'ADMIN', storeId: 'store-001', pin: '9001' });
      const token = login.body.token;
      const products = await request(ctx.port, 'GET', '/api/v1/products', null, { Authorization: `Bearer ${token}` });
      const skuId = products.body.items[0].skuId;
      const r = await request(ctx.port, 'POST', '/api/v1/orders', {
        storeId: 'store-001', terminalId: 'term-001', businessDate: todayBusinessDate(),
        items: [{ skuId, name: 'x', qty: 1, unitPrice: 55 }], idempotencyKey: 'persist-k1',
      }, { Authorization: `Bearer ${token}` });
      assert.equal(r.status, 201);
      createdId = r.body.id;
      await shutApp(ctx);
    }
    // DB file should exist
    assert.ok(fs.existsSync(path.join(dataDir, 'store.db')), 'store.db not created');
    {
      const ctx = await bootApp(dataDir);
      const login = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: 'persist-1', role: 'ADMIN', storeId: 'store-001', pin: '9001' });
      const token = login.body.token;
      const fetched = await request(ctx.port, 'GET', `/api/v1/orders/${createdId}`, null, { Authorization: `Bearer ${token}` });
      assert.equal(fetched.status, 200, `order should survive restart, got status=${fetched.status} body=${JSON.stringify(fetched.body)}`);
      assert.equal(fetched.body.id, createdId);
      await shutApp(ctx);
    }
  } finally {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
