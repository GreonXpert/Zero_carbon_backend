'use strict';

const cron = require('node-cron');

const EsgLinkBoundary      = require('../../boundary/models/EsgLinkBoundary');
const EsgDataEntry         = require('../../data-collection/models/EsgDataEntry');
const Client                = require('../../../../client-management/client/Client');
const User                  = require('../../../../../common/models/User');
const { resolveAssignees }   = require('../../data-collection/services/workflowService');
const { sendEscalationAlert } = require('../../data-collection/services/esgDataNotificationService');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve who should be notified when a submission is escalated:
 * the original reviewers (review stage) or approvers (approval stage),
 * the client's assigned consultant, and the client_admin.
 */
async function _resolveEscalationRecipients(submission) {
  const { reviewers, approvers } = await resolveAssignees(submission);
  const stageAssignees = submission.workflowStatus === 'under_review' ? approvers : reviewers;

  const recipientIds = new Set(stageAssignees.map((id) => id.toString()));

  // NOTE: workflowTracking is encrypted as a single opaque field, so it must be
  // selected in full (not via a sub-path) to be decrypted by the encryption plugin.
  const client = await Client.findOne({ clientId: submission.clientId })
    .select('workflowTracking leadInfo.assignedConsultantId')
    .lean();
  const consultantId = client?.workflowTracking?.assignedConsultantId || client?.leadInfo?.assignedConsultantId;
  if (consultantId) recipientIds.add(consultantId.toString());

  const clientAdmin = await User.findOne({
    clientId: submission.clientId,
    userType: 'client_admin',
    isActive: true,
  }).select('_id').lean();
  if (clientAdmin) recipientIds.add(clientAdmin._id.toString());

  return [...recipientIds];
}

/**
 * Find submissions sitting in `submitted`/`resubmitted` (review stage) or
 * `under_review` (approval stage) past their boundary's SLA deadline,
 * flag them as escalated, and notify the relevant users.
 *
 * @param {Object} options - { clientId } — when provided, only checks that client
 *                            (used by the manual "run check" API for testing).
 */
async function checkEsgReviewerApproverEscalations(options = {}) {
  const { clientId } = options;
  const result = { checked: 0, escalated: 0 };

  try {
    const now = new Date();

    const query = {
      workflowStatus: { $in: ['submitted', 'resubmitted', 'under_review'] },
      // Use $ne:true (not `false`) so documents created before the
      // `isEscalated` field existed (where the field is absent rather
      // than literally `false`) are still picked up by the check.
      isEscalated:    { $ne: true },
      isDeleted:      { $ne: true },
    };
    if (clientId) query.clientId = clientId;

    const submissions = await EsgDataEntry.find(query);

    const boundaryCache = new Map();

    for (const submission of submissions) {
      result.checked += 1;

      const boundaryKey = submission.boundaryDocId ? submission.boundaryDocId.toString() : null;
      if (!boundaryKey) continue;

      let boundary = boundaryCache.get(boundaryKey);
      if (boundary === undefined) {
        boundary = await EsgLinkBoundary.findById(boundaryKey).select('slaConfig').lean();
        boundaryCache.set(boundaryKey, boundary || null);
      }
      if (!boundary) continue;

      const slaConfig = boundary.slaConfig || {};
      if (slaConfig.escalationEnabled === false) continue;

      const reviewDeadlineDays   = slaConfig.reviewDeadlineDays   ?? 3;
      const approvalDeadlineDays = slaConfig.approvalDeadlineDays ?? 3;

      let stage = null;
      let deadlineDays = null;

      if (['submitted', 'resubmitted'].includes(submission.workflowStatus) && submission.submittedAt) {
        const elapsedDays = (now - submission.submittedAt) / MS_PER_DAY;
        if (elapsedDays > reviewDeadlineDays) {
          stage = 'review';
          deadlineDays = reviewDeadlineDays;
        }
      } else if (submission.workflowStatus === 'under_review' && submission.underReviewAt) {
        const elapsedDays = (now - submission.underReviewAt) / MS_PER_DAY;
        if (elapsedDays > approvalDeadlineDays) {
          stage = 'approval';
          deadlineDays = approvalDeadlineDays;
        }
      }

      if (!stage) continue;

      submission.isEscalated     = true;
      submission.escalatedAt     = now;
      submission.escalationStage = stage;
      await submission.save();

      const recipientIds = await _resolveEscalationRecipients(submission);
      if (recipientIds.length) {
        await sendEscalationAlert(submission, stage, recipientIds, { deadlineDays });
      }

      result.escalated += 1;
    }
  } catch (err) {
    console.error('[esgReviewerApproverEscalationChecker] Error:', err.message);
  }

  return result;
}

/**
 * Registers the daily ESG reviewer/approver SLA escalation cron (08:00 UTC).
 */
function startEsgReviewerApproverEscalationChecker() {
  cron.schedule('0 8 * * *', () => {
    console.log('[ESG] Running ESG reviewer/approver escalation check...');
    checkEsgReviewerApproverEscalations();
  });

  console.log('[ESG] ESG reviewer/approver escalation checker scheduled at 08:00 UTC daily');
}

module.exports = { startEsgReviewerApproverEscalationChecker, checkEsgReviewerApproverEscalations };
