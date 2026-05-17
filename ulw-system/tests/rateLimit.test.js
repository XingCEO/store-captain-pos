'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('login bucket rejects after 10 requests/minute', async () => {
  const ctx = await startTestServer();
  try {
    let rateLimited = false;
    for (let i = 0; i < 15; i += 1) {
      const r = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: `rl-${i}`, role: 'ADMIN', storeId: 'store-001' });
      if (r.status === 429 && r.body.errorCode === 'RATE_LIMITED') { rateLimited = true; break; }
    }
    assert.equal(rateLimited, true, 'expected 429 RATE_LIMITED within 15 logins');
  } finally {
    await stopTestServer(ctx);
  }
});

test('rate-limit response carries Retry-After header', async () => {
  const ctx = await startTestServer();
  try {
    let retryAfter = null;
    for (let i = 0; i < 20; i += 1) {
      const r = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: `rl2-${i}`, role: 'ADMIN', storeId: 'store-001' });
      if (r.status === 429) { retryAfter = r.headers['retry-after']; break; }
    }
    assert.ok(retryAfter && Number(retryAfter) > 0, `Retry-After should be positive number, got: ${retryAfter}`);
  } finally {
    await stopTestServer(ctx);
  }
});
