'use strict';

const { reportService }    = require('../services/reportService');
const { templateService }  = require('../services/templateService');
const { ragAuditService }  = require('../services/ragAuditService');
const { generateReportQueue } = require('../jobs/generateReportJob');

const reportController = {
  async list(req, res, next) {
    try {
      const { status, page, limit } = req.query;
      const { userType, clientId, id: userId } = req.user;

      let orgScope = {};

      if (userType === 'super_admin') {
        // super_admin sees all reports — no org filter applied
      } else if (userType === 'consultant_admin') {
        // consultant_admin sees only reports for their own assigned clients
        const Client = require('../../client-management/client/Client');
        const assignedClients = await Client.find(
          { 'leadInfo.consultantAdminId': userId },
          { clientId: 1, _id: 0 }
        ).lean();
        orgScope = { organizationIds: assignedClients.map(c => c.clientId) };
      } else if (userType === 'consultant') {
        // consultant sees only reports for clients directly assigned to them
        const Client = require('../../client-management/client/Client');
        const assignedClients = await Client.find(
          { 'workflowTracking.assignedConsultantId': userId },
          { clientId: 1, _id: 0 }
        ).lean();
        orgScope = { organizationIds: assignedClients.map(c => c.clientId) };
      } else {
        // client_admin, employee, auditor, viewer — own org only
        orgScope = { organizationId: clientId };
      }

      const result = await reportService.list({
        ...orgScope,
        status,
        page:  parseInt(page  || '1',  10),
        limit: parseInt(limit || '20', 10)
      });
      res.json(result);
    } catch (err) { next(err); }
  },

  async generate(req, res, next) {
    try {
      const { templateId, templateVersionId, title, reportingYear, reportingPeriod, brandingId, organizationId: bodyOrgId } = req.body;
      const { userType, clientId, id: userId } = req.user;

      // Resolve the target organizationId based on the caller's role.
      // consultant_admin must supply organizationId in the body and it must be one of their assigned clients.
      // All other roles generate for their own org.
      let targetOrgId;

      if (userType === 'consultant_admin') {
        if (!bodyOrgId) {
          return res.status(400).json({
            error: 'ORGANIZATION_ID_REQUIRED',
            message: 'consultant_admin must supply organizationId in the request body to specify the target client.'
          });
        }
        // Verify the target org is actually one of their assigned clients
        const Client = require('../../client-management/client/Client');
        const isAssigned = await Client.exists({
          clientId:                    bodyOrgId,
          'leadInfo.consultantAdminId': userId
        });
        if (!isAssigned) {
          return res.status(403).json({
            error: 'REPORT_ACCESS_DENIED',
            message: 'You are not authorised to generate reports for this organisation.'
          });
        }
        targetOrgId = bodyOrgId;
      } else if (userType === 'consultant') {
        if (!bodyOrgId) {
          return res.status(400).json({
            error: 'ORGANIZATION_ID_REQUIRED',
            message: 'consultant must supply organizationId in the request body to specify the target client.'
          });
        }
        const Client = require('../../client-management/client/Client');
        const isAssigned = await Client.exists({
          clientId:                                bodyOrgId,
          'workflowTracking.assignedConsultantId': userId
        });
        if (!isAssigned) {
          return res.status(403).json({
            error: 'REPORT_ACCESS_DENIED',
            message: 'You are not authorised to generate reports for this organisation.'
          });
        }
        targetOrgId = bodyOrgId;
      } else if (userType === 'super_admin') {
        // super_admin may optionally supply an org; default to own clientId
        targetOrgId = bodyOrgId || clientId;
      } else {
        // client_admin, employee, etc. — always their own org
        targetOrgId = clientId;
      }

      const version = await templateService.getPublishedVersion(templateId, templateVersionId);
      if (!version) {
        return res.status(404).json({ error: 'TEMPLATE_VERSION_NOT_FOUND', message: 'Template must be published before generating a report.' });
      }

      const templateDoc = await templateService.getById(templateId);

      const report = await reportService.create({
        templateId,
        templateVersionId: version._id,
        templateSnapshot:  { name: templateDoc?.name, version: version.version, type: templateDoc?.type },
        title,
        reportingYear,
        reportingPeriod,
        brandingId,
        organizationId: targetOrgId,
        createdBy:      userId
      });

      const job = await generateReportQueue.add('generate', {
        reportId:          report._id,
        templateVersionId: version._id,
        organizationId:    targetOrgId,
        userId,
        reportingYear
      }, {
        attempts: 3,
        backoff:  { type: 'exponential', delay: 5000 }
      });

      await reportService.setJobId(report._id, job.id);

      ragAuditService.log({
        action:   'REPORT_GENERATED',
        actor:    req.user,
        resource: { type: 'report', id: report._id, organizationId: targetOrgId },
        after:    { status: 'queued', templateId, templateVersionId: version._id },
        context:  { req }
      });

      res.status(202).json({
        reportId: report._id,
        jobId:    job.id,
        status:   'queued',
        message:  'Report generation queued. Listen for report:ready on Socket.IO.'
      });
    } catch (err) { next(err); }
  },

  async getById(req, res, next) {
    try {
      const report = await reportService.getFullReport(req.params.id);
      res.json({ report });
    } catch (err) { next(err); }
  },

  async updateContent(req, res, next) {
    try {
      const { sections, note } = req.body;

      const before = await reportService.getActiveSnapshot(req.params.id);
      const report = await reportService.saveEdit({
        reportId:  req.params.id,
        sections,
        note,
        editedBy:  req.user.id
      });

      ragAuditService.log({
        action:   'REPORT_EDITED',
        actor:    req.user,
        resource: { type: 'report', id: req.params.id, organizationId: req.user.clientId },
        before:   before ? { snapshotId: req.report.activeSnapshotId } : null,
        after:    { snapshotId: report.activeSnapshotId, note },
        context:  { req }
      });

      res.json({ report });
    } catch (err) { next(err); }
  },

  async finalize(req, res, next) {
    try {
      const report = await reportService.finalize(req.params.id, req.user.id);

      ragAuditService.log({
        action:   'REPORT_FINALIZED',
        actor:    req.user,
        resource: { type: 'report', id: req.params.id, organizationId: req.user.clientId },
        before:   { status: 'edited' },
        after:    { status: 'finalized', finalizedAt: report.finalizedAt },
        context:  { req }
      });

      res.json({ report });
    } catch (err) { next(err); }
  },

  async regenerate(req, res, next) {
    try {
      const currentReport = req.report;

      if (currentReport.status === 'finalized') {
        return res.status(409).json({ error: 'REPORT_FINALIZED', message: 'Finalized reports cannot be regenerated directly.' });
      }

      // Reset to queued
      await reportService.updateStatus(req.params.id, 'queued');

      const version = await (require('../models/RagTemplateVersion')).findById(currentReport.templateVersionId);
      if (!version) return res.status(404).json({ error: 'TEMPLATE_VERSION_NOT_FOUND' });

      const job = await generateReportQueue.add('generate', {
        reportId:          req.params.id,
        templateVersionId: currentReport.templateVersionId,
        organizationId:    req.user.clientId,
        userId:            req.user.id,
        reportingYear:     currentReport.reportingYear
      }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

      await reportService.setJobId(req.params.id, job.id);

      ragAuditService.log({
        action:   'REPORT_REGENERATED',
        actor:    req.user,
        resource: { type: 'report', id: req.params.id, organizationId: req.user.clientId },
        before:   { generationCount: currentReport.generationCount },
        after:    { status: 'queued' },
        context:  { req }
      });

      res.status(202).json({ reportId: req.params.id, jobId: job.id, status: 'queued' });
    } catch (err) { next(err); }
  },

  async listSnapshots(req, res, next) {
    try {
      const snapshots = await reportService.listSnapshots(req.params.id);
      res.json({ snapshots });
    } catch (err) { next(err); }
  },

  async softDelete(req, res, next) {
    try {
      await reportService.softDelete(req.params.id);

      ragAuditService.log({
        action:   'REPORT_DELETED',
        actor:    req.user,
        resource: { type: 'report', id: req.params.id, organizationId: req.user.clientId },
        before:   { status: req.report.status },
        after:    { isDeleted: true },
        context:  { req }
      });

      res.json({ success: true });
    } catch (err) { next(err); }
  }
};

module.exports = { reportController };
