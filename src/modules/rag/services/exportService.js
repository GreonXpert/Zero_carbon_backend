'use strict';

const path       = require('path');
const Bull       = require('bull');
const { reportService }    = require('./reportService');
const { s3RagHelper }      = require('../utils/s3RagHelper');
const { ragAuditService }  = require('./ragAuditService');
const { renderReportHTML } = require('../templates/reportHtmlTemplate');

let exportPDFQueue;

function getExportQueue() {
  if (!exportPDFQueue) {
    exportPDFQueue = new Bull('rag-export-pdf', {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      }
    });
  }
  return exportPDFQueue;
}

const exportService = {
  async triggerPDFExport({ reportId, userId, organizationId }) {
    const queue = getExportQueue();
    const job   = await queue.add('export-pdf', { reportId, userId, organizationId }, {
      attempts: 2,
      backoff:  { type: 'exponential', delay: 3000 }
    });
    return { jobId: job.id };
  },

  async exportToPDF(reportId, userId) {
    const report = await reportService.getFullReport(reportId);
    if (!report) throw new Error('Report not found');

    // Diagnostic log — visible in server console
    console.log(`\n[RAG export] ═══════════════════════════════════════`);
    console.log(`[RAG export] Rendering PDF for report ${reportId}`);
    console.log(`[RAG export]   status:           ${report.status}`);
    console.log(`[RAG export]   activeSnapshotId: ${report.activeSnapshotId || 'NONE'}`);
    console.log(`[RAG export]   templateVersionId:${report.templateVersionId || 'NONE'}`);
    console.log(`[RAG export]   content is null:  ${report.content === null}`);

    if (report.content) {
      const sectionKeys = Object.keys(report.content);
      console.log(`[RAG export]   content sections: [${sectionKeys.join(', ')}]`);
      for (const [sid, sdata] of Object.entries(report.content)) {
        const fieldKeys = Object.keys(sdata?.fields || {});
        console.log(`[RAG export]     section "${sid}": fields=[${fieldKeys.join(', ')}]`);
        for (const [fid, fval] of Object.entries(sdata?.fields || {})) {
          const preview = Array.isArray(fval)
            ? `[Array ${fval.length}]`
            : typeof fval === 'string'
              ? `"${fval.substring(0, 60)}${fval.length > 60 ? '...' : ''}"`
              : String(fval);
          console.log(`[RAG export]       ${fid} = ${preview}`);
        }
      }
    } else {
      console.error(`[RAG export]   ❌ content is NULL — snapshot was not saved or generation failed`);
    }

    // Guard: if report is still generating/queued, content will be empty → fail early
    if (['queued', 'generating'].includes(report.status)) {
      throw new Error(
        `Report is still ${report.status}. Wait for generation to complete before exporting.`
      );
    }
    if (report.status === 'failed') {
      throw new Error(
        `Report generation failed: ${report.generationJob?.errorMessage || 'unknown error'}. ` +
        `Please regenerate the report before exporting.`
      );
    }

    // Get template structure if available (used to apply field labels & ordering)
    let template = null;
    try {
      const RagTemplateVersion = require('../models/RagTemplateVersion');
      const version = await RagTemplateVersion.findById(report.templateVersionId);
      if (version?.s3Key) {
        template = await s3RagHelper.fetchJSON(version.s3Key);
        console.log(`[RAG export]   template sections: ${(template?.sections || []).length}`);
      } else {
        console.warn(`[RAG export]   WARNING: templateVersionId ${report.templateVersionId} has no s3Key — will render without template structure`);
      }
    } catch (err) {
      console.error(`[RAG export]   ERROR fetching template (non-fatal, will render from content):`, err.message);
    }

    const html = renderReportHTML(report, template);

    // Launch Puppeteer
    let puppeteer;
    try {
      ({ default: puppeteer } = await import('puppeteer'));
    } catch {
      throw new Error('Puppeteer is not installed. Run: npm install puppeteer');
    }

    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: true
    });

    let pdf;
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      pdf = await page.pdf({
        format:          'A4',
        printBackground: true,
        // '72pt' not supported in Puppeteer v22+ — use mm (72pt = 25.4mm = 1 inch)
        margin:          { top: '25.4mm', bottom: '25.4mm', left: '25.4mm', right: '25.4mm' }
      });
    } finally {
      await browser.close();
    }

    const ts    = Date.now();
    const s3Key = `reports/${report.organizationId}/${reportId}/exports/${ts}_report.pdf`;

    await s3RagHelper.uploadBuffer(s3Key, pdf, 'application/pdf');

    await reportService.recordExport(reportId, {
      format:      'pdf',
      s3Key,
      fileSize:    pdf.length,
      exportedBy:  userId
    });

    ragAuditService.log({
      action:   'REPORT_EXPORTED_PDF',
      actor:    { id: userId },
      resource: { type: 'report', id: reportId, organizationId: report.organizationId },
      after:    { s3Key, fileSize: pdf.length },
      context:  {}
    });

    return s3RagHelper.getSignedDownloadUrl(s3Key);
  },

  async listExports(reportId) {
    const RagReport = require('../models/RagReport');
    const report    = await RagReport.findById(reportId).select('exports').lean();
    return report?.exports || [];
  },

  async getDownloadUrl(reportId, exportId) {
    const RagReport = require('../models/RagReport');
    const report    = await RagReport.findById(reportId).select('exports').lean();
    const entry     = report?.exports?.find(e => e.exportId === exportId);
    if (!entry) throw new Error('Export not found');
    return s3RagHelper.getSignedDownloadUrl(entry.s3Key);
  }
};

module.exports = { exportService, getExportQueue };
