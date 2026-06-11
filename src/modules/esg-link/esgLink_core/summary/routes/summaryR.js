'use strict';

const express = require('express');
const { auth } = require('../../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../../common/utils/Permissions/modulePermission');
const { checkEsgSummaryPermission, checkPortfolioPermission, consultantOnly, adminAndAbove } = require('../utils/summaryPermissions');
const ctrl = require('../controllers/summaryController');

const router = express.Router();

// All routes require: valid JWT + active esg_link subscription + role-based layer access
const guard = [auth, requireActiveModuleSubscription('esg_link'), checkEsgSummaryPermission];

// Portfolio-level guard (no clientId in params)
const portfolioGuard = [auth, checkPortfolioPermission];

// ─────────────────────────────────────────────────────────────────────────────
// PERIOD QUERY PARAMS (apply to all GET routes below)
//
//   Yearly (default)   ?year=2024
//   Monthly            ?periodType=month&year=2024&month=3
//   Daily              ?periodType=day&date=2024-03-15
//   Financial Year     ?periodType=financial_year&fyStart=2023-04-01&fyEnd=2024-03-31
//
// Optional modifiers:
//   ?refresh=true      force recompute before returning (boundary routes only)
//   ?layers=approved,draft  restrict which workflow layers are returned
// ─────────────────────────────────────────────────────────────────────────────

// ── Org-wide dashboard ────────────────────────────────────────────────────────
// Returns combined approved totals across all active boundaries for the period.
router.get('/:clientId/summary/dashboard', guard, ctrl.getDashboardSummary);

// ── Role-scoped personal view ─────────────────────────────────────────────────
// reviewer    → their assigned reviewer-pending entries
// approver    → their assigned approver-pending entries
// contributor → their own submitted entries
// others      → same as dashboard
router.get('/:clientId/summary/my-view', guard, ctrl.getMyViewSummary);

// ── Reviewer pending queue ────────────────────────────────────────────────────
// full-access roles: all pending entries across all boundaries
// reviewer: only entries assigned to them
router.get('/:clientId/summary/reviewer-pending', guard, ctrl.getReviewerPendingSummary);

// ── Approver pending queue ────────────────────────────────────────────────────
// full-access roles: all under-review entries with decisions
// approver: only entries assigned to them
router.get('/:clientId/summary/approver-pending', guard, ctrl.getApproverPendingSummary);

// ── Single boundary summary ───────────────────────────────────────────────────
// Returns the cached summary for the given period.
// Cache is computed on first request; pass ?refresh=true to force recompute.
router.get('/:clientId/boundaries/:boundaryId/summary', guard, ctrl.getBoundarySummary);

// ── Node-level hierarchy (approved layer only) ────────────────────────────────
// Returns per-node metric breakdown for the approved summary layer.
router.get('/:clientId/boundaries/:boundaryId/summary/hierarchy', guard, ctrl.getHierarchySummary);

// ── List all period summaries saved for a boundary ────────────────────────────
// Returns [{periodType, periodKey, periodStart, periodEnd, lastComputedAt, totalEntries}]
// for every summary document that exists for this boundary (year + month + day + FY).
router.get('/:clientId/boundaries/:boundaryId/summary/periods', guard, ctrl.getAvailablePeriods);

// ── Manual single-period refresh (admin / consultant only) ────────────────────
// Recomputes the summary for the period specified by query params and saves it.
// Broadcasts a socket update on completion.
router.post('/:clientId/boundaries/:boundaryId/summary/refresh', guard, ctrl.refreshSummary);

// ── Refresh ALL period types for a boundary (admin / consultant only) ─────────
// Finds every unique periodLabel in EsgDataEntry for this boundary,
// derives all 4 period defs (year / month / day / financial_year),
// and recomputes + saves each one.
// Returns {results:[{periodType,periodKey,success}], succeeded, failed}.
router.post('/:clientId/boundaries/:boundaryId/summary/refresh-all', guard, ctrl.refreshAllPeriods);

// =============================================================================
// GROUP 1 — Portfolio (consultant_admin, consultant, super_admin only)
// No clientId in path — cross-client views.
// =============================================================================
// GET /summary/portfolio         — all assigned clients with E/S/G scores & coverage
// GET /summary/client-health     — extended health: stuck entries, data quality, last submission
router.get('/summary/portfolio',    portfolioGuard, ctrl.getPortfolioDashboard);
router.get('/summary/client-health', portfolioGuard, ctrl.getClientHealthSummary);

// =============================================================================
// GROUP 2 — Period Comparison & Trends  (client_admin and above)
// =============================================================================
// GET /:clientId/summary/compare      ?periods=[{year:2024},{year:2023}]   — side-by-side periods
// GET /:clientId/summary/trend        ?category=E&periodType=year&count=12  — time-series
// GET /:clientId/summary/period-list                                         — all saved periods
router.get('/:clientId/summary/compare',     guard, adminAndAbove, ctrl.comparePeriodsForClient);
router.get('/:clientId/summary/trend',       guard, adminAndAbove, ctrl.getTrendForClient);
router.get('/:clientId/summary/period-list', guard, adminAndAbove, ctrl.listAllClientPeriods);

// =============================================================================
// GROUP 3 — Category Deep-Dive & Top/Bottom  (client_admin and above)
// =============================================================================
// GET /:clientId/summary/by-category  — E/S/G breakdown with subcategory drill-down
// GET /:clientId/summary/top-bottom   ?n=5  — top/bottom N metrics by value
router.get('/:clientId/summary/by-category',       guard, adminAndAbove, ctrl.getCategoryBreakdown);
router.get('/:clientId/summary/period-stats',      guard, adminAndAbove, ctrl.getPeriodWorkflowStats);
router.get('/:clientId/summary/monthly-breakdown', guard, adminAndAbove, ctrl.getMonthlyBreakdown);
router.get('/:clientId/summary/daily-breakdown',   guard, adminAndAbove, ctrl.getDailyBreakdown);
router.get('/:clientId/summary/top-bottom',        guard, adminAndAbove, ctrl.getTopBottomMetrics);

// =============================================================================
// GROUP 4 — Coverage & Data Quality  (client_admin and above)
// =============================================================================
// GET /:clientId/summary/coverage      — assigned vs submitted vs approved per metric
// GET /:clientId/summary/data-quality  — OCR confidence, validation rate, evidence rate
// GET /:clientId/summary/missing-data  — metrics with zero entries for the period
router.get('/:clientId/summary/coverage',     guard, adminAndAbove, ctrl.getMetricCoverage);
router.get('/:clientId/summary/data-quality', guard, adminAndAbove, ctrl.getDataQualityStats);
router.get('/:clientId/summary/missing-data', guard, adminAndAbove, ctrl.getMissingMetrics);

// =============================================================================
// GROUP 5 — Workflow Analytics  (client_admin and above)
// =============================================================================
// GET /:clientId/summary/workflow-status  — count per status (draft/submitted/approved/…)
// GET /:clientId/summary/workflow-aging   — avg days stuck per stage
router.get('/:clientId/summary/workflow-status', guard, adminAndAbove, ctrl.getWorkflowStatusCounts);
router.get('/:clientId/summary/workflow-aging',  guard, adminAndAbove, ctrl.getWorkflowAging);

// =============================================================================
// GROUP 6 — Reviewer Dashboard
// Full-access roles see all (can pass ?userId=xxx); reviewer sees own queue only.
// =============================================================================
// GET /:clientId/summary/reviewer/my-queue  — pending entries sorted oldest-first
// GET /:clientId/summary/reviewer/stats     — historical performance metrics
// GET /:clientId/summary/reviewer/aging     — queue with urgency flags
router.get('/:clientId/summary/reviewer/my-queue', guard, ctrl.getReviewerQueue);
router.get('/:clientId/summary/reviewer/stats',    guard, ctrl.getReviewerStats);
router.get('/:clientId/summary/reviewer/aging',    guard, ctrl.getReviewerAgingQueue);

// =============================================================================
// GROUP 7 — Approver Dashboard
// Full-access roles see all (can pass ?userId=xxx); approver sees own queue only.
// =============================================================================
// GET /:clientId/summary/approver/my-queue   — entries awaiting this approver's decision
// GET /:clientId/summary/approver/stats      — decision count, avg time
// GET /:clientId/summary/approver/decisions  — history of past decisions
router.get('/:clientId/summary/approver/my-queue',  guard, ctrl.getApproverQueue);
router.get('/:clientId/summary/approver/stats',     guard, ctrl.getApproverStats);
router.get('/:clientId/summary/approver/decisions', guard, ctrl.getApproverDecisionHistory);

// =============================================================================
// GROUP 8 — Contributor Dashboard
// Full-access roles can pass ?userId=xxx; contributor sees own data only.
// =============================================================================
// GET /:clientId/summary/contributor/my-submissions  — all my entries + status
// GET /:clientId/summary/contributor/my-coverage     — assigned metrics vs submitted
// GET /:clientId/summary/contributor/pending-actions — entries needing re-submission
router.get('/:clientId/summary/contributor/my-submissions',  guard, ctrl.getContributorSubmissions);
router.get('/:clientId/summary/contributor/my-coverage',     guard, ctrl.getContributorCoverage);
router.get('/:clientId/summary/contributor/pending-actions', guard, ctrl.getContributorPendingActions);

// =============================================================================
// GROUP 9 — Boundary Comparison  (client_admin and above)
// =============================================================================
// GET /:clientId/summary/boundaries/compare  ?boundaryIds=["id1","id2"]
router.get('/:clientId/summary/boundaries/compare', guard, adminAndAbove, ctrl.compareBoundaries);

// =============================================================================
// GROUP 10 — Scorecard & Report-Readiness
// =============================================================================
// GET /:clientId/summary/scorecard    — E/S/G scores based on approved coverage
// GET /:clientId/summary/report-ready — readiness checklist for GRI/SASB reporting
router.get('/:clientId/summary/scorecard',    guard, ctrl.getEsgScorecard);
router.get('/:clientId/summary/report-ready', guard, adminAndAbove, ctrl.getReportReadiness);

module.exports = router;
