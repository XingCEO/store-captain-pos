'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('login succeeds with seeded role', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'POST', '/api/v1/auth/login', {
      tenantId: 'auth-tenant', role: 'ADMIN', storeId: 'store-001', pin: '9001',
    });
    assert.equal(res.status, 200);
    assert.match(res.body.token, /^[0-9a-f]{64}$/);
    assert.equal(res.body.role, 'ADMIN');
  } finally {
    await stopTestServer(ctx);
  }
});

test('seeded login without PIN returns LOGIN_INVALID_CREDENTIALS', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'POST', '/api/v1/auth/login', {
      tenantId: 'auth-pin-required', role: 'ADMIN', storeId: 'store-001',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.errorCode, 'LOGIN_INVALID_CREDENTIALS');
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

test('auth session refresh returns bearer token that remains usable', async () => {
  const ctx = await startTestServer();
  try {
    const login = await request(ctx.port, 'POST', '/api/v1/auth/login', {
      tenantId: 'auth-refresh', role: 'ADMIN', storeId: 'store-001', pin: '9001',
    });
    assert.equal(login.status, 200);
    const session = await request(ctx.port, 'GET', '/api/v1/auth/session', null, { Authorization: `Bearer ${login.body.token}` });
    assert.equal(session.status, 200);
    assert.equal(session.body.token, login.body.token);
    const products = await request(ctx.port, 'GET', '/api/v1/products', null, { Authorization: `Bearer ${session.body.token}` });
    assert.equal(products.status, 200);
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
