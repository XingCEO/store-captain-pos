'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs } = require('./helpers');

test('report export download token is cryptographically strong hex', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'report-export-token', 'MANAGER');
    const auth = { Authorization: `Bearer ${token}` };
    const adminToken = await loginAs(ctx.port, 'report-export-token', 'ADMIN');
    const upgrade = await request(ctx.port, 'POST', '/api/v1/subscription/change', {
      planCode: 'GROWTH', billingCycle: 'MONTHLY', idempotencyKey: 'report-export-growth',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.equal(upgrade.status, 200);
    const create = await request(ctx.port, 'POST', '/api/v1/reports/exports', {
      reportType: 'daily',
      from: '2026-05-01',
      to: '2026-05-02',
      storeIds: ['store-001'],
    }, auth);
    assert.equal(create.status, 200);
    const meta = await request(ctx.port, 'GET', `/api/v1/reports/exports/${create.body.export_id}`, null, auth);
    assert.equal(meta.status, 200);
    // Download token is now returned separately and consumed via the
    // X-Download-Token header — never embedded in the URL.
    assert.equal(typeof meta.body.download_token, 'string');
    assert.match(meta.body.download_token, /^[0-9a-f]{64}$/);
    const url = new URL(meta.body.download_url, 'http://localhost');
    assert.equal(url.searchParams.get('token'), null);
    // The download endpoint rejects without the header.
    const denied = await request(ctx.port, 'GET', meta.body.download_url, null, auth);
    assert.equal(denied.status, 403);
    // ...and accepts with the header.
    const allowed = await request(ctx.port, 'GET', meta.body.download_url, null,
      { ...auth, 'X-Download-Token': meta.body.download_token });
    assert.equal(allowed.status, 200);
  } finally {
    await stopTestServer(ctx);
  }
});
