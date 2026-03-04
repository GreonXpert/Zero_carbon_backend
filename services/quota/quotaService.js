// services/quota/quotaService.js
// ============================================================
// Reusable quota checking service.
//
// DESIGN DECISIONS:
//   - Flowchart/resource usage: computed LIVE from actual DB counts (no sync drift).
//   - User-type usage: tracked atomically via usedCount in ConsultantClientQuota.
//     This is necessary for concurrency safety — live-count + check + create
//     is NOT atomic and can exceed limits under parallel requests.
//   - Limits stored in ConsultantClientQuota (null = unlimited).
//   - Only "consultant" and "consultant_admin" roles consume flowchart quota.
//   - super_admin bypasses all quota checks.
//   - User type quotas are enforced for client_admin creations (employee_head,
//     employee, viewer, auditor).  The quota record is keyed by the ASSIGNED
//     consultant of the client.
// ============================================================

'use strict';

const mongoose              = require('mongoose');
const ConsultantClientQuota = require('../../models/Quota/ConsultantClientQuota');
const Client                = require('../../models/CMS/Client');

// ── Lazy model loaders (avoid circular deps) ──────────────────
const getFlowchart        = () => require('../../models/Organization/Flowchart');
const getProcessFlowchart = () => require('../../models/Organization/ProcessFlowchart');
const getReduction        = () => require('../../models/Reduction/Reduction');
const getTransport        = () => require('../../models/Organization/TransportFlowchart');
const getSbti             = () => require('../../models/Decarbonization/SbtiTarget');
const getUserModel        = () => require('../../models/User');

// ─────────────────────────────────────────────────────────────
// INTERNAL HELPER: safe ObjectId normalizer
// ─────────────────────────────────────────────────────────────
const toObjectId = (consultantId) => {
  try {
    return new mongoose.Types.ObjectId(consultantId.toString());
  } catch (err) {
    throw new Error(
      `[quotaService] Invalid consultantId "${consultantId}". Must be a valid ObjectId.`
    );
  }
};

// ─────────────────────────────────────────────────────────────
// USER TYPE → QUOTA KEY mapping (exported for controllers)
// ─────────────────────────────────────────────────────────────
const USER_TYPE_TO_QUOTA_KEY = ConsultantClientQuota.USER_TYPE_TO_QUOTA_KEY || {
  'client_employee_head': 'employeeHead',
  'employee':             'employee',
  'viewer':               'viewer',
  'auditor':              'auditor',
};

const QUOTA_KEY_TO_USER_TYPE = Object.fromEntries(
  Object.entries(USER_TYPE_TO_QUOTA_KEY).map(([k, v]) => [v, k])
);

const CONTROLLED_USER_TYPES = Object.keys(USER_TYPE_TO_QUOTA_KEY);

// ─────────────────────────────────────────────────────────────
// 1. HELPER: get the assigned consultant for a client
// ─────────────────────────────────────────────────────────────
const getAssignedConsultantId = async (clientId) => {
  const client = await Client.findOne({ clientId })
    .select('stage workflowTracking.assignedConsultantId')
    .lean();
  if (!client) return null;
  return client.workflowTracking?.assignedConsultantId ?? null;
};

// ─────────────────────────────────────────────────────────────
// 2. LIVE USAGE COMPUTATION (flowchart resources only)
// ─────────────────────────────────────────────────────────────
const computeUsage = async (clientId) => {
  const Flowchart          = getFlowchart();
  const ProcessFlowchart   = getProcessFlowchart();
  const Reduction          = getReduction();
  const TransportFlowchart = getTransport();
  const SbtiTarget         = getSbti();

  const [flowchart, processChart, reductionCount, transportCount, sbtiCount] =
    await Promise.all([
      Flowchart.findOne({ clientId, isActive: true })
        .select('nodes')
        .lean(),
      ProcessFlowchart.findOne({ clientId, isDeleted: { $ne: true }, isActive: true })
        .select('nodes')
        .lean(),
      Reduction.countDocuments({ clientId, isDeleted: { $ne: true } }),
      TransportFlowchart.countDocuments({ clientId, isActive: true }),
      SbtiTarget.countDocuments({ clientId }),
    ]);

  const countScopeDetails = (nodes = []) =>
    nodes.reduce(
      (sum, node) =>
        sum + (node.details?.scopeDetails?.filter((s) => !s.isDeleted)?.length ?? 0),
      0
    );

  return {
    flowchartNodes:        flowchart?.nodes?.length      ?? 0,
    flowchartScopeDetails: countScopeDetails(flowchart?.nodes),
    processNodes:          processChart?.nodes?.length   ?? 0,
    processScopeDetails:   countScopeDetails(processChart?.nodes),
    reductionProjects:     reductionCount,
    transportFlows:        transportCount,
    sbtiTargets:           sbtiCount,
  };
};

// ─────────────────────────────────────────────────────────────
// 3. CORE QUOTA CHECK (existing — unchanged)
// ─────────────────────────────────────────────────────────────
const checkQuota = async (clientId, consultantId, resourceType, newTotal) => {
  const quota = await ConsultantClientQuota.getOrCreate(clientId, consultantId);

  const limitsPlain = (quota.limits && typeof quota.limits.toObject === 'function')
    ? quota.limits.toObject()
    : Object.assign({}, quota.limits || {});
  const limit = limitsPlain[resourceType];

  if (limit === null || limit === undefined) {
    return { allowed: true, unlimited: true, limit: null, used: null, remaining: null };
  }

  const usage = await computeUsage(clientId);
  const used  = usage[resourceType] ?? 0;

  if (newTotal > limit) {
    return {
      allowed:   false,
      unlimited: false,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      newTotal,
      message: `Quota exceeded for ${resourceType}. Limit: ${limit}, Currently used: ${used}, Remaining: ${Math.max(0, limit - used)}, Attempted total: ${newTotal}.`,
    };
  }

  return { allowed: true, unlimited: false, limit, used, remaining: limit - newTotal };
};

// ─────────────────────────────────────────────────────────────
// 4. ROLE GATE (existing — unchanged)
// ─────────────────────────────────────────────────────────────
const isQuotaSubject = (userType) =>
  ['consultant', 'consultant_admin'].includes(userType);

// ─────────────────────────────────────────────────────────────
// 5. FULL QUOTA STATUS (existing — extended)
// ─────────────────────────────────────────────────────────────
const getQuotaStatus = async (clientId, consultantId) => {
  const [quota, usage] = await Promise.all([
    ConsultantClientQuota.getOrCreate(clientId, consultantId),
    computeUsage(clientId),
  ]);

  const RESOURCE_KEYS = [
    'flowchartNodes',
    'flowchartScopeDetails',
    'processNodes',
    'processScopeDetails',
    'reductionProjects',
    'transportFlows',
    'sbtiTargets',
  ];

  const limitsPlain = (quota.limits && typeof quota.limits.toObject === 'function')
    ? quota.limits.toObject()
    : Object.assign({}, quota.limits || {});

  const resourceStatus = {};
  for (const key of RESOURCE_KEYS) {
    const limit = limitsPlain[key];
    const used  = usage[key] ?? 0;
    resourceStatus[key] = {
      limit:     limit === null ? 'unlimited' : limit,
      used,
      remaining: limit === null ? 'unlimited' : Math.max(0, limit - used),
      unlimited: limit === null,
      canAdd:    limit === null ? true : (limit - used) > 0,
    };
  }

  // ── NEW: userType quota status ────────────────────────────
  const userTypeStatus = getUserTypeQuotaStatusFromDoc(quota);

  return {
    clientId,
    consultantId:   consultantId.toString(),
    quotaDocId:     quota._id,
    // Existing resource limits
    limits:         quota.limits,
    usage,
    status:         resourceStatus,
    // New userType limits
    userTypeQuotas: quota.userTypeQuotas,
    userTypeStatus,
    setBy:          quota.setBy,
    setAt:          quota.setAt,
    notes:          quota.notes,
    updatedAt:      quota.updatedAt,
  };
};

// ─────────────────────────────────────────────────────────────
// 6. FLOWCHART QUOTA (existing — unchanged)
// ─────────────────────────────────────────────────────────────
const checkFlowchartQuota = async ({ clientId, consultantId, nodes, chartType }) => {
  const isProcess = chartType === 'processFlowchart';
  const nodeKey   = isProcess ? 'processNodes'        : 'flowchartNodes';
  const scopeKey  = isProcess ? 'processScopeDetails' : 'flowchartScopeDetails';

  const nodeCount  = nodes.length;
  const scopeCount = nodes.reduce(
    (sum, node) =>
      sum + (node.details?.scopeDetails?.filter((s) => !s.isDeleted)?.length ?? 0),
    0
  );

  const quota = await ConsultantClientQuota.getOrCreate(clientId, consultantId);

  const limitsPlain = (quota.limits && typeof quota.limits.toObject === 'function')
    ? quota.limits.toObject()
    : Object.assign({}, quota.limits || {});
  const nodeLimit  = limitsPlain[nodeKey];
  const scopeLimit = limitsPlain[scopeKey];

  const needsUsage = (nodeLimit !== null && nodeLimit !== undefined)
                  || (scopeLimit !== null && scopeLimit !== undefined);

  const usage = needsUsage ? await computeUsage(clientId) : null;

  const errors = [];

  const nodeUnlimited = (nodeLimit === null || nodeLimit === undefined);
  if (!nodeUnlimited && nodeCount > nodeLimit) {
    const used      = usage[nodeKey] ?? 0;
    const remaining = Math.max(0, nodeLimit - used);
    errors.push({
      resource:  nodeKey,
      allowed:   false,
      unlimited: false,
      limit:     nodeLimit,
      used,
      remaining,
      newTotal:  nodeCount,
      message: `Quota exceeded for ${nodeKey}. Limit: ${nodeLimit}, Currently used: ${used}, Remaining: ${remaining}, Attempted total: ${nodeCount}.`,
    });
  }

  const scopeUnlimited = (scopeLimit === null || scopeLimit === undefined);
  if (!scopeUnlimited && scopeCount > scopeLimit) {
    const used      = usage[scopeKey] ?? 0;
    const remaining = Math.max(0, scopeLimit - used);
    errors.push({
      resource:  scopeKey,
      allowed:   false,
      unlimited: false,
      limit:     scopeLimit,
      used,
      remaining,
      newTotal:  scopeCount,
      message: `Quota exceeded for ${scopeKey}. Limit: ${scopeLimit}, Currently used: ${used}, Remaining: ${remaining}, Attempted total: ${scopeCount}.`,
    });
  }

  const nodeQuota = nodeUnlimited
    ? { allowed: true, unlimited: true, limit: null, used: null, remaining: null }
    : {
        allowed:   nodeCount <= nodeLimit,
        unlimited: false,
        limit:     nodeLimit,
        used:      usage?.[nodeKey] ?? 0,
        remaining: Math.max(0, nodeLimit - nodeCount),
        newTotal:  nodeCount,
      };

  const scopeQuota = scopeUnlimited
    ? { allowed: true, unlimited: true, limit: null, used: null, remaining: null }
    : {
        allowed:   scopeCount <= scopeLimit,
        unlimited: false,
        limit:     scopeLimit,
        used:      usage?.[scopeKey] ?? 0,
        remaining: Math.max(0, scopeLimit - scopeCount),
        newTotal:  scopeCount,
      };

  return { allowed: errors.length === 0, errors, nodeQuota, scopeQuota };
};

// ═════════════════════════════════════════════════════════════
// NEW: USER TYPE QUOTA FUNCTIONS
// ═════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// 7. INTERNAL: Build userTypeStatus from a quota doc
// ─────────────────────────────────────────────────────────────
const getUserTypeQuotaStatusFromDoc = (quotaDoc) => {
  const qtPlain = (quotaDoc.userTypeQuotas && typeof quotaDoc.userTypeQuotas.toObject === 'function')
    ? quotaDoc.userTypeQuotas.toObject()
    : Object.assign({}, quotaDoc.userTypeQuotas || {});

  const STATUS_KEYS = ['employeeHead', 'employee', 'viewer', 'auditor'];
  const status = {};

  for (const key of STATUS_KEYS) {
    // Apply lazy default: maxCount = 1 if not explicitly set
    const entry = qtPlain[key] || {};
    const maxCount = (entry.maxCount !== undefined && entry.maxCount !== null)
      ? entry.maxCount
      : 1;
    const usedCount = entry.usedCount ?? 0;
    const remaining = maxCount === null ? null : Math.max(0, maxCount - usedCount);

    status[key] = {
      maxCount:             maxCount === null ? 'unlimited' : maxCount,
      usedCount,
      remaining:            maxCount === null ? 'unlimited' : remaining,
      unlimited:            maxCount === null,
      canCreate:            maxCount === null ? true : remaining > 0,
      concurrentLoginLimit: entry.concurrentLoginLimit ?? null,
      userType:             QUOTA_KEY_TO_USER_TYPE[key],
    };
  }

  return status;
};

// ─────────────────────────────────────────────────────────────
// 8. NEW: CHECK + RESERVE user slot atomically
//
// This is the main entry point for user creation enforcement.
// It:
//   a) Resolves the assigned consultantId for the client
//   b) Maps userType → quotaKey
//   c) Calls the atomic reserveUserSlot on the quota model
//   d) Returns { allowed, reserved, quotaKey, entry, consultantId, message }
//
// If allowed = true and reserved = true → proceed with user.save()
// On user.save() failure → call releaseUserTypeSlot() to rollback.
//
// @param {string} clientId  — client the user is being created under
// @param {string} userType  — one of the 4 controlled userTypes
// @returns {object}
// ─────────────────────────────────────────────────────────────
const reserveUserTypeSlot = async (clientId, userType) => {
  const quotaKey = USER_TYPE_TO_QUOTA_KEY[userType];
  if (!quotaKey) {
    // Not a controlled userType — no quota enforcement
    return { allowed: true, controlled: false };
  }

  // Resolve assigned consultant (quota is keyed by consultant)
  const consultantId = await getAssignedConsultantId(clientId);
  if (!consultantId) {
    // No consultant assigned → no quota record → allow creation
    // (Quota only applies once a consultant is assigned)
    return { allowed: true, controlled: false, reason: 'No consultant assigned' };
  }

  // Ensure quota doc exists (getOrCreate is idempotent)
  const existing = await ConsultantClientQuota.getOrCreate(clientId, consultantId);

  // Get current entry for informative error messages
  const qtPlain = typeof existing.userTypeQuotas.toObject === 'function'
    ? existing.userTypeQuotas.toObject()
    : Object.assign({}, existing.userTypeQuotas);
  const entry   = qtPlain[quotaKey] || { maxCount: 1, usedCount: 0, concurrentLoginLimit: null };
  const maxCount = entry.maxCount !== undefined ? entry.maxCount : 1;

  // Hard-blocked (maxCount = 0)?
  if (maxCount === 0) {
    return {
      allowed:      false,
      controlled:   true,
      reserved:     false,
      quotaKey,
      consultantId: consultantId.toString(),
      entry,
      message: `Creation of "${userType}" is blocked for this client (quota limit is 0).`,
    };
  }

  // Attempt atomic reservation
  const updated = await ConsultantClientQuota.reserveUserSlot(clientId, consultantId, quotaKey);

  if (!updated) {
    // Reservation failed → quota exhausted
    const used      = entry.usedCount ?? 0;
    const limit     = maxCount;
    const remaining = Math.max(0, limit - used);
    return {
      allowed:      false,
      controlled:   true,
      reserved:     false,
      quotaKey,
      consultantId: consultantId.toString(),
      entry: { ...entry, maxCount: limit },
      limit,
      used,
      remaining,
      message: `Quota exceeded for "${userType}". Limit: ${limit}, Currently used: ${used}, Remaining: ${remaining}. Contact your consultant admin to increase the quota.`,
    };
  }

  return {
    allowed:      true,
    controlled:   true,
    reserved:     true,
    quotaKey,
    consultantId: consultantId.toString(),
  };
};

// ─────────────────────────────────────────────────────────────
// 9. NEW: Release (rollback) a reserved user slot
//
// Call this if user.save() fails after reserveUserTypeSlot() succeeded.
// Safe to call even if reservation was not controlled (no-op).
//
// @param {string}          clientId
// @param {string}          userType
// @param {string|ObjectId} consultantId  — from the reserveUserTypeSlot result
// ─────────────────────────────────────────────────────────────
const releaseUserTypeSlot = async (clientId, userType, consultantId) => {
  if (!consultantId) return;
  const quotaKey = USER_TYPE_TO_QUOTA_KEY[userType];
  if (!quotaKey) return;

  await ConsultantClientQuota.releaseUserSlot(clientId, consultantId, quotaKey);
};

// ─────────────────────────────────────────────────────────────
// 10. NEW: Get userType quota status for a client
//
// Used by quotaController to respond to GET requests.
// Returns current limits, usedCount, and remaining for all 4 types.
// ─────────────────────────────────────────────────────────────
const getUserTypeQuotaStatus = async (clientId, consultantId) => {
  const quota = await ConsultantClientQuota.getOrCreate(clientId, consultantId);
  return {
    clientId,
    consultantId:   consultantId.toString(),
    quotaDocId:     quota._id,
    userTypeQuotas: quota.userTypeQuotas,
    userTypeStatus: getUserTypeQuotaStatusFromDoc(quota),
    setBy:          quota.setBy,
    setAt:          quota.setAt,
    notes:          quota.notes,
    updatedAt:      quota.updatedAt,
  };
};

// ─────────────────────────────────────────────────────────────
// 11. NEW: Check concurrent login limit for a user
//
// Called at login time (verifyLoginOTP) for controlled userTypes.
// Counts active UserSession documents for this user's clientId + userType.
//
// @param {object} user  — mongoose user doc (must have clientId, userType, _id)
// @returns {{ allowed: boolean, limit: number|null, activeCount: number }}
// ─────────────────────────────────────────────────────────────
const checkConcurrentLoginLimit = async (user) => {
  const quotaKey = USER_TYPE_TO_QUOTA_KEY[user.userType];
  if (!quotaKey) {
    // Not a controlled type — no concurrent session limit
    return { allowed: true, controlled: false };
  }

  if (!user.clientId) {
    return { allowed: true, controlled: false, reason: 'No clientId on user' };
  }

  const consultantId = await getAssignedConsultantId(user.clientId);
  if (!consultantId) {
    return { allowed: true, controlled: false, reason: 'No consultant assigned' };
  }

  const quota = await ConsultantClientQuota.getOrCreate(user.clientId, consultantId);
  const qtPlain = typeof quota.userTypeQuotas.toObject === 'function'
    ? quota.userTypeQuotas.toObject()
    : Object.assign({}, quota.userTypeQuotas);

  const entry = qtPlain[quotaKey] || {};
  const concurrentLimit = entry.concurrentLoginLimit ?? null;

  if (concurrentLimit === null || concurrentLimit === 0) {
    // null = unlimited, 0 is treated as unlimited per original convention
    return { allowed: true, controlled: true, limit: concurrentLimit, unlimited: true };
  }

  // Count active sessions for this specific user
  const UserSession = require('../../models/UserSession');
  const activeCount = await UserSession.countDocuments({
    userId:   user._id,
    isActive: true,
    expiresAt: { $gt: new Date() },
  });

  if (activeCount >= concurrentLimit) {
    return {
      allowed:      false,
      controlled:   true,
      limit:        concurrentLimit,
      activeCount,
      remaining:    0,
      message:      `Concurrent session limit reached (${concurrentLimit}). Please log out from another device first.`,
    };
  }

  return {
    allowed:      true,
    controlled:   true,
    limit:        concurrentLimit,
    activeCount,
    remaining:    concurrentLimit - activeCount,
  };
};

module.exports = {
  // Existing exports (unchanged)
  getAssignedConsultantId,
  computeUsage,
  checkQuota,
  checkFlowchartQuota,
  isQuotaSubject,
  getQuotaStatus,

  // New exports
  USER_TYPE_TO_QUOTA_KEY,
  QUOTA_KEY_TO_USER_TYPE,
  CONTROLLED_USER_TYPES,
  reserveUserTypeSlot,
  releaseUserTypeSlot,
  getUserTypeQuotaStatus,
  getUserTypeQuotaStatusFromDoc,
  checkConcurrentLoginLimit,
};