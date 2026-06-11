'use strict';

const mongoose = require('mongoose');

const ragTemplateVersionSchema = new mongoose.Schema(
  {
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'RagTemplate', required: true },
    version:    { type: Number, required: true },

    s3Key: { type: String, required: true },
    s3Url: { type: String },

    summary: {
      sectionCount:  { type: Number, default: 0 },
      fieldCount:    { type: Number, default: 0 },
      hasTables:     { type: Boolean, default: false },
      hasCharts:     { type: Boolean, default: false },
      dataPlatforms: [String],
      standards:     [String]
    },

    changelog: { type: String, default: '' },
    status: {
      type: String,
      enum: ['draft', 'published', 'deprecated'],
      default: 'draft'
    },

    publishedAt: { type: Date },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt:   { type: Date, default: Date.now }
  },
  { timestamps: false }
);

ragTemplateVersionSchema.index({ templateId: 1, version: 1 }, { unique: true });
ragTemplateVersionSchema.index({ templateId: 1, status: 1 });
ragTemplateVersionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('RagTemplateVersion', ragTemplateVersionSchema, 'rag_report_template_versions');
