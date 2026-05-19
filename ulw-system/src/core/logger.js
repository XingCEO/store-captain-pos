'use strict';

const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level,
  base: { svc: 'ulw-system' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-device-id"]',
      'headers.authorization',
      'headers.cookie',
      'headers["x-device-id"]',
      '*.token',
      '*.token_hash',
      '*.tokenHash',
      '*.refreshToken',
      '*.refresh_token',
      '*.challengeToken',
      '*.mfaSecret',
      '*.mfa_secret',
      '*.secret',
      '*.pin',
      '*.pin_hash',
      '*.pinHash',
      '*.password',
      '*.phone',
      '*.email',
      '*.tenantPublicKey',
      '*.code',
      'pin',
      'token',
      'refreshToken',
      'mfaSecret',
      'tenantPublicKey',
      'phone',
      'password',
    ],
    remove: false,
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

function childFor(bindings) {
  return logger.child(bindings || {});
}

module.exports = { logger, childFor };
