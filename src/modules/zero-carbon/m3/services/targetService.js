'use strict';

const TargetMaster = require('../models/TargetMaster');
const TargetRevision = require('../models/TargetRevision');
const ApprovalWorkflowLog = require('../models/ApprovalWorkflowLog');
const OrgSettings = require('../models/OrgSettings');
const EvidenceAttachment = require('../models/EvidenceAttachment');
const { validateTargetPayload, assertVersionMatch } = require('../validators/targetValidator');
const { LifecycleStatus, ApprovalStatus, WorkflowEventType, ApprovableEntityType, TargetFamily, ApprovalDepth } = require('../constants/enums');
const { ERRORS } = require('../constants/messages');
const dqService = require('./dqService');
const pathwayService = require('./pathwayService');

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildWorkflowLog(target, actionCode, actor, statusBefore, statusAfter, comment = null) {
  return {
    clientId:      target.clientId,
    entity_type:   ApprovableEntityType.TargetMaster,
    entity_id:     String(target._id),
    action_code:   actionCode,
    actor_id:      actor._id,
    actor_role:    actor.userType,
    status_before: statusBefore,
    status_after:  statusAfter,
    comment,
    timestamp:     new Date(),
  };
}

async function getSettings(clientId) {
  return OrgSettings.findOne({ clientId }) || { approval_depth: ApprovalDepth.SINGLE_STEP };
}

// ── Service Methods ──────────────────────────────────────────────────────────

async function createTarget(data, user) {
  const errors = validateTargetPayload(data);
  if (errors.length) {
    const err = new Error(errors.join(' | '));
    err.status = 422;
    throw err;
  }

  if (!data.target_code) {
    const err = new Error('target_code is required.');
    err.status = 422;
    throw err;
  }

  const target = await TargetMaster.create({
    ...data,
    lifecycle_status: LifecycleStatus.DRAFT,
    approval_status:  null,
    version:          1,
    created_by:       user._id,
    updated_by:       user._id,
  });

  await ApprovalWorkflowLog.create(buildWorkflowLog(
    target, WorkflowEventType.CREATED, user, null, LifecycleStatus.DRAFT
  ));

  // Auto-raise DQ flag if base_year_emissions is missing
  if (!data.base_year_emissions) {
    await dqService.raiseFlag({
      clientId:   target.clientId,
      entityType: ApprovableEntityType.TargetMaster,
      entityId:   String(target._id),
      flagCode:   'MISSING_BASE_YEAR',
      severity:   'BLOCKER',
      message:    ERRORS.BASE_YEAR_NOT_APPROVED,
      hint:       'Submit inventory closure in M1 first.',
    });
  }

  return target;
}

async function updateTarget(targetId, data, user) {
  const target = await TargetMaster.findById(targetId);
  if (!target || target.isDeleted) {
    const err = new Error('Target not found.'); err.status = 404; throw err;
  }

  const editableStates = [LifecycleStatus.DRAFT, ApprovalStatus.RETURNED_FOR_REVISION];
  if (!editableStates.includes(target.lifecycle_status) &&
      !editableStates.includes(target.approval_status)) {
    if (target.lifecycle_status === LifecycleStatus.RECALC_PENDING) {
      const err = new Error(ERRORS.EDIT_LOCKED_RECALC); err.status = 422; throw err;
    }
    const err = new Error('Target can only be edited in DRAFT or RETURNED_FOR_REVISION state.');
    err.status = 422; throw err;
  }

  assertVersionMatch(target.version, data.version);
  const errors = validateTargetPayload({ ...target.toObject(), ...data });
  if (errors.length) { const e = new Error(errors.join(' | ')); e.status = 422; throw e; }

  Object.assign(target, data, {
    version:    target.version + 1,
    updated_by: user._id,
  });
  await target.save();
  return target;
}

async function submitTarget(targetId, user) {
  const target = await TargetMaster.findById(targetId);
  if (!target || target.isDeleted) { const e = new Error('Target not found.'); e.status = 404; throw e; }

  const allowed = [LifecycleStatus.DRAFT, ApprovalStatus.RETURNED_FOR_REVISION];
  if (!allowed.includes(target.lifecycle_status) && !allowed.includes(target.approval_status)) {
    const e = new Error('Only DRAFT or RETURNED targets can be submitted.'); e.status = 422; throw e;
  }

  const prev = target.approval_status;
  target.approval_status = ApprovalStatus.SUBMITTED;
  target.updated_by = user._id;
  await target.save();

  await ApprovalWorkflowLog.create(buildWorkflowLog(
    target, WorkflowEventType.SUBMITTED, user, prev, ApprovalStatus.SUBMITTED
  ));
  return target;
}

async function reviewTarget(targetId, user) {
  const target = await TargetMaster.findById(targetId);
  if (!target) { const e = new Error('Target not found.'); e.status = 404; throw e; }

  const settings = await getSettings(target.clientId);
  if (settings.approval_depth === ApprovalDepth.SINGLE_STEP) {
    const e = new Error('Review step is skipped in single_step approval mode.'); e.status = 422; throw e;
  }

  if (target.approval_status !== ApprovalStatus.SUBMITTED) {
    const e = new Error('Target must be SUBMITTED before review.'); e.status = 422; throw e;
  }

  const prev = target.approval_status;
  target.approval_status = ApprovalStatus.UNDER_REVIEW;
  target.updated_by = user._id;
  await target.save();

  await ApprovalWorkflowLog.create(buildWorkflowLog(
    target, WorkflowEventType.REVIEWED, user, prev, ApprovalStatus.UNDER_REVIEW
  ));
  return target;
}

async function returnTarget(targetId, comment, user) {
  const target = await TargetMaster.findById(targetId);
  if (!target) { const e = new Error('Target not found.'); e.status = 404; throw e; }

  const returnable = [ApprovalStatus.SUBMITTED, ApprovalStatus.UNDER_REVIEW];
  if (!returnable.includes(target.approval_status)) {
    const e = new Error('Target must be SUBMITTED or UNDER_REVIEW to be returned.'); e.status = 422; throw e;
  }

  const prev = target.approval_status;
  target.approval_status = ApprovalStatus.RETURNED_FOR_REVISION;
  target.updated_by = user._id;
  await target.save();

  await ApprovalWorkflowLog.create(buildWorkflowLog(
    target, WorkflowEventType.RETURNED, user, prev, ApprovalStatus.RETURNED_FOR_REVISION, comment
  ));
  return target;
}

async function approveTarget(targetId, comment, user) {
  const target = await TargetMaster.findById(targetId);
  if (!target) { const e = new Error('Target not found.'); e.status = 404; throw e; }

  const settings = await getSettings(target.clientId);
  const approvable =
    settings.approval_depth === ApprovalDepth.SINGLE_STEP
      ? [ApprovalStatus.SUBMITTED]
      : [ApprovalStatus.UNDER_REVIEW];

  if (!approvable.includes(target.approval_status)) {
    const e = new Error(`Target must be in ${approvable.join('/')} state to be approved.`);
    e.status = 422; throw e;
  }

  const prev = target.approval_status;
  target.approval_status = ApprovalStatus.APPROVED;
  target.updated_by = user._id;
  await target.save();

  await ApprovalWorkflowLog.create(buildWorkflowLog(
    target, WorkflowEventType.APPROVED, user, prev, ApprovalStatus.APPROVED, comment
  ));
  return target;
}

async function publishTarget(targetId, comment, user) {
  const target = await TargetMaster.findById(targetId);
  if (!target) { const e = new Error('Target not found.'); e.status = 404; throw e; }

  if (target.approval_status !== ApprovalStatus.APPROVED) {
    const e = new Error('Target must be APPROVED before publishing.'); e.status = 422; throw e;
  }

  // SBTi Validated targets require a validation certificate evidence attachment
  if (target.target_family === TargetFamily.SBTi_Validated) {
    const certCount = await EvidenceAttachment.countDocuments({
      entity_type:     ApprovableEntityType.TargetMaster,
      entity_id:       String(target._id),
      attachment_type: 'SBTi_Validation_Certificate',
    });
    if (certCount === 0) {
      const e = new Error(ERRORS.SBTI_VALIDATED_PUBLISH_REQUIRES_CERT); e.status = 422; throw e;
    }
  }

  // Determine current revision number
  const latestRevision = await TargetRevision.findOne({ target_id: target._id })
    .sort({ revision_no: -1 });
  const newRevNo = latestRevision ? latestRevision.revision_no + 1 : 1;

  // Create immutable revision snapshot
  await TargetRevision.create({
    target_id:     target._id,
    revision_no:   newRevNo,
    snapshot_data: target.toObject(),
    created_by:    user._id,
  });

  const prev = target.approval_status;
  target.approval_status  = ApprovalStatus.PUBLISHED;
  target.lifecycle_status = LifecycleStatus.ACTIVE;
  target.updated_by = user._id;
  await target.save();

  await ApprovalWorkflowLog.create(buildWorkflowLog(
    target, WorkflowEventType.PUBLISHED, user, prev, ApprovalStatus.PUBLISHED, comment
  ));

  // Trigger pathway generation
  await pathwayService.generatePathway(target);

  return target;
}

async function archiveTarget(targetId, user) {
  const target = await TargetMaster.findById(targetId);
  if (!target) { const e = new Error('Target not found.'); e.status = 404; throw e; }

  const prev = target.lifecycle_status;
  target.lifecycle_status = LifecycleStatus.ARCHIVED;
  target.updated_by = user._id;
  await target.save();

  await ApprovalWorkflowLog.create(buildWorkflowLog(
    target, WorkflowEventType.ACTIVATED, user, prev, LifecycleStatus.ARCHIVED
  ));
  return target;
}

async function listTargets(clientId, filters = {}) {
  const query = { clientId, isDeleted: false };
  if (filters.lifecycle_status) query.lifecycle_status = filters.lifecycle_status;
  if (filters.target_family)    query.target_family    = filters.target_family;
  if (filters.framework_name)   query.framework_name   = filters.framework_name;
  return TargetMaster.find(query).sort({ createdAt: -1 });
}

async function getTargetById(targetId) {
  const target = await TargetMaster.findOne({ _id: targetId, isDeleted: false });
  if (!target) { const e = new Error('Target not found.'); e.status = 404; throw e; }
  return target;
}

async function getRevisions(targetId) {
  return TargetRevision.find({ target_id: targetId }).sort({ revision_no: -1 });
}

async function getHistory(targetId) {
  return ApprovalWorkflowLog.find({
    entity_type: ApprovableEntityType.TargetMaster,
    entity_id:   String(targetId),
  }).sort({ timestamp: -1 });
}

module.exports = {
  createTarget,
  updateTarget,
  submitTarget,
  reviewTarget,
  returnTarget,
  approveTarget,
  publishTarget,
  archiveTarget,
  listTargets,
  getTargetById,
  getRevisions,
  getHistory,
};
