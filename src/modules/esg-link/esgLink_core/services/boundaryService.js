'use strict';
/**
 * boundaryService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Business logic for ESGLink Core boundary operations.
 */

const Client = require('../../../../modules/client-management/client/Client');
const Flowchart = require('../../../../modules/zero-carbon/organization/models/Flowchart');

const ALLOWED_ASSESSMENT_LEVELS = ['reduction', 'decarbonization', 'organization', 'process'];

/**
 * checkZeroCarbonOrgAvailability
 * ─────────────────────────────────────────────────────────────────────────────
 * Checks whether a client has:
 *   (a) zero_carbon in accessibleModules
 *   (b) assessmentLevel includes 'organization'
 *   (c) an active Flowchart document
 *
 * Returns:
 *   { available: true, flowchartId, chartVersion } on success
 *   { available: false, reason, code }             on failure
 */
const checkZeroCarbonOrgAvailability = async (clientId) => {
  // NOTE: Use submissionData:1 (not the narrower submissionData.assessmentLevel:1)
  // because Mongoose's inline-nested-schema projection can silently omit the
  // subfield when only a dot-path is specified, even with .lean().
  const client = await Client.findOne(
    { clientId },
    { submissionData: 1, accessibleModules: 1, _id: 0 }
  ).lean();

  if (!client) {
    return { available: false, reason: 'Client not found', code: 'CLIENT_NOT_FOUND' };
  }

  const hasZeroCarbon = (client.accessibleModules || []).includes('zero_carbon');
  if (!hasZeroCarbon) {
    return {
      available: false,
      reason: 'Client does not have the zero_carbon module',
      code: 'NO_ZERO_CARBON_MODULE'
    };
  }

  const raw = client?.submissionData?.assessmentLevel;
  let levels = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  levels = levels
    .map(v => String(v || '').trim().toLowerCase())
    .flatMap(v => v === 'both' ? ['organization', 'process'] : [v])
    .filter(v => ALLOWED_ASSESSMENT_LEVELS.includes(v));

  if (!levels.includes('organization')) {
    return {
      available: false,
      reason: 'Client assessmentLevel does not include "organization"',
      code: 'NO_ORGANIZATION_LEVEL',
      assessmentLevel: levels
    };
  }

  const flowchart = await Flowchart.findOne({ clientId, isActive: true }, { _id: 1, version: 1 }).lean();
  if (!flowchart) {
    return {
      available: false,
      reason: 'No active organisational flowchart found for this client',
      code: 'FLOWCHART_NOT_FOUND'
    };
  }

  return {
    available: true,
    flowchartId: flowchart._id,
    chartVersion: flowchart.version || 1
  };
};

/**
 * extractBoundaryFromFlowchart
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads the ZeroCarbon Flowchart for a client and returns boundary-safe
 * nodes and edges (strips all scope details, emission factors, IOT/API data).
 */
const extractBoundaryFromFlowchart = async (clientId) => {
  const flowchart = await Flowchart.findOne({ clientId, isActive: true }).lean();
  if (!flowchart) return null;

  const boundaryNodes = (flowchart.nodes || []).map(node => ({
    id:       node.id,
    label:    node.label || '',
    type:     node.type  || 'entity',
    position: node.position || { x: 0, y: 0 },
    details: {
      name:       node.details?.name       || node.label || '',
      department: node.details?.department || '',
      location:   node.details?.location   || '',
      entityType: node.details?.entityType || '',
      notes:      ''
    }
  }));

  const boundaryEdges = (flowchart.edges || []).map(edge => ({
    id:     edge.id,
    source: edge.source,
    target: edge.target,
    label:  edge.label || ''
  }));

  return {
    nodes:         boundaryNodes,
    edges:         boundaryEdges,
    sourceChartId: flowchart._id,
    chartVersion:  flowchart.version || 1
  };
};

module.exports = {
  checkZeroCarbonOrgAvailability,
  extractBoundaryFromFlowchart
};
