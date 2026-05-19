'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mfa = require('../src/core/mfa');
const { startTestServer, stopTestServer, request, loginAs } = require('./helpers');

test('base32 encode/decode roundtrip preserves bytes', () => {
  const buf = Buffer.from([1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255]);
  const enc = mfa.base32Encode(buf);
  const dec = mfa.base32Decode(enc);
  assert.deepEqual([...dec], [...buf]);
});

test('generateSecret returns 32 base32 chars (160-bit)', () => {
  const s = mfa.generateSecret();
  assert.equal(s.length, 32);
  assert.match(s, /^[A-Z2-7]+$/);
});

test('totp returns 6-digit code, deterministic for same secret + t', () => {
  const secret = mfa.generateSecret();
  const t = 1_700_000_000;
  const c1 = mfa.totp(secret, t);
  const c2 = mfa.totp(secret, t);
  assert.equal(c1.length, 6);
  assert.match(c1, /^\d{6}$/);
  assert.equal(c1, c2);
});

test('verifyTotp accepts current code, rejects unrelated code', () => {
  const secret = mfa.generateSecret();
  const code = mfa.totp(secret);
  assert.equal(mfa.verifyTotp(code, secret), true);
  assert.equal(mfa.verifyTotp('000000', secret), false);
});

test('verifyTotp tolerates ±30s clock skew via window=1', () => {
  const secret = mfa.generateSecret();
  const now = Math.floor(Date.now() / 1000);
  const earlier = mfa.totp(secret, now - 30);
  const later   = mfa.totp(secret, now + 30);
  assert.equal(mfa.verifyTotp(earlier, secret, 1), true);
  assert.equal(mfa.verifyTotp(later, secret, 1), true);
});

test('provisioningUri builds otpauth:// scheme with issuer + label + algo', () => {
  const uri = mfa.provisioningUri('user@tenant', 'JBSWY3DPEHPK3PXP', 'TestCo');
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXP'));
  assert.ok(uri.includes('issuer=TestCo'));
  assert.ok(uri.includes('algorithm=SHA1'));
});

test('/mfa/enroll → /mfa/verify enables MFA; subsequent login requires challenge', async () => {
  const ctx = await startTestServer();
  try {
    // Initial login (no MFA yet)
    const token = await loginAs(ctx.port, 't-mfa-1', 'MANAGER');
    // Enroll
    const enroll = await request(ctx.port, 'POST', '/api/v1/auth/mfa/enroll', null, { Authorization: `Bearer ${token}` });
    assert.equal(enroll.status, 200);
    assert.equal(enroll.body.secret.length, 32);
    assert.ok(enroll.body.provisioningUri.startsWith('otpauth://'));
    const secret = enroll.body.secret;
    // Verify with current TOTP
    const code = mfa.totp(secret);
    const verify = await request(ctx.port, 'POST', '/api/v1/auth/mfa/verify', { code }, { Authorization: `Bearer ${token}` });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.mfaEnabled, true);
    // Re-enroll is rejected
    const reenroll = await request(ctx.port, 'POST', '/api/v1/auth/mfa/enroll', null, { Authorization: `Bearer ${token}` });
    assert.equal(reenroll.status, 409);
    assert.equal(reenroll.body.errorCode, 'MFA_ALREADY_ENROLLED');
    // Now login again — must hit MFA gate
    const second = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: 't-mfa-1', role: 'MANAGER', storeId: 'store-001', pin: '5001' });
    assert.equal(second.status, 200);
    assert.equal(second.body.mfaRequired, true);
    assert.ok(second.body.challengeToken);
    assert.equal(second.body.token, undefined);
    // Challenge with correct code → bearer + refresh issued
    const codeAfter = mfa.totp(secret);
    const chal = await request(ctx.port, 'POST', '/api/v1/auth/mfa/challenge', { challengeToken: second.body.challengeToken, code: codeAfter });
    assert.equal(chal.status, 200);
    assert.ok(chal.body.token);
    assert.ok(chal.body.refreshToken);
    assert.equal(chal.body.role, 'MANAGER');
    // The bearer works
    const sess = await request(ctx.port, 'GET', '/api/v1/auth/session', null, { Authorization: `Bearer ${chal.body.token}` });
    assert.equal(sess.status, 200);
  } finally { await stopTestServer(ctx); }
});

test('/mfa/verify rejects wrong code', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-mfa-2', 'MANAGER');
    await request(ctx.port, 'POST', '/api/v1/auth/mfa/enroll', null, { Authorization: `Bearer ${token}` });
    const verify = await request(ctx.port, 'POST', '/api/v1/auth/mfa/verify', { code: '000000' }, { Authorization: `Bearer ${token}` });
    assert.equal(verify.status, 401);
    assert.equal(verify.body.errorCode, 'MFA_INVALID');
  } finally { await stopTestServer(ctx); }
});

test('/mfa/challenge rejects wrong code; lockout after 5 failures', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-mfa-3', 'MANAGER');
    const enroll = await request(ctx.port, 'POST', '/api/v1/auth/mfa/enroll', null, { Authorization: `Bearer ${token}` });
    assert.equal(enroll.status, 200, `enroll failed: ${JSON.stringify(enroll.body)}`);
    const verify = await request(ctx.port, 'POST', '/api/v1/auth/mfa/verify', { code: mfa.totp(enroll.body.secret) }, { Authorization: `Bearer ${token}` });
    assert.equal(verify.status, 200, `verify failed: ${JSON.stringify(verify.body)}`);
    const login = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: 't-mfa-3', role: 'MANAGER', storeId: 'store-001', pin: '5001' });
    assert.equal(login.status, 200, `second login failed: ${JSON.stringify(login.body)}`);
    assert.ok(login.body.challengeToken, `expected challengeToken, got: ${JSON.stringify(login.body)}`);
    const challengeToken = login.body.challengeToken;
    for (let i = 0; i < 5; i += 1) {
      const out = await request(ctx.port, 'POST', '/api/v1/auth/mfa/challenge', { challengeToken, code: '000000' });
      assert.equal(out.status, 401, `attempt ${i} got ${out.status}: ${JSON.stringify(out.body)}`);
    }
    const locked = await request(ctx.port, 'POST', '/api/v1/auth/mfa/challenge', { challengeToken, code: '000000' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.errorCode, 'LOGIN_RATE_LIMITED');
  } finally { await stopTestServer(ctx); }
});

test('/mfa/disable requires current code; clears mfaEnabled', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 't-mfa-4', 'MANAGER');
    const enroll = await request(ctx.port, 'POST', '/api/v1/auth/mfa/enroll', null, { Authorization: `Bearer ${token}` });
    const secret = enroll.body.secret;
    await request(ctx.port, 'POST', '/api/v1/auth/mfa/verify', { code: mfa.totp(secret) }, { Authorization: `Bearer ${token}` });
    // Wrong code
    const bad = await request(ctx.port, 'POST', '/api/v1/auth/mfa/disable', { code: '000000' }, { Authorization: `Bearer ${token}` });
    assert.equal(bad.status, 401);
    // Right code
    const ok = await request(ctx.port, 'POST', '/api/v1/auth/mfa/disable', { code: mfa.totp(secret) }, { Authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.mfaEnabled, false);
    // Next login no longer gated
    const next = await request(ctx.port, 'POST', '/api/v1/auth/login', { tenantId: 't-mfa-4', role: 'MANAGER', storeId: 'store-001', pin: '5001' });
    assert.equal(next.status, 200);
    assert.ok(next.body.token);
    assert.notEqual(next.body.mfaRequired, true);
  } finally { await stopTestServer(ctx); }
});
