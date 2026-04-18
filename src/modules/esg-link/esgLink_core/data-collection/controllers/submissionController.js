'use strict';

const submissionService = require('../services/submissionService');
const workflowService   = require('../services/workflowService');
const { canSubmit, canViewSubmission } = require('../utils/submissionPermissions');
const { resolveAssignees } = require('../services/workflowService');

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
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }

    return res.status(201).json({ success: true, data: result.doc });
  } catch (err) {
    console.error('[submissionController.createSubmission]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── GET /:clientId/submissions ────────────────────────────────────────────────
async function listSubmissions(req, res) {
  try {
    const { clientId } = req.params;
    const accessCtx    = req.submissionAccessCtx;

    const result = await submissionService.list(clientId, accessCtx, req.query);
    return res.json({
      success: true,
      data: {
        submissions: result.docs,
        total:       result.total,
        page:        result.page,
        limit:       result.limit,
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

    const { reviewers, approvers } = await resolveAssignees(result.doc);
    const { mapping } = await resolveAssignees(result.doc);

    if (!await canViewSubmission(actor, mapping, reviewers, approvers, clientId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    return res.json({ success: true, data: result.doc });
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

// ── Shared helper: resolve esgEvidenceMode for a client ───────────────────────
async function _getEvidenceMode(clientId) {
  const ConsultantClientQuota = require('../../../../modules/client-management/quota/ConsultantClientQuota');
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
  createSubmission,
  listSubmissions,
  getSubmission,
  updateDraft,
  submitForReview,
  resubmit,
  deleteDraft,
  uploadEvidence,
  addEvidenceUrl,
};
