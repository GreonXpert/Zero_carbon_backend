'use strict';

const Joi = require('joi');

const exportPDFSchema = Joi.object({
  // No required body for PDF export — reportId comes from URL param
});

module.exports = { exportPDFSchema };
