'use strict';

// ============================================================================
// chatHistoryService.js — Paginated history retrieval for GreOn IQ
//
// History endpoints remain open even when quota is exhausted.
// Manual delete removes session + messages but NOT audit logs.
// ============================================================================

const { listSessions, getMessages, deleteSession } = require('./chatSessionService');

/**
 * List retained sessions for a user (paginated).
 */
async function listHistory(userId, clientId, query = {}) {
  const page  = parseInt(query.page,  10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 20, 50);
  return listSessions(userId, clientId, { page, limit });
}

/**
 * Get messages for a session (paginated).
 */
async function getSessionHistory(sessionId, userId, query = {}) {
  const page  = parseInt(query.page,  10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 50, 100);
  return getMessages(sessionId, userId, { page, limit });
}

/**
 * Manually delete a session. Does not refund credits.
 */
async function deleteHistory(sessionId, userId) {
  return deleteSession(sessionId, userId);
}

module.exports = { listHistory, getSessionHistory, deleteHistory };
