'use strict';

const mongoose = require('mongoose');

const INSTANCE_STATUS_ENUM = ['active', 'locked', 'submitted', 'completed', 'cancelled'];

const clientFrameworkInstanceSchema = new mongoose.Schema(
  {
    clientId: {
      type:     String,
      required: [true, 'clientId is required'],
      index:    true,
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
    periodId: {
      type:     String,
      required: [true, 'periodId is required'],
      trim:     true,
      // e.g. '2024-25', '2024', or an ObjectId string from a period model
    },
    reportingYear: {
      type:     Number,
      required: [true, 'reportingYear is required'],
      // e.g. 2024 for FY 2024-25
    },
    status: {
      type:    String,
      enum:    INSTANCE_STATUS_ENUM,
      default: 'active',
    },
    activatedBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'activatedBy is required'],
    },
    activatedAt: {
      type:    Date,
      default: Date.now,
    },
    lockedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    lockedAt: {
      type:    Date,
      default: null,
    },
    // Snapshot of question versions active at the time of activation.
    // Keyed by questionCode → questionVersion; frozen on lock.
    questionVersionSnapshot: {
      type:    mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_client_framework_instances',
  }
);

clientFrameworkInstanceSchema.index(
  { clientId: 1, frameworkCode: 1, periodId: 1 },
  { unique: true }
);

module.exports = mongoose.model('ClientFrameworkInstance', clientFrameworkInstanceSchema);
module.exports.INSTANCE_STATUS_ENUM = INSTANCE_STATUS_ENUM;
