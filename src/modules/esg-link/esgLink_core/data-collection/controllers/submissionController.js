'use strict';

const submissionService = require('../services/submissionService');
const workflowService   = require('../services/workflowService');
const { canSubmit, canViewSubmission } = require('../utils/submissionPermissions');
const { resolveAssignees } = require('../services/workflowService');
const EsgLinkBoundary   = require('../../boundary/models/EsgLinkBoundary');

// ── POST /:clientId/submissions/batch ────────────────────────────────────────
// Body: { submissions: [ { nodeId, mappingId, period, dataValues, ... }, ... ], submitImmediately?: bool }
// Returns per-row results so the frontend can show inline evidence uploaders.
async function createBatchSubmissions(req, res) {
  try {
    const { clientId } = req.params;
    const actor        = req.user;
    const { submissions = [], submitImmediately = false } = req.body;

    if (!Array.isArray(submissions) || submissions.length === 0) {
      return res.status(400).json({ success: false, message: '`submissions` must be a non-empty array' });
    }
    if (submissions.length > 100) {
      return res.status(400).json({ success: false, message: 'Maximum 100 submissions per batch request' });
    }

    const created     = [];   // { index, submissionId, period }
    const errors      = [];   // { index, period, error }

    for (let i = 0; i < submissions.length; i++) {
      const sub = submissions[i];
      try {
        const result = await submissionService.create(
          { ...sub, clientId, submitImmediately },
          actor,
          { req }
        );
        if (result.error) {
          errors.push({
            index:    i,
            period:   sub.period?.periodLabel || null,
            error:    result.error,
            code:     result.code     || null,
            existing: result.existing || null,
          });
        } else {
          created.push({
            index:        i,
            submissionId: result.doc._id.toString(),
            period:       result.doc.period?.periodLabel || null,
            workflowStatus: result.doc.workflowStatus,
          });
        }
      } catch (err) {
        errors.push({ index: i, period: sub.period?.periodLabel || null, error: err.message });
      }
    }

    return res.status(201).json({
      success: true,
      data: {
        processed:     submissions.length,
        created:       created.length,
        failed:        errors.length,
        errors,
        submissions:   created,   // array of { index, submissionId, period, workflowStatus }
        submissionIds: created.map((c) => c.submissionId),  // convenience flat array
      },
    });
  } catch (err) {
    console.error('[submissionController.createBatchSubmissions]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/batch-submit ──────────────────────────────────
// Body: { submissionIds: [ "id1", "id2", ... ] }
// Transitions each draft → submitted in one request.
async function batchSubmitForReview(req, res) {
  try {
    const { clientId } = req.params;
    const actor        = req.user;
    const { submissionIds = [] } = req.body;

    if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
      return res.status(400).json({ success: false, message: '`submissionIds` must be a non-empty array' });
    }
    if (submissionIds.length > 100) {
      return res.status(400).json({ success: false, message: 'Maximum 100 submissions per batch-submit request' });
    }

    const submitted = [];
    const errors    = [];

    for (const submissionId of submissionIds) {
      try {
        const result = await workflowService.transition(submissionId, 'submitted', actor, {
          clientId,
          req,
        });
        if (result.error) {
          errors.push({ submissionId, error: result.error });
        } else {
          submitted.push({ submissionId, workflowStatus: result.doc.workflowStatus });
        }
      } catch (err) {
        errors.push({ submissionId, error: err.message });
      }
    }

    return res.json({
      success: true,
      data: {
        processed: submissionIds.length,
        submitted: submitted.length,
        failed:    errors.length,
        errors,
        results:   submitted,
      },
    });
  } catch (err) {
    console.error('[submissionController.batchSubmitForReview]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions ───────────────────────────────────────────────
async function createSubmission(req, res) {
  try {
    const { clientId } = req.params;
    const actor = req.user;

    const result = await submissionService.create(
      { ...req.body, clientId },
      actor,
      { req }
    );

    if (result.error) {
      return res.status(result.status || 400).json({
        success:  false,
        message:  result.error,
        code:     result.code    || null,
        existing: result.existing || null,
      });
    }

    return res.status(201).json({ success: true, data: result.doc });
  } catch (err) {
    console.error('[submissionController.createSubmission] FULL ERROR:', err);
    // Expose detailed message in development to aid debugging
    const isDev = process.env.NODE_ENV !== 'production';
    return res.status(500).json({
      success: false,
      message: isDev ? `Internal server error: ${err.message}` : 'Internal server error',
      ...(isDev && { errorType: err.name, detail: err.message }),
    });
  }
}

// ── GET /:clientId/submissions ────────────────────────────────────────────────
async function listSubmissions(req, res) {
  try {
    const { clientId } = req.params;
    const accessCtx    = req.submissionAccessCtx;

    const result = await submissionService.list(clientId, accessCtx, req.query);

    // Build nodeId → label map from boundary (same as single-submission endpoint)
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false })
      .select('nodes').lean();
    const nodeLabelMap = {};
    for (const node of boundary?.nodes || []) {
      nodeLabelMap[node.id] = node.label;
    }

    const submissions = result.docs.map((doc) => {
      const docObj = doc.toObject ? doc.toObject({ flattenMaps: true }) : doc;
      return {
        ...docObj,
        metricDetails:   { metricName: doc.metricId?.metricName || '', metricCode: doc.metricId?.metricCode || '' },
        nodeDetails:     { label: nodeLabelMap[doc.nodeId] || doc.nodeId || '' },
        contributorName: doc.submittedBy?.userName || doc.submittedBy?.email || '',
      };
    });

    return res.json({
      success: true,
      data: {
        submissions,
        total: result.total,
        page:  result.page,
        limit: result.limit,
      },
    });
  } catch (err) {
    console.error('[submissionController.listSubmissions]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── GET /:clientId/submissions/:submissionId ──────────────────────────────────
async function getSubmission(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;

    const result = await submissionService.getOne(submissionId, actor, clientId);
    if (result.error) {
      return res.status(result.status || 404).json({ success: false, message: result.error });
    }

    const { reviewers, approvers, mapping } = await resolveAssignees(result.doc);

    if (!await canViewSubmission(actor, mapping, reviewers, approvers, clientId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const doc = result.doc;
    const boundary = await EsgLinkBoundary.findOne({ clientId, isActive: true, isDeleted: false })
      .select('nodes').lean();
    const nodeLabelMap = {};
    for (const node of boundary?.nodes || []) {
      nodeLabelMap[node.id] = node.label;
    }

    const docObj = doc.toObject ? doc.toObject({ flattenMaps: true }) : doc;

    // Populate approverName for each approvalDecision slot
    const approverIds = (docObj.approvalDecisions || [])
      .map((d) => d.approverId)
      .filter(Boolean);
    const approverMap = {};
    if (approverIds.length > 0) {
      const User = require('../../../../../common/models/User');
      const approverUsers = await User.find({ _id: { $in: approverIds } })
        .select('_id userName email').lean();
      for (const u of approverUsers) {
        approverMap[String(u._id)] = u.userName || u.email;
      }
    }
    const approvalDecisions = (docObj.approvalDecisions || []).map((d) => ({
      ...d,
      approverName: approverMap[String(d.approverId)] || null,
    }));

    return res.json({
      success: true,
      data: {
        ...docObj,
        approvalDecisions,
        metricDetails:   { metricName: doc.metricId?.metricName || '', metricCode: doc.metricId?.metricCode || '' },
        nodeDetails:     { label: nodeLabelMap[doc.nodeId] || doc.nodeId || '' },
        contributorName: doc.submittedBy?.userName || doc.submittedBy?.email || '',
      },
    });
  } catch (err) {
    console.error('[submissionController.getSubmission]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── PATCH /:clientId/submissions/:submissionId ────────────────────────────────
async function updateDraft(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;

    const result = await submissionService.updateDraft(
      submissionId,
      { ...req.body, clientId },
      actor,
      { req }
    );

    if (result.error) {
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }

    return res.json({ success: true, data: result.doc });
  } catch (err) {
    console.error('[submissionController.updateDraft]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/submit ──────────────────────────
async function submitForReview(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;

    const result = await workflowService.transition(submissionId, 'submitted', actor, {
      clientId,
      note: req.body?.note,
      req,
    });

    if (result.error) {
      return res.status(result.status || 422).json({ success: false, message: result.error });
    }

    return res.json({
      success: true,
      data: {
        submissionId,
        workflowStatus: result.doc.workflowStatus,
        submittedAt:    result.doc.submittedAt,
      },
      message: 'Submission sent for review',
    });
  } catch (err) {
    console.error('[submissionController.submitForReview]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/resubmit ────────────────────────
async function resubmit(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { note, dataValues, text } = req.body || {};

    // Optionally update data values before resubmitting
    if (dataValues) {
      await submissionService.updateDraft(
        submissionId,
        { clientId, dataValues },
        actor,
        { req }
      );
    }

    const result = await workflowService.transition(submissionId, 'resubmitted', actor, {
      clientId,
      note,
      threadMessage: text ? { text, attachments: [] } : null,
      req,
    });

    if (result.error) {
      return res.status(result.status || 422).json({ success: false, message: result.error });
    }

    return res.json({
      success: true,
      data:    { workflowStatus: result.doc.workflowStatus },
    });
  } catch (err) {
    console.error('[submissionController.resubmit]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── DELETE /:clientId/submissions/:submissionId ───────────────────────────────
async function deleteDraft(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;

    const result = await submissionService.softDelete(submissionId, clientId, actor, { req });

    if (result.error) {
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }

    return res.json({ success: true, message: 'Draft deleted' });
  } catch (err) {
    console.error('[submissionController.deleteDraft]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/batch-delete ─────────────────────────────────
async function batchDeleteDrafts(req, res) {
  try {
    const { clientId } = req.params;
    const { submissionIds } = req.body;

    if (!Array.isArray(submissionIds) || submissionIds.length === 0)
      return res.status(400).json({ success: false, message: 'submissionIds array is required' });
    if (submissionIds.length > 100)
      return res.status(400).json({ success: false, message: 'Max 100 submissions per request' });

    const results = [];
    let deleted = 0, failed = 0;

    for (const id of submissionIds) {
      try {
        const result = await submissionService.softDelete(id, clientId, req.user, { req });
        if (result.error) {
          results.push({ id, success: false, error: result.error });
          failed++;
        } else {
          results.push({ id, success: true });
          deleted++;
        }
      } catch (rowErr) {
        results.push({ id, success: false, error: rowErr.message });
        failed++;
      }
    }

    return res.json({ success: true, data: { deleted, failed, results } });
  } catch (err) {
    console.error('[submissionController.batchDeleteDrafts]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── Shared helper: resolve esgEvidenceMode for a client ───────────────────────
async function _getEvidenceMode(clientId) {
  const ConsultantClientQuota = require('../../../../client-management/quota/ConsultantClientQuota');
  const quota = await ConsultantClientQuota.findOne({ clientId }).select('limits.esgEvidenceMode').lean();
  return quota?.limits?.esgEvidenceMode || 'both';
}

// ── POST /:clientId/submissions/:submissionId/evidence ────────────────────────
async function uploadEvidence(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // Quota mode check
    const mode = await _getEvidenceMode(clientId);
    if (mode === 'url_only') {
      return res.status(403).json({
        success: false,
        message: 'File upload is not permitted for this client. Paste a URL link instead.',
      });
    }

    const EsgDataEntry = require('../models/EsgDataEntry');
    const doc = await EsgDataEntry.findOne({
      _id: submissionId, clientId, isDeleted: false,
    });
    if (!doc) return res.status(404).json({ success: false, message: 'Submission not found' });

    // S3 upload
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const { v4: uuidv4 } = require('uuid');
    const s3Client = new S3Client({ region: process.env.AWS_REGION });
    const bucket   = process.env.ESG_EVIDENCE_BUCKET || 'esg-evidence';
    const s3Key    = `esg-evidence/${clientId}/${submissionId}/${uuidv4()}-${req.file.originalname}`;

    await s3Client.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         s3Key,
      Body:        req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    doc.evidence.push({
      evidenceType: 'file',
      fileName:     req.file.originalname,
      s3Key,
      mimeType:     req.file.mimetype,
      fileSize:     req.file.size,
      uploadedBy:   actor._id || actor.id,
      uploadedAt:   new Date(),
    });
    await doc.save();

    const added = doc.evidence[doc.evidence.length - 1];
    return res.json({
      success: true,
      data: {
        evidenceType: added.evidenceType,
        fileName:     added.fileName,
        s3Key:        added.s3Key,
        mimeType:     added.mimeType,
        fileSize:     added.fileSize,
        uploadedAt:   added.uploadedAt,
      },
    });
  } catch (err) {
    console.error('[submissionController.uploadEvidence]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/submissions/:submissionId/evidence/url ────────────────────
async function addEvidenceUrl(req, res) {
  try {
    const { clientId, submissionId } = req.params;
    const actor = req.user;
    const { url, fileName, description } = req.body || {};

    if (!url || !/^https?:\/\/.+/.test(url)) {
      return res.status(400).json({ success: false, message: 'A valid http/https URL is required' });
    }

    // Quota mode check
    const mode = await _getEvidenceMode(clientId);
    if (mode === 'file_only') {
      return res.status(403).json({
        success: false,
        message: 'URL evidence is not permitted for this client. Upload a file instead.',
      });
    }

    const EsgDataEntry = require('../models/EsgDataEntry');
    const doc = await EsgDataEntry.findOne({
      _id: submissionId, clientId, isDeleted: false,
    });
    if (!doc) return res.status(404).json({ success: false, message: 'Submission not found' });

    doc.evidence.push({
      evidenceType: 'url',
      fileName:     fileName || url,
      url,
      description,
      uploadedBy:   actor._id || actor.id,
      uploadedAt:   new Date(),
    });
    await doc.save();

    const added = doc.evidence[doc.evidence.length - 1];
    return res.json({
      success: true,
      data: {
        evidenceType: added.evidenceType,
        fileName:     added.fileName,
        url:          added.url,
        description:  added.description,
        uploadedAt:   added.uploadedAt,
      },
    });
  } catch (err) {
    console.error('[submissionController.addEvidenceUrl]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = {
  createBatchSubmissions,
  batchSubmitForReview,
  createSubmission,
  listSubmissions,
  getSubmission,
  updateDraft,
  submitForReview,
  resubmit,
  deleteDraft,
  batchDeleteDrafts,
  uploadEvidence,
  addEvidenceUrl,
};
