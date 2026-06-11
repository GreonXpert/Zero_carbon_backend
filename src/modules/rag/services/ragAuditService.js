'use strict';

const { v4: uuidv4 } = require('uuid');
const RagAuditLog    = require('../models/RagAuditLog');

const SENSITIVE_KEYS = ['password', 'token', 'secret', 'apiKey', 'embedding'];

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = { ...obj };
  for (const key of SENSITIVE_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
}

function extractIP(req) {
  if (!req) return null;
  return (
    req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.connection?.remoteAddress ||
    req.ip ||
    null
  );
}

const ragAuditService = {
  log({ action, actor, resource, before = null, after = null, context, metadata = {} }) {
    const entry = {
      action,
      actor: {
        userId:         actor?.id || actor?._id,
        email:          actor?.email,
        role:           actor?.userType || actor?.role,
        organizationId: actor?.clientId || actor?.organizationId
      },
      resource: {
        type:           resource?.type,
        id:             resource?.id,
        organizationId: resource?.organizationId || actor?.clientId
      },
      before:    before ? sanitize(before) : null,
      after:     after  ? sanitize(after)  : null,
      context: {
        ip:        extractIP(context?.req || context),
        userAgent: (context?.req || context)?.headers?.['user-agent'],
        requestId: (context?.req || context)?.headers?.['x-request-id'] ||
                   (context?.req || context)?.requestId ||
                   uuidv4(),
        sessionId: context?.sessionId
      },
      metadata,
      timestamp: new Date()
    };

    // Fire-and-forget — never let audit failure break the main request
    RagAuditLog.create(entry).catch(err => {
      console.error('[RAG_AUDIT] Failed to write audit log:', action, err.message);
    });
  }
};

module.exports = { ragAuditService };
