// utils/OCR/ocrSessionStore.js
// In-memory TTL session store for OCR extraction sessions.
//
// Sessions hold the extraction preview data between the /ocr-extract
// and /ocr-confirm steps. They are intentionally ephemeral:
// - If the server restarts, sessions are lost — user must re-upload.
// - Sessions expire after SESSION_TTL_MS (default 30 minutes).
// - A cleanup interval purges expired sessions every 5 minutes.
//
// If the application scales to multiple processes, replace this with
// Redis or a lightweight MongoDB collection.

'use strict';

const { v4: uuidv4 } = require('uuid');

const SESSION_TTL_MS = parseInt(process.env.OCR_SESSION_TTL_MINUTES || '30', 10) * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

/** @type {Map<string, object>} */
const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP JOB
// ─────────────────────────────────────────────────────────────────────────────
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Allow Node.js to exit cleanly even if this interval is still running
if (cleanupInterval.unref) cleanupInterval.unref();

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new extraction session.
 *
 * @param {object} data  Session payload (clientId, nodeId, scopeIdentifier, records, etc.)
 * @returns {string} extractionId — UUID to reference this session on confirm
 */
function createSession(data) {
  const id = uuidv4();
  const now = Date.now();
  sessions.set(id, {
    ...data,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  });
  return id;
}

/**
 * Retrieve an active session by extractionId.
 * Returns null if the session does not exist or has expired.
 *
 * @param {string} id
 * @returns {object|null}
 */
function getSession(id) {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(id);
    return null;
  }
  return session;
}

/**
 * Delete a session explicitly (after successful confirm).
 *
 * @param {string} id
 */
function deleteSession(id) {
  sessions.delete(id);
}

/**
 * Get the ISO expiry timestamp for a session (for including in responses).
 *
 * @param {string} id
 * @returns {string|null} ISO datetime string or null
 */
function getSessionExpiry(id) {
  const session = sessions.get(id);
  if (!session) return null;
  return new Date(session.expiresAt).toISOString();
}

/**
 * Current count of active sessions (for monitoring/debug).
 */
function activeSessionCount() {
  return sessions.size;
}

module.exports = {
  createSession,
  getSession,
  deleteSession,
  getSessionExpiry,
  activeSessionCount
};
