'use strict';

const { getExportQueue } = require('../services/exportService');
const { exportService }  = require('../services/exportService');

function startExportPDFWorker() {
  const queue = getExportQueue();

  queue.process('export-pdf', async (job) => {
    const { reportId, userId, organizationId } = job.data;

    try {
      const signedUrl = await exportService.exportToPDF(reportId, userId);

      emitToOrg(organizationId, 'report:export:ready', { reportId, format: 'pdf', signedUrl });
      console.log(`[RAG export] PDF for report ${reportId} ready`);
    } catch (err) {
      console.error(`[RAG export] PDF export failed for report ${reportId}:`, err.message);
      emitToOrg(organizationId, 'report:export:error', { reportId, format: 'pdf', error: err.message });
      throw err;
    }
  });

  queue.on('failed', (job, err) => {
    console.error(`[RAG export queue] Job ${job.id} failed:`, err.message);
  });
}

function emitToOrg(organizationId, event, data) {
  try {
    if (global.io) {
      global.io.to(`client_${organizationId}`).emit(event, { ...data, timestamp: new Date().toISOString() });
    }
  } catch {}
}

module.exports = { startExportPDFWorker };
