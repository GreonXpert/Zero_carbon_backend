'use strict';

/**
 * FormulaController.js — Backward-Compatibility Re-Export
 *
 * The authoritative FormulaController has moved to:
 *   src/modules/common/formula/controllers/FormulaController.js
 *
 * This file is kept so that any existing code that does:
 *   require('../controllers/FormulaController')
 * continues to work without change.
 *
 * NOTE: attachFormulaToReduction is NOT re-exported from here.
 * It lives in: src/modules/zero-carbon/reduction/controllers/attachFormulaToReduction.js
 * and is mounted directly in the reduction FormulaR.js routes file.
 */

module.exports = require('../../../common/formula/controllers/FormulaController');
