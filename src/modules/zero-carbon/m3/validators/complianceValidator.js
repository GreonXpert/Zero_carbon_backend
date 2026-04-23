'use strict';

const { ComplianceStatus } = require('../constants/enums');
const { ERRORS, BLOCKERS } = require('../constants/messages');
const DataQualityFlag = require('../models/DataQualityFlag');

/**
 * Checks whether a compliance year record can be closed:
 * - Must have actual_emissions and output_value
 * - Must have no unresolved BLOCKER-severity DQFlags for the target
 */
async function assertCanClose(complianceRecord) {
  const errors = [];

  if (complianceRecord.closure_status === ComplianceStatus.CLOSED) {
    errors.push(ERRORS.COMPLIANCE_YEAR_CLOSED);
  }

  if (complianceRecord.actual_emissions == null) {
    errors.push('actual_emissions is required before closing a compliance year.');
  }

  if (complianceRecord.output_value == null) {
    errors.push(ERRORS.OUTPUT_DATA_REQUIRED);
  }

  // Check for unresolved BLOCKER flags on this target
  const blockerCount = await DataQualityFlag.countDocuments({
    entity_type: 'TargetMaster',
    entity_id:   String(complianceRecord.target_id),
    severity:    'BLOCKER',
    resolved:    false,
  });

  if (blockerCount > 0) {
    errors.push(BLOCKERS.COMPLIANCE_YEAR_HAS_BLOCKERS);
  }

  return errors;
}

module.exports = { assertCanClose };
