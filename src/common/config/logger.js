'use strict';

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // Redact sensitive fields wherever they appear in the log record.
  // Paths follow the serialized shape pino-http produces.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.body.password',
      'req.body.token',
      'req.body.apiKey',
      'req.body.refreshToken',
    ],
    censor: '[REDACTED]',
  },

  // Dev: coloured human-readable output via pino-pretty.
  // Production: plain JSON (fastest, pipe to log aggregator).
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
    : undefined,
});

module.exports = logger;
