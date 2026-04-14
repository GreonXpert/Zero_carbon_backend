// services/survey/surveyTokenService.js
// Token and anonymous-code generation/validation for employee commuting surveys.
// Builds on the patterns in utils/ApiKey/keyGenerator.js.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10; // Lower than API keys (12) since survey tokens are shorter-lived

/**
 * Generate a cryptographically secure survey token.
 * Returns the plaintext token — call this once and return it to the caller.
 * The plaintext should NOT be persisted; store only the hash.
 *
 * @returns {string} 40-char URL-safe base64url token
 */
function generateSurveyToken() {
  const bytes = crypto.randomBytes(30); // 30 bytes → 40 chars base64url
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 40);
}

/**
 * Hash a survey token (or anonymous code) for DB storage.
 * @param {string} plaintext
 * @returns {Promise<string>} bcrypt hash
 */
async function hashToken(plaintext) {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

/**
 * Verify a plaintext token against a stored bcrypt hash.
 * @param {string} plaintext
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyToken(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Return the first N characters of a token for admin display (safe to show).
 * @param {string} token
 * @param {number} [n=8]
 * @returns {string}
 */
function tokenPrefix(token, n = 8) {
  return token.substring(0, n);
}

/**
 * Generate a human-readable anonymous code.
 * Format: <CLIENT_SHORT>_<DEPT_SHORT>_<NNN>
 * e.g. ACME_Sales_001
 *
 * @param {string} clientShortName   – Short name / abbreviation for the client
 * @param {string} deptName          – Department name (used as-is, spaces replaced)
 * @param {number} sequence          – 1-based sequence number within the batch
 * @returns {string}
 */
function generateAnonymousCode(clientShortName, deptName, sequence) {
  const client = (clientShortName || 'ORG').replace(/\s+/g, '').toUpperCase().substring(0, 8);
  const dept = (deptName || 'GEN').replace(/\s+/g, '').substring(0, 10);
  const seq = String(sequence).padStart(3, '0');
  return `${client}_${dept}_${seq}`;
}

/**
 * Check whether a SurveyLink has expired based on its stored expiresAt date.
 * @param {Object} surveyLink – Mongoose document with expiresAt field
 * @returns {boolean}
 */
function isSurveyLinkExpired(surveyLink) {
  if (!surveyLink || !surveyLink.expiresAt) return true;
  return new Date() > new Date(surveyLink.expiresAt);
}

/**
 * Calculate the expiry date for a survey link.
 * Default: 30 days from now (can be overridden by caller).
 * @param {number} [daysFromNow=30]
 * @returns {Date}
 */
function calculateLinkExpiry(daysFromNow = 30) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d;
}

module.exports = {
  generateSurveyToken,
  hashToken,
  verifyToken,
  tokenPrefix,
  generateAnonymousCode,
  isSurveyLinkExpired,
  calculateLinkExpiry,
};
