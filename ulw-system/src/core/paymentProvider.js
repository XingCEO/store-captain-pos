'use strict';

// Payment provider adapter.
//
// POS core MUST NOT speak to a PSP / LINE Pay / QR gateway directly. It calls
// providers through this interface, so swap-in of a real adapter (TapPay,
// LINE Pay, EasyCard, etc.) only requires registering the new provider —
// no commerce.js change. The mock providers below model the contract a real
// adapter will satisfy.
//
// Provider shape:
//   provider.code            : string registry key
//   provider.capabilities    : { method, settlementMode, requiresTerminal,
//                                refundSupported, feeBps }
//   provider.charge(input)   : returns { providerTransactionId, authorizationCode,
//                                        settlementState, fee, netSettledAmount,
//                                        raw } | throws { errorCode, message }
//   provider.refund(input)   : returns { providerRefundId, status, raw }
//   provider.settle?(input)  : optional — moves PENDING_SETTLEMENT → SETTLED
//
// settlementState vocabulary (POS side, not provider-side):
//   CASH_COUNTED_IN_DRAWER  | PENDING_CUSTOMER_SCAN | PENDING_SETTLEMENT
//   SETTLED                 | DECLINED              | FAILED
//
// PCI: providers MUST NOT echo PAN, CVV, magstripe or PIN block back. The
// mock providers below show what a compliant adapter looks like — last4 max.

const crypto = require('crypto');

const providers = new Map();

function register(provider) {
  if (!provider || !provider.code || !provider.capabilities) {
    throw new Error('PaymentProvider: invalid provider — code + capabilities required');
  }
  if (typeof provider.charge !== 'function') {
    throw new Error(`PaymentProvider: ${provider.code} missing charge()`);
  }
  providers.set(provider.code, provider);
}

function get(code) {
  return providers.get(code) || null;
}

function listCapabilities() {
  return [...providers.values()].map((p) => ({ code: p.code, ...p.capabilities }));
}

function mockId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

function feeFor(amount, bps) {
  if (!bps) return 0;
  return Math.ceil((amount * bps) / 10_000);
}

// ---------------------------------------------------------------------------
// Built-in providers (mock — production swap-in expected)
// ---------------------------------------------------------------------------

const cashDrawer = {
  code: 'CASH_DRAWER',
  capabilities: {
    method: 'CASH',
    settlementMode: 'CASH_DRAWER',
    requiresTerminal: false,
    refundSupported: true,
    feeBps: 0,
    description: '現金收銀 — POS-managed cash drawer, no external gateway',
  },
  async charge({ amount, idempotencyKey }) {
    return {
      providerTransactionId: null,
      authorizationCode: null,
      settlementState: 'CASH_COUNTED_IN_DRAWER',
      fee: 0,
      netSettledAmount: amount,
      raw: { kind: 'cash', idempotencyKey: idempotencyKey || null },
    };
  },
  async refund({ amount }) {
    return {
      providerRefundId: mockId('cash-refund'),
      status: 'CAPTURED',
      raw: { kind: 'cash-refund', amount },
    };
  },
};

// Mock card PSP — simulates TapPay / NewebPay / ESUN behavior.
// Set metadata.simulate = 'decline' to force a declined response.
const mockCard = {
  code: 'MOCK_CARD_PSP',
  capabilities: {
    method: 'CARD',
    settlementMode: 'NEXT_DAY',
    requiresTerminal: true,
    refundSupported: true,
    feeBps: 200, // 2.0%
    description: 'Mock card PSP — replace with real TapPay / NewebPay adapter behind a gate',
  },
  async charge({ amount, idempotencyKey, metadata }) {
    if (metadata && metadata.simulate === 'decline') {
      const err = new Error('card declined by issuer');
      err.errorCode = 'PAYMENT_DECLINED';
      err.providerRaw = { kind: 'mock-card', reason: 'INSUFFICIENT_FUNDS' };
      throw err;
    }
    const txn = mockId('psp-card');
    const fee = feeFor(amount, 200);
    return {
      providerTransactionId: txn,
      authorizationCode: `AUTH-${txn.slice(-8).toUpperCase()}`,
      settlementState: 'PENDING_SETTLEMENT',
      fee,
      netSettledAmount: amount - fee,
      raw: { kind: 'mock-card', idempotencyKey: idempotencyKey || null, last4: '4242' },
    };
  },
  async refund({ amount, originalProviderTransactionId }) {
    return {
      providerRefundId: mockId('psp-card-refund'),
      status: 'PENDING_GATEWAY',
      raw: { original: originalProviderTransactionId || null, amount },
    };
  },
  async settle({ providerTransactionId }) {
    return { settlementState: 'SETTLED', settledAt: new Date().toISOString(), providerTransactionId };
  },
};

// Mock QR gateway — covers TWQR / TaiwanPay aggregator pattern.
// Set metadata.simulate = 'pending' to return a pre-scan state.
const mockQr = {
  code: 'MOCK_QR_GATEWAY',
  capabilities: {
    method: 'QR',
    settlementMode: 'NEXT_DAY',
    requiresTerminal: false,
    refundSupported: true,
    feeBps: 150,
    description: 'Mock QR aggregator (TWQR style) — replace with real adapter behind a gate',
  },
  async charge({ amount, idempotencyKey, metadata }) {
    if (metadata && metadata.simulate === 'pending') {
      return {
        providerTransactionId: mockId('qr-pending'),
        authorizationCode: null,
        settlementState: 'PENDING_CUSTOMER_SCAN',
        fee: 0,
        netSettledAmount: 0,
        raw: { kind: 'mock-qr-pending', idempotencyKey: idempotencyKey || null },
      };
    }
    const txn = mockId('qr');
    const fee = feeFor(amount, 150);
    return {
      providerTransactionId: txn,
      authorizationCode: `QR-${txn.slice(-8).toUpperCase()}`,
      settlementState: 'PENDING_SETTLEMENT',
      fee,
      netSettledAmount: amount - fee,
      raw: { kind: 'mock-qr', idempotencyKey: idempotencyKey || null },
    };
  },
  async refund({ amount }) {
    return {
      providerRefundId: mockId('qr-refund'),
      status: 'PENDING_GATEWAY',
      raw: { kind: 'mock-qr-refund', amount },
    };
  },
};

// Mock mobile wallet — LINE Pay / JKOS / Apple Pay aggregator.
const mockMobile = {
  code: 'MOCK_LINE_PAY',
  capabilities: {
    method: 'MOBILE',
    settlementMode: 'NEXT_DAY',
    requiresTerminal: false,
    refundSupported: true,
    feeBps: 250,
    description: 'Mock mobile wallet (LINE Pay style) — replace with real LINE Pay adapter behind a gate',
  },
  async charge({ amount, idempotencyKey }) {
    const txn = mockId('line');
    const fee = feeFor(amount, 250);
    return {
      providerTransactionId: txn,
      authorizationCode: `LINE-${txn.slice(-8).toUpperCase()}`,
      settlementState: 'PENDING_SETTLEMENT',
      fee,
      netSettledAmount: amount - fee,
      raw: { kind: 'mock-line-pay', idempotencyKey: idempotencyKey || null },
    };
  },
  async refund({ amount }) {
    return {
      providerRefundId: mockId('line-refund'),
      status: 'PENDING_GATEWAY',
      raw: { kind: 'mock-line-refund', amount },
    };
  },
};

register(cashDrawer);
// Mock CARD / QR / MOBILE providers return fake authorization codes. They
// must NEVER be registered in production unless explicit operator ack via
// ALLOW_MOCK_PAYMENT_PROVIDERS=1. Otherwise a CASHIER hitting paymentMethod=
// CARD would receive a fake "approved" response and the customer walks out
// unpaid. Cash drawer always registers because it has no upstream side
// effects.
const allowMockProviders = process.env.NODE_ENV !== 'production'
  || process.env.ALLOW_MOCK_PAYMENT_PROVIDERS === '1';
if (allowMockProviders) {
  register(mockCard);
  register(mockQr);
  register(mockMobile);
}

function defaultProviderFor(method) {
  switch (method) {
    case 'CASH':   return cashDrawer;
    case 'CARD':   return mockCard;
    case 'QR':     return mockQr;
    case 'MOBILE': return mockMobile;
    default:       return null;
  }
}

module.exports = {
  register,
  get,
  listCapabilities,
  defaultProviderFor,
  providers,
  // Exported for tests:
  __builtin: { cashDrawer, mockCard, mockQr, mockMobile },
};
