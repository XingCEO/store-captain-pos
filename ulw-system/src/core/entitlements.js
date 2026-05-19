'use strict';

const PLAN_RANK = Object.freeze({ STARTER: 1, GROWTH: 2, CHAIN: 3 });

const PLANS = Object.freeze({
  STARTER: Object.freeze({
    code: 'STARTER',
    name: 'Starter',
    priceMonthly: 399,
    priceAnnual: 3990,
    storeLimit: 1,
    seatLimit: 4,
    entitlements: ['POS_CORE', 'ORDER_HUB', 'SANDBOX_INVOICE', 'CASH_DRAWER', 'DAILY_REPORT', 'SYNC_REPAIR', 'ROLES_AUDIT'],
    features: ['POS 收銀', '接單池', '沙盒電子發票流程', '開班交班', '日營收報表', '離線收銀與同步補救', '角色權限與 audit'],
  }),
  GROWTH: Object.freeze({
    code: 'GROWTH',
    name: 'Growth',
    priceMonthly: 899,
    priceAnnual: 8990,
    storeLimit: 1,
    seatLimit: 12,
    entitlements: ['POS_CORE', 'ORDER_HUB', 'SANDBOX_INVOICE', 'CASH_DRAWER', 'DAILY_REPORT', 'SYNC_REPAIR', 'ROLES_AUDIT', 'MEMBERSHIP', 'INVENTORY', 'AI_DAILY_BRIEF', 'CHANNEL_SYNC', 'ACCOUNTING_REPORTS'],
    features: ['Starter 全部功能', '會員優惠券點數', '庫存 ledger', 'AI 老闆日報', '外送平台同步', '三方對帳與會計 CSV'],
  }),
  CHAIN: Object.freeze({
    code: 'CHAIN',
    name: 'Chain',
    priceMonthly: 2500,
    priceAnnual: 25000,
    storeLimit: null,
    seatLimit: null,
    entitlements: ['POS_CORE', 'ORDER_HUB', 'SANDBOX_INVOICE', 'CASH_DRAWER', 'DAILY_REPORT', 'SYNC_REPAIR', 'ROLES_AUDIT', 'MEMBERSHIP', 'INVENTORY', 'AI_DAILY_BRIEF', 'CHANNEL_SYNC', 'ACCOUNTING_REPORTS', 'MULTI_STORE_DIAGNOSTICS', 'STORE_TRANSFER'],
    features: ['Growth 全部功能', '多店即時診斷', '跨店調撥', '區域報表', '細粒度 ACL', '導入治理'],
  }),
});

const FEATURE_MIN_PLAN = Object.freeze({
  MEMBERSHIP: 'GROWTH',
  INVENTORY: 'GROWTH',
  AI_DAILY_BRIEF: 'GROWTH',
  CHANNEL_SYNC: 'GROWTH',
  ACCOUNTING_REPORTS: 'GROWTH',
  MULTI_STORE_DIAGNOSTICS: 'CHAIN',
  STORE_TRANSFER: 'CHAIN',
});

function planList() {
  return Object.values(PLANS).map((plan) => ({ ...plan, entitlements: [...plan.entitlements], features: [...plan.features] }));
}

function currentSubscription(runtime, ctx) {
  runtime.ensureTenantDefaults(ctx.tenantId);
  return runtime.store.data.subscriptions.get(ctx.tenantId);
}

function entitlementsForPlan(planCode) {
  const plan = PLANS[planCode] || PLANS.STARTER;
  return [...plan.entitlements];
}

function subscriptionUsage(runtime, tenantId) {
  const activeSeats = [...runtime.store.data.users.values()].filter((user) => user.tenantId === tenantId && user.status !== 'DISABLED').length;
  const activeStores = [...runtime.store.data.stores.values()].filter((store) => store.tenantId === tenantId && store.status !== 'DISABLED').length;
  return { activeSeats, activeStores };
}

function planLimits(planCode) {
  const plan = PLANS[planCode] || PLANS.STARTER;
  return { planCode: plan.code, seatLimit: plan.seatLimit, storeLimit: plan.storeLimit };
}

function planLimitViolation(runtime, tenantId, planCode, additional = {}) {
  const limits = planLimits(planCode);
  const usage = subscriptionUsage(runtime, tenantId);
  const requestedSeats = usage.activeSeats + Number(additional.seats || 0);
  const requestedStores = usage.activeStores + Number(additional.stores || 0);
  if (limits.seatLimit !== null && requestedSeats > limits.seatLimit) {
    return { limitType: 'SEAT', planCode: limits.planCode, limit: limits.seatLimit, current: usage.activeSeats, requested: requestedSeats, usage, limits };
  }
  if (limits.storeLimit !== null && requestedStores > limits.storeLimit) {
    return { limitType: 'STORE', planCode: limits.planCode, limit: limits.storeLimit, current: usage.activeStores, requested: requestedStores, usage, limits };
  }
  return null;
}

function writeLimitExceeded(runtime, res, violation) {
  runtime.json(res, 409, runtime.error('SUBSCRIPTION_LIMIT_EXCEEDED', 'subscription plan limit exceeded', violation));
}

function requirePlanCapacity(runtime, res, ctx, planCode, additional = {}) {
  const violation = planLimitViolation(runtime, ctx.tenantId, planCode, additional);
  if (!violation) return true;
  writeLimitExceeded(runtime, res, violation);
  return false;
}

function requireCurrentPlanCapacity(runtime, res, ctx, additional = {}) {
  const record = currentSubscription(runtime, ctx);
  return requirePlanCapacity(runtime, res, ctx, record.planCode, additional);
}

function hasFeature(record, featureCode) {
  const requiredPlan = FEATURE_MIN_PLAN[featureCode];
  if (!requiredPlan) return true;
  if (!record || record.status === 'CANCELLED') return false;
  const currentRank = PLAN_RANK[record.planCode] || 0;
  return currentRank >= PLAN_RANK[requiredPlan];
}

function requireFeature(runtime, res, ctx, featureCode) {
  const record = currentSubscription(runtime, ctx);
  if (hasFeature(record, featureCode)) return true;
  const requiredPlan = FEATURE_MIN_PLAN[featureCode] || 'STARTER';
  runtime.json(res, 403, runtime.error('SUBSCRIPTION_FEATURE_NOT_INCLUDED', 'subscription plan does not include this feature', {
    featureCode,
    requiredPlan,
    currentPlan: record ? record.planCode : 'NONE',
    subscriptionStatus: record ? record.status : 'MISSING',
  }));
  return false;
}

module.exports = {
  PLANS,
  FEATURE_MIN_PLAN,
  planList,
  currentSubscription,
  entitlementsForPlan,
  subscriptionUsage,
  planLimits,
  planLimitViolation,
  requirePlanCapacity,
  requireCurrentPlanCapacity,
  requireFeature,
  hasFeature,
};
