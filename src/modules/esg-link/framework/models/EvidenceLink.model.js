'use strict';

const mongoose = require('mongoose');

const EVIDENCE_TYPE_ENUM   = ['url', 'file', 'document_reference'];
const EVIDENCE_STATUS_ENUM = ['submitted', 'accepted', 'rejected'];

const evidenceLinkSchema = new mongoose.Schema(
  {
    clientId: {
      type:     String,
      required: [true, 'clientId is required'],
      index:    true,
    },
    periodId: {
      type:     String,
      required: [true, 'periodId is required'],
      trim:     true,
    },
    frameworkId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgFramework',
      required: [true, 'frameworkId is required'],
    },
    frameworkCode: {
      type:     String,
      required: [true, 'frameworkCode is required'],
      trim:     true,
      uppercase: true,
    },
    questionId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgFrameworkQuestion',
      required: [true, 'questionId is required'],
      index:    true,
    },
    answerId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'DisclosureAnswer',
      required: [true, 'answerId is required'],
      index:    true,
    },
    evidenceType: {
      type:     String,
      enum:     EVIDENCE_TYPE_ENUM,
      required: [true, 'evidenceType is required'],
    },
    title: {
      type:     String,
      required: [true, 'title is required'],
      trim:     true,
    },
    url: {
      type:    String,
      trim:    true,
      default: null,
      // For evidenceType: 'url'
    },
    fileKey: {
      type:    String,
      trim:    true,
      default: null,
      // S3 key or storage reference for uploaded files
    },
    fileName: {
      type:    String,
      trim:    true,
      default: null,
    },
    mimeType: {
      type:    String,
      trim:    true,
      default: null,
    },
    uploadedBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'uploadedBy is required'],
    },
    status: {
      type:    String,
      enum:    EVIDENCE_STATUS_ENUM,
      default: 'submitted',
    },
    reviewerComment: {
      type:    String,
      trim:    true,
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_evidence_links',
  }
);

evidenceLinkSchema.index({ answerId: 1, status: 1 });
evidenceLinkSchema.index({ clientId: 1, periodId: 1, questionId: 1 });

module.exports = mongoose.model('EsgEvidenceLink', evidenceLinkSchema);
module.exports.EVIDENCE_TYPE_ENUM   = EVIDENCE_TYPE_ENUM;
module.exports.EVIDENCE_STATUS_ENUM = EVIDENCE_STATUS_ENUM;
