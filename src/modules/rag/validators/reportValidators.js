'use strict';

const Joi = require('joi');

const generateReportSchema = Joi.object({
  templateId:        Joi.string().length(24).hex().required(),
  templateVersionId: Joi.string().length(24).hex().optional(),
  // consultant_admin must supply the target client's organizationId
  // clientId is a custom string (e.g. "Greon008"), NOT a 24-char hex ObjectId
  organizationId:    Joi.string().min(1).max(100).optional(),
  title:             Joi.string().max(300).optional(),
  reportingYear:     Joi.number().integer().min(2000).max(2100).optional(),
  reportingPeriod:   Joi.object({
    start: Joi.date().optional(),
    end:   Joi.date().optional()
  }).optional(),
  brandingId: Joi.string().length(24).hex().optional()
});

const updateContentSchema = Joi.object({
  sections: Joi.object().required(),
  note:     Joi.string().max(500).allow('').optional()
});

module.exports = { generateReportSchema, updateContentSchema };
