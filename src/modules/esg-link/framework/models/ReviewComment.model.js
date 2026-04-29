'use strict';

const mongoose = require('mongoose');

const COMMENT_TYPE_ENUM   = [
  'reviewer_comment',
  'approver_query',
  'contributor_reply',
  'reviewer_reply',
  'system_note',
];
const COMMENT_STATUS_ENUM = ['open', 'addressed', 'resolved'];

const reviewCommentSchema = new mongoose.Schema(
  {
    answerId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'DisclosureAnswer',
      required: [true, 'answerId is required'],
      index:    true,
    },
    questionId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'EsgFrameworkQuestion',
      required: [true, 'questionId is required'],
    },
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
    commentBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: [true, 'commentBy is required'],
    },
    commentByRole: {
      type:     String,
      required: [true, 'commentByRole is required'],
      trim:     true,
    },
    commentTo: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    commentToRole: {
      type:    String,
      trim:    true,
      default: null,
    },
    commentText: {
      type:     String,
      required: [true, 'commentText is required'],
      trim:     true,
    },
    commentType: {
      type:     String,
      enum:     COMMENT_TYPE_ENUM,
      required: [true, 'commentType is required'],
    },
    status: {
      type:    String,
      enum:    COMMENT_STATUS_ENUM,
      default: 'open',
    },
    parentCommentId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'EsgReviewComment',
      default: null,
    },
    resolvedAt: {
      type:    Date,
      default: null,
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'esg_review_comments',
  }
);

reviewCommentSchema.index({ answerId: 1, status: 1 });
reviewCommentSchema.index({ clientId: 1, periodId: 1, frameworkCode: 1 });

module.exports = mongoose.model('EsgReviewComment', reviewCommentSchema);
module.exports.COMMENT_TYPE_ENUM   = COMMENT_TYPE_ENUM;
module.exports.COMMENT_STATUS_ENUM = COMMENT_STATUS_ENUM;
