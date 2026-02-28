// utils/Permissions/accessControlPermission.js
//
// PURPOSE:
//   Central helper for viewer/auditor module-level access control checklist.
//   client_admin assigns a checklist when creating/editing viewer or auditor accounts.
//   Every read endpoint that viewer/auditor can hit must call these helpers to enforce it.
//
// DESIGN PRINCIPLES:
//   - Fail-closed: missing permission OR missing accessControls → DENY
//   - Only enforced for 'viewer' and 'auditor' roles
//   - All other roles (client_admin, consultant, etc.) pass through untouched
//   - Centralised: no scattered role checks across controllers
//
// USAGE (in a controller or route):
//   const { requireModuleAccess, hasModuleAccess, hasSectionAccess } = require('./accessControlPermission');
//
//   // As middleware on a route:
//   router.get('/summary', auth, requireModuleAccess('emission_summary'), getSummary);
//
//   // Or inline in a controller:
//   if (!hasSectionAccess(req.user, 'data_entry', 'editHistory')) {
//     delete responsePayload.editHistory;
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ─── Roles subject to checklist enforcement ───────────────────────────────────
const CHECKLIST_ROLES = new Set(['viewer', 'auditor']);

// ─── Module keys (must match the keys in User.accessControls.modules) ─────────
const VALID_MODULES = new Set([
  'emission_summary',
  'data_entry',
  'process_flowchart',
  'organization_flowchart',
  'reduction',
  'decarbonization',
  'reports',
  'tickets',
  'audit_logs',    // 🆕 NEW MODULE
]);

// ─── Section keys per module ──────────────────────────────────────────────────
const VALID_SECTIONS = {
  emission_summary: [
    'overview', 'byScope', 'byNode', 'byDepartment', 'byLocation',
    'processEmission', 'reductionSummary', 'trends', 'metadata',
  ],
  data_entry: [
    'list', 'detail', 'editHistory', 'logs', 'cumulativeValues', 'stats',
  ],
  process_flowchart: [
    'view', 'entries', 'processEmissionEntries',
  ],
  organization_flowchart: [
    'view', 'nodes', 'assignments',
  ],
  reduction: [
    'list', 'detail', 'netReduction', 'summary',
  ],
  decarbonization: [
    'sbti', 'targets',
  ],
  reports: [
    'basic', 'detailed', 'export',
  ],
  tickets: [
    'view', 'create',
  ],
  // audit_logs sections
  // HOW IT WORKS:
  //   Page-level sections (list, detail, export) control UI page visibility.
  //   Per-module sections (*_logs) control which AuditLog.module rows are returned.
  //   logPermission._buildModuleFilter() translates these into a MongoDB $in filter.
  //
  // AUTH RESTRICTION:
  //   'auth' module logs are always blocked for viewer/auditor at the logPermission layer.
  //   There is intentionally NO 'auth_logs' section — it cannot be granted via checklist.
  //   Only super_admin, consultant_admin, consultant see auth logs.
  audit_logs: [
    // ── Page-level access ────────────────────────────────────────────────────
    'list',                       // can open the audit log list page
    'detail',                     // can open a single log detail view
    'export',                     // can export logs to CSV/Excel
    // ── Per audit-service module visibility ──────────────────────────────────
    // Each maps 1-to-1 with an AuditLog.module value via SECTION_TO_MODULE in logPermission.js
    'data_entry_logs',            // AuditLog.module === 'data_entry'
    'flowchart_logs',             // AuditLog.module === 'organization_flowchart'
    'process_flowchart_logs',     // AuditLog.module === 'process_flowchart'
    'transport_flowchart_logs',   // AuditLog.module === 'transport_flowchart'
    'reduction_logs',             // AuditLog.module === 'reduction'
    'net_reduction_logs',         // AuditLog.module === 'net_reduction'
    'sbti_logs',                  // AuditLog.module === 'sbti'
    'emission_summary_logs',      // AuditLog.module === 'emission_summary'
    'user_management_logs',       // AuditLog.module === 'user_management'
    'system_logs',                // AuditLog.module === 'system'
  ],
};


// ─── Secure defaults per role ─────────────────────────────────────────────────
// These are used when a viewer/auditor is created WITHOUT an explicit checklist.
// Both default to FULLY CLOSED. client_admin MUST explicitly grant access.
// This prevents accidental over-permissioning.

const VIEWER_DEFAULT_CHECKLIST = buildClosedChecklist();
const AUDITOR_DEFAULT_CHECKLIST = buildClosedChecklist();

/**
 * Build a fully closed (all false) accessControls checklist.
 * Used as the fail-closed default for new viewer/auditor accounts.
 */
function buildClosedChecklist() {
  const modules = {};
  for (const mod of VALID_MODULES) {
    const sections = {};
    for (const sec of (VALID_SECTIONS[mod] || [])) {
      sections[sec] = false;
    }
    modules[mod] = { enabled: false, sections };
  }
  return { modules };
}

/**
 * Build an open (all true) checklist.
 * Useful for admin-facing presets or migration of existing users.
 */
function buildOpenChecklist() {
  const modules = {};
  for (const mod of VALID_MODULES) {
    const sections = {};
    for (const sec of (VALID_SECTIONS[mod] || [])) {
      sections[sec] = true;
    }
    modules[mod] = { enabled: true, sections };
  }
  return { modules };
}


// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * isChecklistRole
 * Returns true only for roles subject to checklist enforcement (viewer, auditor).
 */
const isChecklistRole = (userType) => CHECKLIST_ROLES.has(userType);

/**
 * hasModuleAccess
 *
 * Check if a user has top-level access to a module.
 * Non-checklist roles always return true (pass-through).
 * For viewer/auditor: user.accessControls.modules[moduleKey].enabled must be true.
 *
 * @param {object} user      - req.user or full User document
 * @param {string} moduleKey - one of VALID_MODULES
 * @returns {boolean}
 */
const hasModuleAccess = (user, moduleKey) => {
  if (!user) return false;
  if (!isChecklistRole(user.userType)) return true;
  const ac = user.accessControls;
  if (!ac || !ac.modules) return false;
  const mod = ac.modules[moduleKey];
  if (!mod) return false;
  return mod.enabled === true;
};

/**
 * hasSectionAccess
 *
 * Check if a user has access to a specific section within a module.
 * Module must also be enabled (hasModuleAccess is checked first).
 * Non-checklist roles always return true.
 *
 * @param {object} user        - req.user or full User document
 * @param {string} moduleKey   - one of VALID_MODULES
 * @param {string} sectionKey  - one of VALID_SECTIONS[moduleKey]
 * @returns {boolean}
 */
const hasSectionAccess = (user, moduleKey, sectionKey) => {
  if (!user) return false;
  if (!isChecklistRole(user.userType)) return true;
  if (!hasModuleAccess(user, moduleKey)) return false;
  const ac = user.accessControls;
  if (!ac || !ac.modules) return false;
  const mod = ac.modules[moduleKey];
  if (!mod || !mod.sections) return false;
  return mod.sections[sectionKey] === true;
};

// ─── Express middleware factory ───────────────────────────────────────────────

/**
 * requireModuleAccess
 *
 * Express middleware that blocks requests from viewer/auditor if they don't
 * have the specified module enabled in their accessControls checklist.
 *
 * Usage:
 *   router.get('/summary/:clientId', auth, requireModuleAccess('emission_summary'), getEmissionSummary);
 *
 * @param {string} moduleKey - the module to check
 * @returns {function} Express middleware
 */
const requireModuleAccess = (moduleKey) => {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!hasModuleAccess(user, moduleKey)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. You do not have permission to access the '${moduleKey}' module.`,
        module: moduleKey,
      });
    }
    return next();
  };
};

/**
 * requireSectionAccess
 *
 * Express middleware that blocks requests if user doesn't have section-level access.
 * Useful for endpoints that exclusively serve a single section (e.g. edit history endpoint).
 *
 * @param {string} moduleKey  - the module key
 * @param {string} sectionKey - the section key within the module
 * @returns {function} Express middleware
 */
const requireSectionAccess = (moduleKey, sectionKey) => {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (!hasSectionAccess(user, moduleKey, sectionKey)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. You do not have permission to access '${sectionKey}' within the '${moduleKey}' module.`,
        module: moduleKey,
        section: sectionKey,
      });
    }
    return next();
  };
};

// ─── Payload validation ───────────────────────────────────────────────────────

/**
 * validateAndSanitizeChecklist
 *
 * Validates an incoming accessControls payload.
 * Strips unknown module/section keys.
 * Ensures all boolean values.
 * Returns { valid: true, sanitized } or { valid: false, error }.
 *
 * @param {object} rawChecklist - raw accessControls from req.body
 * @returns {{ valid: boolean, sanitized?: object, error?: string }}
 */
const validateAndSanitizeChecklist = (rawChecklist) => {
  if (!rawChecklist || typeof rawChecklist !== 'object') {
    return { valid: false, error: 'accessControls must be an object.' };
  }
  if (!rawChecklist.modules || typeof rawChecklist.modules !== 'object') {
    return { valid: false, error: 'accessControls.modules must be an object.' };
  }

  const sanitizedModules = {};

  for (const [modKey, modVal] of Object.entries(rawChecklist.modules)) {
    if (!VALID_MODULES.has(modKey)) continue;
    if (typeof modVal !== 'object' || modVal === null) {
      return { valid: false, error: `accessControls.modules.${modKey} must be an object.` };
    }
    const enabled = modVal.enabled === true;
    const sanitizedSections = {};
    const validSecs = VALID_SECTIONS[modKey] || [];
    for (const sec of validSecs) {
      sanitizedSections[sec] = (modVal.sections && typeof modVal.sections === 'object')
        ? modVal.sections[sec] === true
        : false;
    }
    sanitizedModules[modKey] = { enabled, sections: sanitizedSections };
  }

  // Fill missing modules with closed defaults
  for (const mod of VALID_MODULES) {
    if (!sanitizedModules[mod]) {
      const sections = {};
      for (const sec of (VALID_SECTIONS[mod] || [])) {
        sections[sec] = false;
      }
      sanitizedModules[mod] = { enabled: false, sections };
    }
  }

  return { valid: true, sanitized: { modules: sanitizedModules } };
};

/**
 * stripRestrictedSections
 *
 * Given a response object for viewer/auditor, removes keys that correspond to
 * sections the user doesn't have access to.
 * Used inline in controllers to strip sensitive fields from response payloads.
 *
 * @param {object} user        - req.user
 * @param {string} moduleKey   - the module this response belongs to
 * @param {object} payload     - the response object to strip
 * @param {object} sectionMap  - mapping of { sectionKey: [array of payload keys to remove if denied] }
 * @returns {object} - mutated payload (in-place)
 *
 * Example:
 *   stripRestrictedSections(req.user, 'data_entry', entry, {
 *     editHistory:      ['editHistory'],
 *     logs:             ['logs'],
 *     cumulativeValues: ['cumulativeValues', 'dataEntryCumulative'],
 *   });
 */
const stripRestrictedSections = (user, moduleKey, payload, sectionMap) => {
  if (!payload || !isChecklistRole(user?.userType)) return payload;
  for (const [sectionKey, payloadKeys] of Object.entries(sectionMap)) {
    if (!hasSectionAccess(user, moduleKey, sectionKey)) {
      for (const k of payloadKeys) {
        delete payload[k];
      }
    }
  }
  return payload;
};

// ─── Preset templates ─────────────────────────────────────────────────────────

/**
 * PRESET_TEMPLATES
 *
 * Optional: expose named preset templates that client_admin can reference
 * instead of building a checklist from scratch.
 * frontend can GET /api/users/access-control-presets to display these.
 */
const PRESET_TEMPLATES = {

  // ═══════════════════════════════════════════════════════════════════════════
  // VIEWER PRESETS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * viewer_read_only
   * Emission summaries + basic reports only. No edit history, no logs, no audit logs.
   * Use for external stakeholders who need overview data only.
   */
  viewer_read_only: {
    label: 'Viewer — Read Only (Summary + Reports)',
    description: 'Emission summaries and basic reports only. No audit logs.',
    accessControls: (() => {
      const ac = buildClosedChecklist();
      ac.modules.emission_summary.enabled = true;
      ac.modules.emission_summary.sections.overview     = true;
      ac.modules.emission_summary.sections.byScope      = true;
      ac.modules.emission_summary.sections.byDepartment = true;
      ac.modules.emission_summary.sections.byLocation   = true;
      ac.modules.emission_summary.sections.trends       = true;
      ac.modules.reports.enabled = true;
      ac.modules.reports.sections.basic = true;
      // audit_logs fully closed — no log visibility for read-only viewers
      return ac;
    })(),
  },

  /**
   * viewer_full
   * All data + summary modules. Edit history and audit logs are hidden.
   * Use for internal stakeholders who need data visibility but not traceability.
   */
  viewer_full: {
    label: 'Viewer — Full Read (all data modules, no audit logs)',
    description: 'All summary and data modules open. Edit history and audit logs are hidden.',
    accessControls: (() => {
      const ac = buildOpenChecklist();
      // Strip internal-only sections from viewers
      ac.modules.data_entry.sections.editHistory = false;
      ac.modules.data_entry.sections.logs        = false;
      // Fully close audit_logs for viewers in this preset
      ac.modules.audit_logs.enabled = false;
      Object.keys(ac.modules.audit_logs.sections).forEach(k => {
        ac.modules.audit_logs.sections[k] = false;
      });
      return ac;
    })(),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AUDITOR PRESETS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * auditor_standard
   * Full data access + audit logs for core emission modules.
   * No user-management or system logs. No ticket creation.
   * Suitable for third-party carbon auditors.
   */
  auditor_standard: {
    label: 'Auditor — Standard (core emission logs)',
    description: 'Full data access + audit logs for data_entry, flowchart, reduction, sbti, emission_summary modules.',
    accessControls: (() => {
      const ac = buildOpenChecklist();
      ac.modules.tickets.sections.create = false;
      // Audit logs: list + detail for core emission modules
      ac.modules.audit_logs.enabled = true;
      ac.modules.audit_logs.sections.list                     = true;
      ac.modules.audit_logs.sections.detail                   = true;
      ac.modules.audit_logs.sections.export                   = false;
      ac.modules.audit_logs.sections.data_entry_logs          = true;
      ac.modules.audit_logs.sections.flowchart_logs           = true;
      ac.modules.audit_logs.sections.process_flowchart_logs   = true;
      ac.modules.audit_logs.sections.transport_flowchart_logs = true;
      ac.modules.audit_logs.sections.reduction_logs           = true;
      ac.modules.audit_logs.sections.net_reduction_logs       = true;
      ac.modules.audit_logs.sections.sbti_logs                = true;
      ac.modules.audit_logs.sections.emission_summary_logs    = true;
      ac.modules.audit_logs.sections.user_management_logs     = false; // not needed for standard audit
      ac.modules.audit_logs.sections.system_logs              = false;
      return ac;
    })(),
  },

  /**
   * auditor_restricted
   * Emission summary + edit history + data entry logs only.
   * Minimal footprint — for narrow-scope audits.
   */
  auditor_restricted: {
    label: 'Auditor — Restricted (summary + history + data entry logs)',
    description: 'Emission summary, edit history. Audit logs limited to data_entry module.',
    accessControls: (() => {
      const ac = buildClosedChecklist();
      // Emission summary — all sections
      ac.modules.emission_summary.enabled = true;
      Object.keys(ac.modules.emission_summary.sections).forEach(
        k => (ac.modules.emission_summary.sections[k] = true)
      );
      // Data entry — list, detail, editHistory, logs
      ac.modules.data_entry.enabled = true;
      ac.modules.data_entry.sections.list        = true;
      ac.modules.data_entry.sections.detail      = true;
      ac.modules.data_entry.sections.editHistory = true;
      ac.modules.data_entry.sections.logs        = true;
      // Audit logs: list + detail, data_entry module only
      ac.modules.audit_logs.enabled = true;
      ac.modules.audit_logs.sections.list            = true;
      ac.modules.audit_logs.sections.detail          = true;
      ac.modules.audit_logs.sections.data_entry_logs = true;
      return ac;
    })(),
  },

  /**
   * auditor_full_audit
   * Full data access + all audit log types + export.
   * Use for comprehensive internal audits or regulatory submissions.
   */
  auditor_full_audit: {
    label: 'Auditor — Full Audit Trail (all log types + export)',
    description: 'Full data access + every audit log module visible + export. Auth logs still blocked.',
    accessControls: (() => {
      const ac = buildOpenChecklist();
      ac.modules.tickets.sections.create = false;
      // Open every audit_logs section (auth is still blocked at logPermission layer)
      ac.modules.audit_logs.enabled = true;
      Object.keys(ac.modules.audit_logs.sections).forEach(k => {
        ac.modules.audit_logs.sections[k] = true;
      });
      return ac;
    })(),
  },

  /**
   * auditor_compliance
   * Reduction + SBTi + system audit trail with export.
   * Targeted for compliance / regulatory audits.
   */
  auditor_compliance: {
    label: 'Auditor — Compliance (reduction + SBTi + system logs)',
    description: 'Reduction, net_reduction, SBTi data + their audit logs + system logs + export.',
    accessControls: (() => {
      const ac = buildClosedChecklist();
      // Emission summary — overview + scope + reduction
      ac.modules.emission_summary.enabled = true;
      ac.modules.emission_summary.sections.overview         = true;
      ac.modules.emission_summary.sections.byScope          = true;
      ac.modules.emission_summary.sections.reductionSummary = true;
      // Reduction — full
      ac.modules.reduction.enabled = true;
      Object.keys(ac.modules.reduction.sections).forEach(k => {
        ac.modules.reduction.sections[k] = true;
      });
      // Decarbonization — sbti + targets
      ac.modules.decarbonization.enabled = true;
      ac.modules.decarbonization.sections.sbti    = true;
      ac.modules.decarbonization.sections.targets = true;
      // Audit logs: reduction + net_reduction + sbti + system, with export
      ac.modules.audit_logs.enabled = true;
      ac.modules.audit_logs.sections.list               = true;
      ac.modules.audit_logs.sections.detail             = true;
      ac.modules.audit_logs.sections.export             = true;
      ac.modules.audit_logs.sections.reduction_logs     = true;
      ac.modules.audit_logs.sections.net_reduction_logs = true;
      ac.modules.audit_logs.sections.sbti_logs          = true;
      ac.modules.audit_logs.sections.system_logs        = true;
      return ac;
    })(),
  },
};


// ─── Schema definition (for User model reference) ─────────────────────────────

/**
 * ACCESS_CONTROLS_SCHEMA_DEFINITION
 *
 * Export this to paste into models/User.js as the accessControls schema.
 * (Or simply add the plain mongoose schema directly — see models/User.js patch below)
 */
const ACCESS_CONTROLS_SCHEMA_DEFINITION = {
  modules: {
    emission_summary: {
      enabled: { type: Boolean, default: false },
      sections: {
        overview:          { type: Boolean, default: false },
        byScope:           { type: Boolean, default: false },
        byNode:            { type: Boolean, default: false },
        byDepartment:      { type: Boolean, default: false },
        byLocation:        { type: Boolean, default: false },
        processEmission:   { type: Boolean, default: false },
        reductionSummary:  { type: Boolean, default: false },
        trends:            { type: Boolean, default: false },
        metadata:          { type: Boolean, default: false },
      },
    },
    data_entry: {
      enabled: { type: Boolean, default: false },
      sections: {
        list:             { type: Boolean, default: false },
        detail:           { type: Boolean, default: false },
        editHistory:      { type: Boolean, default: false },
        logs:             { type: Boolean, default: false },
        cumulativeValues: { type: Boolean, default: false },
        stats:            { type: Boolean, default: false },
      },
    },
    process_flowchart: {
      enabled: { type: Boolean, default: false },
      sections: {
        view:                   { type: Boolean, default: false },
        entries:                { type: Boolean, default: false },
        processEmissionEntries: { type: Boolean, default: false },
      },
    },
    organization_flowchart: {
      enabled: { type: Boolean, default: false },
      sections: {
        view:        { type: Boolean, default: false },
        nodes:       { type: Boolean, default: false },
        assignments: { type: Boolean, default: false },
      },
    },
    reduction: {
      enabled: { type: Boolean, default: false },
      sections: {
        list:         { type: Boolean, default: false },
        detail:       { type: Boolean, default: false },
        netReduction: { type: Boolean, default: false },
        summary:      { type: Boolean, default: false },
      },
    },
    decarbonization: {
      enabled: { type: Boolean, default: false },
      sections: {
        sbti:    { type: Boolean, default: false },
        targets: { type: Boolean, default: false },
      },
    },
    reports: {
      enabled: { type: Boolean, default: false },
      sections: {
        basic:    { type: Boolean, default: false },
        detailed: { type: Boolean, default: false },
        export:   { type: Boolean, default: false },
      },
    },
    tickets: {
      enabled: { type: Boolean, default: false },
      sections: {
        view:   { type: Boolean, default: false },
        create: { type: Boolean, default: false },
      },
    },
    // audit_logs — controls what audit log data a viewer/auditor can see.
    // 'auth' logs are ALWAYS blocked at logPermission layer regardless of these settings.
    // Per-module sections map to AuditLog.module values via logPermission.SECTION_TO_MODULE.
    audit_logs: {
      enabled: { type: Boolean, default: false },
      sections: {
        // Page-level access
        list:                     { type: Boolean, default: false },
        detail:                   { type: Boolean, default: false },
        export:                   { type: Boolean, default: false },
        // Per audit-service module access (each controls a group of AuditLog rows)
        data_entry_logs:          { type: Boolean, default: false },
        flowchart_logs:           { type: Boolean, default: false },
        process_flowchart_logs:   { type: Boolean, default: false },
        transport_flowchart_logs: { type: Boolean, default: false },
        reduction_logs:           { type: Boolean, default: false },
        net_reduction_logs:       { type: Boolean, default: false },
        sbti_logs:                { type: Boolean, default: false },
        emission_summary_logs:    { type: Boolean, default: false },
        user_management_logs:     { type: Boolean, default: false },
        system_logs:              { type: Boolean, default: false },
      },
    },
  },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Core helpers
  isChecklistRole,
  hasModuleAccess,
  hasSectionAccess,
  requireModuleAccess,
  requireSectionAccess,
  stripRestrictedSections,

  // Payload validation
  validateAndSanitizeChecklist,

  // Defaults
  VIEWER_DEFAULT_CHECKLIST,
  AUDITOR_DEFAULT_CHECKLIST,
  buildClosedChecklist,
  buildOpenChecklist,

  // Metadata
  VALID_MODULES,
  VALID_SECTIONS,
  PRESET_TEMPLATES,
  ACCESS_CONTROLS_SCHEMA_DEFINITION,
};