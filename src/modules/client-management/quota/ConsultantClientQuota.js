// models/Quota/ConsultantClientQuota.js
// ============================================================
// Stores creation LIMITS (quotas) for a consultant assigned to a client.
// Usage for flowchart resources is computed live from actual DB counts.
// Usage for userTypeQuotas is tracked with an atomic usedCount counter
// to enable concurrency-safe enforcement during user creation.
//
// LIMIT CONVENTION (both sections):
//   null  = unlimited (no restriction)
//   0     = blocked (cannot create anything)
//   N > 0 = can create up to N items total
//
// USER TYPE QUOTA KEYS:
//   employeeHead  → maps to userType: 'client_employee_head'  (ZeroCarbon)
//   employee      → maps to userType: 'employee'              (ZeroCarbon)
//   viewer        → maps to userType: 'viewer'                (multi-module)
//   auditor       → maps to userType: 'auditor'               (multi-module)
//   contributor   → maps to userType: 'contributor'           (ESGLink)
//   reviewer      → maps to userType: 'reviewer'              (ESGLink)
//   approver      → maps to userType: 'approver'              (ESGLink)
// ============================================================

'use strict';

const mongoose = require('mongoose');

// ── Flowchart/Resource limits ─────────────────────────────────
// ZeroCarbon: flowchartNodes, flowchartScopeDetails, processNodes,
//             processScopeDetails, reductionProjects, transportFlows, sbtiTargets
// ESGLink:    esgLinkBoundaryNodes (live-counted from EsgLinkBoundary.nodes)
//             esgLinkMetrics, esgLinkFormulas (placeholder — models not yet created)
const LimitsSchema = new mongoose.Schema(
  {
    // ── ZeroCarbon resources ──────────────────────────────────
    flowchartNodes:        { type: Number, default: null, min: 0 },
    flowchartScopeDetails: { type: Number, default: null, min: 0 },
    processNodes:          { type: Number, default: null, min: 0 },
    processScopeDetails:   { type: Number, default: null, min: 0 },
    reductionProjects:     { type: Number, default: null, min: 0 },
    transportFlows:        { type: Number, default: null, min: 0 },
    sbtiTargets:           { type: Number, default: null, min: 0 },
    // ── ESGLink resources ─────────────────────────────────────
    esgLinkBoundaryNodes:  { type: Number, default: null, min: 0 }, // nodes in EsgLinkBoundary
    esgLinkMetrics:        { type: Number, default: null, min: 0 }, // placeholder (model TBD)
    esgLinkFormulas:       { type: Number, default: null, min: 0 }, // placeholder (model TBD)
  },
  { _id: false }
);

// ── Per-userType quota entry ───────────────────────────────────
//
// CONCURRENCY DESIGN:
//   usedCount is incremented atomically with a conditional findOneAndUpdate:
//     filter: { usedCount: { $lt: maxCount } }
//     update: { $inc: { usedCount: 1 } }
//   If no document matches → quota exhausted → deny creation.
//   On deletion or rollback → decrement with $inc: -1 (clamped at 0).
const UserTypeQuotaEntrySchema = new mongoose.Schema(
  {
    // null = unlimited, 0 = blocked, N > 0 = hard cap
    maxCount:             { type: Number, default: 1,    min: 0 },
    // Atomically tracked — never decrements below 0
    usedCount:            { type: Number, default: 0,    min: 0 },
    // null = unlimited concurrent sessions
    concurrentLoginLimit: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

const UserTypeQuotasSchema = new mongoose.Schema(
  {
    // ZeroCarbon user types
    employeeHead: { type: UserTypeQuotaEntrySchema, default: () => ({}) },
    employee:     { type: UserTypeQuotaEntrySchema, default: () => ({}) },
    // Multi-module (shared across ZeroCarbon and ESGLink)
    viewer:       { type: UserTypeQuotaEntrySchema, default: () => ({}) },
    auditor:      { type: UserTypeQuotaEntrySchema, default: () => ({}) },
    // 🆕 ESGLink user types
    contributor:  { type: UserTypeQuotaEntrySchema, default: () => ({}) },
    reviewer:     { type: UserTypeQuotaEntrySchema, default: () => ({}) },
    approver:     { type: UserTypeQuotaEntrySchema, default: () => ({}) },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────
const ConsultantClientQuotaSchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      index: true,
    },
    consultantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    limits: {
      type: LimitsSchema,
      default: () => ({}),
    },
    userTypeQuotas: {
      type: UserTypeQuotasSchema,
      default: () => ({}),
    },
    setBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    setAt:  { type: Date },
    notes:  { type: String, default: '' },
  },
  { timestamps: true }
);

ConsultantClientQuotaSchema.index(
  { clientId: 1, consultantId: 1 },
  { unique: true }
);

ConsultantClientQuotaSchema.virtual('hasAnyLimit').get(function () {
  return Object.values(this.limits.toObject()).some((v) => v !== null);
});

// ─────────────────────────────────────────────────────────────
// INTERNAL: userType string → quota key map
// ─────────────────────────────────────────────────────────────
const USER_TYPE_TO_QUOTA_KEY = {
  // ZeroCarbon
  'client_employee_head': 'employeeHead',
  'employee':             'employee',
  // Multi-module
  'viewer':               'viewer',
  'auditor':              'auditor',
  // 🆕 ESGLink
  'contributor':          'contributor',
  'reviewer':             'reviewer',
  'approver':             'approver',
};

ConsultantClientQuotaSchema.statics.USER_TYPE_TO_QUOTA_KEY = USER_TYPE_TO_QUOTA_KEY;

// ── Static: get or create (atomic upsert) ─────────────────────
ConsultantClientQuotaSchema.statics.getOrCreate = async function (clientId, consultantId) {
  let consultantObjId;
  try {
    consultantObjId = new mongoose.Types.ObjectId(consultantId.toString());
  } catch (err) {
    throw new Error(
      `[ConsultantClientQuota.getOrCreate] Invalid consultantId "${consultantId}".`
    );
  }

  const clientIdStr = String(clientId);

  return this.findOneAndUpdate(
    { clientId: clientIdStr, consultantId: consultantObjId },
    {
      $setOnInsert: {
        clientId:     clientIdStr,
        consultantId: consultantObjId,
      },
    },
    {
      upsert:              true,
      new:                 true,
      setDefaultsOnInsert: true,
      runValidators:       true,
    }
  );
};

// ─────────────────────────────────────────────────────────────
// STATIC: reserveUserSlot — atomically claim one user slot
//
// FIX (Bug #4 from bug report):
//   Original code had a confusing !currentDoc fallthrough where the outer
//   `const maxCount = currentDoc?....maxCount ?? 1` read from a null reference,
//   which only worked by accident (schema default = 1 = ?? 1 fallback).
//   Rewritten to use a single clear doc read then branch on maxCount.
//
// Returns updated doc on success, null on quota exhausted/blocked.
// ─────────────────────────────────────────────────────────────
ConsultantClientQuotaSchema.statics.reserveUserSlot = async function (
  clientId,
  consultantId,
  quotaKey
) {
  let consultantObjId;
  try {
    consultantObjId = new mongoose.Types.ObjectId(consultantId.toString());
  } catch (err) {
    throw new Error(`[ConsultantClientQuota.reserveUserSlot] Invalid consultantId.`);
  }

  const clientIdStr = String(clientId);
  const usedPath    = `userTypeQuotas.${quotaKey}.usedCount`;

  // Single canonical read of the quota document.
  // getOrCreate() is called by the service layer before this, so the doc
  // should already exist. Defensive fallback handles the rare race.
  let doc = await this.findOne(
    { clientId: clientIdStr, consultantId: consultantObjId }
  ).lean();

  if (!doc) {
    // Doc doesn't exist yet — create it (idempotent) then re-read.
    await this.getOrCreate(clientId, consultantId);
    doc = await this.findOne(
      { clientId: clientIdStr, consultantId: consultantObjId }
    ).lean();
  }

  // Single authoritative maxCount read from the fetched document.
  // Default to 1 only when the field is truly absent (undefined).
  // null is a valid value meaning "unlimited" — must be preserved as-is.
  const maxCount = doc?.userTypeQuotas?.[quotaKey]?.maxCount ?? 1;

  if (maxCount === null) {
    // Unlimited — increment for dashboard accuracy, no cap enforced.
    return this.findOneAndUpdate(
      { clientId: clientIdStr, consultantId: consultantObjId },
      { $inc: { [usedPath]: 1 } },
      { new: true }
    );
  }

  // Non-null cap: conditional atomic increment.
  // { $lt: maxCount } is the atomic guard — if usedCount >= maxCount,
  // no document matches and findOneAndUpdate returns null → quota denied.
  // Note: $lt: 0 (when maxCount === 0) never matches, correctly blocking creation.
  return this.findOneAndUpdate(
    {
      clientId:     clientIdStr,
      consultantId: consultantObjId,
      [usedPath]:   { $lt: maxCount },
    },
    { $inc: { [usedPath]: 1 } },
    { new: true }
  );
};

// ─────────────────────────────────────────────────────────────
// STATIC: releaseUserSlot — decrement usedCount by 1 (clamped at 0)
//
// Call on: user soft-delete, subordinate bulk-deactivation, save() rollback.
// ─────────────────────────────────────────────────────────────
ConsultantClientQuotaSchema.statics.releaseUserSlot = async function (
  clientId,
  consultantId,
  quotaKey
) {
  let consultantObjId;
  try {
    consultantObjId = new mongoose.Types.ObjectId(consultantId.toString());
  } catch (_) {
    return; // best-effort — silent on bad input
  }

  const clientIdStr = String(clientId);
  const usedPath    = `userTypeQuotas.${quotaKey}.usedCount`;

  // Guard: only decrement when usedCount > 0 to prevent going negative.
  await this.findOneAndUpdate(
    {
      clientId:     clientIdStr,
      consultantId: consultantObjId,
      [usedPath]:   { $gt: 0 },
    },
    { $inc: { [usedPath]: -1 } }
  );
};

// ─────────────────────────────────────────────────────────────
// STATIC: getUserTypeEntry — read one entry with safe defaults
//
// FIX (Bug #7 from bug report):
//   Original: entry.maxCount === null && entry.maxCount !== null  ← always false
//   Fixed:    entry.maxCount === undefined  ← correct: only backfill if absent
//             null is a valid admin-set value (unlimited) and must NOT be changed to 1.
// ─────────────────────────────────────────────────────────────
ConsultantClientQuotaSchema.statics.getUserTypeEntry = async function (
  clientId,
  consultantId,
  quotaKey
) {
  const quota = await this.getOrCreate(clientId, consultantId);
  const qtPlain = typeof quota.userTypeQuotas.toObject === 'function'
    ? quota.userTypeQuotas.toObject()
    : Object.assign({}, quota.userTypeQuotas);

  const entry = qtPlain[quotaKey] || { maxCount: 1, usedCount: 0, concurrentLoginLimit: null };

  // Only backfill the default (1) when maxCount is genuinely absent.
  // null means "unlimited" — never overwrite it with 1.
  if (entry.maxCount === undefined) {
    entry.maxCount = 1;
  }

  return entry;
};

module.exports = mongoose.model('ConsultantClientQuota', ConsultantClientQuotaSchema);