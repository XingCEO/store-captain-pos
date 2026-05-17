'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('security headers present on every response', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/health');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['referrer-policy'], /strict-origin/);
    assert.ok(res.headers['content-security-policy'], 'CSP header missing');
  } finally {
    await stopTestServer(ctx);
  }
});

test('CORS preflight returns 204 when origin allowed', async () => {
  process.env.ALLOWED_ORIGINS = 'http://allowed.example';
  // Re-require server to pick up new env
  delete require.cache[require.resolve('../src/server')];
  delete require.cache[require.resolve('../src/core/middleware')];
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'OPTIONS', '/api/v1/products', null, { Origin: 'http://allowed.example' });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'http://allowed.example');
    assert.equal(res.headers['vary'], 'Origin');
  } finally {
    await stopTestServer(ctx);
    delete process.env.ALLOWED_ORIGINS;
    delete require.cache[require.resolve('../src/server')];
    delete require.cache[require.resolve('../src/core/middleware')];
  }
});

test('CORS preflight does NOT include allow-origin when origin not allowlisted', async () => {
  process.env.ALLOWED_ORIGINS = 'http://allowed.example';
  delete require.cache[require.resolve('../src/server')];
  delete require.cache[require.resolve('../src/core/middleware')];
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'OPTIONS', '/api/v1/products', null, { Origin: 'http://evil.example' });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  } finally {
    await stopTestServer(ctx);
    delete process.env.ALLOWED_ORIGINS;
    delete require.cache[require.resolve('../src/server')];
    delete require.cache[require.resolve('../src/core/middleware')];
  }
});
