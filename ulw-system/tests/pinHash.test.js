'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs } = require('./helpers');

test('user-created PIN is stored as scrypt hash, not plaintext', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'pin-hash', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    const create = await request(ctx.port, 'POST', '/api/v1/users', {
      name: '測試員', role: 'CASHIER', pin: '4321',
    }, auth);
    assert.equal(create.status, 200);
    const newUserId = create.body.id;

    // List users — server response should not echo PIN field
    const list = await request(ctx.port, 'GET', '/api/v1/users', null, auth);
    const me = list.body.items.find((u) => u.id === newUserId);
    assert.ok(me);
    assert.equal(me.pin, undefined, 'PIN should never appear in user listing');

    // Login with that PIN should succeed
    const login = await request(ctx.port, 'POST', '/api/v1/auth/login', {
      tenantId: 'pin-hash', role: 'CASHIER', storeId: 'store-001', userId: newUserId, pin: '4321',
    });
    assert.equal(login.status, 200, `login expected 200, body=${JSON.stringify(login.body)}`);

    // Login with wrong PIN fails
    const wrong = await request(ctx.port, 'POST', '/api/v1/auth/login', {
      tenantId: 'pin-hash', role: 'CASHIER', storeId: 'store-001', userId: newUserId, pin: 'WRONG',
    });
    assert.ok(wrong.status === 403 || wrong.status === 429, `wrong PIN expected 403/429, got ${wrong.status}`);
  } finally {
    await stopTestServer(ctx);
  }
});
