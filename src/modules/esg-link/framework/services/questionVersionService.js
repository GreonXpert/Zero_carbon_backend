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
 * Moves a published question back to draft status, in place, as a new version —
 * incrementing questionVersion and applying any field changes. Blocks direct
 * edits to published questions (use this instead).
 *
 * @param {string|ObjectId} existingQuestionId - ID of the currently published question
 * @param {object}          changes            - Fields to override on the draft
 * @param {string|ObjectId} createdBy          - User performing the action
 * @returns {Promise<{ success: boolean, message: string, data?: document }>}
 */
const createDraftVersion = async (existingQuestionId, changes, createdBy) => {
  const existing = await EsgFrameworkQuestion.findById(existingQuestionId);
  if (!existing) {
    return { success: false, message: 'Question not found' };
  }

  if (existing.status !== 'published') {
    return {
      success: false,
      message: `Cannot version a question in "${existing.status}" status. Only published questions can be versioned.`,
    };
  }

  Object.assign(existing, changes, {
    questionVersion: existing.questionVersion + 1,
    status:          'draft',
    createdBy,
    submittedBy:     null,
    approvedBy:      null,
    rejectionReason: null,
  });

  await existing.save();
  return { success: true, message: 'Question moved back to draft as a new version', data: existing };
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
