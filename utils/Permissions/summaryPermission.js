// utils/Permissions/summaryPermission.js  (UPDATED)
// UPDATED: attaches req.summaryAccessContext to avoid duplicate DB queries in controller

'use strict';

const Client = require('../../models/CMS/Client');
const User   = require('../../models/User');
const { getActiveFlowchart }     = require('../DataCollection/dataCollection');
const { getSummaryAccessContext } = require('./summaryAccessContext');

const checkSummaryPermission = async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const user = req.user;

    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

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
          consultantAdminId: userId, userType: 'consultant'
        }).select('_id').lean();
        const cIds = consultants.map(c => c._id.toString());
        permitted = (clientAssignedConsultantId && cIds.includes(clientAssignedConsultantId)) ||
                    (workflowAssignedConsultantId && cIds.includes(workflowAssignedConsultantId));
        break;
      }

      case 'consultant':
        permitted = clientAssignedConsultantId === userId || workflowAssignedConsultantId === userId;
        break;

      case 'client_admin':
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
        // Belong to the client — data filtering done in controller via access context
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

    // Attach access context — controller uses this to filter response data.
    // This avoids re-querying Flowchart/Reduction in the controller.
    try {
      req.summaryAccessContext = await getSummaryAccessContext(user, clientId);
    } catch (ctxErr) {
      console.error('[summaryPermission] Access context build failed:', ctxErr.message);
      req.summaryAccessContext = null; // controller will re-build if null
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