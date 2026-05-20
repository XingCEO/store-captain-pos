'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DEV_SECRET = 'store-captain-dev-order-lookup-secret';

function tokenSecret() {
  return process.env.ORDER_LOOKUP_HMAC_SECRET
    || process.env.PIN_PEPPER
    || DEFAULT_DEV_SECRET;
}

function base64urlJson(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeBase64urlJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function hmac(payloadPart) {
  return crypto.createHmac('sha256', tokenSecret()).update(payloadPart).digest('base64url');
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  try { return crypto.timingSafeEqual(left, right); } catch { return false; }
}

function signOrderLookupToken(order, opts = {}) {
  const ttlMs = Number(process.env.ORDER_LOOKUP_TOKEN_TTL_MS || DEFAULT_TTL_MS);
  const nowMs = Number(opts.nowMs || Date.now());
  const payload = {
    v: 1,
    o: order.id || order.orderId,
    t: order.tenantId,
    s: order.storeId,
    c: order.source || opts.source || 'POS',
    e: nowMs + ttlMs,
  };
  const body = base64urlJson(payload);
  return `${body}.${hmac(body)}`;
}

function verifyOrderLookupToken(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'malformed' };
  }
  const expected = hmac(parts[0]);
  if (!safeEqualString(parts[1], expected)) {
    return { ok: false, error: 'signature' };
  }
  let payload;
  try {
    payload = decodeBase64urlJson(parts[0]);
  } catch {
    return { ok: false, error: 'payload' };
  }
  const normalized = {
    orderId: payload.o || payload.orderId,
    tenantId: payload.t || payload.tenantId,
    storeId: payload.s || payload.storeId,
    source: payload.c || payload.source,
    exp: payload.e || payload.exp,
  };
  if (payload.v !== 1 || !normalized.orderId || !normalized.tenantId || !normalized.storeId) {
    return { ok: false, error: 'payload' };
  }
  if (!Number.isFinite(Number(normalized.exp)) || Number(normalized.exp) <= Date.now()) {
    return { ok: false, error: 'expired' };
  }
  return { ok: true, payload: normalized };
}

module.exports = { signOrderLookupToken, verifyOrderLookupToken };
