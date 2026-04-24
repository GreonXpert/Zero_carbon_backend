'use strict';

const mongoose = require('mongoose');
const { ApprovableEntityType } = require('../constants/enums');

const EvidenceAttachmentSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  entity_type: {
    type: String,
    enum: Object.values(ApprovableEntityType),
    required: true,
  },
  entity_id:       { type: String, required: true },
  file_name:       { type: String, required: true },
  file_url:        { type: String, required: true },
  // e.g. "SBTi_Validation_Certificate", "Audit_Report", "Evidence_Document"
  attachment_type: { type: String, required: true },
  uploaded_by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  uploaded_at:     { type: Date, default: Date.now },
  // ── Audit / governance fields ──────────────────────────────────────────────
  storage_ref:     { type: String, default: null },   // S3 key or local path
  checksum:        { type: String, default: null },   // SHA256 hex of file content
  file_size_bytes: { type: Number, default: null },
  mime_type:       { type: String, default: null },   // e.g. "application/pdf"
});

EvidenceAttachmentSchema.index({ entity_type: 1, entity_id: 1 });

module.exports = mongoose.model('EvidenceAttachment', EvidenceAttachmentSchema);
