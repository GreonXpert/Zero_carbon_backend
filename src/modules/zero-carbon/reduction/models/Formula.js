'use strict';

/**
 * Formula.js — Backward-Compatibility Re-Export
 *
 * The authoritative Formula model has moved to:
 *   src/modules/common/formula/models/Formula.js
 *
 * This file is kept so that any existing code that does:
 *   require('../models/Formula')
 * continues to work without change.
 *
 * Model name is now 'Formula' (was 'ReductionFormula').
 * Collection name is still 'reduction_formulas'.
 */

module.exports = require('../../../common/formula/models/Formula');
