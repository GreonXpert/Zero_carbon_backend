'use strict';

const mongoose = require('mongoose');

const ragTemplateSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    slug:        { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: '' },
    type: {
      type: String,
      enum: ['emission_report', 'brsr', 'gri', 'issb', 'csrd', 'esg_summary', 'custom'],
      required: true
    },
    tags: [String],

    currentVersion:  { type: Number, default: 1 },
    latestVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RagTemplateVersion' },

    platform: {
      type: String,
      enum: ['zero_carbon', 'esglink', 'both'],
      default: 'both'
    },
    organizationScope: { type: String, default: 'global' },

    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft'
    },
    isArchived: { type: Boolean, default: false },

    createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

ragTemplateSchema.index({ slug: 1 }, { unique: true });
ragTemplateSchema.index({ type: 1, status: 1 });
ragTemplateSchema.index({ platform: 1, organizationScope: 1 });
ragTemplateSchema.index({ createdBy: 1 });

module.exports = mongoose.model('RagTemplate', ragTemplateSchema, 'rag_report_templates');
