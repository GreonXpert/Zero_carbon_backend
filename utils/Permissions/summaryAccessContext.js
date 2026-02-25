// utils/permission/summaryAccessContext.js
//
// PURPOSE:
//   Determines what summary data a given user is allowed to see.
//   Returns an "access context" object that summary controllers
//   use to filter emission / process / reduction data before response.
//
// DESIGN PRINCIPLES:
//   - Fail-closed: if user has no assignments → return empty scope
//   - Centralised: one place for all summary-access logic
//   - No DB queries duplicated: fetches flowchart + reduction once, reuses
//   - Safe ObjectId normalisation: string/ObjectId mismatch handled

'use strict';

const Flowchart       = require('../../models/Organization/Flowchart');
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
const Reduction       = require('../../models/Reduction/Reduction');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely convert anything (ObjectId, string, populated doc, null) to string.
 */
const toStr = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v._id != null) return String(v._id);
  if (v.id  != null) return String(v.id);
  return typeof v.toString === 'function' ? v.toString() : '';
};

/**
 * Safely extract a user ID as string from req.user.
 */
const getUserId = (user) => {
  if (!user) return '';
  const raw = user._id ?? user.id ?? user;
  return toStr(raw);
};

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * getSummaryAccessContext
 *
 * Returns one of two shapes:
 *
 * Full-access roles (client_admin, auditor, viewer, consultant*, super_admin):
 *   { isFullAccess: true }
 *
 * Restricted roles (employee_head, employee):
 *   {
 *     isFullAccess:               false,
 *     userId:                     string,
 *     role:                       'employee_head' | 'employee',
 *     allowedNodeIds:             Set<string>,      // org-chart node IDs (employee_head only)
 *     allowedProcessNodeIds:      Set<string>,      // process-chart node IDs (employee_head only)
 *     allowedScopeIdentifiers:    Set<string>,      // specific scope IDs (both roles)
 *     allowedCategoryActivities:  Set<string>,      // 'categoryName::activity' keys (employee only)
 *                                                   // used to filter emissionSummary.byCategory
 *     allowedReductionProjectIds: Set<string>,      // reduction project IDs (both roles)
 *   }
 *
 * @param {Object} user     - req.user (mongoose doc or plain object)
 * @param {string} clientId - the client being accessed
 */
const getSummaryAccessContext = async (user, clientId) => {
  if (!user || !clientId) {
    return { isFullAccess: false, allowedNodeIds: new Set(), allowedProcessNodeIds: new Set(), allowedScopeIdentifiers: new Set(), allowedCategoryActivities: new Set(), allowedReductionProjectIds: new Set(), userId: '', role: 'unknown' };
  }

  const { userType } = user;

  // ── Full-access roles ──────────────────────────────────────────────────────
  // These roles see all client data unfiltered.
  const FULL_ACCESS_ROLES = new Set([
    'super_admin',
    'consultant_admin',
    'consultant',
    'client_admin',
    'auditor',
    'viewer',
  ]);

  if (FULL_ACCESS_ROLES.has(userType)) {
    return { isFullAccess: true };
  }

  // ── Restricted roles ───────────────────────────────────────────────────────
  const userId = getUserId(user);

  if (!userId) {
    console.warn('[summaryAccessContext] Could not extract userId from user object');
    return { isFullAccess: false, allowedNodeIds: new Set(), allowedProcessNodeIds: new Set(), allowedScopeIdentifiers: new Set(), allowedCategoryActivities: new Set(), allowedReductionProjectIds: new Set(), userId: '', role: userType };
  }

  const allowedNodeIds             = new Set();
  const allowedProcessNodeIds      = new Set();
  const allowedScopeIdentifiers    = new Set();
  // employee-specific: 'categoryName::activity' keys built from assigned scopeDetails
  // Used by filterEmissionSummary to precisely filter byCategory + byActivity.
  const allowedCategoryActivities  = new Set();
  const allowedReductionProjectIds = new Set();

  try {
    // ── Fetch Flowchart + ProcessFlowchart + Reductions in parallel ───────────
    const [orgChart, processChart, reductions] = await Promise.all([
      Flowchart.findOne({ clientId, isActive: true }).lean(),
      ProcessFlowchart.findOne({ clientId, isDeleted: { $ne: true } }).lean(),
      Reduction.find({ clientId, isDeleted: { $ne: true } })
        .select('projectId assignedTeam')
        .lean(),
    ]);

    // ── Extract org-chart node assignments ────────────────────────────────────
    if (orgChart && Array.isArray(orgChart.nodes)) {
      for (const node of orgChart.nodes) {
        const details      = node.details || {};
        const empHeadId    = toStr(details.employeeHeadId);
        const scopeDetails = details.scopeDetails || [];

        if (userType === 'client_employee_head') {
          // employee_head is allowed to see the full node they are head of
          if (empHeadId && empHeadId === userId) {
            allowedNodeIds.add(node.id);
            // Also collect all scopeIdentifiers on this node
            for (const sd of scopeDetails) {
              if (sd.scopeIdentifier && !sd.isDeleted) {
                allowedScopeIdentifiers.add(sd.scopeIdentifier);
              }
            }
          }
        } else if (userType === 'employee') {
          // employee sees only the specific scopeDetails they are assigned to.
          // NOTE: do NOT add node.id to allowedNodeIds — emissionSummary.byNode is an
          // aggregate of the ENTIRE node across all scopes; we can't split it per-scope.
          // Instead we collect 'categoryName::activity' keys so filterEmissionSummary
          // can filter byCategory (which stores data at the per-activity granularity).
          for (const sd of scopeDetails) {
            if (!sd.scopeIdentifier || sd.isDeleted) continue;
            const assigned = Array.isArray(sd.assignedEmployees) ? sd.assignedEmployees : [];
            const isAssigned = assigned.some(emp => toStr(emp) === userId);
            if (isAssigned) {
              allowedScopeIdentifiers.add(sd.scopeIdentifier);
              // Build the category+activity key for byCategory filtering
              if (sd.categoryName && sd.activity) {
                allowedCategoryActivities.add(`${sd.categoryName}::${sd.activity}`);
              } else if (sd.categoryName) {
                // fallback: allow the whole category if activity is missing
                allowedCategoryActivities.add(`${sd.categoryName}::*`);
              }
            }
          }
        }
      }
    }

    // ── Extract process-chart node assignments ────────────────────────────────
    if (processChart && Array.isArray(processChart.nodes)) {
      for (const node of processChart.nodes) {
        const details      = node.details || {};
        const empHeadId    = toStr(details.employeeHeadId);
        const scopeDetails = details.scopeDetails || [];

        if (userType === 'client_employee_head') {
          if (empHeadId && empHeadId === userId) {
            allowedProcessNodeIds.add(node.id);
            for (const sd of scopeDetails) {
              if (sd.scopeIdentifier && !sd.isDeleted) {
                allowedScopeIdentifiers.add(sd.scopeIdentifier);
              }
            }
          }
        } else if (userType === 'employee') {
          // Same as org-chart: do NOT add node.id to allowedProcessNodeIds.
          // filterProcessEmissionSummary.byNode would expose the full node aggregate.
          // Employees only get data from byScopeIdentifier.
          for (const sd of scopeDetails) {
            if (!sd.scopeIdentifier || sd.isDeleted) continue;
            const assigned = Array.isArray(sd.assignedEmployees) ? sd.assignedEmployees : [];
            const isAssigned = assigned.some(emp => toStr(emp) === userId);
            if (isAssigned) {
              // Only the scopeIdentifier — NOT the process nodeId.
              allowedScopeIdentifiers.add(sd.scopeIdentifier);
            }
          }
        }
      }
    }

    // ── Extract reduction project assignments ─────────────────────────────────
    for (const reduction of (reductions || [])) {
      const team = reduction.assignedTeam || {};

      if (userType === 'client_employee_head') {
        const headId = toStr(team.employeeHeadId);
        if (headId && headId === userId) {
          allowedReductionProjectIds.add(reduction.projectId);
        }
      } else if (userType === 'employee') {
        const empIds = Array.isArray(team.employeeIds) ? team.employeeIds : [];
        const isAssigned = empIds.some(eid => toStr(eid) === userId);
        if (isAssigned) {
          allowedReductionProjectIds.add(reduction.projectId);
        }
      }
    }

    console.log(`[summaryAccessContext] userId=${userId} role=${userType} ` +
      `allowedNodes=${allowedNodeIds.size} ` +
      `allowedProcessNodes=${allowedProcessNodeIds.size} ` +
      `allowedScopeIds=${allowedScopeIdentifiers.size} ` +
      `allowedReductions=${allowedReductionProjectIds.size}`);

  } catch (err) {
    console.error('[summaryAccessContext] Error building access context:', err.message);
    // Fail-closed: if we can't determine access, return empty (no data)
  }

  return {
    isFullAccess: false,
    userId,
    role: userType,
    allowedNodeIds,
    allowedProcessNodeIds,
    allowedScopeIdentifiers,
    allowedCategoryActivities,
    allowedReductionProjectIds,
  };
};

// ─── Filter functions ──────────────────────────────────────────────────────────

/**
 * filterEmissionSummary
 *
 * Filters the `emissionSummary` nested object from an EmissionSummary document.
 * Reconstructs totals, byScope, byDepartment, byLocation from allowed byNode entries.
 * Zeros out byCategory, byActivity, byEmissionFactor (can't decompose these without raw data).
 *
 * @param {Object} emissionSummary  - doc.emissionSummary (plain object, Maps already converted)
 * @param {Object} context          - result of getSummaryAccessContext
 * @returns {Object}                - filtered emissionSummary
 */
const filterEmissionSummary = (emissionSummary, context) => {
  if (!emissionSummary || context.isFullAccess) return emissionSummary;

  const safeN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // ── employee: filter via byCategory (per-activity granularity) ────────────
  // emissionSummary.byNode is an aggregate of the ENTIRE node across ALL scopes —
  // we cannot decompose it to a single employee's scope without raw DataEntry re-query.
  // HOWEVER, emissionSummary.byCategory stores data at the per-activity level, and
  // each scopeDetail has categoryName + activity — so we CAN filter precisely here.
  if (context.role === 'employee') {
    const { allowedCategoryActivities } = context;

    if (!allowedCategoryActivities || allowedCategoryActivities.size === 0) {
      return buildEmptyEmissionSummaryShell(emissionSummary);
    }

    const totalEmissions = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 };
    const byScope = {
      'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
      'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
      'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    };
    const filteredByCategory = {};
    const filteredByActivity = {};

    for (const [catName, catData] of Object.entries(emissionSummary.byCategory || {})) {
      const activities = catData.activities || {};
      const filteredActivities = {};

      for (const [actName, actData] of Object.entries(activities)) {
        const key      = `${catName}::${actName}`;
        const wildcard = `${catName}::*`;
        if (!allowedCategoryActivities.has(key) && !allowedCategoryActivities.has(wildcard)) continue;

        filteredActivities[actName] = actData;
        filteredByActivity[actName] = actData;

        const co2e = safeN(actData.CO2e);
        const co2  = safeN(actData.CO2);
        const ch4  = safeN(actData.CH4);
        const n2o  = safeN(actData.N2O);

        totalEmissions.CO2e += co2e;
        totalEmissions.CO2  += co2;
        totalEmissions.CH4  += ch4;
        totalEmissions.N2O  += n2o;

        // Recompute byScope using the category's scopeType
        const scopeType = catData.scopeType;
        if (scopeType && byScope[scopeType]) {
          byScope[scopeType].CO2e += co2e;
          byScope[scopeType].CO2  += co2;
          byScope[scopeType].CH4  += ch4;
          byScope[scopeType].N2O  += n2o;
          byScope[scopeType].dataPointCount += safeN(actData.dataPointCount);
        }
      }

      // Only include this category if at least one activity passed the filter
      if (Object.keys(filteredActivities).length > 0) {
        // Recompute the category-level CO2e from its filtered activities
        const catCO2e = Object.values(filteredActivities).reduce((s, a) => s + safeN(a.CO2e), 0);
        filteredByCategory[catName] = {
          ...catData,
          CO2e:       catCO2e,
          CO2:        Object.values(filteredActivities).reduce((s, a) => s + safeN(a.CO2), 0),
          CH4:        Object.values(filteredActivities).reduce((s, a) => s + safeN(a.CH4), 0),
          N2O:        Object.values(filteredActivities).reduce((s, a) => s + safeN(a.N2O), 0),
          activities: filteredActivities,
        };
      }
    }

    return {
      ...emissionSummary,
      totalEmissions,
      byScope,
      byCategory: filteredByCategory,
      byActivity: filteredByActivity,
      // byNode aggregates the whole node — cannot split per scope without raw DataEntry re-query
      byNode:           {},
      byDepartment:     {},
      byLocation:       {},
      byEmissionFactor: {},
      byInputType: {
        manual: { CO2e: 0, dataPointCount: 0 },
        API:    { CO2e: 0, dataPointCount: 0 },
        IOT:    { CO2e: 0, dataPointCount: 0 },
      },
      metadata: {
        ...(emissionSummary.metadata || {}),
        filteredByRole:      context.role,
        filteredForUserId:   context.userId,
        isFiltered:          true,
        filterMethod:        'byCategory',
      },
    };
  }

  // ── employee_head: filter via byNode (they own entire nodes) ─────────────
  if (!emissionSummary.byNode) return emissionSummary;

  const { allowedNodeIds } = context;

  // Fail-closed: employee_head with no assigned nodes → empty summary
  if (allowedNodeIds.size === 0) {
    return buildEmptyEmissionSummaryShell(emissionSummary);
  }

  const totalEmissions = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 };
  const byScope = {
    'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
  };
  const byDepartment = {};
  const byLocation   = {};
  const byNode       = {};

  for (const [nodeId, nodeData] of Object.entries(emissionSummary.byNode)) {
    if (!allowedNodeIds.has(nodeId)) continue;

    byNode[nodeId] = nodeData;

    const co2e = safeN(nodeData.CO2e);
    const co2  = safeN(nodeData.CO2);
    const ch4  = safeN(nodeData.CH4);
    const n2o  = safeN(nodeData.N2O);

    totalEmissions.CO2e += co2e;
    totalEmissions.CO2  += co2;
    totalEmissions.CH4  += ch4;
    totalEmissions.N2O  += n2o;

    // Recompute byScope from per-node byScope
    const nodeByScopeRaw = nodeData.byScope || {};
    for (const scopeKey of ['Scope 1', 'Scope 2', 'Scope 3']) {
      const scopeVal = nodeByScopeRaw[scopeKey];
      if (!scopeVal) continue;
      byScope[scopeKey].CO2e          += safeN(scopeVal.CO2e);
      byScope[scopeKey].CO2           += safeN(scopeVal.CO2);
      byScope[scopeKey].CH4           += safeN(scopeVal.CH4);
      byScope[scopeKey].N2O           += safeN(scopeVal.N2O);
      byScope[scopeKey].dataPointCount += safeN(scopeVal.dataPointCount);
    }

    // Recompute byDepartment
    const dept = nodeData.department || 'Unknown';
    if (!byDepartment[dept]) byDepartment[dept] = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, nodeCount: 0 };
    byDepartment[dept].CO2e += co2e;
    byDepartment[dept].CO2  += co2;
    byDepartment[dept].CH4  += ch4;
    byDepartment[dept].N2O  += n2o;
    byDepartment[dept].nodeCount += 1;

    // Recompute byLocation
    const loc = nodeData.location || 'Unknown';
    if (!byLocation[loc]) byLocation[loc] = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, nodeCount: 0 };
    byLocation[loc].CO2e += co2e;
    byLocation[loc].CO2  += co2;
    byLocation[loc].CH4  += ch4;
    byLocation[loc].N2O  += n2o;
    byLocation[loc].nodeCount += 1;
  }

  return {
    ...emissionSummary,
    totalEmissions,
    byScope,
    byNode,
    byDepartment,
    byLocation,
    // byCategory/byActivity aggregate across ALL nodes — can't decompose per-node
    // without raw DataEntry re-query. Return empty to prevent cross-node leakage.
    byCategory:       {},
    byActivity:       {},
    byEmissionFactor: {},
    byInputType: {
      manual: { CO2e: 0, dataPointCount: 0 },
      API:    { CO2e: 0, dataPointCount: 0 },
      IOT:    { CO2e: 0, dataPointCount: 0 },
    },
    metadata: {
      ...(emissionSummary.metadata || {}),
      filteredByRole:    context.role,
      filteredForUserId: context.userId,
      isFiltered:        true,
      filterMethod:      'byNode',
    },
  };
};

/**
 * filterProcessEmissionSummary
 *
 * Filters processEmissionSummary using allowedProcessNodeIds (employee_head)
 * or allowedScopeIdentifiers (employee).
 * Recomputes totals and byScope from filtered data.
 */
const filterProcessEmissionSummary = (processSummary, context) => {
  if (!processSummary || context.isFullAccess) return processSummary;

  const { allowedProcessNodeIds, allowedScopeIdentifiers, role } = context;

  if (allowedProcessNodeIds.size === 0 && allowedScopeIdentifiers.size === 0) {
    return buildEmptyProcessSummaryShell(processSummary);
  }

  const safeN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  const totalEmissions = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 };
  const byScope = {
    'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
  };
  const byNode            = {};
  const byScopeIdentifier = {};
  const byDepartment      = {};
  const byLocation        = {};

  // Filter byNode — only for employee_head (allowedProcessNodeIds is populated).
  // For employee role, allowedProcessNodeIds is intentionally empty, so this loop
  // produces nothing. Employees get their data from byScopeIdentifier below.
  const allProcessNodes = processSummary.byNode || {};
  for (const [nodeId, nodeData] of Object.entries(allProcessNodes)) {
    if (!allowedProcessNodeIds.has(nodeId)) continue;

    byNode[nodeId] = nodeData;

    const co2e = safeN(nodeData.CO2e);
    totalEmissions.CO2e += co2e;
    totalEmissions.CO2  += safeN(nodeData.CO2);
    totalEmissions.CH4  += safeN(nodeData.CH4);
    totalEmissions.N2O  += safeN(nodeData.N2O);

    const dept = nodeData.department || 'Unknown';
    if (!byDepartment[dept]) byDepartment[dept] = { CO2e: 0, nodeCount: 0 };
    byDepartment[dept].CO2e    += co2e;
    byDepartment[dept].nodeCount += 1;

    const loc = nodeData.location || 'Unknown';
    if (!byLocation[loc]) byLocation[loc] = { CO2e: 0, nodeCount: 0 };
    byLocation[loc].CO2e    += co2e;
    byLocation[loc].nodeCount += 1;
  }

  // Filter byScopeIdentifier (for both roles — employees have specific scope IDs)
  const allScopeIds = processSummary.byScopeIdentifier || {};
  for (const [scopeId, scopeData] of Object.entries(allScopeIds)) {
    if (!allowedScopeIdentifiers.has(scopeId)) continue;
    byScopeIdentifier[scopeId] = scopeData;

    // If employee_head the byNode loop already got totals;
    // for employee, augment totalEmissions from scope-level data
    if (role === 'employee') {
      totalEmissions.CO2e += safeN(scopeData.CO2e);
      totalEmissions.CO2  += safeN(scopeData.CO2);
      totalEmissions.CH4  += safeN(scopeData.CH4);
      totalEmissions.N2O  += safeN(scopeData.N2O);

      const scopeType = scopeData.scopeType;
      if (scopeType && byScope[scopeType]) {
        byScope[scopeType].CO2e          += safeN(scopeData.CO2e);
        byScope[scopeType].dataPointCount += safeN(scopeData.dataPointCount);
      }
    }
  }

  // For employee_head, recompute byScope from byNode (process summary doesn't store it per-node)
  // byScope was already zeroed — recalculate from processSummary.byScope proportionally is
  // not reliable without raw data. Leave byScope empty for now to prevent leakage.

  return {
    ...processSummary,
    totalEmissions,
    byScope,
    byNode,
    byScopeIdentifier,
    byDepartment,
    byLocation,
    byCategory:      {},
    byActivity:      {},
    byEmissionFactor: {},
    metadata: {
      ...(processSummary.metadata || {}),
      filteredByRole: context.role,
      filteredForUserId: context.userId,
      isFiltered: true,
    },
  };
};

/**
 * filterReductionSummary
 *
 * Filters reductionSummary.byProject to allowed project IDs.
 * Recomputes totalNetReduction from filtered projects.
 */
const filterReductionSummary = (reductionSummary, context) => {
  if (!reductionSummary || context.isFullAccess) return reductionSummary;

  const { allowedReductionProjectIds } = context;

  if (allowedReductionProjectIds.size === 0) {
    return buildEmptyReductionSummaryShell();
  }

  const safeN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  const byProject = (reductionSummary.byProject || [])
    .filter(p => allowedReductionProjectIds.has(p.projectId));

  const totalNetReduction = byProject.reduce((sum, p) => sum + safeN(p.totalNetReduction), 0);
  const entriesCount      = byProject.reduce((sum, p) => sum + safeN(p.entriesCount), 0);

  // Recompute byScope / byCategory / byLocation from filtered projects
  const byScope    = {};
  const byCategory = {};
  const byLocation = {};
  const byProjectActivity = {};
  const byMethodology     = {};

  for (const p of byProject) {
    const nr   = safeN(p.totalNetReduction);
    const bump = (obj, key) => {
      const k = key || 'Unknown';
      if (!obj[k]) obj[k] = { totalNetReduction: 0, entriesCount: 0 };
      obj[k].totalNetReduction += nr;
      obj[k].entriesCount      += safeN(p.entriesCount);
    };
    bump(byScope,          p.scope);
    bump(byCategory,       p.category);
    bump(byLocation,       p.location);
    bump(byProjectActivity, p.projectActivity);
    bump(byMethodology,    p.methodology);
  }

  return {
    ...reductionSummary,
    totalNetReduction,
    entriesCount,
    byProject,
    byScope,
    byCategory,
    byLocation,
    byProjectActivity,
    byMethodology,
    metadata: {
      ...(reductionSummary.metadata || {}),
      filteredByRole: context.role,
      filteredForUserId: context.userId,
      isFiltered: true,
    },
  };
};

// ─── Empty shells ─────────────────────────────────────────────────────────────

const buildEmptyEmissionSummaryShell = (original = {}) => ({
  ...(original || {}),
  totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
  byScope: {
    'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
  },
  byNode: {}, byDepartment: {}, byLocation: {},
  byCategory: {}, byActivity: {}, byEmissionFactor: {},
  byInputType: { manual: { CO2e: 0, dataPointCount: 0 }, API: { CO2e: 0, dataPointCount: 0 }, IOT: { CO2e: 0, dataPointCount: 0 } },
});

const buildEmptyProcessSummaryShell = (original = {}) => ({
  ...(original || {}),
  totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
  byScope: {
    'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
    'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
  },
  byNode: {}, byScopeIdentifier: {}, byDepartment: {}, byLocation: {},
  byCategory: {}, byActivity: {}, byEmissionFactor: {},
  metadata: { ...(original?.metadata || {}), filteredByRole: 'unknown', isFiltered: true },
});

const buildEmptyReductionSummaryShell = () => ({
  totalNetReduction: 0, entriesCount: 0,
  byProject: [], byScope: {}, byCategory: {}, byLocation: {}, byProjectActivity: {}, byMethodology: {},
});

// ─── Master apply function ─────────────────────────────────────────────────────

/**
 * applyAccessContextToSummary
 *
 * Given a raw summary document (lean object) and an access context,
 * applies all three filters and returns a new summary object ready to send.
 *
 * @param {Object} summaryDoc  - EmissionSummary lean doc
 * @param {Object} context     - from getSummaryAccessContext
 * @returns {Object}           - filtered summary doc
 */
const applyAccessContextToSummary = (summaryDoc, context) => {
  if (!summaryDoc) return summaryDoc;
  if (context.isFullAccess) return summaryDoc;

  return {
    ...summaryDoc,
    emissionSummary:        filterEmissionSummary(summaryDoc.emissionSummary || {}, context),
    processEmissionSummary: filterProcessEmissionSummary(summaryDoc.processEmissionSummary || {}, context),
    reductionSummary:       filterReductionSummary(summaryDoc.reductionSummary || {}, context),
  };
};

module.exports = {
  getSummaryAccessContext,
  applyAccessContextToSummary,
  filterEmissionSummary,
  filterProcessEmissionSummary,
  filterReductionSummary,
};