'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { invoiceTransitionAllowed } = require('../src/domains/commerce');

test('ISSUED_SANDBOX → UPLOAD_PENDING allowed', () => {
  assert.equal(invoiceTransitionAllowed('ISSUED_SANDBOX', 'UPLOAD_PENDING'), true);
});

test('ISSUED_SANDBOX → UPLOADED not allowed', () => {
  assert.equal(invoiceTransitionAllowed('ISSUED_SANDBOX', 'UPLOADED'), false);
});

test('VOIDED_SANDBOX is terminal', () => {
  assert.equal(invoiceTransitionAllowed('VOIDED_SANDBOX', 'UPLOAD_PENDING'), false);
  assert.equal(invoiceTransitionAllowed('VOIDED_SANDBOX', 'ISSUED_SANDBOX'), false);
});

test('UPLOAD_PENDING → UPLOADED allowed', () => {
  assert.equal(invoiceTransitionAllowed('UPLOAD_PENDING', 'UPLOADED'), true);
});

test('UPLOAD_FAILED can retry to UPLOAD_PENDING', () => {
  assert.equal(invoiceTransitionAllowed('UPLOAD_FAILED', 'UPLOAD_PENDING'), true);
});

test('same-state transition is allowed (idempotent)', () => {
  assert.equal(invoiceTransitionAllowed('ISSUED_SANDBOX', 'ISSUED_SANDBOX'), true);
});
