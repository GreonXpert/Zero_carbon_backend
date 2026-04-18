const mongoose = require('mongoose');

const { Schema } = mongoose;

// ─── Thread Message Sub-Schema ────────────────────────────────────────────────
const ThreadMessageSchema = new Schema(
  {
    type: {
      type: String,
      enum: [
        'reviewer_clarification', // reviewer asks for more info (triggers status change)
        'contributor_reply',      // contributor responds to clarification
        'reviewer_followup',      // reviewer follows up after contributor reply
        'approver_note',          // approver adds note during review
        'system_event',           // auto-generated status transition record (immutable)
      ],
      required: true,
    },
    authorId:   { type: Schema.Types.ObjectId, ref: 'User' }, // null for system_event
    authorType: { type: String }, // snapshot: 'reviewer' | 'approver' | 'contributor' | 'system'
    text:       { type: String, required: true },
    attachments: [
      {
        fileName: String,
        s3Key:    String,
        mimeType: String,
      },
    ],
    createdAt: { type: Date, default: Date.now },
    // System events are never soft-deleted.
    // Casual comments (reviewer_followup, approver_note) can be soft-deleted.
    isDeleted: { type: Boolean, default: false },
  },
  { _id: true }
);

// ─── Main Schema ─────────────────────────────────────────────────────────────
const EsgSubmissionThreadSchema = new Schema(
  {
    submissionId: {
      type:     Schema.Types.ObjectId,
      ref:      'EsgDataEntry',
      required: true,
      unique:   true, // one thread per submission
      index:    true,
    },
    clientId: { type: String, required: true, index: true },
    messages: [ThreadMessageSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  'EsgSubmissionThread',
  EsgSubmissionThreadSchema,
  'esg_submission_threads'
);
