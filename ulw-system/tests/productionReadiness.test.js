'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { validateStartupEnvironment } = require('../src/server');
const { startTestServer, stopTestServer, request, loginAs } = require('./helpers');

const VALID_PROD_ENV = Object.freeze({
  NODE_ENV: 'production',
  METRICS_TOKEN: 'metrics-secret',
  PIN_PEPPER: 'pin-pepper-secret',
  MFA_KEK: 'a'.repeat(64),
  ALLOWED_ORIGINS: 'https://pos.example.com',
  ENABLE_HSTS: '1',
});

function restoreEnv(snapshot) {
  for (const key of ['NODE_ENV', 'INVOICE_NON_PRODUCTION_ACK']) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

test('production startup preflight allows formal Starter service without demo mode', () => {
  const result = validateStartupEnvironment(VALID_PROD_ENV);
  assert.equal(result.ok, true);
  assert.equal(result.serviceMode, 'starter-production');
  assert.deepEqual(result.errors, []);
});

test('production startup preflight rejects missing secrets and wildcard origins', () => {
  const result = validateStartupEnvironment({ NODE_ENV: 'production', ALLOWED_ORIGINS: '*' });
  assert.equal(result.ok, false);
  assert(result.errors.includes('METRICS_TOKEN is required in production'));
  assert(result.errors.includes('PIN_PEPPER is required in production'));
  assert(result.errors.includes('MFA_KEK must be a 32-byte hex key in production'));
  assert(result.errors.includes('ALLOWED_ORIGINS must not include * in production'));
});

test('production startup preflight blocks mock payment providers outside demo mode', () => {
  const result = validateStartupEnvironment({ ...VALID_PROD_ENV, ALLOW_MOCK_PAYMENT_PROVIDERS: '1' });
  assert.equal(result.ok, false);
  assert(result.errors.includes('ALLOW_MOCK_PAYMENT_PROVIDERS is only allowed with DEMO_MODE=1'));
});

test('production payment registry exposes only cash unless mock providers are explicitly acknowledged', () => {
  const script = `
    const pp = require('./src/core/paymentProvider');
    process.stdout.write(JSON.stringify({
      caps: pp.listCapabilities().map((item) => item.code).sort(),
      card: pp.defaultProviderFor('CARD'),
      cash: pp.defaultProviderFor('CASH').code
    }));
  `;
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', ALLOW_MOCK_PAYMENT_PROVIDERS: '' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.deepEqual(payload.caps, ['CASH_DRAWER']);
  assert.equal(payload.card, null);
  assert.equal(payload.cash, 'CASH_DRAWER');
});

test('production blocks sandbox invoice routes without explicit non-production ack', async () => {
  const ctx = await startTestServer();
  const snapshot = {
    NODE_ENV: process.env.NODE_ENV,
    INVOICE_NON_PRODUCTION_ACK: process.env.INVOICE_NON_PRODUCTION_ACK,
  };
  try {
    const token = await loginAs(ctx.port, 'prod-invoice-gate', 'MANAGER');
    process.env.NODE_ENV = 'production';
    delete process.env.INVOICE_NON_PRODUCTION_ACK;
    const res = await request(ctx.port, 'GET', '/api/v1/invoices/health', null, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 403);
    assert.equal(res.body.errorCode, 'NON_PRODUCTION_FEATURE_DISABLED');
    assert.equal(res.headers['x-environment'], 'disabled');
  } finally {
    restoreEnv(snapshot);
    await stopTestServer(ctx);
  }
});
