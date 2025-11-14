const Flowchart = require ('../../models/Flowchart');
const ProcessFlowchart =require ('../../models/ProcessFlowchart');
const Client = require('../../models/Client');

/**
 * Return the assessmentLevel as a normalized lowercase array.
 * Falls back to [] when missing.
 */
/**
 * Normalize assessmentLevel into a lowercase array.
 * Accepts: 'both', 'organization', 'process', 'reduction' etc., or an array.
 * Expands 'both' => ['organization','process'] and aliases 'organisation' => 'organization'.
 */
async function getNormalizedAssessmentLevels(clientId) {
  const client = await Client.findOne(
    { clientId },
    { 'submissionData.assessmentLevel': 1, _id: 0 }
  ).lean();

  const raw = client?.submissionData?.assessmentLevel;
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);

  const norm = arr
    .map(v => String(v || '').trim().toLowerCase())
    .flatMap(v => {
      if (v === 'both') return ['organization', 'process'];
      if (v === 'organisation') return ['organization'];
      return [v];
    })
    .filter(Boolean);

  return [...new Set(norm)];
}

/**
 * Merge nodes by id and merge scopeDetails de-duped by scopeIdentifier.
 * Left-most source wins for node meta; scopes are appended if not duplicate.
 */
function mergeCharts(orgChart, procChart) {
  const result = {
    clientId: orgChart?.clientId || procChart?.clientId,
    isActive: true,
    // keep a minimal structure consistent with your models
    nodes: [],
    edges: []
  };

  const nodeMap = new Map();

  const push = (chart, sourceTag) => {
    if (!chart?.nodes) return;
    for (const node of chart.nodes) {
      const existing = nodeMap.get(node.id) || {
        id: node.id,
        label: node.label,
        details: {
          ...(node.details || {}),
          scopeDetails: []
        },
        // keep any other fields if your frontend relies on them
      };

      const seen = new Set(
        (existing.details.scopeDetails || []).map(s => s?.scopeIdentifier).filter(Boolean)
      );

      // merge scopeDetails (avoid duplicates by scopeIdentifier)
      const incomingScopes = (node.details?.scopeDetails || []);
      for (const s of incomingScopes) {
        if (!s || !s.scopeIdentifier) continue;
        if (seen.has(s.scopeIdentifier)) continue;
        existing.details.scopeDetails.push(s);
        seen.add(s.scopeIdentifier);
      }

      nodeMap.set(node.id, existing);
    }
  };

  if (orgChart) push(orgChart, 'org');
  if (procChart) push(procChart, 'proc');

  result.nodes = Array.from(nodeMap.values());
  // Optional: combine unique edges if you use them
  const edgeSet = new Set();
  const addEdges = (chart) => {
    for (const e of chart?.edges || []) {
      const key = `${e.source}->${e.target}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        result.edges.push(e);
      }
    }
  };
  if (orgChart) addEdges(orgChart);
  if (procChart) addEdges(procChart);

  return result;
}
/**
 * Build a virtual "active chart" that merges nodes/scopes
 * from Flowchart (organization) and ProcessFlowchart (process)
 * depending on assessmentLevel.
 *
 * Returns { chartType: 'merged' | 'flowchart' | 'processflowchart', chart }
 * where chart.nodes has the usual shape.
 */
async function getActiveFlowchart(clientId) {
  const levels = await getNormalizedAssessmentLevels(clientId);
  const needOrg = levels.includes('organization');
  const needProc = levels.includes('process');

  // If only one level is enabled, return that chart as-is
  if (needOrg && !needProc) {
    const org = await Flowchart.findOne({ clientId, isActive: true }).lean();
    if (!org) return null;
    return { chartType: 'flowchart', chart: org };
  }
  if (!needOrg && needProc) {
    const proc = await ProcessFlowchart.findOne({ clientId, isDeleted: { $ne: true }, isActive: true }).lean();
    if (!proc) return null;
    return { chartType: 'processflowchart', chart: proc };
  }

  // Otherwise, both → merge
  const [org, proc] = await Promise.all([
    Flowchart.findOne({ clientId, isActive: true }).lean(),
    ProcessFlowchart.findOne({ clientId, isDeleted: { $ne: true }, isActive: true }).lean()
  ]);

  // If one of them is missing, gracefully fallback to the other
  if (!org && !proc) return null;
  if (org && !proc) return { chartType: 'flowchart', chart: org };
  if (!org && proc) return { chartType: 'processflowchart', chart: proc };

  // Merge nodes by (nodeId + scopeIdentifier)
  const nodeMap = new Map();

  const pushNodeScopes = (chart) => {
    for (const node of chart?.nodes || []) {
      const base = nodeMap.get(node.id) || { id: node.id, label: node.label, position: node.position, details: { ...(node.details || {}), scopeDetails: [] } };
      const scopes = node?.details?.scopeDetails || [];
      base.details = base.details || {};
      base.details.scopeDetails = base.details.scopeDetails || [];

      // De-duplicate by scopeIdentifier for this node
      const seen = new Set(base.details.scopeDetails.map(s => s.scopeIdentifier));
      for (const s of scopes) {
        if (!s?.scopeIdentifier) continue;
        if (seen.has(s.scopeIdentifier)) continue;
        base.details.scopeDetails.push(s);
        seen.add(s.scopeIdentifier);
      }
      nodeMap.set(node.id, base);
    }
  };

  pushNodeScopes(org);
  pushNodeScopes(proc);

  const mergedChart = {
    _id: org?._id || proc?._id,
    clientId,
    isActive: true,
    nodes: Array.from(nodeMap.values()),
    edges: [...(org?.edges || []), ...(proc?.edges || [])] // keep edges if you need
  };

  return { chartType: 'merged', chart: mergedChart };
}

module.exports = {
  getActiveFlowchart,
  getNormalizedAssessmentLevels
};
