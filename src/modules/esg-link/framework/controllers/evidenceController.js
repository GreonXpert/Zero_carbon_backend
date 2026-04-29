'use strict';

const EsgEvidenceLink   = require('../models/EvidenceLink.model');
const DisclosureAnswer  = require('../models/DisclosureAnswer.model');
const { canAnswerQuestion, canViewClientBrsr } = require('../services/frameworkAccessService');

const addEvidence = async (req, res) => {
  try {
    const { answerId } = req.params;
    const answer = await DisclosureAnswer.findById(answerId).lean();
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const perm = await canAnswerQuestion(req.user, answer.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { evidenceType, title, url, fileKey, fileName, mimeType } = req.body;
    if (!evidenceType) return res.status(400).json({ message: 'evidenceType is required' });
    if (!title)        return res.status(400).json({ message: 'title is required' });
    if (evidenceType === 'url' && !url) {
      return res.status(400).json({ message: 'url is required for evidenceType "url"' });
    }

    const evidence = await EsgEvidenceLink.create({
      clientId:      answer.clientId,
      periodId:      answer.periodId,
      frameworkId:   answer.frameworkId,
      frameworkCode: answer.frameworkCode,
      questionId:    answer.questionId,
      answerId,
      evidenceType,
      title,
      url:           url       || null,
      fileKey:       fileKey   || null,
      fileName:      fileName  || null,
      mimeType:      mimeType  || null,
      uploadedBy:    req.user._id,
      status:        'submitted',
    });

    // Add to answer's evidenceIds array
    await DisclosureAnswer.findByIdAndUpdate(answerId, {
      $addToSet: { evidenceIds: evidence._id },
      $push: {
        evidenceLinks: {
          evidenceId:   evidence._id,
          evidenceType: evidence.evidenceType,
          title:        evidence.title,
          url:          evidence.url,
        },
      },
    });

    return res.status(201).json({ success: true, message: 'Evidence added', data: evidence });
  } catch (err) {
    console.error('[evidenceController] addEvidence:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const listEvidence = async (req, res) => {
  try {
    const { answerId } = req.params;
    const answer = await DisclosureAnswer.findById(answerId, 'clientId').lean();
    if (!answer) return res.status(404).json({ message: 'Answer not found' });

    const perm = await canViewClientBrsr(req.user, answer.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const evidence = await EsgEvidenceLink.find({ answerId }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, count: evidence.length, data: evidence });
  } catch (err) {
    console.error('[evidenceController] listEvidence:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const updateEvidence = async (req, res) => {
  try {
    const { evidenceId } = req.params;
    const evidence = await EsgEvidenceLink.findById(evidenceId).lean();
    if (!evidence) return res.status(404).json({ message: 'Evidence not found' });

    const perm = await canAnswerQuestion(req.user, evidence.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    const { title, url, reviewerComment, status } = req.body;
    const update = {};
    if (title           !== undefined) update.title           = title;
    if (url             !== undefined) update.url             = url;
    if (reviewerComment !== undefined) update.reviewerComment = reviewerComment;
    if (status          !== undefined) update.status          = status;

    const updated = await EsgEvidenceLink.findByIdAndUpdate(evidenceId, { $set: update }, { new: true });
    return res.status(200).json({ success: true, message: 'Evidence updated', data: updated });
  } catch (err) {
    console.error('[evidenceController] updateEvidence:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const deleteEvidence = async (req, res) => {
  try {
    const { evidenceId } = req.params;
    const evidence = await EsgEvidenceLink.findById(evidenceId).lean();
    if (!evidence) return res.status(404).json({ message: 'Evidence not found' });

    const perm = await canAnswerQuestion(req.user, evidence.clientId);
    if (!perm.allowed) return res.status(403).json({ message: perm.reason });

    await EsgEvidenceLink.findByIdAndDelete(evidenceId);

    // Remove from answer's evidenceIds array
    await DisclosureAnswer.findByIdAndUpdate(evidence.answerId, {
      $pull: {
        evidenceIds:   evidence._id,
        evidenceLinks: { evidenceId: evidence._id },
      },
    });

    return res.status(200).json({ success: true, message: 'Evidence deleted' });
  } catch (err) {
    console.error('[evidenceController] deleteEvidence:', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

module.exports = { addEvidence, listEvidence, updateEvidence, deleteEvidence };
