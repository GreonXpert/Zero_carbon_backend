'use strict';

const { exportService } = require('../services/exportService');
const { ragAuditService } = require('../services/ragAuditService');

const exportController = {
  async triggerPDF(req, res, next) {
    try {
      const { jobId } = await exportService.triggerPDFExport({
        reportId:       req.params.id,
        userId:         req.user.id,
        organizationId: req.user.clientId
      });

      res.status(202).json({
        reportId: req.params.id,
        jobId,
        format:   'pdf',
        message:  'PDF export queued. Listen for report:export:ready on Socket.IO.'
      });
    } catch (err) { next(err); }
  },

  async listExports(req, res, next) {
    try {
      const exports = await exportService.listExports(req.params.id);
      res.json({ exports });
    } catch (err) { next(err); }
  },

  async getDownloadUrl(req, res, next) {
    try {
      const signedUrl = await exportService.getDownloadUrl(req.params.id, req.params.exportId);

      ragAuditService.log({
        action:   'REPORT_EXPORTED_PDF',
        actor:    req.user,
        resource: { type: 'report', id: req.params.id, organizationId: req.user.clientId },
        after:    { downloadedAt: new Date() },
        context:  { req }
      });

      res.json({ signedUrl, expiresIn: 900 });
    } catch (err) { next(err); }
  }
};

module.exports = { exportController };
