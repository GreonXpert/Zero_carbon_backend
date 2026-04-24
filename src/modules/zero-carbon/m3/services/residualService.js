'use strict';

const ResidualPosition = require('../models/ResidualPosition');
const CreditLedger = require('../models/CreditLedger');
const InitiativeAttribution = require('../models/InitiativeAttribution');
const EvidenceAttachment = require('../models/EvidenceAttachment');
const { ApprovableEntityType, CreditStatus } = require('../constants/enums');
const { ERRORS } = require('../constants/messages');

/**
 * Computes and stores a residual position.
 * residual = gross_emissions - verified_reductions
 * Credits are NEVER netted into pathway gaps — they are separate.
 */
async function computeResidualPosition({ target_id, clientId, gross_emissions }, user) {
  if (!target_id) {
    const e = new Error('target_id is required.'); e.status = 422; throw e;
  }
  if (gross_emissions == null || isNaN(Number(gross_emissions))) {
    const e = new Error('gross_emissions is required and must be a number.'); e.status = 422; throw e;
  }

  const grossEmissions = Number(gross_emissions);

  // Sum verified reductions from approved InitiativeAttributions
  const attributions = await InitiativeAttribution.find({
    target_id, isDeleted: false,
    verification_status: { $in: ['VERIFIED', 'APPROVED'] },
  });
  const verifiedReductions = attributions.reduce((sum, a) => sum + (a.achieved_reduction || 0), 0);

  const residual = grossEmissions - verifiedReductions;
  const neutralization_required_pct = grossEmissions > 0
    ? (residual / grossEmissions) * 100
    : 0;

  return ResidualPosition.create({
    clientId,
    target_id,
    gross_emissions:             grossEmissions,
    verified_reductions:         verifiedReductions,
    residual_emissions:          residual,
    neutralization_required_pct: neutralization_required_pct,
    computed_at:                 new Date(),
    created_by:                  user?._id,
  });
}

async function listResidualPositions(clientId, targetId) {
  const query = { clientId };
  if (targetId) query.target_id = targetId;
  return ResidualPosition.find(query).sort({ computed_at: -1 });
}

async function getResidualPositionById(id) {
  const r = await ResidualPosition.findById(id);
  if (!r) { const e = new Error('Residual position not found.'); e.status = 404; throw e; }
  return r;
}

// ── Credit Ledger ─────────────────────────────────────────────────────────────

async function createCredit(data, user) {
  if (data.purpose === 'PATHWAY_COMPLIANCE') {
    const e = new Error(ERRORS.CREDIT_PURPOSE_INVALID); e.status = 422; throw e;
  }
  return CreditLedger.create({ ...data, created_by: user._id, updated_by: user._id });
}

async function updateCredit(creditId, data, user) {
  const credit = await CreditLedger.findById(creditId);
  if (!credit) { const e = new Error('Credit not found.'); e.status = 404; throw e; }
  if (credit.retirement_status) {
    const e = new Error('Retired credits cannot be modified.'); e.status = 422; throw e;
  }
  const blocked = [CreditStatus.CANCELLED, CreditStatus.TRANSFERRED_OUT, CreditStatus.RETIRED];
  if (blocked.includes(credit.credit_status)) {
    const e = new Error(`Credits in ${credit.credit_status} status cannot be modified.`); e.status = 422; throw e;
  }
  Object.assign(credit, data, { updated_by: user._id });
  await credit.save();
  return credit;
}

/**
 * Puts a credit on HOLD (pause, reversible → HELD).
 * Only ACTIVE credits can be put on hold.
 */
async function holdCredit(creditId, user) {
  const credit = await CreditLedger.findById(creditId);
  if (!credit) { const e = new Error('Credit not found.'); e.status = 404; throw e; }

  if (credit.credit_status !== CreditStatus.ACTIVE) {
    const e = new Error(`Only ACTIVE credits can be put on hold. Current status: ${credit.credit_status}.`);
    e.status = 422; throw e;
  }

  credit.credit_status = CreditStatus.HELD;
  credit.updated_by    = user._id;
  await credit.save();
  return credit;
}

/**
 * Cancels a credit (irreversible → CANCELLED).
 * ACTIVE or HELD credits can be cancelled.
 */
async function cancelCredit(creditId, reason, user) {
  const credit = await CreditLedger.findById(creditId);
  if (!credit) { const e = new Error('Credit not found.'); e.status = 404; throw e; }

  const cancellable = [CreditStatus.ACTIVE, CreditStatus.HELD];
  if (!cancellable.includes(credit.credit_status)) {
    const e = new Error(`Credits in ${credit.credit_status} status cannot be cancelled.`);
    e.status = 422; throw e;
  }

  credit.credit_status = CreditStatus.CANCELLED;
  credit.updated_by    = user._id;
  if (reason) credit.cancellation_reason = reason;   // stored loosely as a field
  await credit.save();
  return credit;
}

async function retireCredit(creditId, evidenceAttachmentId, user) {
  const credit = await CreditLedger.findById(creditId);
  if (!credit) { const e = new Error('Credit not found.'); e.status = 404; throw e; }
  if (credit.retirement_status) {
    const e = new Error('Credit is already retired.'); e.status = 422; throw e;
  }
  if (!evidenceAttachmentId) {
    const e = new Error('Evidence attachment is required to retire a credit.'); e.status = 422; throw e;
  }

  credit.retirement_status    = true;
  credit.retired_at           = new Date();
  credit.evidence_attachment_id = evidenceAttachmentId;
  credit.updated_by           = user._id;
  await credit.save();
  return credit;
}

async function listCredits(clientId, filters = {}) {
  const query = { clientId };
  if (filters.retirement_status !== undefined) query.retirement_status = filters.retirement_status;
  if (filters.purpose) query.purpose = filters.purpose;
  return CreditLedger.find(query).sort({ createdAt: -1 });
}

async function getCreditById(creditId) {
  const c = await CreditLedger.findById(creditId);
  if (!c) { const e = new Error('Credit not found.'); e.status = 404; throw e; }
  return c;
}

module.exports = {
  computeResidualPosition,
  listResidualPositions,
  getResidualPositionById,
  createCredit,
  updateCredit,
  retireCredit,
  holdCredit,
  cancelCredit,
  listCredits,
  getCreditById,
};
