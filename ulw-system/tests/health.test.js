'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('GET /health returns ok', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.service, 'store-captain-pos');
  } finally {
    await stopTestServer(ctx);
  }
});
