'use strict';

const EsgDataEntry        = require('../models/EsgDataEntry');
const EsgWorkflowAction   = require('../models/EsgWorkflowAction');
const EsgSubmissionThread = require('../models/EsgSubmissionThread');
const EsgLinkBoundary     = require('../../boundary/models/EsgLinkBoundary');
const { logEventFireAndForget } = require('../../../../../common/services/audit/auditLogService');
const { canReview, canApprove, isConsultantForClient } = require('../utils/submissionPermissions');

// ─── Valid Transition Map ─────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  draft:                     ['submitted'],
  submitted:                 ['under_review', 'clarification_requested'],
  resubmitted:               ['under_review', 'clarification_requested'],
  under_review:              ['approved', 'rejected', 'clarification_requested'],
  clarification_requested:   ['resubmitted'],
};

function isValidTransition(from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

// ─── Resolve Effective Assignees ──────────────────────────────────────────────
async function resolveAssignees(submission) {
  const boundary = await EsgLinkBoundary.findOne({
    _id:       submission.boundaryDocId,
    isActive:  true,
    isDeleted: false,
  });
  if (!boundary) return { reviewers: [], approvers: [], contributors: [] };

  for (const node of boundary.nodes || []) {
    if (node.id !== submission.nodeId) continue;
    for (const mapping of node.metricsDetails || []) {
      if (!mapping._id || mapping._id.toString() !== submission.mappingId) continue;

      const reviewers = mapping.inheritNodeReviewers
        ? node.nodeReviewerIds || []
        : mapping.reviewers || [];
      const approvers = mapping.inheritNodeApprovers
        ? node.nodeApproverIds || []
        : mapping.approvers || [];

      return {
        reviewers:    reviewers.map((id) => id.toString()),
        approvers:    approvers.map((id) => id.toString()),
        contributors: (mapping.contributors || []).map((id) => id.toString()),
        mapping,
        node,
      };
    }
  }
  return { reviewers: [], approvers: [], contributors: [], mapping: null, node: null };
}

// ─── Append system_event to thread ────────────────────────────────────────────
async function appendSystemEvent(submissionId, clientId, text) {
  await EsgSubmissionThread.updateOne(
    { submissionId, clientId },
    {
      $push: {
        messages: {
          type:       'system_event',
          authorType: 'system',
          text,
          createdAt:  new Date(),
          isDeleted:  false,
        },
      },
    },
    { upsert: false }
  );
}

// ─── Core transition ──────────────────────────────────────────────────────────

/**
 * Transition a submission to a new workflow status.
 * Handles: submit, review-pass, clarification-request, resubmit.
 * Does NOT handle approve/reject — those use recordApproverDecision().
 */
async function transition(submissionId, targetStatus, actor, options = {}) {
  const { clientId, note, threadMessage, req } = options;

  const submission = await EsgDataEntry.findOne({
    _id:       submissionId,
    clientId,
    isDeleted: false,
  });
  if (!submission) return { error: 'Submission not found', status: 404 };

  const fromStatus = submission.workflowStatus;

  // ── 1. Validate transition ────────────────────────────────────────────────
  if (!isValidTransition(fromStatus, targetStatus)) {
    return {
      error:  `Cannot transition from ${fromStatus} to ${targetStatus}`,
      status: 422,
    };
  }

  // ── 2. Resolve assignees for permission check ─────────────────────────────
  const { reviewers, approvers, contributors, mapping } = await resolveAssignees(submission);

  // ── 3. Role-based permission check per target status ─────────────────────
  if (targetStatus === 'submitted' || targetStatus === 'resubmitted') {
    const isContributor = contributors.includes((actor._id || actor.id).toString());
    const isAdmin = ['super_admin', 'consultant_admin', 'consultant'].includes(actor.userType);
    if (!isContributor && !isAdmin) {
      return { error: 'Only assigned contributors can submit', status: 403 };
    }
  }

  if (targetStatus === 'under_review' || targetStatus === 'clarification_requested') {
    if (!await canReview(actor, mapping, reviewers, clientId)) {
      return { error: 'Not authorized to review this submission', status: 403 };
    }
  }

  const now = new Date();

  // ── 4. Status-specific logic ──────────────────────────────────────────────
  submission.workflowStatus = targetStatus;

  if (targetStatus === 'submitted' || targetStatus === 'resubmitted') {
    submission.submittedBy = actor._id || actor.id;
    submission.submittedAt = now;
  }

  // When moving to under_review, populate approvalDecisions for all approvers
  if (targetStatus === 'under_review' && submission.approvalDecisions.length === 0) {
    submission.approvalDecisions = approvers.map((approverId) => {
      // Determine approver type: check if this approver is a consultant
      return {
        approverId,
        approverType: 'approver', // simplified — enriched below if needed
        decision:     'pending',
      };
    });
  }

  await submission.save();

  // ── 5. Workflow action record ─────────────────────────────────────────────
  await EsgWorkflowAction.create({
    submissionId: submission._id,
    clientId,
    action:    _statusToAction(targetStatus),
    actorId:   actor._id || actor.id,
    actorType: actor.userType,
    fromStatus,
    toStatus:  targetStatus,
    note:      note || null,
    createdAt: now,
  });

  // ── 6. Thread: system event + optional clarification message ─────────────
  const systemText = `Status changed: ${fromStatus} → ${targetStatus} by ${actor.userName || actor.userType}`;
  await appendSystemEvent(submission._id, clientId, systemText);

  if (threadMessage && (targetStatus === 'clarification_requested' || targetStatus === 'resubmitted')) {
    const msgType = targetStatus === 'clarification_requested'
      ? 'reviewer_clarification'
      : 'contributor_reply';

    await EsgSubmissionThread.updateOne(
      { submissionId: submission._id, clientId },
      {
        $push: {
          messages: {
            type:       msgType,
            authorId:   actor._id || actor.id,
            authorType: actor.userType,
            text:       threadMessage.text,
            attachments: threadMessage.attachments || [],
            createdAt:  new Date(),
            isDeleted:  false,
          },
        },
      }
    );
  }

  // ── 7. Audit log ──────────────────────────────────────────────────────────
  logEventFireAndForget({
    req,
    actor,
    module:        'esg_data_collection',
    action:        _statusToAuditAction(targetStatus),
    entityType:    'EsgDataEntry',
    entityId:      submission._id.toString(),
    clientId,
    changeSummary: `Submission ${submission._id}: ${fromStatus} → ${targetStatus}`,
    metadata:      { nodeId: submission.nodeId, mappingId: submission.mappingId },
  });

  return { doc: submission, fromStatus, toStatus: targetStatus, reviewers, approvers };
}

// ─── Approver Decision ────────────────────────────────────────────────────────

/**
 * Record an individual approver's decision (approve or reject).
 * Recalculates approval/rejection percentages after each decision.
 * Sets workflowStatus to 'approved' or 'rejected' when threshold is met.
 * On approval: marks any previous approved submission for same period as 'superseded'.
 */
async function recordApproverDecision(submissionId, actorId, decision, note, options = {}) {
  const { clientId, req } = options;

  const submission = await EsgDataEntry.findOne({
    _id:       submissionId,
    clientId,
    isDeleted: false,
  });
  if (!submission) return { error: 'Submission not found', status: 404 };
  if (submission.workflowStatus !== 'under_review') {
    return { error: 'Submission is not under review', status: 422 };
  }

  // ── 1. Verify this actor is an assigned approver ──────────────────────────
  const { approvers, mapping } = await resolveAssignees(submission);
  const actor = options.actor;

  if (!await canApprove(actor, mapping, approvers, clientId)) {
    return { error: 'Not authorized to approve this submission', status: 403 };
  }

  const actorIdStr = actorId.toString();

  // ── 2. Find this approver's decision slot ─────────────────────────────────
  const slot = submission.approvalDecisions.find(
    (d) => d.approverId && d.approverId.toString() === actorIdStr
  );
  if (!slot) {
    return { error: 'You are not in the approver list for this submission', status: 403 };
  }
  if (slot.decision !== 'pending') {
    return { error: 'You have already recorded a decision for this submission', status: 409 };
  }

  // ── 3. Record decision ────────────────────────────────────────────────────
  slot.decision  = decision;
  slot.note      = note || null;
  slot.decidedAt = new Date();

  // Enrich approverType based on actor's userType
  slot.approverType = actor.userType;

  submission.markModified('approvalDecisions');

  // ── 4. Calculate percentages ──────────────────────────────────────────────
  const total    = submission.approvalDecisions.length;
  const approved = submission.approvalDecisions.filter((d) => d.decision === 'approved').length;
  const rejected = submission.approvalDecisions.filter((d) => d.decision === 'rejected').length;

  const approvalPct  = total > 0 ? (approved / total) * 100 : 0;
  const rejectionPct = total > 0 ? (rejected / total) * 100 : 0;

  // ── 5. Consultant fast-track check ────────────────────────────────────────
  // If >= 75% of approvers are consultants of this client AND all consultant-approvers
  // have approved → fast-track approval (their weight already >= 75% > 50% threshold)
  let consultantFastTrack = false;
  if (decision === 'approved') {
    const consultantApprovers = submission.approvalDecisions.filter(
      (d) => d.approverType === 'consultant' || d.approverType === 'consultant_admin'
    );
    const consultantPct = total > 0 ? (consultantApprovers.length / total) * 100 : 0;
    const allConsultantsApproved = consultantApprovers.every((d) => d.decision === 'approved');
    consultantFastTrack = consultantPct >= 75 && allConsultantsApproved;
  }

  const now         = new Date();
  let finalStatus   = submission.workflowStatus;
  let supersededId  = null;

  if (approvalPct >= 50 || consultantFastTrack) {
    finalStatus = 'approved';

    // ── Supersede previous approved submission for same (mappingId, periodLabel) ──
    const prevApproved = await EsgDataEntry.findOne({
      clientId,
      mappingId:            submission.mappingId,
      'period.periodLabel': submission.period.periodLabel,
      workflowStatus:       'approved',
      isDeleted:            false,
      _id:                  { $ne: submission._id },
    });
    if (prevApproved) {
      prevApproved.workflowStatus = 'superseded';
      prevApproved.supersededBy   = submission._id;
      await prevApproved.save();

      // Record supersede action
      await EsgWorkflowAction.create({
        submissionId: prevApproved._id,
        clientId,
        action:    'supersede',
        actorId:   actor._id || actor.id,
        actorType: actor.userType,
        fromStatus: 'approved',
        toStatus:   'superseded',
        note:       `Superseded by newer submission ${submission._id}`,
        createdAt:  now,
      });

      submission.supersedes = prevApproved._id;
      supersededId = prevApproved._id;
    }

  } else if (rejectionPct > 50) {
    finalStatus = 'rejected';
  }

  submission.workflowStatus = finalStatus;
  await submission.save();

  // ── 6. Workflow action ────────────────────────────────────────────────────
  await EsgWorkflowAction.create({
    submissionId: submission._id,
    clientId,
    action:    decision === 'approved' ? 'approve' : 'reject',
    actorId:   actor._id || actor.id,
    actorType: actor.userType,
    fromStatus: 'under_review',
    toStatus:  finalStatus,
    note:      note || null,
    metadata:  { approvalPct, rejectionPct, finalStatus, consultantFastTrack },
    createdAt: now,
  });

  // Thread system event
  await appendSystemEvent(
    submission._id,
    clientId,
    `${actor.userName || actor.userType} recorded decision: ${decision} (${approvalPct.toFixed(0)}% approval)`
  );
  if (finalStatus !== 'under_review') {
    await appendSystemEvent(submission._id, clientId, `Final status: ${finalStatus}`);
  }

  // ── 7. Audit log ──────────────────────────────────────────────────────────
  logEventFireAndForget({
    req,
    actor,
    module:        'esg_data_collection',
    action:        decision === 'approved' ? 'approve' : 'reject',
    entityType:    'EsgDataEntry',
    entityId:      submission._id.toString(),
    clientId,
    changeSummary: `Approver decision: ${decision} — final status: ${finalStatus}`,
    metadata:      { approvalPct, rejectionPct },
  });

  return {
    doc:              submission,
    finalStatus,
    approvalPct,
    rejectionPct,
    consultantFastTrack,
    supersededId,
  };
}

// ─── Thread helpers exposed for controllers ───────────────────────────────────

async function addThreadMessage(submissionId, clientId, messageData) {
  const result = await EsgSubmissionThread.findOneAndUpdate(
    { submissionId, clientId },
    { $push: { messages: { ...messageData, createdAt: new Date(), isDeleted: false } } },
    { new: true, upsert: false }
  );
  if (!result) return { error: 'Thread not found', status: 404 };
  const msg = result.messages[result.messages.length - 1];
  return { message: msg };
}

async function getThread(submissionId, clientId) {
  const thread = await EsgSubmissionThread.findOne({ submissionId, clientId });
  if (!thread) return { error: 'Thread not found', status: 404 };
  return { thread };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _statusToAction(status) {
  switch (status) {
    case 'submitted':               return 'submit';
    case 'resubmitted':             return 'submit';
    case 'under_review':            return 'review_pass';
    case 'clarification_requested': return 'clarification_request';
    default:                        return 'other';
  }
}

function _statusToAuditAction(status) {
  switch (status) {
    case 'submitted':               return 'create';
    case 'resubmitted':             return 'update';
    case 'under_review':            return 'other';
    case 'clarification_requested': return 'other';
    default:                        return 'other';
  }
}

module.exports = {
  transition,
  recordApproverDecision,
  resolveAssignees,
  addThreadMessage,
  getThread,
};
