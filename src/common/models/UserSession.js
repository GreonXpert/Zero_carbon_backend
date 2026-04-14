/**
 * models/UserSession.js
 *
 * Tracks one active login session per token.
 * Used to enforce concurrentLoginLimit on User.
 *
 * TTL index on `expiresAt` means MongoDB auto-removes expired documents —
 * no manual cron job needed.
 */

const mongoose = require('mongoose');

const userSessionSchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    /**
     * Unique opaque identifier embedded in the JWT payload.
     * Generated with crypto.randomBytes(32).toString('hex') at login time.
     * The auth middleware verifies this value exists in the DB and isActive.
     */
    sessionId: {
      type: String,
      required: true,
      unique: true
    },

    // ── Device / Network metadata (no frontend changes required) ─────────
    userAgent: { type: String, default: 'unknown' },
    ip:        { type: String, default: 'unknown' },

    // ── Lifecycle ────────────────────────────────────────────────────────
    /**
     * Set to false by logout or by an admin force-revoke.
     * Expired sessions are removed automatically by the TTL index;
     * you only need isActive:false for explicit revocation before expiry.
     */
    isActive: { type: Boolean, default: true },

    /** Updated on every authenticated request (fire-and-forget). */
    lastSeen: { type: Date, default: Date.now },

    /**
     * Must equal the JWT's own `exp` so that token expiry and session
     * expiry are always in sync.  Set to: new Date(Date.now() + 24*60*60*1000)
     * when the session is created (matches the "24h" JWT expiry in verifyLoginOTP).
     *
     * The TTL index { expireAfterSeconds: 0 } tells MongoDB to delete this
     * document at the moment `expiresAt` is reached.
     */
    expiresAt: { type: Date, required: true }
  },
  {
    // We manage createdAt manually via default in lastSeen; we do want
    // createdAt for display/audit — so keep timestamps but only createdAt.
    timestamps: { createdAt: 'createdAt', updatedAt: false }
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────

// TTL: auto-delete documents once expiresAt is passed (0-second grace)
userSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Fast lookup by sessionId (used by auth middleware on EVERY request)
userSessionSchema.index({ sessionId: 1 });

// Counting active sessions per user (used at login time)
userSessionSchema.index({ userId: 1, isActive: 1 });

module.exports = mongoose.model('UserSession', userSessionSchema);