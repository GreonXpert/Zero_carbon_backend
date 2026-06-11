'use strict';

// ============================================================================
// dataEntryRetriever.js — handles three ZeroCarbon domains:
//
//   data_entry            → DataEntry records (raw emission inputs)
//   organization_flowchart→ Flowchart structure (nodes/edges) + DataEntry counts
//   process_flowchart     → ProcessEmissionDataEntry + ProcessFlowchart structure
//
// sections per domain (from moduleRegistry):
//   data_entry            → ['list', 'detail', 'stats', 'logs']
//   organization_flowchart→ ['view', 'nodes', 'scopeDetails', 'assignments']
//   process_flowchart     → ['view', 'entries', 'processEmissionEntries']
//
// Flowchart.nodes and Flowchart.edges are AES-encrypted; never project sub-fields
// on encrypted Mixed blobs — fetch the full document and extract after decryption.
// ============================================================================

const DataEntry                = require('../../../modules/zero-carbon/organization/models/DataEntry');
const ProcessEmissionDataEntry = require('../../../modules/zero-carbon/organization/models/ProcessEmissionDataEntry');
const Flowchart                = require('../../../modules/zero-carbon/organization/models/Flowchart');
const { safeFindMany, safeCount } = require('../utils/decryptSafeReader');
const { explainNoData, explainScopeRestrictions, explainTruncation } = require('../utils/exclusionExplainer');

// ── Helper: slim a Flowchart document's nodes for DeepSeek context ──────────
// Never pass raw encrypted strings or coordinates — only meaningful fields.
function slimFlowchartNodes(flowchart) {
  if (!flowchart) return null;
  const nodes = Array.isArray(flowchart.nodes) ? flowchart.nodes : [];
  return {
    totalNodes: nodes.length,
    nodes: nodes.map((n) => ({
      id:         n.id   || n._id,
      label:      n.label || n.data?.label || '',
      type:       n.type  || n.data?.nodeType || '',
      department: n.details?.department  || n.data?.department  || null,
      location:   n.details?.location    || n.data?.location    || null,
      scopeCount: Array.isArray(n.scopeDetails) ? n.scopeDetails.length : 0,
    })),
  };
}

async function retrieve(plan, accessContext) {
  const { clientId, domain, dateRange, sections, filters, maxRecords } = plan;
  const exclusions = [];

  if (accessContext.isScopeRestricted) {
    exclusions.push(...explainScopeRestrictions(accessContext.nodeRestrictions));
  }

  // ── Date filter ───────────────────────────────────────────────────────────
  const dateFilter = {};
  if (dateRange?.startDate) dateFilter.createdAt = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter.createdAt = { ...dateFilter.createdAt, $lte: dateRange.endDate };

  // ── Scope filters ─────────────────────────────────────────────────────────
  const nodeFilter = {};
  if (filters.nodeIds?.length)          nodeFilter.nodeId          = { $in: filters.nodeIds };
  if (filters.scopeIdentifiers?.length) nodeFilter.scopeIdentifier = { $in: filters.scopeIdentifiers };

  const results = {};

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN: data_entry
  //   sections: ['list', 'detail', 'stats', 'logs']
  // ══════════════════════════════════════════════════════════════════════════
  if (domain === 'data_entry') {
    const dataEntryFilter = {
      clientId,
      isDeleted: { $ne: true },
      ...dateFilter,
      ...nodeFilter,
    };

    const { docs, totalFound, wasTruncated } = await safeFindMany(
      DataEntry,
      dataEntryFilter,
      {
        nodeId: 1, scopeIdentifier: 1, inputType: 1,
        status: 1, processingStatus: 1, createdAt: 1,
      },
      { sort: { createdAt: -1 } },
      maxRecords
    );

    if (wasTruncated) exclusions.push(explainTruncation(totalFound, docs.length));
    if (docs.length === 0) exclusions.push(explainNoData('data_entry', dateRange));

    results.dataEntries = {
      records:    sections.includes('list') || sections.includes('detail') ? docs : [],
      totalCount: totalFound,
      stats:      sections.includes('stats') ? _computeEntryStats(docs) : null,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN: organization_flowchart
  //   sections: ['view', 'nodes', 'scopeDetails', 'assignments']
  //
  // Primary data: Flowchart document (node/edge structure, encrypted).
  // Secondary: DataEntry counts per node so DeepSeek can answer questions like
  // "which nodes have the most data?" or "show me nodes with missing entries".
  // ══════════════════════════════════════════════════════════════════════════
  if (domain === 'organization_flowchart') {
    // Fetch active flowchart — do NOT project sub-fields of encrypted 'nodes'/'edges'
    const flowchart = await Flowchart.findOne(
      { clientId, isActive: true, isDeleted: { $ne: true } }
    ).lean();

    if (!flowchart) {
      exclusions.push(explainNoData('organization_flowchart', dateRange));
    } else {
      results.flowchart = slimFlowchartNodes(flowchart);

      // DataEntry counts per node — gives DeepSeek data density context
      if (sections.includes('nodes') || sections.includes('scopeDetails') || sections.includes('view')) {
        const entryFilter = { clientId, isDeleted: { $ne: true }, ...nodeFilter };
        const { docs: entries, totalFound: eTotal, wasTruncated: eTrunc } = await safeFindMany(
          DataEntry,
          entryFilter,
          { nodeId: 1, scopeIdentifier: 1, status: 1, inputType: 1 },
          { sort: { createdAt: -1 } },
          maxRecords
        );
        if (eTrunc) exclusions.push(explainTruncation(eTotal, entries.length));

        // Group entry counts by nodeId for the AI
        const countByNode = {};
        const statusByNode = {};
        for (const e of entries) {
          const nid = String(e.nodeId || 'unknown');
          countByNode[nid]  = (countByNode[nid]  || 0) + 1;
          if (!statusByNode[nid]) statusByNode[nid] = {};
          const st = e.status || 'unknown';
          statusByNode[nid][st] = (statusByNode[nid][st] || 0) + 1;
        }
        results.dataEntryCounts = { byNode: countByNode, statusByNode, totalEntries: eTotal };
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN: process_flowchart
  //   sections: ['view', 'entries', 'processEmissionEntries']
  // ══════════════════════════════════════════════════════════════════════════
  if (domain === 'process_flowchart') {
    const processFilter = {
      clientId,
      isDeleted: { $ne: true },
      ...dateFilter,
    };
    if (filters.processNodeIds?.length) {
      processFilter.processNodeId = { $in: filters.processNodeIds };
    }

    const { docs: processDocs, totalFound: pTotal, wasTruncated: pTrunc } = await safeFindMany(
      ProcessEmissionDataEntry,
      processFilter,
      { processNodeId: 1, status: 1, createdAt: 1 },
      { sort: { createdAt: -1 } },
      maxRecords
    );

    if (pTrunc) exclusions.push(explainTruncation(pTotal, processDocs.length));
    if (pTotal === 0) exclusions.push(explainNoData('process_flowchart', dateRange));
    results.processEmissionEntries = { records: processDocs, totalCount: pTotal };
  }

  return {
    data:        results,
    exclusions,
    recordCount:
      (results.dataEntries?.totalCount          || 0) +
      (results.processEmissionEntries?.totalCount|| 0) +
      (results.flowchart?.totalNodes             || 0),
  };
}

function _computeEntryStats(docs) {
  const byInputType = {};
  const byStatus    = {};
  for (const d of docs) {
    byInputType[d.inputType || 'unknown'] = (byInputType[d.inputType || 'unknown'] || 0) + 1;
    byStatus[d.status || 'unknown']       = (byStatus[d.status || 'unknown']       || 0) + 1;
  }
  return { byInputType, byStatus, total: docs.length };
}

module.exports = { retrieve };
