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

    // Sessions live in their own indexed table (auth_sessions) — peek the
    // token_hash column directly. Plain token must never appear; sha256 hash
    // must be the primary key.
    const Database = require('better-sqlite3');
    const db = new Database(dbFile, { readonly: true });
    const rows = db.prepare('SELECT token_hash, payload_json FROM auth_sessions').all();
    db.close();
    assert.ok(rows.length >= 1, 'auth_sessions should have at least one row');
    const hashes = rows.map((r) => r.token_hash);
    const blob = rows.map((r) => r.payload_json).join('\n');
    assert.ok(!blob.includes(token2), 'plaintext session token leaked into auth_sessions.payload_json');
    assert.ok(hashes.includes(expectedHash), 'sha256 hash of token missing from auth_sessions.token_hash');
  } finally {
    await stopTestServer(ctx);
  }
});
