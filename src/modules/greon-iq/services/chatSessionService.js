'use strict';

// ============================================================================
// chatSessionService.js — CRUD for ChatSession and ChatMessage
//
// Session lifecycle:
//   - getOrCreateSession() finds the last active session or creates a new one
//   - saveMessage() appends user+assistant messages to the session
//   - updateContextState() keeps contextState in sync after each turn
//   - Sessions are soft-closed (isActive: false) by retention trim
// ============================================================================

const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');

/**
 * Find an existing session or create a new one.
 *
 * @param {string} userId
 * @param {string} clientId
 * @param {string} [sessionId]  — if provided, tries to find that specific session
 * @returns {Promise<object>}
 */
async function getOrCreateSession(userId, clientId, sessionId) {
  if (sessionId) {
    const existing = await ChatSession.findOne({
      _id: sessionId, userId, clientId, isActive: true,
    });
    if (existing) return existing;
  }

  // Create a new session
  const session = await ChatSession.create({
    userId,
    clientId,
    title:     null,   // auto-set on first message
    isActive:  true,
    contextState: {},
  });
  return session;
}

/**
 * Save a user question + assistant response as messages in the session.
 * Also updates the session's contextState and auto-title if not yet set.
 *
 * @param {string} sessionId
 * @param {object} opts
 */
async function saveMessage(sessionId, opts) {
  const {
    userId, clientId,
    userQuestion, answer, outputMode, tables, charts,
    exclusions, followupQuestions, quotaUsed, aiMeta, trace,
  } = opts;

  // Save the user message
  const userMsg = await ChatMessage.create({
    sessionId,
    userId,
    clientId,
    role:    'user',
    content: userQuestion,
  });

  // Save the assistant message
  const assistantMsg = await ChatMessage.create({
    sessionId,
    userId,
    clientId,
    role:             'assistant',
    content:          answer,
    outputMode:       outputMode || 'text',
    tables:           tables     || [],
    charts:           charts     || [],
    exclusions:       exclusions || [],
    followupQuestions:followupQuestions || [],
    quotaUsed:        quotaUsed  || 0,
    aiMeta:           aiMeta     || {},
    trace,
  });

  // Update session context and title
  const session = await ChatSession.findById(sessionId);
  if (session) {
    if (!session.title && userQuestion) {
      session.title = userQuestion.slice(0, 80);
    }
    session.updatedAt = new Date();
    await session.save();
  }

  return { userMsg, assistantMsg };
}

/**
 * Update context state in the session for follow-up resolution.
 * @param {string} sessionId
 * @param {object} contextPatch  — partial contextState fields
 */
async function updateContextState(sessionId, contextPatch) {
  await ChatSession.findByIdAndUpdate(sessionId, {
    $set: Object.fromEntries(
      Object.entries(contextPatch).map(([k, v]) => [`contextState.${k}`, v])
    ),
  });
}

/**
 * Get paginated list of sessions for a user.
 */
async function listSessions(userId, clientId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const [sessions, total] = await Promise.all([
    ChatSession.find({ userId, clientId, isActive: true })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ChatSession.countDocuments({ userId, clientId, isActive: true }),
  ]);
  return { sessions, total, page, limit };
}

/**
 * Get messages for a session (paginated).
 */
async function getMessages(sessionId, userId, { page = 1, limit = 50 } = {}) {
  // Verify session belongs to user
  const session = await ChatSession.findOne({ _id: sessionId, userId }).lean();
  if (!session) return null;

  const skip = (page - 1) * limit;
  const [messages, total] = await Promise.all([
    ChatMessage.find({ sessionId })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ChatMessage.countDocuments({ sessionId }),
  ]);
  return { session, messages, total, page, limit };
}

/**
 * Delete a session and all its messages (manual delete, no quota refund).
 * Audit logs are NOT deleted.
 */
async function deleteSession(sessionId, userId) {
  const session = await ChatSession.findOne({ _id: sessionId, userId });
  if (!session) return { deleted: false, reason: 'not_found' };

  await ChatMessage.deleteMany({ sessionId });
  await ChatSession.findByIdAndDelete(sessionId);
  return { deleted: true };
}

module.exports = {
  getOrCreateSession,
  saveMessage,
  updateContextState,
  listSessions,
  getMessages,
  deleteSession,
};
