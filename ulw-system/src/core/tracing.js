'use strict';

// OpenTelemetry tracing. No-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
// Must be required BEFORE any instrumented module (http, better-sqlite3) so
// auto-instrumentation hooks fire.

const { logger } = require('./logger');

let sdk = null;

function init() {
  if (sdk) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || 'ulw-system',
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      })],
    });
    sdk.start();
    logger.info({ endpoint }, 'OpenTelemetry SDK started');
  } catch (err) {
    logger.warn({ err: err.message }, 'OTel init failed; running without it');
    sdk = null;
  }
}

async function shutdown() {
  if (!sdk) return;
  try { await sdk.shutdown(); }
  catch (err) { logger.warn({ err: err.message }, 'OTel shutdown error'); }
  sdk = null;
}

function isEnabled() {
  return Boolean(sdk);
}

module.exports = { init, shutdown, isEnabled };
