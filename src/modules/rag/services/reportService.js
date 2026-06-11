'use strict';

const { v4: uuidv4 }    = require('uuid');
const RagReport          = require('../models/RagReport');
const { s3RagHelper }    = require('../utils/s3RagHelper');

const reportService = {
  async create({ templateId, templateVersionId, templateSnapshot, title, reportingYear, reportingPeriod, organizationId, createdBy }) {
    const report = await RagReport.create({
      templateId,
      templateVersionId,
      templateSnapshot: templateSnapshot || {},
      title:            title || 'Untitled Report',
      reportingYear,
      reportingPeriod:  reportingPeriod || {},
      organizationId,
      createdBy,
      status:           'queued',
      generationJob:    { queuedAt: new Date() }
    });
    return report;
  },

  async setJobId(reportId, jobId) {
    return RagReport.findByIdAndUpdate(
      reportId,
      { 'generationJob.jobId': String(jobId) },
      { new: true }
    );
  },

  async updateStatus(reportId, status) {
    const update = { status };
    if (status === 'generating') update['generationJob.startedAt'] = new Date();
    if (status === 'draft')      update['generationJob.completedAt'] = new Date();
    return RagReport.findByIdAndUpdate(reportId, update, { new: true });
  },

  async saveGeneratedSnapshot(reportId, generatedContent, userId) {
    const report      = await RagReport.findById(reportId);
    if (!report) throw new Error('Report not found');

    const snapshotId  = uuidv4();
    const ts          = Date.now();
    const s3Key       = `reports/${report.organizationId}/${reportId}/snapshots/${ts}_generated.json`;

    await s3RagHelper.uploadJSON(s3Key, generatedContent);

    report.snapshots.push({ snapshotId, type: 'generated', s3Key, createdAt: new Date(), createdBy: userId });
    report.activeSnapshotId = snapshotId;
    report.status           = 'draft';
    report.generationJob.completedAt = new Date();
    await report.save();
    return report;
  },

  async saveEdit({ reportId, sections, note, editedBy }) {
    const report = await RagReport.findById(reportId);
    if (!report) throw new Error('Report not found');
    if (report.status === 'finalized') throw new Error('Report is finalized');

    const snapshotId = uuidv4();
    const ts         = Date.now();
    const s3Key      = `reports/${report.organizationId}/${reportId}/snapshots/${ts}_edited.json`;

    // Merge edits into the current active snapshot content
    let currentContent = {};
    if (report.activeSnapshotId) {
      const activeSnap = report.snapshots.find(s => s.snapshotId === report.activeSnapshotId);
      if (activeSnap) {
        try { currentContent = await s3RagHelper.fetchJSON(activeSnap.s3Key); } catch {}
      }
    }
    const merged = { ...currentContent, ...sections };

    await s3RagHelper.uploadJSON(s3Key, merged);

    report.snapshots.push({
      snapshotId, type: 'edited', s3Key,
      createdAt: new Date(), createdBy: editedBy, note: note || ''
    });
    report.activeSnapshotId = snapshotId;
    report.status           = 'edited';
    await report.save();
    return report;
  },

  async finalize(reportId, userId) {
    const report = await RagReport.findById(reportId);
    if (!report) throw new Error('Report not found');
    if (report.status === 'finalized') throw new Error('Already finalized');

    const snapshotId = uuidv4();
    const ts         = Date.now();
    const s3Key      = `reports/${report.organizationId}/${reportId}/snapshots/${ts}_finalized.json`;

    // Copy active snapshot as finalized
    if (report.activeSnapshotId) {
      const activeSnap = report.snapshots.find(s => s.snapshotId === report.activeSnapshotId);
      if (activeSnap) {
        try {
          const content = await s3RagHelper.fetchJSON(activeSnap.s3Key);
          await s3RagHelper.uploadJSON(s3Key, content);
        } catch {}
      }
    }

    report.snapshots.push({
      snapshotId, type: 'finalized', s3Key,
      createdAt: new Date(), createdBy: userId
    });
    report.activeSnapshotId = snapshotId;
    report.status           = 'finalized';
    report.finalizedAt      = new Date();
    report.finalizedBy      = userId;
    await report.save();
    return report;
  },

  async getFullReport(reportId) {
    const report = await RagReport.findById(reportId).lean();
    if (!report) throw new Error('Report not found');

    let content = null;
    if (report.activeSnapshotId) {
      const activeSnap = report.snapshots.find(s => s.snapshotId === report.activeSnapshotId);
      if (activeSnap) {
        try {
          content = await s3RagHelper.fetchJSON(activeSnap.s3Key);
          console.log(`[reportService] Loaded snapshot for report ${reportId}: s3Key=${activeSnap.s3Key}`);
        } catch (err) {
          console.error(`[reportService] ❌ Failed to fetch snapshot from S3: key=${activeSnap.s3Key} error=${err.message}`);
          // content stays null — PDF will show "content not available" message
        }
      } else {
        console.warn(`[reportService] No snapshot found for activeSnapshotId=${report.activeSnapshotId}`);
      }
    } else {
      console.warn(`[reportService] Report ${reportId} has no activeSnapshotId (status=${report.status})`);
    }
    return { ...report, content };
  },

  async getActiveSnapshot(reportId) {
    const report = await RagReport.findById(reportId).lean();
    if (!report || !report.activeSnapshotId) return null;

    const activeSnap = report.snapshots.find(s => s.snapshotId === report.activeSnapshotId);
    if (!activeSnap) return null;

    try {
      return await s3RagHelper.fetchJSON(activeSnap.s3Key);
    } catch {
      return null;
    }
  },

  async markFailed(reportId, errorMessage) {
    return RagReport.findByIdAndUpdate(
      reportId,
      {
        status:                    'failed',
        'generationJob.failedAt':  new Date(),
        'generationJob.errorMessage': errorMessage
      },
      { new: true }
    );
  },

  async incrementGenerationCount(reportId) {
    return RagReport.findByIdAndUpdate(
      reportId,
      { $inc: { generationCount: 1 }, lastGeneratedAt: new Date() },
      { new: true }
    );
  },

  async recordExport(reportId, { format, s3Key, fileSize, exportedBy }) {
    const exportId = uuidv4();
    return RagReport.findByIdAndUpdate(
      reportId,
      {
        $push: {
          exports: {
            exportId, format, s3Key,
            fileSize:    fileSize || 0,
            exportedAt:  new Date(),
            exportedBy,
            brandingApplied: false
          }
        }
      },
      { new: true }
    );
  },

  async list({ organizationId, organizationIds, status, page = 1, limit = 20 }) {
    const query = { isDeleted: false };

    // organizationIds (array) takes priority — used when consultant_admin scopes to multiple clients
    if (Array.isArray(organizationIds) && organizationIds.length > 0) {
      query.organizationId = { $in: organizationIds };
    } else if (organizationId) {
      query.organizationId = organizationId;
    }

    if (status) query.status = status;

    const skip = (page - 1) * limit;
    const [reports, total] = await Promise.all([
      RagReport.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RagReport.countDocuments(query)
    ]);
    return { reports, total, page, pages: Math.ceil(total / limit) };
  },

  async softDelete(reportId) {
    return RagReport.findByIdAndUpdate(reportId, { isDeleted: true }, { new: true });
  },

  async listSnapshots(reportId) {
    const report = await RagReport.findById(reportId).select('snapshots activeSnapshotId').lean();
    return report?.snapshots || [];
  }
};

module.exports = { reportService };
