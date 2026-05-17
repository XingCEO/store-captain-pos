'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('login succeeds with seeded role', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'POST', '/api/v1/auth/login', {
      tenantId: 'auth-tenant', role: 'ADMIN', storeId: 'store-001',
    });
    assert.equal(res.status, 200);
    assert.match(res.body.token, /^[0-9a-f]{64}$/);
    assert.equal(res.body.role, 'ADMIN');
  } finally {
    await stopTestServer(ctx);
  }
});

test('login with bad PIN returns LOGIN_INVALID_CREDENTIALS', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'POST', '/api/v1/auth/login', {
      tenantId: 'auth-tenant-bad-pin', role: 'ADMIN', storeId: 'store-001', pin: 'NOPE',
    });
    assert.ok(res.status === 403 || res.status === 400, `unexpected ${res.status}`);
    assert.equal(res.body.errorCode, 'LOGIN_INVALID_CREDENTIALS');
  } finally {
    await stopTestServer(ctx);
  }
});

test('login without tenantId returns 400', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'POST', '/api/v1/auth/login', { role: 'ADMIN', storeId: 'store-001' });
    assert.equal(res.status, 400);
    assert.equal(res.body.errorCode, 'LOGIN_INVALID_CREDENTIALS');
  } finally {
    await stopTestServer(ctx);
  }
});

test('unauthenticated tenant-scoped request returns 403', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/api/v1/audit-logs');
    assert.equal(res.status, 403);
    assert.equal(res.body.errorCode, 'TENANT_NOT_AUTHORIZED');
  } finally {
    await stopTestServer(ctx);
  }
});
