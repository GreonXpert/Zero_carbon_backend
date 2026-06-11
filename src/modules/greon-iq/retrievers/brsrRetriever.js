'use strict';

// ============================================================================
// brsrRetriever.js — Retrieves BRSR questionnaire progress for GreOn IQ
//
// Data sources:
//   ClientFrameworkInstance — activation/period status per client
//   EsgFrameworkQuestion    — published questions (total count, sections)
//   DisclosureAnswer        — per-question workflow status + contributor answers
//   QuestionAssignment      — contributor / reviewer / approver assignments
//   BrsrFinalReport         — consultant final-approval record
//
// Uses brsrReadinessService.getReadinessDashboard() for the main summary so
// the computation logic stays DRY and consistent with the existing REST API.
// ============================================================================

const ClientFrameworkInstance = require('../../esg-link/framework/models/ClientFrameworkInstance.model');
const EsgFrameworkQuestion    = require('../../esg-link/framework/models/FrameworkQuestion.model');
const DisclosureAnswer        = require('../../esg-link/framework/models/DisclosureAnswer.model');
const QuestionAssignment      = require('../../esg-link/framework/models/QuestionAssignment.model');
const User                    = require('../../../common/models/User');
const { getReadinessDashboard } = require('../../esg-link/framework/services/brsrReadinessService');

const FRAMEWORK_CODE = 'BRSR';

// Human-readable labels for answer workflow statuses
const STATUS_LABELS = {
  not_started:                       'Not Started',
  in_progress:                       'In Progress',
  submitted_to_reviewer:             'Submitted to Reviewer',
  reviewer_changes_requested:        'Reviewer Requested Changes',
  resubmitted_to_reviewer:           'Resubmitted to Reviewer',
  reviewer_approved:                 'Reviewer Approved',
  submitted_to_approver:             'Submitted to Approver',
  approver_query_to_reviewer:        'Approver Queried Reviewer',
  reviewer_response_pending:         'Reviewer Response Pending',
  contributor_clarification_required:'Contributor Clarification Required',
  contributor_clarification_submitted:'Contributor Clarification Submitted',
  approver_declined:                 'Approver Declined',
  final_approved:                    'Final Approved',
  locked:                            'Locked',
};

async function retrieve(plan, accessContext) {
  const { clientId } = plan;
  const exclusions = [];

  // ── Find available BRSR instances for this client ───────────────────────────
  const instances = await ClientFrameworkInstance.find(
    { clientId, frameworkCode: FRAMEWORK_CODE },
    { periodId: 1, reportingYear: 1, status: 1, activatedAt: 1, lockedAt: 1 }
  ).sort({ reportingYear: -1, createdAt: -1 }).limit(5).lean();

  if (!instances.length) {
    exclusions.push(
      `No BRSR framework has been activated for client ${clientId}. ` +
      `The BRSR questionnaire must be activated first before any progress or answers can be tracked.`
    );
    return { data: {}, exclusions, recordCount: 0 };
  }

  // Use the most recent active instance, or fall back to the most recent overall
  const activeInstance = instances.find((i) => i.status === 'active') || instances[0];
  const periodId = activeInstance.periodId;

  // ── Main readiness dashboard (section + principle + progress counters) ──────
  const dashboard = await getReadinessDashboard(clientId, FRAMEWORK_CODE, periodId);

  if (!dashboard.found) {
    exclusions.push(`BRSR instance found but readiness data could not be computed for period ${periodId}.`);
    return { data: {}, exclusions, recordCount: 0 };
  }

  // ── Per-answer status breakdown ──────────────────────────────────────────────
  const answers = await DisclosureAnswer.find(
    { clientId, periodId, frameworkCode: FRAMEWORK_CODE },
    { questionId: 1, questionCode: 1, status: 1, answerSource: 1,
      assignedContributor: 1, submittedAt: 1, 'consultantMetricApproval.isApproved': 1 }
  ).lean();

  const byStatus = {};
  for (const a of answers) {
    const label = STATUS_LABELS[a.status] || a.status;
    byStatus[label] = (byStatus[label] || 0) + 1;
  }

  // ── Per-contributor assignment summary ───────────────────────────────────────
  const assignments = await QuestionAssignment.find(
    { clientId, periodId, frameworkCode: FRAMEWORK_CODE },
    { questionCode: 1, contributorId: 1, reviewerId: 1, approverId: 1, status: 1 }
  ).lean();

  // Collect unique user IDs to resolve names
  const userIds = new Set();
  for (const a of assignments) {
    if (a.contributorId) userIds.add(String(a.contributorId));
    if (a.reviewerId)    userIds.add(String(a.reviewerId));
    if (a.approverId)    userIds.add(String(a.approverId));
  }
  const users = userIds.size
    ? await User.find({ _id: { $in: [...userIds] } }, { _id: 1, userName: 1, email: 1, userType: 1 }).lean()
    : [];
  const userMap = {};
  for (const u of users) userMap[String(u._id)] = { name: u.userName || u.email, role: u.userType };

  // Build per-contributor stats
  const contributorStatsMap = {};
  for (const a of assignments) {
    const cId = String(a.contributorId || 'unassigned');
    if (!contributorStatsMap[cId]) {
      const u = userMap[cId];
      contributorStatsMap[cId] = {
        contributorId:   cId,
        contributorName: u?.name || 'Unassigned',
        contributorRole: u?.role || '—',
        assigned:  0,
        submitted: 0,
        reviewed:  0,
        approved:  0,
      };
    }
    contributorStatsMap[cId].assigned++;
    if (['submitted', 'reviewed', 'approved'].includes(a.status)) contributorStatsMap[cId].submitted++;
    if (['reviewed', 'approved'].includes(a.status))              contributorStatsMap[cId].reviewed++;
    if (a.status === 'approved')                                  contributorStatsMap[cId].approved++;
  }

  const contributorStats = Object.values(contributorStatsMap);

  // ── Total questions from framework ───────────────────────────────────────────
  const totalQuestionsInFramework = dashboard.progress.totalQuestions;

  return {
    data: {
      brsrData: {
        clientId,
        frameworkCode:       FRAMEWORK_CODE,
        periodId,
        instanceStatus:      activeInstance.status,
        activatedAt:         activeInstance.activatedAt,
        lockedAt:            activeInstance.lockedAt,

        // Overall readiness
        overallReadinessPct: dashboard.overallReadinessPct,

        // Detailed progress counters
        progress: {
          totalQuestions:       dashboard.progress.totalQuestions,
          notStarted:           dashboard.progress.notStarted,
          answeredByContributor:dashboard.progress.answeredByContributor,
          metricLinked:         dashboard.progress.metricLinked,
          metricDataApproved:   dashboard.progress.metricDataApproved,
          reviewed:             dashboard.progress.reviewed,
          approverApproved:     dashboard.progress.approverApproved,
          consultantFinalDone:  dashboard.progress.consultantFinalDone,
          finalReport:          dashboard.progress.finalReport,
        },

        // Answer workflow status distribution
        answersByStatus:     byStatus,
        totalAnswers:        answers.length,

        // Section-level breakdown (A, B, C-P1 through C-P9)
        sections:            dashboard.sections,

        // Per-contributor progress
        contributorStats,

        // All available periods for this client
        allPeriods: instances.map((i) => ({
          periodId:      i.periodId,
          status:        i.status,
          reportingYear: i.reportingYear,
        })),
      },
    },
    exclusions,
    recordCount: totalQuestionsInFramework + answers.length,
  };
}

module.exports = { retrieve };
