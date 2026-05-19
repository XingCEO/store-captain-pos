'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('GET /openapi.json returns OpenAPI 3.0 spec', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/openapi.json');
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, '3.0.3');
    assert.ok(res.body.paths['/api/v1/auth/login']);
    assert.ok(res.body.paths['/api/v1/orders']);
    assert.ok(res.body.paths['/api/v1/audit-logs']);
    assert.ok(res.body.paths['/api/v1/subscription/plans']);
    assert.ok(res.body.paths['/api/v1/subscription/current']);
    assert.ok(res.body.paths['/api/v1/subscription/change']);
    assert.ok(res.body.paths['/api/v1/subscription/cancel']);
    assert.ok(res.body.components.securitySchemes.bearerAuth);
  } finally {
    await stopTestServer(ctx);
  }
});
