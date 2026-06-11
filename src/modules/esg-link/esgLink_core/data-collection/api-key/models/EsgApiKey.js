const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Schema } = mongoose;

const EsgApiKeySchema = new Schema(
  {
    // ── Scope ─────────────────────────────────────────────────────────────────
    clientId:  { type: String, required: true, index: true },
    nodeId:    { type: String, required: true, index: true },
    mappingId: { type: String, required: true, index: true },
    metricId:  { type: Schema.Types.ObjectId, ref: 'EsgMetric' },

    // ── Key Identity ──────────────────────────────────────────────────────────
    keyType: {
      type:     String,
      enum:     ['ESG_API', 'ESG_IOT'],
      required: true,
      index:    true,
    },
    keyHash:   { type: String, required: true, unique: true }, // bcrypt hash
    keyPrefix: { type: String, required: true, index: true },  // first 8 chars (safe to display)

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    status:    { type: String, enum: ['ACTIVE', 'REVOKED', 'EXPIRED'], default: 'ACTIVE', index: true },
    expiresAt: { type: Date, required: true, index: true },

    // ── Connection Gate ───────────────────────────────────────────────────────
    // Controls whether the ingestion endpoint accepts data for this key.
    // ACTIVE status = key is not revoked/expired; connectionStatus = data flow toggle.
    connectionStatus: {
      type:    String,
      enum:    ['connected', 'disconnected'],
      default: 'connected',
      index:   true,
    },
    disconnectedAt: { type: Date },
    disconnectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reconnectedAt:  { type: Date },
    reconnectedBy:  { type: Schema.Types.ObjectId, ref: 'User' },

    // ── Creator ───────────────────────────────────────────────────────────────
    createdBy:   { type: Schema.Types.ObjectId, ref: 'User' },
    creatorRole: { type: String }, // snapshot
    description: { type: String },
    ipWhitelist: [{ type: String }],

    // ── Usage Tracking ────────────────────────────────────────────────────────
    lastUsedAt: { type: Date },
    usageCount: { type: Number, default: 0 },

    // ── Revocation ────────────────────────────────────────────────────────────
    revokedAt:        { type: Date },
    revokedBy:        { type: Schema.Types.ObjectId, ref: 'User' },
    revocationReason: { type: String },

    // ── Expiry Notifications ──────────────────────────────────────────────────
    expiryWarningsSent: [
      {
        daysBeforeExpiry: Number,
        sentAt:           Date,
      },
    ],
  },
  { timestamps: true }
);

// ─── Instance Methods ─────────────────────────────────────────────────────────

EsgApiKeySchema.methods.verifyKey = async function (plaintextKey) {
  return bcrypt.compare(plaintextKey, this.keyHash);
};

EsgApiKeySchema.methods.isValid = function () {
  return this.status === 'ACTIVE' && this.expiresAt > new Date();
};

EsgApiKeySchema.methods.recordUsage = function () {
  return this.constructor.updateOne(
    { _id: this._id },
    { $set: { lastUsedAt: new Date() }, $inc: { usageCount: 1 } }
  );
};

EsgApiKeySchema.methods.revoke = function (userId, reason) {
  this.status = 'REVOKED';
  this.revokedAt = new Date();
  this.revokedBy = userId;
  this.revocationReason = reason || '';
  return this.save();
};

// ─── Static Methods ───────────────────────────────────────────────────────────

EsgApiKeySchema.statics.findByPrefix = function (keyPrefix, clientId) {
  return this.find({ keyPrefix, clientId, status: 'ACTIVE' });
};

EsgApiKeySchema.statics.validateKeyScope = function (keyDoc, params) {
  return (
    keyDoc.clientId === params.clientId &&
    keyDoc.nodeId === params.nodeId &&
    keyDoc.mappingId === params.mappingId
  );
};

EsgApiKeySchema.statics.findExpiringSoon = function (days = 7) {
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return this.find({ status: 'ACTIVE', expiresAt: { $lte: cutoff } });
};

EsgApiKeySchema.index({ clientId: 1, status: 1 });
EsgApiKeySchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('EsgApiKey', EsgApiKeySchema, 'esg_api_keys');
