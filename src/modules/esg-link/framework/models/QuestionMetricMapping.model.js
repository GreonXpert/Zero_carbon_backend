'use strict';

const mongoose = require('mongoose');

const MAPPING_TYPE_ENUM       = ['auto_answer', 'manual_reference', 'hybrid'];
const AGGREGATION_METHOD_ENUM = ['sum', 'average', 'latest', 'max', 'min', 'count'];
const PERIOD_TYPE_ENUM        = ['annual', 'quarterly', 'monthly', 'custom'];

const questionMetricMappingSchema = new mongoose.Schema(
  {
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
    // null = framework-level template (applies to all clients by default)
    // a real clientId = client-specific override
    clientId: {
      type:    String,
      trim:    true,
      default: null,
      index:   true,
    },
    questionId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgFrameworkQuestion',
      required: [true, 'questionId is required'],
      index:    true,
    },
    questionCode: {
      type:     String,
      required: [true, 'questionCode is required'],
      trim:     true,
    },
    metricId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgMetric',
      required: [true, 'metricId is required'],
      index:    true,
    },
    metricCode: {
      type:     String,
      required: [true, 'metricCode is required'],
      trim:     true,
    },
    sectionCode: {
      type:    String,
      trim:    true,
      default: null,
    },
    principleCode: {
      type:    String,
      trim:    true,
      default: null,
    },
    indicatorType: {
      type:    String,
      trim:    true,
      default: null,
    },
    mappingType: {
      type:    String,
      enum:    MAPPING_TYPE_ENUM,
      default: 'auto_answer',
    },
    boundaryLevel: {
      type:    String,
      trim:    true,
      default: null,
      // e.g. 'site', 'entity', 'group'
    },
    aggregationMethod: {
      type:    String,
      enum:    AGGREGATION_METHOD_ENUM,
      default: 'sum',
    },
    periodType: {
      type:    String,
      enum:    PERIOD_TYPE_ENUM,
      default: 'annual',
    },
    answerFieldKey: {
      type:    String,
      trim:    true,
      default: null,
      // Key in answerData to populate (for table/matrix answers)
    },
    isPrimary: {
      type:    Boolean,
      default: false,
      // Is this the primary metric for auto-filling the answer?
    },
    isCore: {
      type:    Boolean,
      default: false,
      // Is this a core BRSR metric mapping?
    },
    isBrsrCore: {
      type:    Boolean,
      default: false,
    },
    allowManualOverride: {
      type:    Boolean,
      default: true,
    },
    requiredForReadiness: {
      type:    Boolean,
      default: false,
    },

    // ── Boundary node scope ───────────────────────────────────────────────────
    // Controls which boundary nodes contribute to the prefilled value.
    // There is always exactly one active boundary per client; this controls
    // which of its nodes are included in the aggregated value.
    useAllNodes: {
      type:    Boolean,
      default: true,
      // true  → use byMetric[].combinedValue (all nodes aggregated)
      // false → sum only the node IDs listed in boundaryNodeIds
    },
    boundaryNodeIds: {
      type:    [String],
      default: [],
      // Populated when useAllNodes = false.
      // Values match BoundaryNode.id strings inside EsgLinkBoundary.nodes[].
    },
    active: {
      type:    Boolean,
      default: true,
      index:   true,
    },
    createdBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'createdBy is required'],
    },
    updatedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_question_metric_mappings',
  }
);

// Unique active mapping per question+metric+client combination
// clientId: null  = framework-level template (one per question+metric)
// clientId: <id>  = client-specific override (one per question+metric+client)
questionMetricMappingSchema.index(
  { questionId: 1, metricId: 1, clientId: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: 'unique_active_question_metric_client',
  }
);
questionMetricMappingSchema.index({ frameworkCode: 1, questionCode: 1, active: 1 });
questionMetricMappingSchema.index({ metricId: 1, active: 1 });

module.exports = mongoose.model('QuestionMetricMapping', questionMetricMappingSchema);
module.exports.MAPPING_TYPE_ENUM       = MAPPING_TYPE_ENUM;
module.exports.AGGREGATION_METHOD_ENUM = AGGREGATION_METHOD_ENUM;
module.exports.PERIOD_TYPE_ENUM        = PERIOD_TYPE_ENUM;
