'use strict';

// ============================================================================
// auditService.js — Writes ChatAuditLog records for every GreOn IQ query
//
// Audit logs are immutable — they are never deleted by retention cleanup,
// manual session delete, or user deactivation.
// ============================================================================

const ChatAuditLog = require('../models/ChatAuditLog');

/**
 * Write an audit log entry. Never throws — errors are silently suppressed
 * so a logging failure never breaks the query pipeline.
 *
 * @param {object} payload
 */
async function writeAuditLog(payload) {
  try {
    await ChatAuditLog.create({
      userId:              payload.userId,
      userType:            payload.userType,
      clientId:            payload.clientId,
      sessionId:           payload.sessionId    || null,
      messageId:           payload.messageId    || null,
      question:            payload.question     || '',
      normalizedIntent:    payload.normalizedIntent  || null,
      detectedProduct:     payload.detectedProduct   || null,
      queryPlan:           payload.queryPlan          || null,
      modulesUsed:         payload.modulesUsed        || [],
      recordsTouchedCount: payload.recordsTouchedCount || 0,
      excludedDomains:     payload.excludedDomains    || [],
      aiRequestMeta:       payload.aiRequestMeta      || {},
      aiResponseMeta:      payload.aiResponseMeta     || {},
      durationMs:          payload.durationMs         || 0,
      quotaConsumed:       payload.quotaConsumed       || 0,
      status:              payload.status             || 'error',
    });
  } catch (err) {
    // Audit failure must never propagate — log to console only
    console.error('[GreOnIQ] auditService: failed to write audit log:', err.message);
  }
}

module.exports = { writeAuditLog };
