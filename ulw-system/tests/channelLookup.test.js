'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId } = require('./helpers');

function loadQrCode() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/lib/qrcode.js'), 'utf8'), sandbox);
  return sandbox.QRCode;
}

async function changePlan(port, auth, planCode, idempotencyKey) {
  const res = await request(port, 'POST', '/api/v1/subscription/change', {
    planCode,
    billingCycle: 'MONTHLY',
    idempotencyKey,
  }, auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.planCode, planCode);
}

test('QR channel order returns signed customer lookup token', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'channel-lookup', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    await changePlan(ctx.port, auth, 'GROWTH', 'lookup-growth');
    const skuId = await firstSkuId(ctx.port, token);

    const created = await request(ctx.port, 'POST', '/api/v1/channels/qr/orders', {
      channel: 'QR',
      idempotencyKey: 'qr-lookup-1',
      storeId: 'store-001',
      items: [{ skuId, qty: 1 }],
    }, auth);
    assert.equal(created.status, 200);
    assert.match(created.body.lookupToken, /^[^.]+\.[^.]+$/);
    assert.doesNotThrow(() => {
      loadQrCode().generate(`https://pos.example/o.html?t=${created.body.lookupToken}`, { ecc: 'M' });
    });

    const lookup = await request(ctx.port, 'GET', `/api/v1/channels/orders/lookup?token=${encodeURIComponent(created.body.lookupToken)}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.orderId, created.body.orderId);
    assert.equal(lookup.body.orderNumber, created.body.orderNumber);
    assert.equal(lookup.body.grandTotal, created.body.grandTotal);
    assert.equal(lookup.body.storeName, '一號店');
    assert.equal(lookup.body.tenantId, undefined);
    assert.equal(lookup.body.items.length, 1);
  } finally {
    await stopTestServer(ctx);
  }
});

test('customer order lookup rejects tampered token', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'channel-lookup-bad', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    await changePlan(ctx.port, auth, 'GROWTH', 'lookup-growth-bad');
    const skuId = await firstSkuId(ctx.port, token);

    const created = await request(ctx.port, 'POST', '/api/v1/channels/qr/orders', {
      channel: 'QR',
      idempotencyKey: 'qr-lookup-bad',
      storeId: 'store-001',
      items: [{ skuId, qty: 1 }],
    }, auth);
    assert.equal(created.status, 200);
    const tampered = `${created.body.lookupToken.slice(0, -1)}x`;
    const lookup = await request(ctx.port, 'GET', `/api/v1/channels/orders/lookup?token=${encodeURIComponent(tampered)}`);
    assert.equal(lookup.status, 403);
    assert.equal(lookup.body.errorCode, 'CHANNEL_AUTH_FAILED');
  } finally {
    await stopTestServer(ctx);
  }
});
