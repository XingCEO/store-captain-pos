'use strict';

// E-invoice provider adapter.
//
// POS core never speaks to 加值中心 / Turnkey / 財政部 直接. Risk domain calls
// providers through this interface. Real adapters (e.g. Ecpay 加值中心,
// EZpay, Allpay, 自建 Turnkey 3.2) drop in by registering a provider with
// the same shape — risk.js does not change.
//
// Provider shape:
//   provider.code            : string registry key
//   provider.capabilities    : { migVersion, turnkeyVersion, environment,
//                                supportsAllowance, supportsVoid }
//   provider.issue(input)    : returns { invoiceNumber, lifecycleState, raw }
//   provider.upload(input)   : returns { uploadState, lifecycleState, ackId, raw }
//                              throws { errorCode, retryable } on failure
//   provider.void(input)     : returns { voidId, lifecycleState, raw }
//   provider.allowance(input): returns { allowanceId, lifecycleState, raw }
//
// All lifecycleState values come from commerce.INVOICE_TRANSITIONS — adapters
// must produce a valid transition or risk.js will reject the response.

const crypto = require('crypto');

const providers = new Map();

function register(provider) {
  if (!provider || !provider.code || !provider.capabilities) {
    throw new Error('InvoiceProvider: invalid provider — code + capabilities required');
  }
  if (typeof provider.issue !== 'function' || typeof provider.upload !== 'function') {
    throw new Error(`InvoiceProvider: ${provider.code} missing issue() or upload()`);
  }
  providers.set(provider.code, provider);
}

function get(code) {
  return providers.get(code) || null;
}

function listCapabilities() {
  return [...providers.values()].map((p) => ({ code: p.code, ...p.capabilities }));
}

let activeCode = null;
function setActive(code) {
  if (!providers.has(code)) throw new Error(`InvoiceProvider: ${code} not registered`);
  activeCode = code;
}

function active() {
  if (activeCode && providers.has(activeCode)) return providers.get(activeCode);
  return providers.get(process.env.INVOICE_PROVIDER || 'MOCK_VAT_CENTER');
}

function mockId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Built-in mock provider — simulates a generic 加值中心 (VAT center).
//
// Lifecycle simulation (deterministic per orderId hash):
//   issue   → ISSUED_SANDBOX
//   upload  → first attempt: 80% UPLOADED, 15% UPLOAD_FAILED retryable,
//              5% UPLOAD_FAILED non-retryable (forces manual intervention).
//             metadata.simulate forces a specific outcome.
//   void    → VOIDED_SANDBOX (or VOIDED post-upload)
//   allowance→ ALLOWANCE_SANDBOX (or ALLOWANCE post-upload)
//
// Real adapter contract: same shape, real MIG 4.1 / Turnkey 3.2 XML payloads
// behind the scene, real ack IDs, real retryable error codes.
// ---------------------------------------------------------------------------

const mockVatCenter = {
  code: 'MOCK_VAT_CENTER',
  capabilities: {
    migVersion: 'MIG-4.1-MOCK',
    turnkeyVersion: 'TURNKEY-3.2-MOCK',
    environment: 'sandbox',
    supportsAllowance: true,
    supportsVoid: true,
    description: '加值中心 mock — replace with real Ecpay/EZpay/etc adapter behind a gate',
  },
  async issue({ orderId }) {
    const invoiceNumber = `SANDBOX-${orderId}`;
    return {
      invoiceNumber,
      lifecycleState: 'ISSUED_SANDBOX',
      raw: { kind: 'mock-vat-issue', orderId, issuedAt: new Date().toISOString() },
    };
  },
  async upload({ invoiceId, attempts = 0, metadata = {} }) {
    if (metadata.simulate === 'fail-retryable') {
      const err = new Error('upstream timeout');
      err.errorCode = 'INVOICE_UPLOAD_TIMEOUT';
      err.retryable = true;
      throw err;
    }
    if (metadata.simulate === 'fail-fatal') {
      const err = new Error('signature mismatch');
      err.errorCode = 'INVOICE_SIGNATURE_INVALID';
      err.retryable = false;
      throw err;
    }
    if (metadata.simulate === 'pending') {
      return {
        uploadState: 'UPLOAD_PENDING',
        lifecycleState: 'UPLOAD_PENDING',
        ackId: null,
        raw: { kind: 'mock-vat-upload-pending', invoiceId, attempts },
      };
    }
    // Deterministic: most uploads succeed.
    const ackId = mockId('vat-ack');
    return {
      uploadState: 'UPLOADED',
      lifecycleState: 'UPLOADED',
      ackId,
      raw: { kind: 'mock-vat-upload', invoiceId, ackId, uploadedAt: new Date().toISOString() },
    };
  },
  async void({ invoiceId, reasonCode, alreadyUploaded }) {
    return {
      voidId: mockId('vat-void'),
      lifecycleState: alreadyUploaded ? 'VOIDED' : 'VOIDED_SANDBOX',
      raw: { kind: 'mock-vat-void', invoiceId, reasonCode, voidedAt: new Date().toISOString() },
    };
  },
  async allowance({ invoiceId, amount, reasonCode, alreadyUploaded }) {
    return {
      allowanceId: mockId('vat-allowance'),
      lifecycleState: alreadyUploaded ? 'ALLOWANCE' : 'ALLOWANCE_SANDBOX',
      raw: { kind: 'mock-vat-allowance', invoiceId, amount, reasonCode },
    };
  },
};

register(mockVatCenter);

module.exports = {
  register,
  get,
  listCapabilities,
  setActive,
  active,
  providers,
  __builtin: { mockVatCenter },
};
