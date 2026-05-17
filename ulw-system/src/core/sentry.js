'use strict';

// Sentry integration. No-op when SENTRY_DSN is unset so local dev stays clean.
// Hook into pino error path so any logger.error(...) call also captures.

const { logger } = require('./logger');

let initialized = false;
let Sentry = null;

function init() {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || (process.env.NODE_ENV || 'development'),
      release: process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    });
    initialized = true;
    logger.info({ dsnHost: new URL(dsn).host }, 'sentry initialized');
  } catch (err) {
    logger.warn({ err: err.message }, 'sentry init failed; running without it');
  }
}

function captureException(err, extra) {
  if (!initialized || !Sentry) return;
  try { Sentry.captureException(err, { extra }); }
  catch { /* sentry transport may fail under load — never block request */ }
}

function captureMessage(message, level = 'error', extra) {
  if (!initialized || !Sentry) return;
  try { Sentry.captureMessage(message, { level, extra }); }
  catch { /* sentry transport may fail */ }
}

function flush(timeoutMs = 2000) {
  if (!initialized || !Sentry) return Promise.resolve();
  return Sentry.close(timeoutMs);
}

function isEnabled() {
  return initialized;
}

module.exports = { init, captureException, captureMessage, flush, isEnabled };
