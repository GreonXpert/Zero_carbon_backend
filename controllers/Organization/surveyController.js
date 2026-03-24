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

const { canManageFlowchart, canViewFlowchart } = require('../../utils/Permissions/permissions');

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

    const { flowchartId, nodeId, scopeIdentifier, employees, linkExpiryDays = 30 } = req.body;
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
    const expiresAt = calculateLinkExpiry(linkExpiryDays);

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
          generatedBy: req.user._id,
        });
      } else {
        // Update totalLinks if regenerating
        cycle.totalLinks = employees.length;
        cycle.status = 'open';
        if (!cycle.openedAt) cycle.openedAt = new Date();
        await cycle.save();
      }

      for (const emp of employees) {
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
          generatedBy: req.user._id,
        });
      } else {
        cycle.totalLinks = existingTotal + totalRequested;
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
                createdBy: req.user._id,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );

          deptCodes.push(codeLabel);
        }

        deptBreakdown.push({ departmentName: dept.departmentName, count: dept.count, codes: deptCodes });
      }

      batchSummary.push({ cycleIndex, cycleDate, batchId, totalCodeCount: totalRequested, departments: deptBreakdown });
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
      vehicleType: calcData.vehicleType ?? null,
      fuelType: calcData.fuelType ?? null,
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
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    console.error('submitAnonymousSurvey error:', err);
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
  // Public
  resolveUniqueToken,
  saveUniqueAutosave,
  submitUniqueSurvey,
  resolveAnonymousCode,
  submitAnonymousSurvey,
};
