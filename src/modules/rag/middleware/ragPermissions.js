'use strict';

const RagReport = require('../models/RagReport');

const PRIVILEGED_ROLES = ['super_admin', 'consultant_admin'];

const ragPermissions = {
  // Only super_admin or consultant_admin can author templates
  templateAuthor(req, res, next) {
    if (!PRIVILEGED_ROLES.includes(req.user.userType)) {
      return res.status(403).json({
        error: 'INSUFFICIENT_PERMISSIONS',
        message: 'Template authoring requires super_admin or consultant_admin role'
      });
    }
    next();
  },

  // Any authenticated user — scoping enforced at service layer
  reportAccess(req, res, next) {
    next();
  },

  // Report must belong to the requesting user's org — OR the user must be
  // a consultant_admin/consultant whose client record owns that org.
  async reportOwner(req, res, next) {
    try {
      const report = await RagReport.findById(req.params.id)
        .select('organizationId createdBy status isDeleted');

      if (!report || report.isDeleted) {
        return res.status(404).json({ error: 'REPORT_NOT_FOUND' });
      }

      const { userType, clientId, id: userId } = req.user;

      // super_admin — unrestricted
      if (userType === 'super_admin') {
        req.report = report;
        return next();
      }

      // client_admin / employee / auditor / viewer — own org only
      const isOwnerOrg = report.organizationId.toString() === (clientId || '').toString();
      if (isOwnerOrg) {
        req.report = report;
        return next();
      }

      // consultant_admin — allowed only for their own assigned clients
      // Client.leadInfo.consultantAdminId links a client to its consultant_admin
      if (userType === 'consultant_admin') {
        const Client = require('../../client-management/client/Client');
        const isAssignedClient = await Client.exists({
          clientId:                    report.organizationId,
          'leadInfo.consultantAdminId': userId
        });
        if (isAssignedClient) {
          req.report = report;
          return next();
        }
      }

      // consultant — allowed only for clients they are directly assigned to
      if (userType === 'consultant') {
        const Client = require('../../client-management/client/Client');
        const isAssignedClient = await Client.exists({
          clientId:                                  report.organizationId,
          'workflowTracking.assignedConsultantId':   userId
        });
        if (isAssignedClient) {
          req.report = report;
          return next();
        }
      }

      return res.status(403).json({ error: 'REPORT_ACCESS_DENIED' });
    } catch (err) {
      next(err);
    }
  },

  // Report must not be finalized to allow edits
  reportEditable(req, res, next) {
    if (req.report && req.report.status === 'finalized') {
      return res.status(409).json({
        error: 'REPORT_FINALIZED',
        message: 'This report has been finalized and cannot be edited. Use regenerate to create a new version.'
      });
    }
    next();
  },

  // Audit logs: super_admin only
  auditViewer(req, res, next) {
    if (req.user.userType !== 'super_admin') {
      return res.status(403).json({ error: 'AUDIT_ACCESS_DENIED' });
    }
    next();
  },

  // Branding: org_admin or above (Phase 2 — stub for now)
  brandingManager(req, res, next) {
    const allowed = ['super_admin', 'consultant_admin', 'client_admin'];
    if (!allowed.includes(req.user.userType)) {
      return res.status(403).json({ error: 'BRANDING_ACCESS_DENIED' });
    }
    next();
  }
};

module.exports = { ragPermissions };
