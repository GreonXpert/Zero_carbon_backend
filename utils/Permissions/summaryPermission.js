// utils/Permissions/summaryPermission.js  — PATCHED VERSION
//
// KEY CHANGE from original:
//   1. checkSummaryPermission now calls hasModuleAccess for viewer/auditor
//      BEFORE the existing client-id check.
//   2. This is the ONLY change needed in this file.
//      The rest of the function remains exactly as-is.
//
// ─────────────────────────────────────────────────────────────
// HOW TO APPLY:
//   Find the checkSummaryPermission function in your existing
//   summaryPermission.js and replace it with the function below.
// ─────────────────────────────────────────────────────────────

'use strict';

const User   = require('../../models/User');
const Client = require('../../models/CMS/Client');
const { getActiveFlowchart } = require('../DataCollection/dataCollection');
const { getSummaryAccessContext } = require('./summaryAccessContext');

// 🆕 Import accessControlPermission helpers
const {
  hasModuleAccess,
  isChecklistRole,
} = require('./accessControlPermission');

/**
 * checkSummaryPermission
 *
 * Express middleware.
 * Verifies the requesting user has permission to access an EmissionSummary
 * for the given :clientId.
 *
 * 🆕 ADDED: For viewer and auditor roles, enforces module-level access from
 *    their accessControls checklist BEFORE the existing client-id check.
 *
 * Attaches req.summaryAccessContext for the controller.
 */
const checkSummaryPermission = async (req, res, next) => {
  try {
    const user     = req.user;
    const clientId = req.params?.clientId || req.query?.clientId || req.body?.clientId;

    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    if (!clientId) {
      return res.status(400).json({ success: false, message: 'clientId is required.' });
    }

    // ────────────────────────────────────────────────────────────────────────
    // 🆕 CHECKLIST GATE — viewer and auditor
    // Must have emission_summary module enabled in their accessControls.
    // This check runs BEFORE the existing client/role checks below.
    // ────────────────────────────────────────────────────────────────────────
    if (isChecklistRole(user.userType)) {
      if (!hasModuleAccess(user, 'emission_summary')) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Your account does not have access to the Emission Summary module.',
          module: 'emission_summary',
        });
      }
    }
    // ────────────────────────────────────────────────────────────────────────
    // END CHECKLIST GATE
    // ────────────────────────────────────────────────────────────────────────

    const userId = (user._id || user.id).toString();
    const client = await Client.findOne({ clientId }).lean();
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found.' });
    }

    const getIdString = (field) => {
      if (!field) return null;
      if (field._id) return field._id.toString();
      if (field.$oid) return field.$oid;
      return field.toString();
    };

    const clientConsultantAdminId      = getIdString(client.leadInfo?.consultantAdminId);
    const clientAssignedConsultantId   = getIdString(client.leadInfo?.assignedConsultantId);
    const workflowAssignedConsultantId = getIdString(client.workflowTracking?.assignedConsultantId);
    const createdById                  = getIdString(client.leadInfo?.createdBy);

    let permitted = false;

    switch (user.userType) {
      case 'super_admin':
        permitted = true;
        break;

      case 'consultant_admin': {
        if (clientConsultantAdminId === userId || createdById === userId) {
          permitted = true;
          break;
        }
        const consultants = await User.find({
          consultantAdminId: userId, userType: 'consultant',
        }).select('_id').lean();
        const cIds = consultants.map(c => c._id.toString());
        permitted =
          (clientAssignedConsultantId  && cIds.includes(clientAssignedConsultantId)) ||
          (workflowAssignedConsultantId && cIds.includes(workflowAssignedConsultantId));
        break;
      }

      case 'consultant':
        permitted =
          clientAssignedConsultantId  === userId ||
          workflowAssignedConsultantId === userId;
        break;

      case 'client_admin':
        permitted = user.clientId === clientId;
        break;

      // 🆕 auditor / viewer: passed checklist gate above, now verify clientId
      case 'auditor':
      case 'viewer':
        permitted = user.clientId === clientId;
        break;

      case 'client_employee_head': {
        if (user.clientId !== clientId) break;
        const fc = await getActiveFlowchart(clientId);
        if (fc?.chart) {
          permitted = fc.chart.nodes.some(n =>
            getIdString(n.details?.employeeHeadId) === userId
          );
        }
        break;
      }

      case 'employee':
        permitted = user.clientId === clientId;
        break;

      default:
        permitted = false;
    }

    if (!permitted) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You do not have permission to view this summary.',
      });
    }

    // Attach access context for the controller
    try {
      req.summaryAccessContext = await getSummaryAccessContext(user, clientId);
    } catch (ctxErr) {
      console.error('[summaryPermission] Access context build failed:', ctxErr.message);
      req.summaryAccessContext = null;
    }

    return next();

  } catch (error) {
    console.error('Error in checkSummaryPermission:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during permission check.',
    });
  }
};

module.exports = { checkSummaryPermission };