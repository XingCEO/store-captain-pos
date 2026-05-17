'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('static file response includes ETag', async () => {
  const ctx = await startTestServer();
  try {
    const r1 = await request(ctx.port, 'GET', '/login.html');
    assert.equal(r1.status, 200);
    assert.ok(r1.headers['etag'], 'expected ETag header');
  } finally {
    await stopTestServer(ctx);
  }
});

test('static file returns 304 when If-None-Match matches ETag', async () => {
  const ctx = await startTestServer();
  try {
    const r1 = await request(ctx.port, 'GET', '/login.html');
    const etag = r1.headers['etag'];
    const r2 = await request(ctx.port, 'GET', '/login.html', null, { 'If-None-Match': etag });
    assert.equal(r2.status, 304);
  } finally {
    await stopTestServer(ctx);
  }
});
