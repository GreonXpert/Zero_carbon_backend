// services/survey/surveyEFHelper.js
// Resolves scope-level emission factor data for Tier-2 Employee Commuting surveys.
// Handles both Flowchart and ProcessFlowchart source models transparently.

'use strict';

const Flowchart = require('../../models/Organization/Flowchart');
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');

/**
 * Fetch the emissionFactors[] array and collectionFrequency for a given
 * flowchart node + scope. Works for both Flowchart and ProcessFlowchart.
 *
 * Priority: processFlowchartId is checked first (if truthy). This matches
 * the schema design where exactly one of the two IDs is set per survey.
 *
 * If both IDs are null/undefined the function returns { found: false }
 * immediately without hitting the database.
 *
 * @param {string|import('mongoose').Types.ObjectId|null} flowchartId
 * @param {string|import('mongoose').Types.ObjectId|null} processFlowchartId
 * @param {string} nodeId
 * @param {string} scopeIdentifier
 * @returns {Promise<{
 *   employeeCommutingEmissionFactors: Array,
 *   collectionFrequency: string|null,
 *   found: boolean
 * }>}
 */
async function fetchScopeEFData(flowchartId, processFlowchartId, nodeId, scopeIdentifier) {
  // ── 1. Determine which model to query ──────────────────────────────────────
  let doc = null;

  if (processFlowchartId) {
    doc = await ProcessFlowchart.findById(processFlowchartId).lean();
  } else if (flowchartId) {
    doc = await Flowchart.findById(flowchartId).lean();
  }

  // ── 2. Guard: document not found or no ID provided ─────────────────────────
  if (!doc) {
    return { employeeCommutingEmissionFactors: [], collectionFrequency: null, found: false };
  }

  // ── 3. Locate the node ──────────────────────────────────────────────────────
  const node = (doc.nodes || []).find(n => n.id === nodeId);
  if (!node) {
    return { employeeCommutingEmissionFactors: [], collectionFrequency: null, found: false };
  }

  // ── 4. Locate the scope detail ─────────────────────────────────────────────
  const scope = (node.details?.scopeDetails || []).find(
    s => s.scopeIdentifier === scopeIdentifier
  );
  if (!scope) {
    return { employeeCommutingEmissionFactors: [], collectionFrequency: null, found: false };
  }

  // ── 5. Return what the calculator needs ────────────────────────────────────
  return {
    employeeCommutingEmissionFactors: scope.employeeCommutingEmissionFactors || [],
    collectionFrequency: scope.employeeCommutingConfig?.collectionFrequency || null,
    found: true,
  };
}

module.exports = { fetchScopeEFData };
