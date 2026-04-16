'use strict';

/**
 * formulaNotifications.js — Backward-Compatibility Re-Export
 *
 * The authoritative notification helpers have moved to:
 *   src/modules/common/formula/notifications/formulaNotifications.js
 *
 * This file is kept so that any existing code that does:
 *   require('../../workflow/notifications/formulaNotifications')
 * continues to work without change.
 */

module.exports = require('../../../common/formula/notifications/formulaNotifications');
