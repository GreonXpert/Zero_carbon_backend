'use strict';

// ============================================================================
// historyController.js — Chat history endpoints
//
// GET  /api/greon-iq/history               — list sessions (paginated)
// GET  /api/greon-iq/history/:sessionId    — messages in a session
// DELETE /api/greon-iq/history/:sessionId  — manual delete (no quota refund)
//
// History endpoints remain accessible even when quota is exhausted.
// ============================================================================

const { listHistory, getSessionHistory, deleteHistory } = require('../services/chatHistoryService');

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

module.exports = { list, getSession, deleteSession };
