'use strict';

const EsgFrameworkQuestion  = require('../models/FrameworkQuestion.model');
const QuestionMetricMapping = require('../models/QuestionMetricMapping.model');
const EsgBoundarySummary    = require('../../esgLink_core/summary/models/EsgBoundarySummary');

// Lazy-require to avoid circular dep issues at startup
const getEsgLinkBoundary = () => require('../../esgLink_core/boundary/models/EsgLinkBoundary');

// ── Private helpers ───────────────────────────────────────────────────────────

const _findActiveBoundaryDocId = async (clientId) => {
  const EsgLinkBoundary = getEsgLinkBoundary();
  const boundary = await EsgLinkBoundary.findOne(
    { clientId, isActive: true },
    { _id: 1 }
  ).lean();
  return boundary ? boundary._id : null;
};

// Group byMetric[] entries by metricId and aggregate their values + contributingNodes.
// The Core summary can produce multiple entries for the same metricId when a metric
// has entries across different data collection runs. We collapse them here so the
// prefill sees one aggregated group per metric.
const _groupByMetric = (byMetric = []) => {
  const map = new Map();

  for (const group of byMetric) {
    const key = String(group.metricId);
    if (!map.has(key)) {
      map.set(key, {
        metricId:          group.metricId,
        metricCode:        group.metricCode        || '',
        metricName:        group.metricName        || '',
        esgCategory:       group.esgCategory       || '',
        primaryUnit:       group.primaryUnit       || '',
        rollUpBehavior:    group.rollUpBehavior    || 'sum',
        combinedValue:     0,
        contributingNodes: [],
        entryCount:        0,
      });
    }

    const existing = map.get(key);

    // Prefer non-empty metadata from any entry
    if (!existing.metricCode  && group.metricCode)  existing.metricCode  = group.metricCode;
    if (!existing.metricName  && group.metricName)  existing.metricName  = group.metricName;
    if (!existing.primaryUnit && group.primaryUnit) existing.primaryUnit = group.primaryUnit;

    existing.combinedValue += (typeof group.combinedValue === 'number' ? group.combinedValue : 0);
    existing.entryCount    += (group.entryCount || 0);

    for (const node of (group.contributingNodes || [])) {
      const existingNode = existing.contributingNodes.find((n) => n.nodeId === node.nodeId);
      if (existingNode) {
        existingNode.value += (typeof node.value === 'number' ? node.value : 0);
      } else {
        existing.contributingNodes.push({
          nodeId:    node.nodeId,
          nodeLabel: node.nodeLabel || null,
          value:     typeof node.value === 'number' ? node.value : 0,
        });
      }
    }
  }

  return Array.from(map.values());
};

const _pickSummaryLayer = (summary) => {
  if ((summary.approvedSummary?.byMetric || []).length) {
    return { name: 'approvedSummary', data: summary.approvedSummary };
  }
  if ((summary.reviewerPendingSummary?.byMetric || []).length) {
    return { name: 'reviewerPendingSummary', data: summary.reviewerPendingSummary };
  }
  if ((summary.draftSummary?.byMetric || []).length) {
    return { name: 'draftSummary', data: summary.draftSummary };
  }
  return { name: 'approvedSummary', data: summary.approvedSummary || {} };
};

const _extractYear = (periodId) => {
  if (!periodId) return null;
  const match = String(periodId).match(/^(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
};

const _emptyResult = (questionCode, reason) => ({
  questionCode,
  answerSource:   'manual',
  autoFilled:     false,
  values:         {},
  sourceTrace:    reason ? [{ note: `answerMode is "${reason}" — prefill skipped` }] : [],
  autoFilledData: null,
});

const _noSummaryTrace = (mapping, boundaryDocId, periodType, periodKey) => ({
  metricId:      mapping.metricId,
  metricCode:    mapping.metricCode,
  value:         null,
  unit:          null,
  boundaryDocId,
  note:          `No EsgBoundarySummary found for this client/boundary — periodType: "${periodType}", periodKey: "${periodKey}"`,
});

// ── Summary lookup ────────────────────────────────────────────────────────────
// Priority:
//   1. periodType + periodKey  (new format — exact match)
//   2. periodYear              (old format — year-only docs)
//   3. no period filter        (last resort — returns latest)

const _findSummary = async (clientId, boundaryDocId, { periodType, periodKey, periodId }) => {
  const base = { clientId, boundaryDocId };

  // Option 1: explicit periodType + periodKey
  if (periodType && periodKey) {
    const doc = await EsgBoundarySummary.findOne({ ...base, periodType, periodKey }).lean();
    if (doc) return doc;
  }

  // Option 2: fall back to periodYear extracted from periodId (old-format docs have no periodKey)
  const periodYear = _extractYear(periodId || periodKey);
  if (periodYear) {
    const doc = await EsgBoundarySummary.findOne({ ...base, periodYear }).lean();
    if (doc) return doc;
  }

  // Option 3: newest summary for this client+boundary
  return EsgBoundarySummary.findOne(base).sort({ lastComputedAt: -1 }).lean();
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * prefillAnswerFromCore
 * Fetches Core metric summary values for a question's metric mappings.
 * READ-ONLY — does not write anything to the database.
 *
 * Period resolution (in priority order):
 *   1. periodType + periodKey  e.g. "financial_year" + "2025-04-01_2026-03-31"
 *   2. periodId                e.g. "2026" or "2024-25" → extracts year → matches old docs
 *
 * Node scope per mapping:
 *   - useAllNodes: true  → combinedValue (all nodes aggregated)
 *   - useAllNodes: false → sum only the nodeIds in boundaryNodeIds
 *
 * @param {object} params
 * @param {string}          params.clientId
 * @param {string}          [params.periodId]      e.g. "2026" or "2024-25" (old format)
 * @param {string}          [params.periodType]    e.g. "financial_year", "year", "month"
 * @param {string}          [params.periodKey]     e.g. "2025-04-01_2026-03-31", "2026", "2026-02"
 * @param {string|ObjectId} params.questionId
 * @param {string|ObjectId} [params.boundaryDocId] optional override (auto-resolved if omitted)
 * @returns {Promise<object>}
 */
const prefillAnswerFromCore = async ({
  clientId,
  periodId,
  periodType,
  periodKey,
  questionId,
  boundaryDocId,
}) => {
  const question = await EsgFrameworkQuestion.findById(questionId).lean();
  if (!question) return _emptyResult(null);

  if (question.answerMode === 'manual') {
    return _emptyResult(question.questionCode, 'manual');
  }

  // Load mappings: client-specific takes priority over framework template
  const projection = {
    metricId:          1,
    metricCode:        1,
    answerFieldKey:    1,
    aggregationMethod: 1,
    isPrimary:         1,
    useAllNodes:       1,
    boundaryNodeIds:   1,
    clientId:          1,
  };

  const [clientMappings, frameworkMappings] = await Promise.all([
    QuestionMetricMapping.find({ questionId, clientId, active: true }, projection).lean(),
    QuestionMetricMapping.find({ questionId, clientId: null, active: true }, projection).lean(),
  ]);

  const clientMetricIds  = new Set(clientMappings.map((m) => String(m.metricId)));
  const fallbackMappings = frameworkMappings.filter((m) => !clientMetricIds.has(String(m.metricId)));
  const mappings         = [...clientMappings, ...fallbackMappings];

  if (!mappings.length) return _emptyResult(question.questionCode);

  // Resolve boundary
  const resolvedBoundaryDocId = boundaryDocId || await _findActiveBoundaryDocId(clientId);
  if (!resolvedBoundaryDocId) {
    return {
      questionCode:   question.questionCode,
      answerSource:   'manual',
      autoFilled:     false,
      values:         {},
      sourceTrace:    [{ note: 'No active boundary found for this client' }],
      autoFilledData: null,
    };
  }

  // Resolve the correct summary document
  const summary = await _findSummary(clientId, resolvedBoundaryDocId, { periodType, periodKey, periodId });

  const values      = {};
  const sourceTrace = [];

  for (const mapping of mappings) {
    try {
      if (!summary) {
        sourceTrace.push(_noSummaryTrace(mapping, resolvedBoundaryDocId, periodType || 'unknown', periodKey || periodId || 'unknown'));
        continue;
      }

      const layer     = _pickSummaryLayer(summary);
      // Group duplicate metricId entries before searching
      const groupedByMetric = _groupByMetric(layer.data.byMetric);

      const metricGroup = groupedByMetric.find(
        (g) => String(g.metricId) === String(mapping.metricId)
      );

      if (!metricGroup) {
        sourceTrace.push({
          metricId:      mapping.metricId,
          metricCode:    mapping.metricCode,
          value:         null,
          unit:          null,
          boundaryDocId: resolvedBoundaryDocId,
          summaryLayer:  layer.name,
          periodType:    summary.periodType || null,
          periodKey:     summary.periodKey  || null,
          snapshotAt:    summary.lastComputedAt || null,
          note:          'Metric not found in summary — no approved data for this period',
        });
        continue;
      }

      // Node scope
      let value;
      let usedNodes;
      const allContributing = metricGroup.contributingNodes || [];

      if (mapping.useAllNodes !== false) {
        value     = metricGroup.combinedValue;
        usedNodes = allContributing.map((n) => ({
          nodeId:    n.nodeId,
          nodeLabel: n.nodeLabel || null,
          value:     n.value,
        }));
      } else if (mapping.boundaryNodeIds && mapping.boundaryNodeIds.length > 0) {
        const nodeSet  = new Set(mapping.boundaryNodeIds);
        const filtered = allContributing.filter((n) => nodeSet.has(n.nodeId));
        value     = filtered.reduce((sum, n) => sum + (typeof n.value === 'number' ? n.value : 0), 0);
        usedNodes = filtered.map((n) => ({
          nodeId:    n.nodeId,
          nodeLabel: n.nodeLabel || null,
          value:     n.value,
        }));
      } else {
        // useAllNodes=false but no nodeIds configured — fall back to combinedValue
        value     = metricGroup.combinedValue;
        usedNodes = allContributing.map((n) => ({
          nodeId:    n.nodeId,
          nodeLabel: n.nodeLabel || null,
          value:     n.value,
        }));
      }

      const unit     = metricGroup.primaryUnit || null;
      const fieldKey = mapping.answerFieldKey  || mapping.metricCode;

      if (value !== null && value !== undefined) {
        values[fieldKey] = { value, unit, metricCode: mapping.metricCode };
      }

      sourceTrace.push({
        metricId:          mapping.metricId,
        metricCode:        mapping.metricCode,
        metricName:        metricGroup.metricName || null,
        mappingId:         mapping._id,
        mappingScope:      mapping.clientId ? 'client' : 'framework',
        value,
        unit,
        boundaryDocId:     resolvedBoundaryDocId,
        summaryLayer:      layer.name,
        periodType:        summary.periodType || null,
        periodKey:         summary.periodKey  || null,
        snapshotAt:        summary.lastComputedAt || null,
        useAllNodes:       mapping.useAllNodes !== false,
        contributingNodes: usedNodes,
      });
    } catch (err) {
      console.error('[brsrPrefillService] error for metric', mapping.metricCode, err);
      sourceTrace.push({
        metricId:   mapping.metricId,
        metricCode: mapping.metricCode,
        value:      null,
        unit:       null,
        note:       'Error fetching summary data: ' + err.message,
      });
    }
  }

  const autoFilled     = sourceTrace.some((t) => t.value !== null && t.value !== undefined);
  const autoFilledData = autoFilled ? values : null;

  return {
    questionCode:          question.questionCode,
    answerSource:          autoFilled ? 'core_metric' : 'manual',
    autoFilled,
    values,
    sourceTrace,
    autoFilledData,
    resolvedBoundaryDocId,
    resolvedPeriod: {
      periodType: summary?.periodType || null,
      periodKey:  summary?.periodKey  || null,
      periodYear: summary?.periodYear || null,
    },
  };
};

module.exports = { prefillAnswerFromCore };
