'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('GET /health returns ok + checks + uptime + memory', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.service, 'store-captain-pos');
    assert.equal(res.body.checks.sqlite.ok, true);
    assert.ok(typeof res.body.uptimeSeconds === 'number');
    assert.ok(typeof res.body.memoryMb === 'number');
    assert.ok(typeof res.body.queryMs === 'number');
  } finally { await stopTestServer(ctx); }
});

test('GET /health/live returns minimal ok shape', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/health/live');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // /health/live omits checks for the cheapest possible response.
    assert.equal(res.body.checks, undefined);
  } finally { await stopTestServer(ctx); }
});

test('GET /health/ready reports sqlite + worker checks', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/health/ready');
    // Worker is disabled in tests by default; ageSeconds may be null which
    // we treat as OK (worker not configured).
    assert.equal(res.status, 200);
    assert.equal(res.body.checks.sqlite.ok, true);
    assert.ok('worker' in res.body.checks);
  } finally { await stopTestServer(ctx); }
});
