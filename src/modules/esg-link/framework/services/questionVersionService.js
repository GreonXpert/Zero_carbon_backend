'use strict';

const EsgFrameworkQuestion = require('../models/FrameworkQuestion.model');

/**
 * getActiveQuestion
 * Returns the latest published version of a question by questionCode.
 * @param {string} questionCode
 * @returns {Promise<document|null>}
 */
const getActiveQuestion = async (questionCode) => {
  return EsgFrameworkQuestion.findOne(
    { questionCode, status: 'published', isDeleted: false },
    null,
    { sort: { questionVersion: -1 } }
  ).lean();
};

/**
 * createDraftVersion
 * Creates a new draft version of an existing question with incremented questionVersion.
 * Blocks direct edits to published questions.
 *
 * @param {string|ObjectId} existingQuestionId - ID of the currently published question
 * @param {object}          changes            - Fields to override in the new draft
 * @param {string|ObjectId} createdBy          - User performing the action
 * @returns {Promise<{ success: boolean, message: string, data?: document }>}
 */
const createDraftVersion = async (existingQuestionId, changes, createdBy) => {
  const existing = await EsgFrameworkQuestion.findById(existingQuestionId).lean();
  if (!existing) {
    return { success: false, message: 'Question not found' };
  }

  if (existing.status !== 'published') {
    return {
      success: false,
      message: `Cannot version a question in "${existing.status}" status. Only published questions can be versioned.`,
    };
  }

  const {
    _id, createdAt, updatedAt, submittedBy, approvedBy, rejectionReason,
    publishedAt, ...baseFields
  } = existing;

  const newDraft = new EsgFrameworkQuestion({
    ...baseFields,
    ...changes,
    questionVersion: existing.questionVersion + 1,
    status:          'draft',
    createdBy,
    submittedBy:     null,
    approvedBy:      null,
    rejectionReason: null,
    isDeleted:       false,
    deletedAt:       null,
    deletedBy:       null,
  });

  await newDraft.save();
  return { success: true, message: 'New draft version created', data: newDraft };
};

/**
 * blockPublishedEdit
 * Returns an error object if the question is published (use createDraftVersion instead).
 * Returns null if the edit is safe to proceed.
 *
 * @param {document} question
 * @returns {{ message: string }|null}
 */
const blockPublishedEdit = (question) => {
  if (question.status === 'published') {
    return {
      message:
        'Published questions cannot be edited directly. Use POST /questions/:questionId/version to create a new draft version.',
    };
  }
  return null;
};

module.exports = {
  getActiveQuestion,
  createDraftVersion,
  blockPublishedEdit,
};
