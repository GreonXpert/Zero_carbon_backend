'use strict';

const mongoose = require('mongoose');

const SECTION_STATUS_ENUM = ['active', 'retired'];

const frameworkSectionSchema = new mongoose.Schema(
  {
    frameworkId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgFramework',
      required: [true, 'frameworkId is required'],
      index:    true,
    },
    frameworkCode: {
      type:     String,
      required: [true, 'frameworkCode is required'],
      trim:     true,
      uppercase: true,
    },
    sectionCode: {
      type:     String,
      required: [true, 'sectionCode is required'],
      trim:     true,
      // e.g. 'A', 'B', 'C', 'C-P1', 'C-P2' ... 'C-P9'
    },
    sectionName: {
      type:     String,
      required: [true, 'sectionName is required'],
      trim:     true,
    },
    description: {
      type:    String,
      trim:    true,
      default: null,
    },
    parentSectionId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'EsgFrameworkSection',
      default: null,
      // null = top-level section
    },
    parentSectionCode: {
      type:    String,
      trim:    true,
      default: null,
    },
    principleCode: {
      type:    String,
      trim:    true,
      default: null,
      // e.g. 'P1' through 'P9' for BRSR Section C
    },
    displayOrder: {
      type:    Number,
      default: 0,
    },
    status: {
      type:    String,
      enum:    SECTION_STATUS_ENUM,
      default: 'active',
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_framework_sections',
  }
);

frameworkSectionSchema.index({ frameworkCode: 1, sectionCode: 1 }, { unique: true });
frameworkSectionSchema.index({ frameworkCode: 1, principleCode: 1 });

module.exports = mongoose.model('EsgFrameworkSection', frameworkSectionSchema);
module.exports.SECTION_STATUS_ENUM = SECTION_STATUS_ENUM;
