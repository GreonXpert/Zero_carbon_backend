// models/Organization/OCRFeedback.js
// Stores user-confirmed field mapping corrections from OCR extraction reviews.
//
// Each document records that a specific client, when uploading a document for
// a specific scope, had an image label (rawLabel) confirmed/corrected to a
// specific canonical internal field (mappedToField).
//
// The model matcher uses this collection to boost confidence scores:
// if a rawLabel was previously confirmed, it returns confidence = 100.
//
// Design decisions:
// - rawLabel is stored normalized (lowercase, trimmed) for reliable lookup.
// - usedCount tracks how many times this mapping was confirmed (not just set once).
// - A unique index on (clientId, scopeIdentifier, rawLabel) prevents duplicates.

'use strict';

const mongoose = require('mongoose');

const OCRFeedbackSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      index: true
    },
    nodeId: {
      type: String,
      required: true
    },
    scopeIdentifier: {
      type: String,
      required: true,
      index: true
    },
    scopeType: {
      type: String,
      enum: ['Scope 1', 'Scope 2', 'Scope 3'],
      required: true
    },
    categoryName: {
      type: String,
      default: ''
    },
    // The label as it appeared in the image (normalized: lowercase, trimmed)
    rawLabel: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    // The canonical internal field name the user confirmed this label maps to
    // e.g. 'consumed_electricity', 'fuelConsumption', 'wasteMass'
    mappedToField: {
      type: String,
      required: true
    },
    // Display label of the mapped field (for UI rendering without re-lookup)
    mappedToDisplayLabel: {
      type: String,
      default: ''
    },
    // Number of times this mapping has been confirmed (incremented on each confirm)
    usedCount: {
      type: Number,
      default: 1,
      min: 1
    },
    lastUsedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true  // adds createdAt, updatedAt
  }
);

// Unique index: one mapping record per (client, scope, rawLabel)
// If the same client uploads another bill with the same label, we increment
// usedCount rather than creating a duplicate.
OCRFeedbackSchema.index(
  { clientId: 1, scopeIdentifier: 1, rawLabel: 1 },
  { unique: true }
);

// Additional index for bulk scope-level queries (used by model matcher)
OCRFeedbackSchema.index({ clientId: 1, scopeIdentifier: 1 });

const OCRFeedback = mongoose.model('OCRFeedback', OCRFeedbackSchema);

module.exports = OCRFeedback;
