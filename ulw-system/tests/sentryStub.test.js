'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('sentry init is no-op when SENTRY_DSN unset', () => {
  delete process.env.SENTRY_DSN;
  delete require.cache[require.resolve('../src/core/sentry')];
  const sentry = require('../src/core/sentry');
  sentry.init();
  assert.equal(sentry.isEnabled(), false);
  // Capture functions never throw even when disabled
  sentry.captureException(new Error('test'));
  sentry.captureMessage('test', 'info');
});

test('tracing init is no-op when OTEL_EXPORTER_OTLP_ENDPOINT unset', () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete require.cache[require.resolve('../src/core/tracing')];
  const tracing = require('../src/core/tracing');
  tracing.init();
  assert.equal(tracing.isEnabled(), false);
});

test('assertSchemaCompatible passes for fresh deploy', () => {
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ulw-migrate-'));
  try {
    const { assertSchemaCompatible } = require('../src/db/migrate');
    // No store.db exists yet — should not throw
    assertSchemaCompatible(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
