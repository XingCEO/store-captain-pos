'use strict';

// Token-bucket rate limiter backed by SQLite. The bucket key is composed of
// (rule_name + identity) so per-tenant or per-IP limits can coexist. Survives
// restart because rows live in the same store.db.

const BUCKETS = {
  login:    { capacity: 10,  refillPerSec: 10 / 60 },   // 10 / minute
  api:      { capacity: 120, refillPerSec: 120 / 60 },  // 120 / minute per IP
};

let preparedTake = null;
let preparedUpsert = null;
let dbRef = null;

function init(db) {
  dbRef = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit (
      bucket TEXT NOT NULL,
      identity TEXT NOT NULL,
      tokens REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (bucket, identity)
    );
  `);
  preparedTake = db.prepare('SELECT tokens, updated_at FROM rate_limit WHERE bucket = ? AND identity = ?');
  preparedUpsert = db.prepare(`
    INSERT INTO rate_limit(bucket, identity, tokens, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(bucket, identity) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at
  `);
}

function pickRule(req) {
  const url = req.url || '';
  if (url.startsWith('/api/v1/auth/login')) return 'login';
  if (url.startsWith('/api/')) return 'api';
  return null;
}

function identityFor(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function consume(bucket, identity, now = Date.now()) {
  const rule = BUCKETS[bucket];
  if (!rule || !preparedTake) return { allowed: true, remaining: 0, retryAfterMs: 0 };
  const tx = dbRef.transaction(() => {
    const row = preparedTake.get(bucket, identity);
    let tokens, updatedAt;
    if (!row) { tokens = rule.capacity; updatedAt = now; }
    else { tokens = row.tokens; updatedAt = row.updated_at; }
    const elapsed = (now - updatedAt) / 1000;
    tokens = Math.min(rule.capacity, tokens + elapsed * rule.refillPerSec);
    if (tokens < 1) {
      preparedUpsert.run(bucket, identity, tokens, now);
      const need = 1 - tokens;
      const retryAfterMs = Math.ceil((need / rule.refillPerSec) * 1000);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    tokens -= 1;
    preparedUpsert.run(bucket, identity, tokens, now);
    return { allowed: true, remaining: Math.floor(tokens), retryAfterMs: 0 };
  });
  return tx();
}

function middleware(req, res) {
  const bucket = pickRule(req);
  if (!bucket) return true;
  const id = identityFor(req);
  const result = consume(bucket, id);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 429;
    res.end(JSON.stringify({
      errorCode: 'RATE_LIMITED',
      message: `Rate limit exceeded for ${bucket}`,
      retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
    }));
    return false;
  }
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  return true;
}

function resetForTests() {
  if (dbRef) dbRef.exec('DELETE FROM rate_limit');
}

module.exports = { init, consume, middleware, BUCKETS, resetForTests };
