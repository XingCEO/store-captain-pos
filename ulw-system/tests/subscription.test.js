'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer, request, loginAs, firstSkuId } = require('./helpers');

async function changePlan(port, auth, planCode, idempotencyKey) {
  const res = await request(port, 'POST', '/api/v1/subscription/change', {
    planCode, billingCycle: 'MONTHLY', idempotencyKey,
  }, auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.planCode, planCode);
  return res;
}

test('subscription plans are available without tenant session', async () => {
  const ctx = await startTestServer();
  try {
    const res = await request(ctx.port, 'GET', '/api/v1/subscription/plans');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((plan) => plan.code), ['STARTER', 'GROWTH', 'CHAIN']);
    assert.deepEqual(res.body.items.find((plan) => plan.code === 'STARTER').entitlements, ['POS_CORE', 'ORDER_HUB', 'SANDBOX_INVOICE', 'CASH_DRAWER', 'DAILY_REPORT', 'SYNC_REPAIR', 'ROLES_AUDIT']);
    assert.ok(res.body.items.find((plan) => plan.code === 'GROWTH').entitlements.includes('INVENTORY'));
    assert.ok(res.body.items.find((plan) => plan.code === 'CHAIN').entitlements.includes('STORE_TRANSFER'));
    assert.equal(res.body.billingMode, 'LOCAL_MVP_MANUAL_BILLING');
  } finally {
    await stopTestServer(ctx);
  }
});

test('current subscription is seeded as Starter trial', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-current', 'MANAGER');
    const res = await request(ctx.port, 'GET', '/api/v1/subscription/current', null, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.planCode, 'STARTER');
    assert.equal(res.body.status, 'TRIALING');
    assert.ok(res.body.entitlements.includes('POS_CORE'));
    assert.equal(res.body.entitlements.includes('INVENTORY'), false);
    assert.deepEqual(res.body.usage, { activeSeats: 4, activeStores: 1 });
    assert.equal(res.body.limits.seatLimit, 4);
    assert.equal(res.body.limits.storeLimit, 1);
    assert.equal(res.body.billing.mode, 'LOCAL_MVP_MANUAL_BILLING');
  } finally {
    await stopTestServer(ctx);
  }
});

test('Starter subscription blocks adding more seats', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-seat-starter', 'ADMIN');
    const res = await request(ctx.port, 'POST', '/api/v1/users', {
      name: '第五人', role: 'CASHIER', pin: '4321',
    }, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 409);
    assert.equal(res.body.errorCode, 'SUBSCRIPTION_LIMIT_EXCEEDED');
    assert.equal(res.body.limitType, 'SEAT');
    assert.equal(res.body.limit, 4);
    assert.equal(res.body.current, 4);
  } finally {
    await stopTestServer(ctx);
  }
});

test('Growth subscription allows extra seats but prevents downgrade over Starter limit', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-seat-growth', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    await changePlan(ctx.port, auth, 'GROWTH', 'seat-growth-1');
    const create = await request(ctx.port, 'POST', '/api/v1/users', {
      name: '第五人', role: 'CASHIER', pin: '4321',
    }, auth);
    assert.equal(create.status, 200);
    const downgrade = await request(ctx.port, 'POST', '/api/v1/subscription/change', {
      planCode: 'STARTER', billingCycle: 'MONTHLY', idempotencyKey: 'seat-downgrade-1',
    }, auth);
    assert.equal(downgrade.status, 409);
    assert.equal(downgrade.body.errorCode, 'SUBSCRIPTION_LIMIT_EXCEEDED');
    assert.equal(downgrade.body.limitType, 'SEAT');
    assert.equal(downgrade.body.requested, 5);
  } finally {
    await stopTestServer(ctx);
  }
});

test('Starter blocks extra stores while Chain permits store creation', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-store-chain', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    const denied = await request(ctx.port, 'POST', '/api/v1/stores', { name: '二號店' }, auth);
    assert.equal(denied.status, 409);
    assert.equal(denied.body.errorCode, 'SUBSCRIPTION_LIMIT_EXCEEDED');
    assert.equal(denied.body.limitType, 'STORE');

    await changePlan(ctx.port, auth, 'CHAIN', 'store-chain-1');
    const created = await request(ctx.port, 'POST', '/api/v1/stores', { name: '二號店' }, auth);
    assert.equal(created.status, 200);
    assert.match(created.body.id, /^store-/);
    assert.equal(created.body.name, '二號店');
    const stores = await request(ctx.port, 'GET', '/api/v1/stores', null, auth);
    assert.equal(stores.status, 200);
    assert.equal(stores.body.items.filter((store) => store.status === 'ACTIVE').length, 2);
  } finally {
    await stopTestServer(ctx);
  }
});

test('Starter subscription blocks Growth-only membership routes', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-gate-membership', 'CASHIER');
    const res = await request(ctx.port, 'POST', '/api/v1/customers', {
      phone: '0912345678', name: 'Starter Member',
    }, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 403);
    assert.equal(res.body.errorCode, 'SUBSCRIPTION_FEATURE_NOT_INCLUDED');
    assert.equal(res.body.featureCode, 'MEMBERSHIP');
    assert.equal(res.body.requiredPlan, 'GROWTH');
    assert.equal(res.body.currentPlan, 'STARTER');
  } finally {
    await stopTestServer(ctx);
  }
});

test('Growth subscription unlocks inventory and membership routes', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-gate-growth', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    await changePlan(ctx.port, auth, 'GROWTH', 'growth-gate-1');

    const inventory = await request(ctx.port, 'GET', '/api/v1/inventory/levels', null, auth);
    assert.equal(inventory.status, 200);
    assert.ok(Array.isArray(inventory.body.items));

    const customer = await request(ctx.port, 'POST', '/api/v1/customers', {
      phone: '0912345678', name: 'Growth Member',
    }, auth);
    assert.equal(customer.status, 200);
    assert.equal(customer.body.phone, '0912345678');
  } finally {
    await stopTestServer(ctx);
  }
});

test('Growth subscription blocks Chain-only transfer until upgraded', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-gate-chain', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    const skuId = await firstSkuId(ctx.port, token);
    await changePlan(ctx.port, auth, 'GROWTH', 'growth-before-chain');

    const body = { skuId, qty: 1, fromStoreId: 'store-001', toStoreId: 'store-001' };
    const denied = await request(ctx.port, 'POST', '/api/v1/inventory/transfers', body, auth);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.errorCode, 'SUBSCRIPTION_FEATURE_NOT_INCLUDED');
    assert.equal(denied.body.featureCode, 'STORE_TRANSFER');
    assert.equal(denied.body.requiredPlan, 'CHAIN');

    const chain = await changePlan(ctx.port, auth, 'CHAIN', 'chain-gate-1');
    assert.ok(chain.body.entitlements.includes('STORE_TRANSFER'));
    const allowed = await request(ctx.port, 'POST', '/api/v1/inventory/transfers', body, auth);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.skuId, skuId);
    assert.equal(allowed.body.state, 'RECORDED_MANUAL');
  } finally {
    await stopTestServer(ctx);
  }
});

test('subscription change requires ADMIN role', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-permission', 'MANAGER');
    const res = await request(ctx.port, 'POST', '/api/v1/subscription/change', {
      planCode: 'GROWTH', billingCycle: 'MONTHLY', idempotencyKey: 'deny-1',
    }, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 403);
    assert.equal(res.body.errorCode, 'TENANT_NOT_AUTHORIZED');
  } finally {
    await stopTestServer(ctx);
  }
});

test('subscription change is idempotent and audited', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-change', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    const body = { planCode: 'GROWTH', billingCycle: 'MONTHLY', idempotencyKey: 'grow-1' };
    const first = await request(ctx.port, 'POST', '/api/v1/subscription/change', body, auth);
    assert.equal(first.status, 200);
    assert.equal(first.body.planCode, 'GROWTH');
    assert.equal(first.body.status, 'ACTIVE');
    assert.equal(first.body.paymentState, 'MANUAL_INVOICE_PENDING');
    assert.equal(first.body.duplicated, false);

    const replay = await request(ctx.port, 'POST', '/api/v1/subscription/change', body, auth);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicated, true);
    assert.equal(replay.body.planCode, 'GROWTH');

    const audit = await request(ctx.port, 'GET', '/api/v1/audit-logs?action=SUBSCRIPTION_CHANGED', null, auth);
    assert.equal(audit.status, 200);
    assert.equal(audit.body.items.length, 1);
  } finally {
    await stopTestServer(ctx);
  }
});

test('subscription rejects invalid plan', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-invalid', 'ADMIN');
    const res = await request(ctx.port, 'POST', '/api/v1/subscription/change', {
      planCode: 'ULTIMATE', billingCycle: 'MONTHLY', idempotencyKey: 'bad-1',
    }, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 400);
    assert.equal(res.body.errorCode, 'SUBSCRIPTION_PLAN_INVALID');
  } finally {
    await stopTestServer(ctx);
  }
});

test('subscription cancel marks cancellation at period end', async () => {
  const ctx = await startTestServer();
  try {
    const token = await loginAs(ctx.port, 'sub-cancel', 'ADMIN');
    const auth = { Authorization: `Bearer ${token}` };
    const res = await request(ctx.port, 'POST', '/api/v1/subscription/cancel', {
      reasonCode: 'OWNER_REQUEST', idempotencyKey: 'cancel-1',
    }, auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CANCELLED_AT_PERIOD_END');
    assert.equal(res.body.cancelAtPeriodEnd, true);
    const replay = await request(ctx.port, 'POST', '/api/v1/subscription/cancel', {
      reasonCode: 'OWNER_REQUEST', idempotencyKey: 'cancel-1',
    }, auth);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicated, true);
  } finally {
    await stopTestServer(ctx);
  }
});
