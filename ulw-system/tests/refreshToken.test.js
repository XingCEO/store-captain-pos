'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs } = require('./helpers');

async function login(port, tenantId) {
  const res = await request(port, 'POST', '/api/v1/auth/login', { tenantId, role: 'MANAGER', storeId: 'store-001', pin: '5001' });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

test('login response includes refreshToken + refreshExpiresAt', async () => {
  const ctx = await startTestServer();
  try {
    const out = await login(ctx.port, 't-rt-1');
    assert.ok(out.token);
    assert.ok(out.refreshToken);
    assert.notEqual(out.token, out.refreshToken);
    assert.ok(new Date(out.refreshExpiresAt).getTime() > Date.now());
  } finally { await stopTestServer(ctx); }
});

test('refresh rotates session — old bearer dies, new bearer + new refresh issued', async () => {
  const ctx = await startTestServer();
  try {
    const first = await login(ctx.port, 't-rt-2');
    const refresh1 = await request(ctx.port, 'POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(refresh1.status, 200);
    assert.notEqual(refresh1.body.token, first.token);
    assert.notEqual(refresh1.body.refreshToken, first.refreshToken);

    // New bearer works
    const sess = await request(ctx.port, 'GET', '/api/v1/auth/session', null, { Authorization: `Bearer ${refresh1.body.token}` });
    assert.equal(sess.status, 200);

    // Old bearer is dead (session was rotated)
    const oldSess = await request(ctx.port, 'GET', '/api/v1/auth/session', null, { Authorization: `Bearer ${first.token}` });
    assert.equal(oldSess.status, 403);
  } finally { await stopTestServer(ctx); }
});

test('refresh reuse detection revokes the whole family', async () => {
  const ctx = await startTestServer();
  try {
    const first = await login(ctx.port, 't-rt-3');
    // Rotate once: refreshToken1 → refreshToken2
    const rot = await request(ctx.port, 'POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(rot.status, 200);
    const refreshToken2 = rot.body.refreshToken;
    // Reuse the original (now consumed) refresh token — must trigger family revocation
    const reuse = await request(ctx.port, 'POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.errorCode, 'REFRESH_TOKEN_REUSED');
    // The legitimate rotated refresh token must also now be revoked
    const after = await request(ctx.port, 'POST', '/api/v1/auth/refresh', { refreshToken: refreshToken2 });
    assert.equal(after.status, 401);
  } finally { await stopTestServer(ctx); }
});

test('refresh with unknown token returns REFRESH_TOKEN_INVALID', async () => {
  const ctx = await startTestServer();
  try {
    const out = await request(ctx.port, 'POST', '/api/v1/auth/refresh', { refreshToken: 'deadbeef-no-such-token' });
    assert.equal(out.status, 401);
    assert.equal(out.body.errorCode, 'REFRESH_TOKEN_INVALID');
  } finally { await stopTestServer(ctx); }
});

test('logout revokes the refresh token tied to that session', async () => {
  const ctx = await startTestServer();
  try {
    const first = await login(ctx.port, 't-rt-4');
    const out = await request(ctx.port, 'POST', '/api/v1/auth/logout', null, { Authorization: `Bearer ${first.token}` });
    assert.equal(out.status, 200);
    const reuse = await request(ctx.port, 'POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.body.errorCode, 'REFRESH_TOKEN_INVALID');
  } finally { await stopTestServer(ctx); }
});

test('refresh after session TTL still works (refresh outlasts session)', async () => {
  const ctx = await startTestServer();
  try {
    const first = await login(ctx.port, 't-rt-5');
    // Simulate session expiry by directly evicting from store
    const security = require('../src/core/security');
    ctx.app.runtime.store.data.sessions.delete(security.hashToken(first.token));
    // Refresh should still mint a fresh session
    const out = await request(ctx.port, 'POST', '/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    assert.equal(out.status, 200);
    assert.ok(out.body.token);
  } finally { await stopTestServer(ctx); }
});
