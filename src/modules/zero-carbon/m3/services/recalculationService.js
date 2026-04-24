'use strict';

const RecalculationEvent = require('../models/RecalculationEvent');
const TargetMaster = require('../models/TargetMaster');
const TargetRevision = require('../models/TargetRevision');
const ApprovalWorkflowLog = require('../models/ApprovalWorkflowLog');
const {
  RecalcEventStatus, LifecycleStatus, ApprovableEntityType, WorkflowEventType,
  RecalculationTrigger,
} = require('../constants/enums');
const { ERRORS } = require('../constants/messages');
const pathwayService  = require('./pathwayService');

async function createRecalcEvent(data, user) {
  // "Other" trigger requires justification
  if (data.trigger_type === RecalculationTrigger.Other && !data.justification) {
    const e = new Error(ERRORS.RECALC_OTHER_REQUIRES_JUSTIFICATION); e.status = 422; throw e;
  }

  const event = await RecalculationEvent.create({
    ...data,
    status:     RecalcEventStatus.PENDING,
    created_by: user._id,
  });

  // Lock the target with RECALC_PENDING
  await TargetMaster.findByIdAndUpdate(data.target_id, {
    $set: { lifecycle_status: LifecycleStatus.RECALC_PENDING },
  });

  await ApprovalWorkflowLog.create({
    clientId:      data.clientId,
    entity_type:   ApprovableEntityType.RecalculationEvent,
    entity_id:     String(event._id),
    action_code:   WorkflowEventType.RECALCULATION_INITIATED,
    actor_id:      user._id,
    actor_role:    user.userType,
    status_before: null,
    status_after:  RecalcEventStatus.PENDING,
    timestamp:     new Date(),
  });

  return event;
}

async function approveRecalcEvent(eventId, user) {
  const event = await RecalculationEvent.findById(eventId);
  if (!event) { const e = new Error('Recalculation event not found.'); e.status = 404; throw e; }
  if (event.status !== RecalcEventStatus.PENDING) {
    const e = new Error('Only PENDING recalculation events can be approved.'); e.status = 422; throw e;
  }

  const target = await TargetMaster.findById(event.target_id);
  if (!target) { const e = new Error('Target not found.'); e.status = 404; throw e; }

  // Supersede old revision by creating a new one
  const latestRevision = await TargetRevision.findOne({ target_id: target._id })
    .sort({ revision_no: -1 });
  const newRevNo = latestRevision ? latestRevision.revision_no + 1 : 1;

  const newRevision = await TargetRevision.create({
    target_id:        target._id,
    revision_no:      newRevNo,
    snapshot_data:    target.toObject(),
    trigger_event_id: event._id,
    created_by:       user._id,
  });

  // Mark old revision(s) as superseded (via lifecycle_status on target)
  await TargetMaster.findByIdAndUpdate(target._id, {
    $set: {
      lifecycle_status: LifecycleStatus.ACTIVE,
    },
  });

  // Update event
  event.status         = RecalcEventStatus.APPROVED;
  event.approved_by    = user._id;
  event.approved_at    = new Date();
  event.new_revision_id= newRevision._id;
  await event.save();

  await ApprovalWorkflowLog.create({
    clientId:      event.clientId,
    entity_type:   ApprovableEntityType.RecalculationEvent,
    entity_id:     String(event._id),
    action_code:   WorkflowEventType.RECALCULATION_APPROVED,
    actor_id:      user._id,
    actor_role:    user.userType,
    status_before: RecalcEventStatus.PENDING,
    status_after:  RecalcEventStatus.APPROVED,
    timestamp:     new Date(),
  });

  // Re-generate pathway after recalculation approval
  await pathwayService.generatePathway(target);

  return event;
}

async function rejectRecalcEvent(eventId, comment, user) {
  if (!comment || !String(comment).trim()) {
    const e = new Error(ERRORS.REJECT_COMMENT_REQUIRED); e.status = 422; throw e;
  }

  const event = await RecalculationEvent.findById(eventId);
  if (!event) { const e = new Error('Recalculation event not found.'); e.status = 404; throw e; }
  if (event.status !== RecalcEventStatus.PENDING) {
    const e = new Error('Only PENDING recalculation events can be rejected.'); e.status = 422; throw e;
  }

  event.status = RecalcEventStatus.REJECTED;
  await event.save();

  // Release RECALC_PENDING lock
  await TargetMaster.findByIdAndUpdate(event.target_id, {
    $set: { lifecycle_status: LifecycleStatus.ACTIVE },
  });

  await ApprovalWorkflowLog.create({
    clientId:      event.clientId,
    entity_type:   ApprovableEntityType.RecalculationEvent,
    entity_id:     String(event._id),
    action_code:   WorkflowEventType.RETURNED,
    actor_id:      user._id,
    actor_role:    user.userType,
    status_before: RecalcEventStatus.PENDING,
    status_after:  RecalcEventStatus.REJECTED,
    comment,
    timestamp:     new Date(),
  });

  return event;
}

async function listRecalcEvents(clientId, targetId) {
  const query = { clientId };
  if (targetId) query.target_id = targetId;
  return RecalculationEvent.find(query).sort({ createdAt: -1 });
}

async function getRecalcEventById(eventId) {
  const event = await RecalculationEvent.findById(eventId);
  if (!event) { const e = new Error('Recalculation event not found.'); e.status = 404; throw e; }
  return event;
}

module.exports = {
  createRecalcEvent,
  approveRecalcEvent,
  rejectRecalcEvent,
  listRecalcEvents,
  getRecalcEventById,
};
