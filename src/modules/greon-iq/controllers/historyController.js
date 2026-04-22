'use strict';

// ============================================================================
// historyController.js — Chat history endpoints
//
// GET    /api/greon-iq/history               — list sessions (paginated)
// GET    /api/greon-iq/history/:sessionId    — messages in a session
// DELETE /api/greon-iq/history/:sessionId    — manual delete (no quota refund)
// PATCH  /api/greon-iq/history/:sessionId/pin — toggle pin on a session
// POST   /api/greon-iq/messages/:messageId/feedback — like/dislike toggle
//
// History endpoints remain accessible even when quota is exhausted.
// ============================================================================

const { listHistory, getSessionHistory, deleteHistory } = require('../services/chatHistoryService');
const ChatSession            = require('../models/ChatSession');
const ChatMessage            = require('../models/ChatMessage');
const GreOnIQInteractionEvent = require('../models/GreOnIQInteractionEvent');

async function list(req, res) {
  try {
    const user     = req.user;
    const clientId = user.clientId || req.query.clientId;
    if (!clientId) {
      return res.status(400).json({ success: false, code: 'MISSING_CLIENT_ID', message: 'clientId is required.' });
    }

    const result = await listHistory(String(user._id), String(clientId), req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[GreOnIQ] history list error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

async function getSession(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await getSessionHistory(sessionId, String(req.user._id), req.query);
    if (!result) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Session not found.' });
    }
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[GreOnIQ] history getSession error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

async function deleteSession(req, res) {
  try {
    const { sessionId } = req.params;
    const result = await deleteHistory(sessionId, String(req.user._id));
    if (!result.deleted) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Session not found.' });
    }
    return res.status(200).json({
      success: true,
      message: 'Session deleted. Credits are not refunded for manual deletes.',
    });
  } catch (err) {
    console.error('[GreOnIQ] history delete error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

async function togglePin(req, res) {
  try {
    const { sessionId } = req.params;
    const userId  = req.user._id;
    const clientId = req.user.clientId || req.query.clientId;

    const session = await ChatSession.findOne({ _id: sessionId, userId });
    if (!session) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Session not found.' });
    }

    session.isPinned = !session.isPinned;
    await session.save();

    // Record interaction event for analytics
    try {
      await GreOnIQInteractionEvent.create({
        userId,
        clientId: clientId || session.clientId,
        sessionId: session._id,
        messageId: null,
        eventType: session.isPinned ? 'pin' : 'unpin',
      });
    } catch (eventErr) {
      console.error('[GreOnIQ] interaction event write error (non-fatal):', eventErr.message);
    }

    return res.status(200).json({ success: true, isPinned: session.isPinned });
  } catch (err) {
    console.error('[GreOnIQ] togglePin error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

async function messageFeedback(req, res) {
  try {
    const { messageId } = req.params;
    const { value }     = req.body;
    const userId  = req.user._id;
    const clientId = req.user.clientId || req.query.clientId;

    const ALLOWED = ['like', 'dislike', null];
    if (!ALLOWED.includes(value)) {
      return res.status(400).json({
        success: false,
        code:    'INVALID_FEEDBACK_VALUE',
        message: "value must be 'like', 'dislike', or null.",
      });
    }

    const message = await ChatMessage.findOne({ _id: messageId, userId });
    if (!message) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Message not found.' });
    }

    message.feedback = { value, updatedAt: new Date() };
    await message.save();

    // Record interaction event for analytics
    const eventType = value === null ? 'feedback_clear' : value;
    try {
      await GreOnIQInteractionEvent.create({
        userId,
        clientId: clientId || message.clientId,
        sessionId: message.sessionId,
        messageId: message._id,
        eventType,
      });
    } catch (eventErr) {
      console.error('[GreOnIQ] interaction event write error (non-fatal):', eventErr.message);
    }

    return res.status(200).json({ success: true, feedback: value });
  } catch (err) {
    console.error('[GreOnIQ] messageFeedback error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

module.exports = { list, getSession, deleteSession, togglePin, messageFeedback };
