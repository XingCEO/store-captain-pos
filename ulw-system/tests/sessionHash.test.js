'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer, stopTestServer, request } = require('./helpers');

test('session token is stored as sha256 hash, not plaintext', async () => {
  const ctx = await startTestServer();
  try {
    const r = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: 'sess-hash', role: 'ADMIN', storeId: 'store-001', pin: '9001' });
    assert.equal(r.status, 200);
    const token = r.body.token;
    // Token is returned to client in plaintext
    assert.match(token, /^[0-9a-f]{64}$/);

    // Force a persist to flush the session table to DB
    await request(ctx.port, 'POST', '/api/v1/auth/logout', null, { Authorization: `Bearer ${token}` });
    // Re-login (so there IS a session row to check)
    const r2 = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: 'sess-hash', role: 'ADMIN', storeId: 'store-001', pin: '9001' });
    const token2 = r2.body.token;

    // Inspect raw DB JSON for the sessions Map — token2 (plaintext) must NOT appear, but its sha256 hash should.
    const crypto = require('node:crypto');
    const expectedHash = `sha256:${crypto.createHash('sha256').update(token2).digest('hex')}`;
    const dbFile = path.join(ctx.dataDir, 'store.db');
    assert.ok(fs.existsSync(dbFile), 'store.db should exist');

    // Open SQLite read-only to peek sessions state row
    const Database = require('better-sqlite3');
    const db = new Database(dbFile, { readonly: true });
    const row = db.prepare("SELECT value FROM state WHERE name = 'sessions'").get();
    db.close();
    assert.ok(row, 'sessions state row missing');
    assert.ok(!row.value.includes(token2), 'plaintext session token leaked into DB');
    assert.ok(row.value.includes(expectedHash), 'sha256 hash of token not stored as session key');
  } finally {
    await stopTestServer(ctx);
  }
});
