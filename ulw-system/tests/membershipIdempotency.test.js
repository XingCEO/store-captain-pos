'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs } = require('./helpers');

const authH = (token) => ({ Authorization: `Bearer ${token}` });

// MEMBERSHIP features require the GROWTH plan. Upgrade the tenant first, then
// exercise the points-adjust idempotency guard.
async function upgradeToGrowth(port, token) {
  const res = await request(port, 'POST', '/api/v1/subscription/change', {
    planCode: 'GROWTH', billingCycle: 'MONTHLY', idempotencyKey: `up-${Date.now()}`,
  }, authH(token));
  assert.equal(res.status, 200, `plan upgrade failed: ${JSON.stringify(res.body)}`);
}

test('points/adjust requires idempotencyKey and dedups a replay (no double-apply)', async () => {
  const ctx = await startTestServer();
  try {
    const admin = await loginAs(ctx.port, 'mem-pts', 'ADMIN');
    await upgradeToGrowth(ctx.port, admin);

    const cust = await request(ctx.port, 'POST', '/api/v1/customers', { phone: '0912345678', name: '測試會員' }, authH(admin));
    assert.equal(cust.status, 200, `customer create failed: ${JSON.stringify(cust.body)}`);
    const customerId = cust.body.id;

    // missing key → 400
    const noKey = await request(ctx.port, 'POST', '/api/v1/customers/points/adjust', { customerId, points: 10, reasonCode: 'ADJUST' }, authH(admin));
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.errorCode, 'IDEMPOTENCY_KEY_MISMATCH');

    // first apply → after = before + 10
    const first = await request(ctx.port, 'POST', '/api/v1/customers/points/adjust', { customerId, points: 10, reasonCode: 'ADJUST', idempotencyKey: 'pts-k1' }, authH(admin));
    assert.equal(first.status, 200);
    assert.equal(first.body.after, 10);

    // replay same key+payload → cached, NOT doubled
    const replay = await request(ctx.port, 'POST', '/api/v1/customers/points/adjust', { customerId, points: 10, reasonCode: 'ADJUST', idempotencyKey: 'pts-k1' }, authH(admin));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicated, true);
    assert.equal(replay.body.after, 10, 'replay must not double the points');

    // same key, different payload → 409
    const conflict = await request(ctx.port, 'POST', '/api/v1/customers/points/adjust', { customerId, points: 20, reasonCode: 'ADJUST', idempotencyKey: 'pts-k1' }, authH(admin));
    assert.equal(conflict.status, 409);
  } finally { await stopTestServer(ctx); }
});

test('coupons/redeem requires an idempotencyKey', async () => {
  const ctx = await startTestServer();
  try {
    const admin = await loginAs(ctx.port, 'mem-cpn', 'ADMIN');
    await upgradeToGrowth(ctx.port, admin);
    // The required-key gate fires before coupon/order resolution, so a missing
    // key is rejected regardless of coupon validity.
    const res = await request(ctx.port, 'POST', '/api/v1/coupons/redeem', { orderId: 'order-x', code: 'WELCOME50' }, authH(admin));
    assert.equal(res.status, 400);
    assert.equal(res.body.errorCode, 'IDEMPOTENCY_KEY_MISMATCH');
  } finally { await stopTestServer(ctx); }
});
