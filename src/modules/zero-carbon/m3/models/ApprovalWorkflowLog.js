'use strict';

const mongoose = require('mongoose');
const { ApprovableEntityType, WorkflowEventType } = require('../constants/enums');

const ApprovalWorkflowLogSchema = new mongoose.Schema({
  clientId:      { type: String, required: true, index: true },
  entity_type: {
    type: String,
    enum: Object.values(ApprovableEntityType),
    required: true,
  },
  entity_id:     { type: String, required: true },
  action_code: {
    type: String,
    enum: Object.values(WorkflowEventType),
    required: true,
  },
  actor_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actor_role:    { type: String, required: true },
  status_before: { type: String, default: null },
  status_after:  { type: String, required: true },
  comment:       { type: String, default: null },
  timestamp:     { type: Date, default: Date.now },
});

ApprovalWorkflowLogSchema.index({ entity_type: 1, entity_id: 1 });
ApprovalWorkflowLogSchema.index({ clientId: 1, timestamp: -1 });

module.exports = mongoose.model('ApprovalWorkflowLog', ApprovalWorkflowLogSchema);
