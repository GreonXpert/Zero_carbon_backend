const mongoose = require('mongoose');

const { Schema } = mongoose;

// ─── Immutable Workflow Action ────────────────────────────────────────────────
// Records are created ONCE and never updated. No isDeleted. No updatedAt.
// This is the tamper-evident, append-only audit trail for each submission.
const EsgWorkflowActionSchema = new Schema(
  {
    submissionId: {
      type:     Schema.Types.ObjectId,
      ref:      'EsgDataEntry',
      required: true,
      index:    true,
    },
    clientId: { type: String, required: true, index: true },

    action: {
      type: String,
      enum: [
        'draft_saved',
        'submit',
        'review_pass',
        'clarification_request',
        'clarification_reply',
        'approve',
        'reject',
        'supersede',
        'import',           // batch CSV/Excel/OCR import
        'system_reminder',  // frequency reminder notification sent
      ],
      required: true,
    },

    actorId:   { type: Schema.Types.ObjectId, ref: 'User' }, // null for system actions
    actorType: { type: String }, // snapshot of userType at action time

    fromStatus: { type: String }, // workflowStatus before action
    toStatus:   { type: String }, // workflowStatus after action

    note: { type: String, maxlength: 1000 },

    // Flexible context (e.g. { fileName } for import, { periodLabel, reminderType } for system_reminder)
    metadata: { type: Schema.Types.Mixed },

    // Immutable timestamp — set at creation, never changed
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  {
    // No timestamps:true — createdAt is manually set above and immutable
    // No updatedAt because records are never modified
  }
);

EsgWorkflowActionSchema.index({ submissionId: 1, createdAt: 1 });
EsgWorkflowActionSchema.index({ clientId: 1, action: 1, createdAt: -1 });

module.exports = mongoose.model(
  'EsgWorkflowAction',
  EsgWorkflowActionSchema,
  'esg_workflow_actions'
);
