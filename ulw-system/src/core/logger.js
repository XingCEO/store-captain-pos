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
      'headers.authorization',
      'headers.cookie',
      '*.token',
      '*.pin',
      'pin',
      'token',
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
