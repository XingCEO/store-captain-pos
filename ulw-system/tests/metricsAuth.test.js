'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('/metrics requires METRICS_TOKEN when env is set', async () => {
  process.env.METRICS_TOKEN = 'topsecret';
  delete require.cache[require.resolve('../src/server')];
  const ctx = await startTestServer();
  try {
    const denied = await request(ctx.port, 'GET', '/metrics');
    assert.equal(denied.status, 401);
    const ok = await request(ctx.port, 'GET', '/metrics', null, { Authorization: 'Bearer topsecret' });
    assert.equal(ok.status, 200);
    assert.match(ok.raw, /ulw_http_requests_total/);
  } finally {
    await stopTestServer(ctx);
    delete process.env.METRICS_TOKEN;
    delete require.cache[require.resolve('../src/server')];
  }
});

test('/metrics is open when METRICS_TOKEN not set', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/metrics');
    assert.equal(res.status, 200);
  } finally {
    await stopTestServer(ctx);
  }
});

test('/metrics emits ulw_db_query_duration_seconds histogram', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/metrics');
    assert.match(res.raw, /ulw_db_query_duration_seconds_bucket/);
  } finally {
    await stopTestServer(ctx);
  }
});
