// controllers/Organization/surveyController.js
// Handles all survey lifecycle operations for Tier-2 Employee Commuting surveys.
//
// Authenticated endpoints: client_employee_head / client_admin / consultant / super_admin
// Public endpoints (no auth): survey resolution and submission

const mongoose = require('mongoose');
const Flowchart = require('../../models/Organization/Flowchart');
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
const SurveyLink = require('../../models/Organization/SurveyLink');
const AnonymousCode = require('../../models/Organization/AnonymousCode');
const SurveyResponse = require('../../models/Organization/SurveyResponse');
const SurveyCycle = require('../../models/Organization/SurveyCycle');

const {
  generateSurveyToken,
  hashToken,
  verifyToken,
  tokenPrefix,
  generateAnonymousCode,
  isSurveyLinkExpired,
  calculateLinkExpiry,
} = require('../../services/survey/surveyTokenService');

const {
  validateSurveyResponse,
  calculateResponseEmissions,
  weeksForFrequency,
  buildEFLookup,
} = require('../../services/survey/surveyEmissionCalculator');

const { fetchScopeEFData } = require('../../services/survey/surveyEFHelper');

const DataEntry = require('../../models/Organization/DataEntry');
const { canManageFlowchart, canViewFlowchart } = require('../../utils/Permissions/permissions');
const {
  aggregateAndSaveSurveyEmissions,
  finalizeCycleEmissions,
  crossCycleAverage,
} = require('../Calculation/emissionCalculationController');
const { logEvent } = require('../../services/audit/auditLogService');

// ─── Constants ───────────────────────────────────────────────────────────────
const SURVEY_VERSION = '1.0';

// ─── Helper: check if a scope qualifies for EC Tier-2 survey ─────────────────
function isECTier2Scope(scope) {
  return (
    scope &&
    scope.scopeType === 'Scope 3' &&
    (scope.categoryName || '').toLowerCase() === 'employee commuting' &&
    scope.calculationModel === 'tier 2' &&
    scope.fromOtherChart === false
  );
}

// ─── Helper: resolve clientId guard (client-scoped roles only see own client) ─
const CLIENT_SCOPED_ROLES = new Set([
  'client_admin', 'client_employee_head', 'employee', 'auditor', 'viewer',
]);

function assertClientAccess(user, clientId) {
  if (CLIENT_SCOPED_ROLES.has(user.userType) && user.clientId !== clientId) {
    return false;
  }
  return true;
}

// ─── Helper: find the EC Tier-2 scope in a flowchart node ────────────────────
function findECScope(flowchart, nodeId, scopeIdentifier) {
  const node = (flowchart.nodes || []).find(n => n.id === nodeId);
  if (!node) return null;
  const scope = (node.details?.scopeDetails || []).find(
    s => s.scopeIdentifier === scopeIdentifier && isECTier2Scope(s)
  );
  return scope || null;
}

// ─── Helper: recompute and persist SurveyCycle statistics ────────────────────
async function refreshCycleStats(clientId, scopeIdentifier, cycleIndex, responseMode) {
  const cycle = await SurveyCycle.findOne({ clientId, scopeIdentifier, cycleIndex });
  if (!cycle) return;

  if (responseMode === 'unique') {
    const [submitted, opened, pending, expired] = await Promise.all([
      SurveyLink.countDocuments({ clientId, scopeIdentifier, cycleIndex, status: 'submitted' }),
      SurveyLink.countDocuments({ clientId, scopeIdentifier, cycleIndex, status: 'opened' }),
      SurveyLink.countDocuments({ clientId, scopeIdentifier, cycleIndex, status: 'pending' }),
      SurveyLink.countDocuments({ clientId, scopeIdentifier, cycleIndex, status: 'expired' }),
    ]);
    const total = cycle.totalLinks || 1;
    cycle.statistics = {
      submitted,
      opened,
      pending,
      expired,
      completionPct: Math.round((submitted / total) * 100),
    };
  } else {
    const [redeemed, total] = await Promise.all([
      AnonymousCode.countDocuments({ clientId, scopeIdentifier, cycleIndex, isRedeemed: true }),
      AnonymousCode.countDocuments({ clientId, scopeIdentifier, cycleIndex }),
    ]);
    const cycleTotalLinks = cycle.totalLinks || total || 1;
    cycle.statistics = {
      submitted: redeemed,
      opened: 0,
      pending: total - redeemed,
      expired: 0,
      completionPct: Math.round((redeemed / cycleTotalLinks) * 100),
    };
  }

  await cycle.save();
}

// ════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/surveys/:clientId/generate-links
 * Unique mode: generate survey tokens per employee per cycle.
 *
 * Body: {
 *   flowchartId, nodeId, scopeIdentifier,
 *   employees: [{ employeeId, employeeName }],
 *   linkExpiryDays (optional, default 30)
 * }
 */
async function generateSurveyLinks(req, res) {
  try {
    const { clientId } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const { flowchartId, nodeId, scopeIdentifier, employees, linkExpiryDays = 30, completionThresholdPct = 100 } = req.body;
    if (!flowchartId || !nodeId || !scopeIdentifier || !Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ message: 'flowchartId, nodeId, scopeIdentifier and employees[] are required.' });
    }

    // Load flowchart and locate the EC Tier-2 scope
    const flowchart = await Flowchart.findById(flowchartId);
    if (!flowchart || flowchart.clientId !== clientId) {
      return res.status(404).json({ message: 'Flowchart not found.' });
    }

    const scope = findECScope(flowchart, nodeId, scopeIdentifier);
    if (!scope) {
      return res.status(400).json({ message: 'No Employee Commuting Tier-2 scope found at this node (or fromOtherChart=true).' });
    }

    const ecConfig = scope.employeeCommutingConfig || {};
    const collectionDates = ecConfig.collectionDates || [];
    if (collectionDates.length === 0) {
      return res.status(400).json({ message: 'No collection dates configured on this scope. Set collectionStartDate and collectionFrequency first.' });
    }
    if (ecConfig.responseMode !== 'unique') {
      return res.status(400).json({ message: 'This scope is configured for anonymous mode, not unique.' });
    }

    const reportingYear = new Date(collectionDates[0]).getFullYear();
    // Note: per-employee expiresAt is computed inside the employee loop below.

    const createdLinks = []; // { cycleIndex, cycleDate, employeeId, employeeName, token, surveyLinkId }

    for (let cycleIndex = 0; cycleIndex < collectionDates.length; cycleIndex++) {
      const cycleDate = collectionDates[cycleIndex];

      // Upsert SurveyCycle
      let cycle = await SurveyCycle.findOne({ clientId, scopeIdentifier, cycleIndex });
      if (!cycle) {
        cycle = await SurveyCycle.create({
          clientId,
          flowchartId: flowchart._id,
          nodeId,
          scopeIdentifier,
          responseMode: 'unique',
          cycleIndex,
          cycleDate,
          reportingYear,
          status: 'open',
          openedAt: new Date(),
          totalLinks: employees.length,
          completionThresholdPct,
          generatedBy: req.user._id,
        });
      } else {
        // Update totalLinks and threshold if regenerating
        cycle.totalLinks = employees.length;
        cycle.completionThresholdPct = completionThresholdPct;
        cycle.status = 'open';
        if (!cycle.openedAt) cycle.openedAt = new Date();
        await cycle.save();
      }

      for (const emp of employees) {
        // Per-employee expiry: use emp.linkExpiryDays if provided, else fall back to global default
        const empExpiryDays = (emp.linkExpiryDays != null) ? emp.linkExpiryDays : linkExpiryDays;
        const expiresAt = calculateLinkExpiry(empExpiryDays);

        const token = generateSurveyToken();
        const hash = await hashToken(token);
        const prefix = tokenPrefix(token);

        const link = await SurveyLink.findOneAndUpdate(
          { clientId, scopeIdentifier, cycleIndex, recipientId: emp.employeeId || null },
          {
            $setOnInsert: {
              clientId,
              flowchartId: flowchart._id,
              nodeId,
              scopeIdentifier,
              cycleIndex,
              cycleDate,
              reportingYear,
              recipientId: emp.employeeId || null,
              recipientName: emp.employeeName || '',
              tokenHash: hash,
              tokenPrefix: prefix,
              status: 'pending',
              expiresAt,
              createdBy: req.user._id,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // If already exists (not newly created), regenerate token
        if (link.status === 'submitted') {
          // Don't regenerate for already-submitted links
          createdLinks.push({
            cycleIndex,
            cycleDate,
            employeeId: emp.employeeId,
            employeeName: emp.employeeName,
            token: null,
            surveyLinkId: link._id,
            status: 'already_submitted',
          });
          continue;
        }

        // For non-submitted, update with new token
        link.tokenHash = hash;
        link.tokenPrefix = prefix;
        link.status = 'pending';
        link.expiresAt = expiresAt;
        await link.save();

        createdLinks.push({
          cycleIndex,
          cycleDate,
          employeeId: emp.employeeId,
          employeeName: emp.employeeName,
          token,            // Plaintext — caller must distribute this securely
          surveyLinkId: link._id,
          status: 'pending',
          expiresAt,        // Per-employee expiry date
        });
      }
    }

    return res.status(200).json({
      message: `Survey links generated for ${collectionDates.length} cycle(s) and ${employees.length} employee(s).`,
      totalLinks: createdLinks.length,
      links: createdLinks,
    });
  } catch (err) {
    console.error('generateSurveyLinks error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * POST /api/surveys/:clientId/generate-codes
 * Anonymous mode: generate codes per department across every configured cycle.
 *
 * Body: {
 *   flowchartId        (string)  — required unless processFlowchartId provided
 *   processFlowchartId (string)  — required unless flowchartId provided
 *   nodeId             (string)  — required
 *   scopeIdentifier    (string)  — required
 *   clientShortName    (string)  — optional; used as code prefix
 *   departments        (array)   — required; [{ departmentName: string, count: number }, ...]
 * }
 *
 * Capacity rule: sum of all department counts (existing + new per cycle) must not
 * exceed employeeCommutingConfig.numberOfEmployees on the scope.
 *
 * Example:
 *   departments: [
 *     { departmentName: 'Production', count: 100 },
 *     { departmentName: 'Operations', count: 100 },
 *     { departmentName: 'Finance',    count: 100 }
 *   ]
 */
async function generateAnonymousCodes(req, res) {
  try {
    const { clientId } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const {
      flowchartId,
      processFlowchartId,
      nodeId,
      scopeIdentifier,
      departments,
      clientShortName,
      codeExpiryDays = 30,
      completionThresholdPct = 100,
    } = req.body;

    // ── 1. Basic field validation ─────────────────────────────────────────────
    if (!nodeId || !scopeIdentifier) {
      return res.status(400).json({ message: 'nodeId and scopeIdentifier are required.' });
    }
    if (!flowchartId && !processFlowchartId) {
      return res.status(400).json({ message: 'flowchartId or processFlowchartId is required.' });
    }

    // ── 2. Validate departments array ─────────────────────────────────────────
    if (!Array.isArray(departments) || departments.length === 0) {
      return res.status(400).json({
        message: 'departments must be a non-empty array of { departmentName, count }.',
      });
    }
    for (const dept of departments) {
      if (!dept.departmentName || typeof dept.departmentName !== 'string') {
        return res.status(400).json({ message: 'Each department entry must have a departmentName string.' });
      }
      if (!Number.isInteger(dept.count) || dept.count < 1) {
        return res.status(400).json({
          message: `Department "${dept.departmentName}": count must be a positive integer.`,
        });
      }
    }
    const totalRequested = departments.reduce((sum, d) => sum + d.count, 0);

    // ── 3. Load Flowchart or ProcessFlowchart (processFlowchartId takes priority) ──
    let chartDoc = null;
    let isProcessFlowchart = false;
    if (processFlowchartId) {
      chartDoc = await ProcessFlowchart.findById(processFlowchartId);
      if (!chartDoc || chartDoc.clientId !== clientId) {
        return res.status(404).json({ message: 'ProcessFlowchart not found.' });
      }
      isProcessFlowchart = true;
    } else {
      chartDoc = await Flowchart.findById(flowchartId);
      if (!chartDoc || chartDoc.clientId !== clientId) {
        return res.status(404).json({ message: 'Flowchart not found.' });
      }
    }

    // ── 4. Locate the EC Tier-2 scope ─────────────────────────────────────────
    const scope = findECScope(chartDoc, nodeId, scopeIdentifier);
    if (!scope) {
      return res.status(400).json({
        message: 'No Employee Commuting Tier-2 scope found at this node (or fromOtherChart=true).',
      });
    }

    const ecConfig = scope.employeeCommutingConfig || {};
    if (ecConfig.responseMode !== 'anonymous') {
      return res.status(400).json({ message: 'This scope is configured for unique mode, not anonymous.' });
    }

    const numberOfEmployees = ecConfig.numberOfEmployees || 0;
    if (numberOfEmployees < 1) {
      return res.status(400).json({ message: 'numberOfEmployees must be set on the scope configuration.' });
    }

    const collectionDates = ecConfig.collectionDates || [];
    if (collectionDates.length === 0) {
      return res.status(400).json({ message: 'No collection dates configured.' });
    }

    // ── 5. Capacity check: per cycle, existing + requested ≤ numberOfEmployees ──
    const overflowCycles = [];
    for (let ci = 0; ci < collectionDates.length; ci++) {
      const existing = await AnonymousCode.countDocuments({ clientId, scopeIdentifier, cycleIndex: ci });
      if (existing + totalRequested > numberOfEmployees) {
        overflowCycles.push({
          cycleIndex: ci,
          existing,
          requested: totalRequested,
          capacity: numberOfEmployees,
          available: Math.max(0, numberOfEmployees - existing),
        });
      }
    }
    if (overflowCycles.length > 0) {
      return res.status(400).json({
        message: `Total codes (existing + requested ${totalRequested}) would exceed numberOfEmployees (${numberOfEmployees}).`,
        overflowCycles,
      });
    }

    // ── 6. Generate codes per cycle per department ────────────────────────────
    const shortName = clientShortName || clientId.substring(0, 8).toUpperCase();
    const reportingYear = new Date(collectionDates[0]).getFullYear();
    const expiresAt = calculateLinkExpiry(codeExpiryDays);
    const batchSummary = [];

    for (let cycleIndex = 0; cycleIndex < collectionDates.length; cycleIndex++) {
      const cycleDate = collectionDates[cycleIndex];
      const batchId = `${clientId}_${scopeIdentifier}_${cycleIndex}_${Date.now()}`;

      const existingTotal = await AnonymousCode.countDocuments({ clientId, scopeIdentifier, cycleIndex });

      // Upsert SurveyCycle
      let cycle = await SurveyCycle.findOne({ clientId, scopeIdentifier, cycleIndex });
      if (!cycle) {
        cycle = await SurveyCycle.create({
          clientId,
          flowchartId: isProcessFlowchart ? null : chartDoc._id,
          processFlowchartId: isProcessFlowchart ? chartDoc._id : null,
          nodeId,
          scopeIdentifier,
          responseMode: 'anonymous',
          cycleIndex,
          cycleDate,
          reportingYear,
          status: 'open',
          openedAt: new Date(),
          totalLinks: existingTotal + totalRequested,
          completionThresholdPct,
          generatedBy: req.user._id,
        });
      } else {
        cycle.totalLinks = existingTotal + totalRequested;
        cycle.completionThresholdPct = completionThresholdPct;
        cycle.status = 'open';
        if (!cycle.openedAt) cycle.openedAt = new Date();
        await cycle.save();
      }

      // Generate codes per department
      const deptBreakdown = [];
      for (const dept of departments) {
        // Offset seq by existing codes for this dept so top-up calls don't collide
        const existingDeptCount = await AnonymousCode.countDocuments({
          clientId, scopeIdentifier, cycleIndex, department: dept.departmentName,
        });

        const deptCodes = [];
        for (let i = 1; i <= dept.count; i++) {
          const seq = existingDeptCount + i;
          const codeLabel = generateAnonymousCode(shortName, dept.departmentName, seq);
          const hash = await hashToken(codeLabel);

          await AnonymousCode.findOneAndUpdate(
            { batchId, clientId, scopeIdentifier, cycleIndex, anonymousCodeId: codeLabel },
            {
              $setOnInsert: {
                clientId,
                flowchartId: isProcessFlowchart ? null : chartDoc._id,
                processFlowchartId: isProcessFlowchart ? chartDoc._id : null,
                nodeId,
                scopeIdentifier,
                cycleIndex,
                cycleDate,
                reportingYear,
                batchId,
                department: dept.departmentName,
                anonymousCodeId: codeLabel,
                codeHash: hash,
                isRedeemed: false,
                expiresAt,
                createdBy: req.user._id,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );

          deptCodes.push(codeLabel);
        }

        deptBreakdown.push({ departmentName: dept.departmentName, count: dept.count, codes: deptCodes });
      }

      batchSummary.push({ cycleIndex, cycleDate, batchId, totalCodeCount: totalRequested, departments: deptBreakdown, expiresAt });
    }

    // Remaining capacity after this generation (cycle 0 used as reference)
    const usedAfter = await AnonymousCode.countDocuments({ clientId, scopeIdentifier, cycleIndex: 0 });

    return res.status(200).json({
      message: `Anonymous codes generated for ${collectionDates.length} cycle(s), ${totalRequested} code(s) across ${departments.length} department(s).`,
      totalRequested,
      capacityUsed: usedAfter,
      capacityTotal: numberOfEmployees,
      remainingCapacity: numberOfEmployees - usedAfter,
      batches: batchSummary,
    });
  } catch (err) {
    console.error('generateAnonymousCodes error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * GET /api/surveys/:clientId/schedule
 * Returns all survey cycles with their status and basic stats.
 */
async function getSurveySchedule(req, res) {
  try {
    const { clientId } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const { scopeIdentifier } = req.query;
    const filter = { clientId };
    if (scopeIdentifier) filter.scopeIdentifier = scopeIdentifier;

    const cycles = await SurveyCycle.find(filter).sort({ cycleIndex: 1 }).lean();

    return res.status(200).json({ cycles });
  } catch (err) {
    console.error('getSurveySchedule error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * GET /api/surveys/:clientId/cycles/:cycleIndex/statistics
 * Returns live completion statistics for a specific cycle.
 */
async function getSurveyStatistics(req, res) {
  try {
    const { clientId, cycleIndex } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const { scopeIdentifier } = req.query;
    if (!scopeIdentifier) {
      return res.status(400).json({ message: 'scopeIdentifier query parameter is required.' });
    }

    const cycle = await SurveyCycle.findOne({
      clientId,
      scopeIdentifier,
      cycleIndex: Number(cycleIndex),
    }).lean();

    if (!cycle) {
      return res.status(404).json({ message: 'Survey cycle not found.' });
    }

    // Recompute live stats
    await refreshCycleStats(clientId, scopeIdentifier, Number(cycleIndex), cycle.responseMode);
    const updated = await SurveyCycle.findOne({ clientId, scopeIdentifier, cycleIndex: Number(cycleIndex) }).lean();

    const s = updated.statistics || {};
    return res.status(200).json({
      cycleIndex: updated.cycleIndex,
      cycleDate: updated.cycleDate,
      reportingYear: updated.reportingYear,
      status: updated.status,
      responseMode: updated.responseMode,
      // ── Headline numbers ───────────────────────────────────────────────────
      total: updated.totalLinks,                           // total surveys issued
      completed: s.submitted || 0,                        // submitted responses
      remaining: (s.pending || 0) + (s.opened || 0),     // not yet submitted
      // ── Breakdown ─────────────────────────────────────────────────────────
      opened: s.opened || 0,
      pending: s.pending || 0,
      expired: s.expired || 0,
      completionPct: s.completionPct || 0,
      // ── Full statistics object for clients that need all fields ────────────
      statistics: s,
    });
  } catch (err) {
    console.error('getSurveyStatistics error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * POST /api/surveys/:clientId/cycles/:cycleIndex/cancel
 * Cancel an active survey cycle. Sets all pending/opened links to expired.
 * Allowed roles: client_employee_head, client_admin, super_admin.
 */
async function cancelSurvey(req, res) {
  try {
    const { clientId, cycleIndex } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const allowed = ['client_employee_head', 'client_admin', 'super_admin'];
    if (!allowed.includes(req.user.userType)) {
      return res.status(403).json({ message: 'Only client_employee_head, client_admin, or super_admin can cancel surveys.' });
    }

    const { scopeIdentifier } = req.body;
    if (!scopeIdentifier) {
      return res.status(400).json({ message: 'scopeIdentifier is required.' });
    }

    const cycle = await SurveyCycle.findOne({
      clientId,
      scopeIdentifier,
      cycleIndex: Number(cycleIndex),
    });

    if (!cycle) {
      return res.status(404).json({ message: 'Survey cycle not found.' });
    }
    if (cycle.status === 'cancelled') {
      return res.status(400).json({ message: 'Survey cycle is already cancelled.' });
    }
    if (cycle.status === 'closed') {
      return res.status(400).json({ message: 'Cannot cancel a closed survey cycle.' });
    }
    if (cycle.status === 'approved') {
      return res.status(400).json({ message: 'Cannot cancel an already-approved survey cycle.' });
    }

    // Bulk-expire all non-submitted links
    const { modifiedCount } = await SurveyLink.updateMany(
      { clientId, scopeIdentifier, cycleIndex: Number(cycleIndex), status: { $in: ['pending', 'opened'] } },
      { $set: { status: 'expired' } }
    );

    cycle.status = 'cancelled';
    cycle.cancelledAt = new Date();
    cycle.cancelledBy = req.user._id;
    await cycle.save();

    return res.status(200).json({
      message: 'Survey cycle cancelled.',
      expiredLinks: modifiedCount,
      cycle: { status: cycle.status, cancelledAt: cycle.cancelledAt },
    });
  } catch (err) {
    console.error('cancelSurvey error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * GET /api/surveys/:clientId/responses
 * Paginated responses for a cycle (admin / consultant).
 * Query: scopeIdentifier, cycleIndex, page, limit, workArrangement, primaryModeCode
 */
async function getSurveyResponses(req, res) {
  try {
    const { clientId } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const {
      scopeIdentifier,
      cycleIndex,
      page = 1,
      limit = 50,
      workArrangement,
      primaryModeCode,
    } = req.query;

    if (!scopeIdentifier || cycleIndex == null) {
      return res.status(400).json({ message: 'scopeIdentifier and cycleIndex are required.' });
    }

    const filter = {
      clientId,
      scopeIdentifier,
      cycleIndex: Number(cycleIndex),
    };
    if (workArrangement) filter.workArrangement = workArrangement;
    if (primaryModeCode) filter.primaryModeCode = primaryModeCode;

    const skip = (Number(page) - 1) * Number(limit);
    const [responses, total] = await Promise.all([
      SurveyResponse.find(filter)
        .skip(skip)
        .limit(Number(limit))
        .sort({ responseTimestamp: -1 })
        .lean(),
      SurveyResponse.countDocuments(filter),
    ]);

    return res.status(200).json({
      total,
      page: Number(page),
      limit: Number(limit),
      responses,
    });
  } catch (err) {
    console.error('getSurveyResponses error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * GET /api/surveys/:clientId/response-rates
 * Per-employee link status for unique mode; redemption rate for anonymous mode.
 */
async function getResponseRates(req, res) {
  try {
    const { clientId } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const { scopeIdentifier, cycleIndex } = req.query;
    if (!scopeIdentifier || cycleIndex == null) {
      return res.status(400).json({ message: 'scopeIdentifier and cycleIndex are required.' });
    }

    const cycle = await SurveyCycle.findOne({
      clientId,
      scopeIdentifier,
      cycleIndex: Number(cycleIndex),
    }).lean();

    if (!cycle) return res.status(404).json({ message: 'Survey cycle not found.' });

    if (cycle.responseMode === 'unique') {
      const links = await SurveyLink.find({
        clientId,
        scopeIdentifier,
        cycleIndex: Number(cycleIndex),
      })
        .select('recipientId recipientName status sentAt openedAt submittedAt tokenPrefix')
        .lean();

      return res.status(200).json({ responseMode: 'unique', totalLinks: links.length, links });
    }

    // Anonymous mode — no PII
    const total = await AnonymousCode.countDocuments({ clientId, scopeIdentifier, cycleIndex: Number(cycleIndex) });
    const redeemed = await AnonymousCode.countDocuments({ clientId, scopeIdentifier, cycleIndex: Number(cycleIndex), isRedeemed: true });

    return res.status(200).json({
      responseMode: 'anonymous',
      totalCodes: total,
      redeemed,
      pending: total - redeemed,
      redemptionPct: total > 0 ? Math.round((redeemed / total) * 100) : 0,
    });
  } catch (err) {
    console.error('getResponseRates error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * PATCH /api/surveys/:clientId/links/:linkId/invalidate
 * Expire a single survey link (client_employee_head / client_admin / super_admin).
 */
async function invalidateSurveyLink(req, res) {
  try {
    const { clientId, linkId } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const allowed = ['client_employee_head', 'client_admin', 'super_admin'];
    if (!allowed.includes(req.user.userType)) {
      return res.status(403).json({ message: 'Insufficient permissions.' });
    }

    const link = await SurveyLink.findOne({ _id: linkId, clientId });
    if (!link) return res.status(404).json({ message: 'Survey link not found.' });
    if (link.status === 'submitted') {
      return res.status(400).json({ message: 'Cannot invalidate an already-submitted link.' });
    }

    link.status = 'expired';
    await link.save();

    return res.status(200).json({ message: 'Link invalidated.', linkId, status: 'expired' });
  } catch (err) {
    console.error('invalidateSurveyLink error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * POST /api/surveys/:clientId/links/:linkId/resend
 * Generate a new token for an existing recipient (replaces old token).
 */
async function resendSurveyLink(req, res) {
  try {
    const { clientId, linkId } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const allowed = ['client_employee_head', 'client_admin', 'super_admin'];
    if (!allowed.includes(req.user.userType)) {
      return res.status(403).json({ message: 'Insufficient permissions.' });
    }

    const link = await SurveyLink.findOne({ _id: linkId, clientId });
    if (!link) return res.status(404).json({ message: 'Survey link not found.' });
    if (link.status === 'submitted') {
      return res.status(400).json({ message: 'Cannot resend a link that has already been submitted.' });
    }

    const { linkExpiryDays = 30 } = req.body;
    const newToken = generateSurveyToken();
    const newHash = await hashToken(newToken);

    link.tokenHash = newHash;
    link.tokenPrefix = tokenPrefix(newToken);
    link.status = 'pending';
    link.expiresAt = calculateLinkExpiry(linkExpiryDays);
    link.openedAt = null;
    link.draftData = null;
    await link.save();

    return res.status(200).json({
      message: 'Survey link regenerated.',
      token: newToken,
      expiresAt: link.expiresAt,
    });
  } catch (err) {
    console.error('resendSurveyLink error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * GET /api/surveys/:clientId/export
 * Export survey results as JSON (Excel formatting is handled by the caller or a dedicated export service).
 * Anonymous mode: excludes PII.
 */
async function exportSurveyResults(req, res) {
  try {
    const { clientId } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const {
      scopeIdentifier,
      cycleIndex,
      startDate,
      endDate,
      workArrangement,
      primaryModeCode,
    } = req.query;

    const filter = { clientId };
    if (scopeIdentifier) filter.scopeIdentifier = scopeIdentifier;
    if (cycleIndex != null) filter.cycleIndex = Number(cycleIndex);
    if (workArrangement) filter.workArrangement = workArrangement;
    if (primaryModeCode) filter.primaryModeCode = primaryModeCode;
    if (startDate || endDate) {
      filter.responseTimestamp = {};
      if (startDate) filter.responseTimestamp.$gte = new Date(startDate);
      if (endDate) filter.responseTimestamp.$lte = new Date(endDate);
    }

    const responses = await SurveyResponse.find(filter).lean();

    // Strip PII for anonymous responses
    const sanitized = responses.map(r => {
      const out = { ...r };
      if (r.responseMode === 'anonymous') {
        delete out.recipientId;
        // anonymousCodeId is kept — it's a random label, not personal data
      }
      return out;
    });

    return res.status(200).json({
      total: sanitized.length,
      exportedAt: new Date(),
      responses: sanitized,
    });
  } catch (err) {
    console.error('exportSurveyResults error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (no auth)
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/survey/resolve/:token
 * Validate a unique survey token and return pre-survey metadata.
 * Marks link status as 'opened' on first access.
 */
async function resolveUniqueToken(req, res) {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token is required.' });

    // Find all non-expired links and verify token against their hashes
    // For performance, index on tokenPrefix and narrow the search
    const prefix = tokenPrefix(token);
    const candidates = await SurveyLink.find({
      tokenPrefix: prefix,
      status: { $in: ['pending', 'opened'] },
    });

    let matched = null;
    for (const candidate of candidates) {
      const valid = await verifyToken(token, candidate.tokenHash);
      if (valid) { matched = candidate; break; }
    }

    if (!matched) {
      return res.status(404).json({ message: 'Survey link not found or already used.' });
    }

    if (isSurveyLinkExpired(matched)) {
      matched.status = 'expired';
      await matched.save();
      return res.status(410).json({ message: 'This survey link has expired.' });
    }

    // Mark as opened on first access
    if (matched.status === 'pending') {
      matched.status = 'opened';
      matched.openedAt = new Date();
      await matched.save();
    }

    return res.status(200).json({
      cycleIndex: matched.cycleIndex,
      cycleDate: matched.cycleDate,
      reportingYear: matched.reportingYear,
      scopeIdentifier: matched.scopeIdentifier,
      nodeId: matched.nodeId,
      responseMode: 'unique',
      recipientName: matched.recipientName,
      surveyLinkId: matched._id,
      // Return draft if autosave data exists
      draftData: matched.draftData || null,
    });
  } catch (err) {
    console.error('resolveUniqueToken error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * PATCH /api/survey/autosave/:token
 * Save a partial draft for unique mode only. Anonymous mode returns 400.
 *
 * Body: partial survey data object
 */
async function saveUniqueAutosave(req, res) {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token is required.' });

    const prefix = tokenPrefix(token);
    const candidates = await SurveyLink.find({ tokenPrefix: prefix, status: 'opened' });

    let matched = null;
    for (const c of candidates) {
      if (await verifyToken(token, c.tokenHash)) { matched = c; break; }
    }

    if (!matched) return res.status(404).json({ message: 'Survey link not found or not in opened state.' });
    if (isSurveyLinkExpired(matched)) return res.status(410).json({ message: 'Survey link has expired.' });

    matched.draftData = req.body;
    await matched.save();

    return res.status(200).json({ message: 'Draft saved.' });
  } catch (err) {
    console.error('saveUniqueAutosave error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * POST /api/survey/submit/:token
 * Submit a completed unique-mode survey response.
 *
 * Body: full survey response payload (Q1–Q11 + optional mixed legs + analytics)
 */
async function submitUniqueSurvey(req, res) {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ message: 'Token is required.' });

    const prefix = tokenPrefix(token);
    const candidates = await SurveyLink.find({
      tokenPrefix: prefix,
      status: { $in: ['pending', 'opened'] },
    });

    let matched = null;
    for (const c of candidates) {
      if (await verifyToken(token, c.tokenHash)) { matched = c; break; }
    }

    if (!matched) return res.status(404).json({ message: 'Survey link not found or already submitted.' });
    if (isSurveyLinkExpired(matched)) {
      matched.status = 'expired';
      await matched.save();
      return res.status(410).json({ message: 'Survey link has expired.' });
    }

    // Validation
    const { errors, warnings, flags } = validateSurveyResponse(req.body);
    if (errors.length > 0) {
      return res.status(422).json({ message: 'Validation failed.', errors, warnings });
    }

    // Load scope from Flowchart or ProcessFlowchart to get collectionFrequency and emission factors
    const scopeEFData = await fetchScopeEFData(
      matched.flowchartId,
      matched.processFlowchartId,
      matched.nodeId,
      matched.scopeIdentifier
    );
    let weeksInPeriod = 52; // default annual
    let efLookup = () => 0;
    if (scopeEFData.found) {
      if (scopeEFData.collectionFrequency) weeksInPeriod = weeksForFrequency(scopeEFData.collectionFrequency);
      efLookup = buildEFLookup(scopeEFData.employeeCommutingEmissionFactors);
    }

    const { analyticsData, ...calcData } = req.body;

    // Build and save response
    const response = new SurveyResponse({
      clientId: matched.clientId,
      flowchartId: matched.flowchartId,
      nodeId: matched.nodeId,
      scopeIdentifier: matched.scopeIdentifier,
      cycleIndex: matched.cycleIndex,
      cycleDate: matched.cycleDate,
      reportingYear: matched.reportingYear,
      responseMode: 'unique',
      surveyLinkId: matched._id,
      recipientId: matched.recipientId,
      responseTimestamp: new Date(),
      // Calc-critical fields from body
      workArrangement: calcData.workArrangement,
      commuteDaysPerWeek: calcData.commuteDaysPerWeek ?? null,
      commuteDaysInPeriod: calcData.commuteDaysInPeriod ?? null,
      oneWayDistance: calcData.oneWayDistance ?? null,
      distanceUnit: calcData.distanceUnit || 'km',
      tripType: calcData.tripType ?? null,
      isMixedMode: calcData.isMixedMode ?? null,
      primaryModeCode: calcData.primaryModeCode ?? null,
      vehicleType: calcData.vehicleType || null,
      fuelType:    calcData.fuelType    || null,
      occupancy: calcData.occupancy ?? null,
      legs: calcData.legs || [],
      // Analytics only
      analyticsData: analyticsData || null,
      // Flags
      hasOutlierDistance: flags.hasOutlierDistance,
      hasMixedModeInconsistency: flags.hasMixedModeInconsistency,
      surveyVersion: SURVEY_VERSION,
    });

    // Calculate emissions
    const { emissionsKgCO2e, breakdown } = calculateResponseEmissions(response, weeksInPeriod, efLookup);
    response.calculatedEmissions = emissionsKgCO2e;
    response.calculationBreakdown = breakdown;

    await response.save();

    // Update link status
    matched.status = 'submitted';
    matched.submittedAt = new Date();
    matched.responseId = response._id;
    matched.draftData = null; // clear draft after submission
    await matched.save();

    // Refresh cycle stats
    await refreshCycleStats(matched.clientId, matched.scopeIdentifier, matched.cycleIndex, 'unique');

    return res.status(201).json({
      message: 'Survey response submitted successfully.',
      responseId: response._id,
      calculatedEmissions: emissionsKgCO2e,
      calculationBreakdown: breakdown,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    console.error('submitUniqueSurvey error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * POST /api/survey/anonymous/resolve
 * Validate an anonymous code and return pre-survey context.
 *
 * Body: { anonymousCode }
 */
async function resolveAnonymousCode(req, res) {
  try {
    const { anonymousCode } = req.body;
    if (!anonymousCode) return res.status(400).json({ message: 'anonymousCode is required.' });

    // Find candidate by anonymousCodeId label (not hash — label is stored)
    const codeDoc = await AnonymousCode.findOne({ anonymousCodeId: anonymousCode });
    if (!codeDoc) return res.status(404).json({ message: 'Invalid anonymous code.' });

    if (codeDoc.isRedeemed) {
      return res.status(409).json({ message: 'This code has already been used. Anonymous surveys cannot be resumed.' });
    }

    // Check expiry
    if (codeDoc.expiresAt && new Date() > new Date(codeDoc.expiresAt)) {
      return res.status(410).json({ message: 'This anonymous code has expired.' });
    }

    // Verify hash
    const valid = await verifyToken(anonymousCode, codeDoc.codeHash);
    if (!valid) return res.status(401).json({ message: 'Code verification failed.' });

    return res.status(200).json({
      codeDocId: codeDoc._id,
      cycleIndex: codeDoc.cycleIndex,
      cycleDate: codeDoc.cycleDate,
      reportingYear: codeDoc.reportingYear,
      scopeIdentifier: codeDoc.scopeIdentifier,
      nodeId: codeDoc.nodeId,
      responseMode: 'anonymous',
      // No autosave warning — callers must complete in one session
      autosaveEnabled: false,
      message: 'Please complete the survey in one session. Progress cannot be saved.',
    });
  } catch (err) {
    console.error('resolveAnonymousCode error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * POST /api/survey/anonymous/submit
 * Submit a completed anonymous survey response.
 *
 * Body: { codeDocId, ...surveyData }
 */
async function submitAnonymousSurvey(req, res) {
  try {
    const { codeDocId, anonymousCode, analyticsData, ...calcData } = req.body;

    if (!codeDocId) return res.status(400).json({ message: 'codeDocId is required.' });

    const codeDoc = await AnonymousCode.findById(codeDocId);
    if (!codeDoc) return res.status(404).json({ message: 'Anonymous code not found.' });

    if (codeDoc.isRedeemed) {
      return res.status(409).json({ message: 'This code has already been used.' });
    }

    // Validation
    const { errors, warnings, flags } = validateSurveyResponse(calcData);
    if (errors.length > 0) {
      return res.status(422).json({ message: 'Validation failed.', errors, warnings });
    }

    // Load scope from Flowchart or ProcessFlowchart to get collectionFrequency and emission factors
    const scopeEFData = await fetchScopeEFData(
      codeDoc.flowchartId,
      codeDoc.processFlowchartId,
      codeDoc.nodeId,
      codeDoc.scopeIdentifier
    );
    let weeksInPeriod = 52;
    let efLookup = () => 0;
    if (scopeEFData.found) {
      if (scopeEFData.collectionFrequency) weeksInPeriod = weeksForFrequency(scopeEFData.collectionFrequency);
      efLookup = buildEFLookup(scopeEFData.employeeCommutingEmissionFactors);
    }

    const response = new SurveyResponse({
      clientId: codeDoc.clientId,
      flowchartId: codeDoc.flowchartId,
      nodeId: codeDoc.nodeId,
      scopeIdentifier: codeDoc.scopeIdentifier,
      cycleIndex: codeDoc.cycleIndex,
      cycleDate: codeDoc.cycleDate,
      reportingYear: codeDoc.reportingYear,
      responseMode: 'anonymous',
      anonymousCodeId: codeDoc.anonymousCodeId,
      anonymousCodeDocId: codeDoc._id,
      responseTimestamp: new Date(),
      workArrangement: calcData.workArrangement,
      commuteDaysPerWeek: calcData.commuteDaysPerWeek ?? null,
      commuteDaysInPeriod: calcData.commuteDaysInPeriod ?? null,
      oneWayDistance: calcData.oneWayDistance ?? null,
      distanceUnit: calcData.distanceUnit || 'km',
      tripType: calcData.tripType ?? null,
      isMixedMode: calcData.isMixedMode ?? null,
      primaryModeCode: calcData.primaryModeCode ?? null,
      vehicleType: calcData.vehicleType ?? null,
      fuelType: calcData.fuelType ?? null,
      occupancy: calcData.occupancy ?? null,
      legs: calcData.legs || [],
      analyticsData: analyticsData || null,
      hasOutlierDistance: flags.hasOutlierDistance,
      hasMixedModeInconsistency: flags.hasMixedModeInconsistency,
      surveyVersion: SURVEY_VERSION,
    });

    const { emissionsKgCO2e, breakdown } = calculateResponseEmissions(response, weeksInPeriod, efLookup);
    response.calculatedEmissions = emissionsKgCO2e;
    response.calculationBreakdown = breakdown;

    await response.save();

    // Mark code as redeemed
    codeDoc.isRedeemed = true;
    codeDoc.redeemedAt = new Date();
    codeDoc.responseId = response._id;
    await codeDoc.save();

    // Refresh cycle stats
    await refreshCycleStats(codeDoc.clientId, codeDoc.scopeIdentifier, codeDoc.cycleIndex, 'anonymous');

    return res.status(201).json({
      message: 'Survey response submitted successfully.',
      responseId: response._id,
      calculatedEmissions: emissionsKgCO2e,
      calculationBreakdown: breakdown,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    console.error('submitAnonymousSurvey error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * POST /api/surveys/:clientId/cycles/:cycleIndex/approve
 * Approve a survey cycle: applies average-fill for non-respondents and persists to DataEntry.
 * Blocked until cycle.statistics.completionPct >= cycle.completionThresholdPct.
 *
 * Body:  { scopeIdentifier, nodeId }
 * Roles: client_admin, client_employee_head, consultant, super_admin
 */
async function approveSurvey(req, res) {
  try {
    const { clientId, cycleIndex } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const allowed = ['client_employee_head', 'client_admin', 'super_admin', 'consultant'];
    if (!allowed.includes(req.user.userType)) {
      return res.status(403).json({ message: 'Insufficient permissions to approve a survey cycle.' });
    }

    const { scopeIdentifier, nodeId } = req.body;
    if (!scopeIdentifier || !nodeId) {
      return res.status(400).json({ message: 'scopeIdentifier and nodeId are required.' });
    }

    const cycle = await SurveyCycle.findOne({
      clientId,
      scopeIdentifier,
      cycleIndex: Number(cycleIndex),
    });

    if (!cycle) {
      return res.status(404).json({ message: 'Survey cycle not found.' });
    }
    if (cycle.status === 'approved') {
      return res.status(400).json({ message: 'Survey cycle is already approved.' });
    }
    if (cycle.status === 'cancelled') {
      return res.status(400).json({ message: 'Cannot approve a cancelled survey cycle.' });
    }

    // ── Threshold guard ───────────────────────────────────────────────────────
    const currentPct  = cycle.statistics?.completionPct ?? 0;
    const thresholdPct = cycle.completionThresholdPct ?? 100;
    if (currentPct < thresholdPct) {
      return res.status(400).json({
        message: `Cannot approve: only ${currentPct}% of surveys submitted, minimum threshold is ${thresholdPct}%.`,
        currentCompletionPct: currentPct,
        completionThresholdPct: thresholdPct,
      });
    }

    // ── Fetch collectionFrequency ─────────────────────────────────────────────
    const efData = await fetchScopeEFData(
      cycle.flowchartId,
      cycle.processFlowchartId,
      nodeId,
      scopeIdentifier
    );
    const collectionFrequency = efData.collectionFrequency || 'annually';

    // ── Average-fill calculation + DataEntry upsert ───────────────────────────
    const result = await finalizeCycleEmissions({
      clientId,
      nodeId,
      scopeIdentifier,
      cycleIndex: Number(cycleIndex),
      cycleDate: cycle.cycleDate,
      reportingYear: cycle.reportingYear,
      flowchartId: cycle.flowchartId,
      collectionFrequency,
      totalLinks: cycle.totalLinks || 0,
    });

    // ── Mark cycle as approved ────────────────────────────────────────────────
    cycle.status = 'approved';
    cycle.approvedAt = new Date();
    cycle.approvedBy = req.user._id;
    cycle.closedAt = new Date();
    cycle.totalEmissionsKgCO2e = result.finalTotal;
    await cycle.save();

    const r4 = (n) => parseFloat((Number(n) || 0).toFixed(4));
    const totalLinks = cycle.totalLinks || 0;
    const submissionPct = totalLinks > 0 ? Math.round((result.submittedCount / totalLinks) * 100) : 0;

    return res.status(200).json({
      message: 'Survey cycle approved. DataEntry saved with average-fill for non-respondents.',
      cycleIndex: Number(cycleIndex),
      scopeIdentifier,
      completionThresholdPct: thresholdPct,
      approvedAt: cycle.approvedAt,
      approvedBy: req.user._id,
      submissionSummary: {
        totalLinks,
        submittedCount: result.submittedCount,
        submissionPct,
      },
      emissionSummary: {
        sumOfSubmitted: r4(result.sumActual ?? (result.finalTotal - result.pendingEmission)),
        averagePerEmployee: r4(result.averageEmission),
        pendingCount: result.pendingCount,
        pendingEmission: r4(result.pendingEmission),
        finalTotalKgCO2e: r4(result.finalTotal),
        isFinalizedWithAverage: result.pendingCount > 0,
      },
      averageFillBreakdown: {
        formula: 'finalTotal = sumOfSubmitted + (averagePerEmployee × pendingCount)',
        step1_sumOfSubmitted:   `${r4(result.finalTotal - result.pendingEmission)} kgCO2e from ${result.submittedCount} submitted response(s)`,
        step2_averagePerEmployee: result.submittedCount > 0
          ? `${r4(result.finalTotal - result.pendingEmission)} / ${result.submittedCount} = ${r4(result.averageEmission)} kgCO2e per employee`
          : '0 responses submitted — average = 0 kgCO2e',
        step3_pendingCount:     `${totalLinks} total − ${result.submittedCount} submitted = ${result.pendingCount} pending`,
        step4_pendingEmission:  `${r4(result.averageEmission)} × ${result.pendingCount} = ${r4(result.pendingEmission)} kgCO2e`,
        step5_finalTotal:       `${r4(result.finalTotal - result.pendingEmission)} + ${r4(result.pendingEmission)} = ${r4(result.finalTotal)} kgCO2e`,
      },
      dataEntryId: result.dataEntryId,
      cycle: { status: cycle.status, approvedAt: cycle.approvedAt, closedAt: cycle.closedAt },
    });
  } catch (err) {
    console.error('approveSurvey error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

/**
 * PATCH /api/surveys/:clientId/cycles/:cycleIndex/threshold
 * Update the completion threshold % for a cycle.
 *
 * Body:  { scopeIdentifier, completionThresholdPct }
 * Roles: client_admin, client_employee_head, super_admin
 */
async function updateSurveyThreshold(req, res) {
  try {
    const { clientId, cycleIndex } = req.params;
    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied for this client.' });
    }

    const allowed = ['client_employee_head', 'client_admin', 'super_admin'];
    if (!allowed.includes(req.user.userType)) {
      return res.status(403).json({ message: 'Only client_employee_head, client_admin, or super_admin can update the threshold.' });
    }

    const { scopeIdentifier, completionThresholdPct } = req.body;
    if (!scopeIdentifier) {
      return res.status(400).json({ message: 'scopeIdentifier is required.' });
    }
    if (completionThresholdPct == null || isNaN(Number(completionThresholdPct))) {
      return res.status(400).json({ message: 'completionThresholdPct must be a number.' });
    }
    const pct = Number(completionThresholdPct);
    if (pct < 0 || pct > 100) {
      return res.status(400).json({ message: 'completionThresholdPct must be between 0 and 100.' });
    }

    const cycle = await SurveyCycle.findOne({
      clientId,
      scopeIdentifier,
      cycleIndex: Number(cycleIndex),
    });

    if (!cycle) {
      return res.status(404).json({ message: 'Survey cycle not found.' });
    }
    if (cycle.status === 'approved') {
      return res.status(400).json({ message: 'Cannot update threshold on an already-approved cycle.' });
    }
    if (cycle.status === 'cancelled') {
      return res.status(400).json({ message: 'Cannot update threshold on a cancelled cycle.' });
    }

    cycle.completionThresholdPct = pct;
    await cycle.save();

    return res.status(200).json({
      message: `Completion threshold updated to ${pct}%.`,
      completionThresholdPct: pct,
      currentCompletionPct: cycle.statistics?.completionPct ?? 0,
      approveUnlocked: (cycle.statistics?.completionPct ?? 0) >= pct,
      cycle: { status: cycle.status, completionThresholdPct: pct, statistics: cycle.statistics },
    });
  } catch (err) {
    console.error('updateSurveyThreshold error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSED CYCLE — CALCULATE AVERAGE SURVEY
// Computes a cross-cycle average from past real (non-auto-filled) DataEntry
// records and upserts it as the DataEntry for the missed/closed cycle.
// Sets approvalStatus: 'pending_approval' — consultant must approve before
// the value counts toward emissions reports.
// ─────────────────────────────────────────────────────────────────────────────
async function calculateAverageSurvey(req, res) {
  try {
    const { clientId, cycleIndex } = req.params;
    const { nodeId, scopeIdentifier, reason } = req.body;

    if (!assertClientAccess(req.user, clientId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const ALLOWED_ROLES = new Set(['client_employee_head', 'client_admin', 'consultant', 'super_admin']);
    if (!ALLOWED_ROLES.has(req.user.userType)) {
      return res.status(403).json({ message: 'Insufficient role to calculate average survey.' });
    }

    if (!nodeId || !scopeIdentifier) {
      return res.status(400).json({ message: 'nodeId and scopeIdentifier are required.' });
    }

    // Fetch and validate the cycle
    const cycle = await SurveyCycle.findOne({ clientId, scopeIdentifier, cycleIndex: Number(cycleIndex) });
    if (!cycle) return res.status(404).json({ message: 'Survey cycle not found.' });
    if (['approved', 'cancelled'].includes(cycle.status)) {
      return res.status(400).json({ message: `Cannot apply average to a cycle with status '${cycle.status}'.` });
    }

    // Compute cross-cycle average
    const result = await crossCycleAverage({
      clientId,
      nodeId,
      scopeIdentifier,
      targetCycleIndex: Number(cycleIndex),
    });

    if (result.error === 'no_historical_data') {
      return res.status(400).json({
        message: 'No approved real survey cycles found to compute average. Please enter data manually.',
      });
    }

    const { average, usedCycleIndexes, usedCount, lowDataWarning, values } = result;

    // Snapshot existing DataEntry (if any) for rollback in editHistory
    const externalId = `survey_cycle_${cycleIndex}`;
    const existingEntry = await DataEntry.findOne({
      clientId, nodeId, scopeIdentifier, isSummary: true, externalId,
    });
    const previousValues = existingEntry
      ? {
          dataValues: Object.fromEntries(existingEntry.dataValues || []),
          totalCO2e: existingEntry.emissionsSummary?.totalCO2e,
          notes: existingEntry.notes,
          approvalStatus: existingEntry.approvalStatus,
        }
      : null;

    // Derive time period from the cycle
    // Derive period manually from cycleDate (UTC-safe)
    const cycleDate = new Date(cycle.cycleDate);
    const periodMonth = cycleDate.getUTCMonth() + 1;
    const periodYear = cycleDate.getUTCFullYear();
    const timestamp = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
    const dateFmt = `${String(timestamp.getUTCDate()).padStart(2, '0')}:${String(periodMonth).padStart(2, '0')}:${periodYear}`;

    const notesText =
      `Cross-cycle average applied.\n` +
      `Source cycles: [${usedCycleIndexes.join(', ')}].\n` +
      `Values (kgCO2e): [${values.map(v => v.toFixed(4)).join(', ')}].\n` +
      `Mean: ${average.toFixed(4)} kgCO2e.\n` +
      `Triggered by: ${req.user.userName} on ${new Date().toISOString()}.\n` +
      `Reason: ${reason || 'Not provided'}.`;

    // Upsert DataEntry
    const savedEntry = await DataEntry.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier, isSummary: true, externalId },
      {
        $set: {
          scopeType: 'Scope 3',
          inputType: 'manual',
          isSummary: true,
          externalId,
          timestamp,
          date: dateFmt,
          summaryPeriod: { year: periodYear, month: periodMonth },
          dataValues: new Map([['totalEmployeeCommutingKgCO2e', average]]),
          'emissionsSummary.totalCO2e': average,
          'emissionsSummary.unit': 'kgCO2e',
          processingStatus: 'processed',
          emissionCalculationStatus: 'completed',
          approvalStatus: 'pending_approval',
          isFinalizedWithAverage: true,
          isAutoFilled: true,
          autoFillReason: 'cycle_missed_manual',
          autoFillSourceCycles: usedCycleIndexes,
          'sourceDetails.dataSource': 'employee_commuting_survey_tier2_average',
          notes: notesText,
          lastEditedBy: req.user._id,
          lastEditedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Snapshot previous values into editHistory if overwriting an existing entry
    if (previousValues) {
      savedEntry.addEditHistory(
        req.user._id,
        reason || 'Cross-cycle average applied',
        previousValues,
        'DataEntry updated with cross-cycle average'
      );
      await savedEntry.save();
    }

    // Update SurveyCycle with reference to the DataEntry
    cycle.autoFillDataEntryId = savedEntry._id;
    await cycle.save();

    // Write AuditLog
    await logEvent({
      req,
      clientId,
      module: 'data_entry',
      action: 'calculate',
      source: 'manual',
      entityType: 'DataEntry',
      entityId: savedEntry._id.toString(),
      severity: lowDataWarning ? 'warning' : 'info',
      status: 'success',
      changeSummary: `Average ${average.toFixed(4)} kgCO2e applied to cycle ${cycleIndex} from ${usedCount} cycle(s)`,
      metadata: {
        cycleIndex: Number(cycleIndex),
        average,
        usedCycleIndexes,
        usedCount,
        lowDataWarning: lowDataWarning || false,
        previousValue: previousValues?.totalCO2e ?? null,
        reason: reason || null,
      },
    });

    return res.status(200).json({
      message: 'Average calculated and applied. Pending consultant approval.',
      dataEntryId: savedEntry._id,
      average,
      usedCycleIndexes,
      usedCount,
      lowDataWarning: lowDataWarning || false,
      previousValue: previousValues?.totalCO2e ?? null,
    });
  } catch (err) {
    console.error('calculateAverageSurvey error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSED CYCLE — CONSULTANT APPROVE AVERAGE
// Approves a pending auto-filled DataEntry so it counts toward emissions reports.
// ─────────────────────────────────────────────────────────────────────────────
async function approveCycleAverage(req, res) {
  try {
    const { clientId, cycleIndex } = req.params;
    const { nodeId, scopeIdentifier, remarks } = req.body;

    const ALLOWED_ROLES = new Set(['consultant', 'super_admin']);
    if (!ALLOWED_ROLES.has(req.user.userType)) {
      return res.status(403).json({ message: 'Only consultants or super admins can approve average fills.' });
    }

    if (!nodeId || !scopeIdentifier) {
      return res.status(400).json({ message: 'nodeId and scopeIdentifier are required.' });
    }

    const externalId = `survey_cycle_${cycleIndex}`;
    const entry = await DataEntry.findOne({
      clientId, nodeId, scopeIdentifier, isSummary: true, externalId, isAutoFilled: true,
    });

    if (!entry) return res.status(404).json({ message: 'No auto-filled DataEntry found for this cycle.' });
    if (entry.approvalStatus !== 'pending_approval') {
      return res.status(400).json({ message: `Entry already actioned (status: '${entry.approvalStatus}').` });
    }

    entry.approvalStatus = 'approved';
    entry.lastEditedBy = req.user._id;
    entry.lastEditedAt = new Date();
    await entry.save();

    await logEvent({
      req,
      clientId,
      module: 'data_entry',
      action: 'approve',
      source: 'manual',
      entityType: 'DataEntry',
      entityId: entry._id.toString(),
      severity: 'info',
      status: 'success',
      changeSummary: `Consultant approved auto-filled average for cycle ${cycleIndex}: ${entry.emissionsSummary?.totalCO2e?.toFixed(4)} kgCO2e`,
      metadata: {
        cycleIndex: Number(cycleIndex),
        approvedBy: req.user._id,
        remarks: remarks || null,
        value: entry.emissionsSummary?.totalCO2e,
      },
    });

    return res.status(200).json({
      message: 'Cycle average approved. Value now counts toward emissions reports.',
      dataEntryId: entry._id,
    });
  } catch (err) {
    console.error('approveCycleAverage error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSED CYCLE — CONSULTANT REJECT AVERAGE
// Rejects a pending auto-filled DataEntry and flags it for manual entry.
// ─────────────────────────────────────────────────────────────────────────────
async function rejectCycleAverage(req, res) {
  try {
    const { clientId, cycleIndex } = req.params;
    const { nodeId, scopeIdentifier, reason } = req.body;

    const ALLOWED_ROLES = new Set(['consultant', 'super_admin']);
    if (!ALLOWED_ROLES.has(req.user.userType)) {
      return res.status(403).json({ message: 'Only consultants or super admins can reject average fills.' });
    }

    if (!nodeId || !scopeIdentifier) {
      return res.status(400).json({ message: 'nodeId and scopeIdentifier are required.' });
    }

    const externalId = `survey_cycle_${cycleIndex}`;
    const entry = await DataEntry.findOne({
      clientId, nodeId, scopeIdentifier, isSummary: true, externalId, isAutoFilled: true,
    });

    if (!entry) return res.status(404).json({ message: 'No auto-filled DataEntry found for this cycle.' });
    if (entry.approvalStatus !== 'pending_approval') {
      return res.status(400).json({ message: `Entry already actioned (status: '${entry.approvalStatus}').` });
    }

    entry.approvalStatus = 'rejected';
    entry.lastEditedBy = req.user._id;
    entry.lastEditedAt = new Date();
    await entry.save();

    await logEvent({
      req,
      clientId,
      module: 'data_entry',
      action: 'other',
      source: 'manual',
      entityType: 'DataEntry',
      entityId: entry._id.toString(),
      severity: 'warning',
      status: 'success',
      changeSummary: `Consultant rejected auto-filled average for cycle ${cycleIndex}`,
      metadata: {
        cycleIndex: Number(cycleIndex),
        rejectedBy: req.user._id,
        reason: reason || null,
      },
    });

    return res.status(200).json({
      message: 'Average rejected. Please enter data manually or recalculate.',
      dataEntryId: entry._id,
    });
  } catch (err) {
    console.error('rejectCycleAverage error:', err);
    return res.status(500).json({ message: 'Internal server error.', error: err.message });
  }
}

module.exports = {
  // Authenticated
  generateSurveyLinks,
  generateAnonymousCodes,
  getSurveySchedule,
  getSurveyStatistics,
  cancelSurvey,
  getSurveyResponses,
  getResponseRates,
  invalidateSurveyLink,
  resendSurveyLink,
  exportSurveyResults,
  approveSurvey,
  updateSurveyThreshold,
  calculateAverageSurvey,
  approveCycleAverage,
  rejectCycleAverage,
  // Public
  resolveUniqueToken,
  saveUniqueAutosave,
  submitUniqueSurvey,
  resolveAnonymousCode,
  submitAnonymousSurvey,
};
