'use strict';

const Bull = require('bull');

const { reportService }      = require('../services/reportService');
const { platformDataService } = require('../services/platformDataService');
const { ragAuditService }    = require('../services/ragAuditService');
const { s3RagHelper }        = require('../utils/s3RagHelper');
const { generateReport }     = require('../rag/ragService');
const { debugEmissionSummary } = require('../rag/dataResolver');

const generateReportQueue = new Bull('rag-generate-report', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10)
  }
});

generateReportQueue.process('generate', async (job) => {
  let { reportId, templateVersionId, organizationId, userId, reportingYear } = job.data;

  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[RAG job] Starting job for report ${reportId}`);
    console.log(`[RAG job]   orgId:         ${organizationId}`);
    console.log(`[RAG job]   reportingYear: ${reportingYear} (type: ${typeof reportingYear})`);
    console.log(`[RAG job]   templateVerId: ${templateVersionId}`);

    // Ensure reportingYear is a Number — Joi converts it but Bull serialises job data as JSON
    // which preserves number type. Guard against edge case where it arrives as string.
    if (reportingYear !== undefined && reportingYear !== null) {
      reportingYear = Number(reportingYear);
      console.log(`[RAG job]   reportingYear (cast): ${reportingYear}`);
    }

    // DEBUG: Log raw EmissionSummary docs so we can check the schema
    try {
      await debugEmissionSummary(organizationId);
    } catch (e) {
      console.warn('[RAG job] debugEmissionSummary failed:', e.message);
    }

    // 1. Mark generating + notify client
    await reportService.updateStatus(reportId, 'generating');
    emitToOrg(organizationId, 'report:generating', { reportId });

    // 2. Fetch template JSON from S3
    const RagTemplateVersion = require('../models/RagTemplateVersion');
    const version = await RagTemplateVersion.findById(templateVersionId);
    if (!version || !version.s3Key) {
      throw new Error(`Template version ${templateVersionId} not found or has no s3Key`);
    }
    const template = await s3RagHelper.fetchJSON(version.s3Key);
    if (!template || !Array.isArray(template.sections)) {
      throw new Error(`Template JSON from S3 is invalid — missing sections array (key: ${version.s3Key})`);
    }

    // 3. Collect org data from platform
    const { data: orgData, warnings } = await platformDataService.collectOrgData(
      organizationId,
      template.dataMappings,
      reportingYear
    );
    if (warnings.length) {
      console.warn(`[RAG job] Data binding warnings for report ${reportId}:`, warnings);
    }

    // 4. Emit progress subscription — client listens to rag:section:{reportId}
    emitToOrg(organizationId, 'report:section:start', {
      reportId,
      totalSections: (template.sections || []).length
    });

    // 5. Generate via RAG pipeline
    const generated = await generateReport(template, orgData, reportId);

    // 6. Save snapshot to S3 + update status
    console.log(`\n[RAG job] Final generated snapshot summary:`);
    for (const [secId, secResult] of Object.entries(generated)) {
      const fieldKeys = Object.keys(secResult?.fields || {});
      console.log(`  Section "${secId}": ${fieldKeys.length} fields [${fieldKeys.join(', ')}]`);
      for (const [fk, fv] of Object.entries(secResult?.fields || {})) {
        const preview = Array.isArray(fv)
          ? `[Array ${fv.length}]`
          : typeof fv === 'string'
            ? `"${fv.substring(0, 60)}${fv.length > 60 ? '...' : ''}"`
            : String(fv);
        console.log(`    ${fk} = ${preview}`);
      }
    }
    await reportService.saveGeneratedSnapshot(reportId, generated, userId);
    await reportService.incrementGenerationCount(reportId);

    // 7. Notify success
    emitToOrg(organizationId, 'report:ready', { reportId });

    console.log(`[RAG job] Report ${reportId} generated successfully`);
  } catch (err) {
    console.error(`[RAG job] Report ${reportId} failed:`, err.message);
    await reportService.markFailed(reportId, err.message);
    emitToOrg(organizationId, 'report:error', { reportId, error: err.message });
    throw err; // Bull handles retries
  }
});

generateReportQueue.on('failed', (job, err) => {
  console.error(`[RAG queue] Job ${job.id} permanently failed after ${job.attemptsMade} attempts:`, err.message);
});

generateReportQueue.on('completed', (job) => {
  console.log(`[RAG queue] Job ${job.id} completed`);
});

function emitToOrg(organizationId, event, data) {
  try {
    if (global.io) {
      global.io.to(`client_${organizationId}`).emit(event, { ...data, timestamp: new Date().toISOString() });
    }
  } catch {}
}

module.exports = { generateReportQueue };
