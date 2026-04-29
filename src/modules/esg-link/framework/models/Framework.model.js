'use strict';

const mongoose = require('mongoose');

const FRAMEWORK_STATUS_ENUM = ['draft', 'active', 'retired'];
const FRAMEWORK_TYPE_ENUM   = ['mandatory', 'voluntary', 'hybrid'];

const frameworkSchema = new mongoose.Schema(
  {
    frameworkCode: {
      type:     String,
      required: [true, 'frameworkCode is required'],
      unique:   true,
      trim:     true,
      uppercase: true,
      // e.g. 'BRSR', 'GRI', 'SASB', 'CSRD'
    },
    frameworkName: {
      type:     String,
      required: [true, 'frameworkName is required'],
      trim:     true,
    },
    frameworkType: {
      type: String,
      enum: FRAMEWORK_TYPE_ENUM,
      default: 'mandatory',
    },
    country: {
      type:    String,
      trim:    true,
      default: null,
      // null = global / multi-country
    },
    authority: {
      type:    String,
      trim:    true,
      default: null,
      // e.g. 'SEBI', 'GRI Standards', 'EFRAG'
    },
    description: {
      type:    String,
      trim:    true,
      default: null,
    },
    status: {
      type:    String,
      enum:    FRAMEWORK_STATUS_ENUM,
      default: 'draft',
    },
    version: {
      type:    String,
      trim:    true,
      default: '1.0',
      // e.g. '2023-24', '1.0', '4.0'
    },
    createdBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'createdBy is required'],
    },
    approvedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_frameworks',
  }
);

module.exports = mongoose.model('EsgFramework', frameworkSchema);
module.exports.FRAMEWORK_STATUS_ENUM = FRAMEWORK_STATUS_ENUM;
module.exports.FRAMEWORK_TYPE_ENUM   = FRAMEWORK_TYPE_ENUM;
