'use strict';

const {
  PLANS,
  planList,
  currentSubscription,
  entitlementsForPlan,
  subscriptionUsage,
  planLimits,
  requirePlanCapacity,
} = require('../core/entitlements');

const VALID_BILLING_CYCLES = new Set(['MONTHLY', 'ANNUAL']);
const VALID_CANCEL_REASONS = new Set(['STORE_CLOSED', 'SWITCH_VENDOR', 'DUPLICATE_ACCOUNT', 'OWNER_REQUEST']);

function responseFor(runtime, record) {
  const plan = PLANS[record.planCode];
  return {
    ...record,
    entitlements: entitlementsForPlan(record.planCode),
    usage: subscriptionUsage(runtime, record.tenantId),
    limits: planLimits(record.planCode),
    plan: plan ? { ...plan, entitlements: [...plan.entitlements], features: [...plan.features] } : null,
    billing: {
      mode: record.billingMode,
      paymentState: record.paymentState,
      externalPspConnected: false,
      note: 'LOCAL_MVP_MANUAL_BILLING：此版本只記錄訂閱與人工帳務狀態，不自動扣款。',
    },
  };
}

function storeIdempotency(runtime, key, fingerprint, response) {
  runtime.store.data.idempotency.set(key, { fingerprint, response, createdAt: runtime.nowIso() });
}

function idempotencyResult(runtime, res, key, body) {
  const previous = runtime.store.data.idempotency.get(key);
  if (!previous) return null;
  if (previous.fingerprint === runtime.requestFingerprint(body)) {
    runtime.json(res, 200, { ...previous.response, duplicated: true });
  } else {
    runtime.json(res, 409, runtime.error('SUBSCRIPTION_IDEMPOTENCY_CONFLICT', 'idempotency key payload mismatch'));
  }
  return true;
}

function register(router, runtime) {
  const { store } = runtime;

  router.add('GET', '/api/v1/subscription/plans', async ({ res }) => {
    runtime.json(res, 200, { items: planList(), billingMode: 'LOCAL_MVP_MANUAL_BILLING' });
  });

  router.add('GET', '/api/v1/subscription/current', async ({ res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'MANAGER')) return;
    runtime.json(res, 200, responseFor(runtime, currentSubscription(runtime, ctx)));
  });

  router.add('POST', '/api/v1/subscription/change', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'ADMIN')) return;
    const body = await runtime.parseBody(req);
    const idempotencyKey = String(body.idempotencyKey || '').trim();
    if (!idempotencyKey) { runtime.json(res, 400, runtime.error('IDEMPOTENCY_KEY_MISMATCH', 'idempotencyKey required')); return; }
    const idemKey = `${ctx.tenantId}:subscription:change:${idempotencyKey}`;
    if (idempotencyResult(runtime, res, idemKey, body)) return;

    const planCode = String(body.planCode || '').trim().toUpperCase();
    const billingCycle = String(body.billingCycle || 'MONTHLY').trim().toUpperCase();
    const plan = PLANS[planCode];
    if (!plan || !VALID_BILLING_CYCLES.has(billingCycle)) {
      runtime.json(res, 400, runtime.error('SUBSCRIPTION_PLAN_INVALID', 'planCode or billingCycle invalid'));
      return;
    }

    const current = currentSubscription(runtime, ctx);
    if (current.status === 'CANCELLED') {
      runtime.json(res, 409, runtime.error('SUBSCRIPTION_STATE_INVALID', 'cancelled subscription cannot be changed'));
      return;
    }
    if (!requirePlanCapacity(runtime, res, ctx, planCode)) return;

    const at = runtime.nowIso();
    const nextStatus = 'ACTIVE';
    const nextPaymentState = 'MANUAL_INVOICE_PENDING';
    const periodDays = billingCycle === 'ANNUAL' ? 365 : 30;
    const next = {
      ...current,
      planCode,
      status: nextStatus,
      billingCycle,
      storeLimit: plan.storeLimit,
      seatLimit: plan.seatLimit,
      billingMode: 'LOCAL_MVP_MANUAL_BILLING',
      paymentState: nextPaymentState,
      currentPeriodStart: at,
      currentPeriodEnd: new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      updatedAt: at,
      requestedBy: ctx.userId,
    };
    store.data.subscriptions.set(ctx.tenantId, next);
    runtime.addAudit(ctx, 'SUBSCRIPTION_CHANGED', 'SUBSCRIPTION', next.id,
      { planCode: current.planCode, status: current.status, billingCycle: current.billingCycle },
      { planCode: next.planCode, status: next.status, billingCycle: next.billingCycle, paymentState: next.paymentState });
    const response = { ...responseFor(runtime, next), duplicated: false };
    storeIdempotency(runtime, idemKey, runtime.requestFingerprint(body), response);
    runtime.json(res, 200, response);
  });

  router.add('POST', '/api/v1/subscription/cancel', async ({ req, res, ctx }) => {
    if (!runtime.requireTenant(res, ctx) || !runtime.requireRole(res, ctx, 'ADMIN')) return;
    const body = await runtime.parseBody(req);
    const idempotencyKey = String(body.idempotencyKey || '').trim();
    if (!idempotencyKey) { runtime.json(res, 400, runtime.error('IDEMPOTENCY_KEY_MISMATCH', 'idempotencyKey required')); return; }
    const idemKey = `${ctx.tenantId}:subscription:cancel:${idempotencyKey}`;
    if (idempotencyResult(runtime, res, idemKey, body)) return;
    const reasonCode = String(body.reasonCode || '').trim().toUpperCase();
    if (!VALID_CANCEL_REASONS.has(reasonCode)) {
      runtime.json(res, 400, runtime.error('SUBSCRIPTION_STATE_INVALID', 'reasonCode invalid'));
      return;
    }
    const current = currentSubscription(runtime, ctx);
    if (current.status === 'CANCELLED_AT_PERIOD_END' || current.status === 'CANCELLED') {
      runtime.json(res, 409, runtime.error('SUBSCRIPTION_STATE_INVALID', 'subscription already cancelling or cancelled'));
      return;
    }
    const next = {
      ...current,
      status: 'CANCELLED_AT_PERIOD_END',
      cancelAtPeriodEnd: true,
      cancelReasonCode: reasonCode,
      cancelledBy: ctx.userId,
      updatedAt: runtime.nowIso(),
    };
    store.data.subscriptions.set(ctx.tenantId, next);
    runtime.addAudit(ctx, 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION', next.id,
      { status: current.status, planCode: current.planCode },
      { status: next.status, planCode: next.planCode, reasonCode });
    const response = { ...responseFor(runtime, next), duplicated: false };
    storeIdempotency(runtime, idemKey, runtime.requestFingerprint(body), response);
    runtime.json(res, 200, response);
  });
}

module.exports = { register, PLANS };
