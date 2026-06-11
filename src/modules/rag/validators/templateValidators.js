'use strict';

const Joi = require('joi');

const createTemplateSchema = Joi.object({
  name:        Joi.string().min(2).max(200).required(),
  slug:        Joi.string().min(2).max(200).pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  description: Joi.string().max(1000).allow('').optional(),
  type:        Joi.string().valid('emission_report','brsr','gri','issb','csrd','esg_summary','custom').required(),
  platform:    Joi.string().valid('zero_carbon','esglink','both').optional(),
  tags:        Joi.array().items(Joi.string()).optional(),
  structure:   Joi.object().required()
});

const updateTemplateSchema = Joi.object({
  structure:  Joi.object().required(),
  changelog:  Joi.string().max(500).allow('').optional()
});

module.exports = { createTemplateSchema, updateTemplateSchema };
