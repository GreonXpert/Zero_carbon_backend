'use strict';

const mongoose           = require('mongoose');
const { Parser: FormulaParser } = require('expr-eval');
const EsgDataEntry       = require('../../data-collection/models/EsgDataEntry');
const EsgLinkBoundary    = require('../../boundary/models/EsgLinkBoundary');
const EsgBoundarySummary = require('../models/EsgBoundarySummary');
const EsgMetric          = require('../../metric/models/EsgMetric');
const { execute }        = require('../../rollup/utils/rollUpExecutor');
const esgSocket          = require('../utils/esgSummarySocket');
const Client             = require('../../../../client-management/client/Client');
const User               = require('../../../../../common/models/User');

// ─── Period resolution ────────────────────────────────────────────────────────

function parsePeriodLabelToDate(label) {
  if (!label) return null;
  const parts = label.split('-').map(Number);
  if (parts.length === 1) return new Date(parts[0], 0, 1);
  if (parts.length === 2) return new Date(parts[0], parts[1] - 1, 1);
  if (parts.length === 3) {
    // Detect DD-MM-YYYY (first part ≤ 31, third part is a 4-digit year)
    if (parts[2] > 31) return new Date(parts[2], parts[1] - 1, parts[0]);
    return new Date(parts[0], parts[1] - 1, parts[2]); // YYYY-MM-DD
  }
  return null;
}

// Normalise any common date string → YYYY-MM-DD (or YYYY-MM / YYYY for non-daily).
// Handles: DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD, YYYY-MM-DD, YYYY-MM, YYYY-Qn, YYYY
function normalisePeriodLabel(label) {
  if (!label) return label;

  // Slash-separated: DD/MM/YYYY or YYYY/MM/DD
  if (label.includes('/')) {
    const sp = label.split('/').map(Number);
    if (sp.length === 3 && !sp.some(isNaN)) {
      if (sp[2] > 31) return `${sp[2]}-${String(sp[1]).padStart(2, '0')}-${String(sp[0]).padStart(2, '0')}`;
      if (sp[0] > 31) return `${sp[0]}-${String(sp[1]).padStart(2, '0')}-${String(sp[2]).padStart(2, '0')}`;
    }
    return label;
  }

  // Dash-separated 3 parts: DD-MM-YYYY
  const parts = label.split('-');
  if (parts.length === 3) {
    const nums = parts.map(Number);
    if (!nums.some(isNaN) && nums[2] > 31) {
      return `${nums[2]}-${String(nums[1]).padStart(2, '0')}-${String(nums[0]).padStart(2, '0')}`;
    }
  }

  return label;
}

function resolvePeriod({ periodType, year, month, date, fyStart, fyEnd }) {
  if (!periodType || periodType === 'year') {
    const y = year || new Date().getFullYear();
    return {
      periodType:  'year',
      periodKey:   String(y),
      periodYear:  y,
      periodStart: new Date(y, 0, 1),
      periodEnd:   new Date(y, 11, 31),
      dbFilter:    { 'period.year': y },
    };
  }
  if (periodType === 'month') {
    const label = `${year}-${String(month).padStart(2, '0')}`;
    return {
      periodType:  'month',
      periodKey:   label,
      periodYear:  year,
      periodStart: new Date(year, month - 1, 1),
      periodEnd:   new Date(year, month, 0),
      dbFilter:    { 'period.periodLabel': label },
    };
  }
  if (periodType === 'day') {
    const [y, m, d] = date.split('-').map(Number);
    return {
      periodType:  'day',
      periodKey:   date,
      periodYear:  y,
      periodStart: new Date(y, m - 1, d),
      periodEnd:   new Date(y, m - 1, d),
      dbFilter:    { 'period.periodLabel': date },
    };
  }
  if (periodType === 'financial_year') {
    const startDate = new Date(fyStart);
    const endDate   = new Date(fyEnd);
    const years = [...new Set([startDate.getFullYear(), endDate.getFullYear()])];
    return {
      periodType:  'financial_year',
      periodKey:   `${fyStart}_${fyEnd}`,
      periodYear:  startDate.getFullYear(),
      periodStart: startDate,
      periodEnd:   endDate,
      dbFilter:    { 'period.year': { $in: years } },
      jsFilter: (entry) => {
        const d = parsePeriodLabelToDate(entry.period.periodLabel);
        return d && d >= startDate && d <= endDate;
      },
    };
  }
  throw new Error(`Unknown periodType: ${periodType}`);
}

// Derive periodDef from a saved EsgDataEntry's period sub-document
function resolvePeriodFromEntry(period) {
  const label = normalisePeriodLabel((period && period.periodLabel) || '');
  const year  = (period && period.year) || new Date().getFullYear();
  const parts = label.split('-');
  if (parts.length === 3) return resolvePeriod({ periodType: 'day', date: label });
  if (parts.length === 2) return resolvePeriod({ periodType: 'month', year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) });
  return resolvePeriod({ periodType: 'year', year });
}

// ─── Bucket classification ────────────────────────────────────────────────────

function classifyEntry(entry) {
  const s = entry.workflowStatus;
  if (s === 'approved')  return 'approved';
  if (s === 'draft')     return 'draft';
  if (s === 'submitted') return 'draft';
  if (s === 'under_review') {
    const hasDecisions = Array.isArray(entry.approvalDecisions) && entry.approvalDecisions.length > 0;
    return hasDecisions ? 'approverPending' : 'reviewerPending';
  }
  if (s === 'clarification_requested') return 'reviewerPending';
  if (s === 'resubmitted')             return 'reviewerPending';
  return null; // superseded / rejected — excluded
}

// ─── Resolve the numeric value for a single entry ────────────────────────────
// Priority 1: stored calculatedValue (formula already evaluated at submission time)
// Priority 2: re-evaluate formula from derivedFrom.expression + dataValues
//             (fixes API/IoT entries where formula ran before data was populated)
// Priority 3: dataValues.primaryValue (OCR / raw metrics with no formula)
// Priority 4: single numeric field in dataValues (simple direct-input metrics)
// Returns null when the value cannot be determined — entry is excluded from totals.

function resolveEntryValue(entry) {
  if (entry.calculatedValue != null && Number.isFinite(Number(entry.calculatedValue))) {
    return Number(entry.calculatedValue);
  }

  const dv         = entry.dataValues || {};
  const expression = entry.derivedFrom && entry.derivedFrom.expression;
  const storedVars = entry.derivedFrom && entry.derivedFrom.variableValues;

  if (expression && storedVars && Object.keys(storedVars).length > 0) {
    try {
      // Case-insensitive lookup so "emission" matches variable name "Emission"
      const dvLower = {};
      for (const [k, v] of Object.entries(dv)) {
        if (k !== 'timestamp') dvLower[k.toLowerCase()] = v;
      }
      const vars = {};
      let canEval = true;
      for (const varName of Object.keys(storedVars)) {
        const raw = dvLower[varName.toLowerCase()];
        if (raw != null && Number.isFinite(Number(raw))) {
          vars[varName] = Number(raw);
        } else {
          canEval = false;
          break;
        }
      }
      if (canEval) {
        const result = FormulaParser.evaluate(expression, vars);
        if (Number.isFinite(result)) return result;
      }
    } catch (_) { /* fall through */ }
  }

  // OCR / raw metric: use primaryValue
  if (dv.primaryValue != null && Number.isFinite(Number(dv.primaryValue))) {
    return Number(dv.primaryValue);
  }

  // Single numeric field (simple direct-input with one variable)
  const numericVals = Object.entries(dv)
    .filter(([k, v]) => k !== 'timestamp' && Number.isFinite(Number(v)))
    .map(([, v]) => Number(v));
  if (numericVals.length === 1) return numericVals[0];

  return null;
}

// ─── Build a single summary layer ────────────────────────────────────────────
// Each metric group collects ALL individual approved values across every node
// and time period. rollUpBehavior is then applied to the full set:
//   sum     → add every approved reading together
//   average → mean of every approved reading
//   min/max → minimum / maximum across every approved reading
// Per-node breakdown applies the same rollUpBehavior to just that node's values.

function buildLayer(entries, nodeMap) {
  const metricGroups = new Map();

  for (const entry of entries) {
    const value = resolveEntryValue(entry);
    if (value === null) continue; // exclude entries with unresolvable values

    const nodeMeta  = nodeMap.get(entry.nodeId) || {};
    const nodeLabel = (typeof nodeMeta === 'string' ? nodeMeta : nodeMeta.label) || entry.nodeId;

    const key = [
      (entry.metricId || '').toString(),
      entry.metricCode      || '',
      entry.metricName      || '',
      entry.esgCategory     || '',
      entry.subcategoryCode || '',
      entry.metricType      || '',
      entry.primaryUnit     || entry.unitOfMeasurement || '',
      entry.rollUpBehavior  || 'sum',
      entry.boundaryScope   || '',
    ].join('|');

    if (!metricGroups.has(key)) {
      metricGroups.set(key, {
        metricId:        entry.metricId,
        metricCode:      entry.metricCode      || '',
        metricName:      entry.metricName      || '',
        esgCategory:     entry.esgCategory     || '',
        subcategoryCode: entry.subcategoryCode || '',
        metricType:      entry.metricType      || '',
        primaryUnit:     entry.primaryUnit     || entry.unitOfMeasurement || '',
        rollUpBehavior:  entry.rollUpBehavior  || 'sum',
        boundaryScope:   entry.boundaryScope   || '',
        allValues: [],       // every individual value — rollUpBehavior applied here
        nodes:     new Map(), // nodeId → { nodeId, nodeLabel, values[] }
      });
    }

    const group = metricGroups.get(key);
    group.allValues.push(value);

    if (!group.nodes.has(entry.nodeId)) {
      group.nodes.set(entry.nodeId, { nodeId: entry.nodeId, nodeLabel, values: [] });
    }
    group.nodes.get(entry.nodeId).values.push({
      value,
      entryId:   entry._id,
      decidedAt: entry.updatedAt || entry.createdAt,
    });
  }

  const byMetric      = [];
  const byNodeMap     = new Map();
  const byCategoryMap = new Map();
  const byScopeMap    = new Map();

  for (const group of metricGroups.values()) {
    // Combined value: rollUpBehavior over ALL individual values
    const combined = execute(group.rollUpBehavior, group.allValues);

    // Per-node values: rollUpBehavior over that node's values
    const contributingNodes = Array.from(group.nodes.values()).map((n) => {
      const nodeVal  = execute(group.rollUpBehavior, n.values.map((v) => v.value));
      const latest   = n.values.reduce((a, b) => (b.decidedAt > a.decidedAt ? b : a));
      return {
        nodeId:    n.nodeId,
        nodeLabel: n.nodeLabel,
        value:     nodeVal,
        entryId:   latest.entryId,
        decidedAt: latest.decidedAt,
      };
    });

    byMetric.push({
      metricId:          group.metricId,
      metricCode:        group.metricCode,
      metricName:        group.metricName,
      esgCategory:       group.esgCategory,
      subcategoryCode:   group.subcategoryCode,
      metricType:        group.metricType,
      primaryUnit:       group.primaryUnit,
      rollUpBehavior:    group.rollUpBehavior,
      boundaryScope:     group.boundaryScope,
      combinedValue:     combined,
      contributingNodes,
      entryCount:        group.allValues.length,
    });

    if (group.esgCategory) {
      byCategoryMap.set(group.esgCategory, (byCategoryMap.get(group.esgCategory) || 0) + combined);
    }

    const scopeKey = group.boundaryScope || 'unspecified';
    if (!byScopeMap.has(scopeKey)) {
      byScopeMap.set(scopeKey, { total: 0, entryCount: 0, metrics: [] });
    }
    const sc = byScopeMap.get(scopeKey);
    sc.total      += combined;
    sc.entryCount += group.allValues.length;
    sc.metrics.push({
      metricId:        group.metricId,
      metricCode:      group.metricCode,
      metricName:      group.metricName,
      esgCategory:     group.esgCategory,
      subcategoryCode: group.subcategoryCode,
      combinedValue:   combined,
      primaryUnit:     group.primaryUnit,
    });

    for (const n of contributingNodes) {
      if (!byNodeMap.has(n.nodeId)) {
        byNodeMap.set(n.nodeId, { nodeId: n.nodeId, nodeLabel: n.nodeLabel, metrics: [] });
      }
      byNodeMap.get(n.nodeId).metrics.push({
        metricId:        group.metricId,
        metricCode:      group.metricCode,
        metricName:      group.metricName,
        esgCategory:     group.esgCategory,
        subcategoryCode: group.subcategoryCode,
        value:           n.value,
        unit:            group.primaryUnit,
        rollUpBehavior:  group.rollUpBehavior,
        boundaryScope:   group.boundaryScope,
        entryCount:      group.nodes.get(n.nodeId).values.length,
      });
    }
  }

  const byCategory = Array.from(byCategoryMap.entries()).map(([esgCategory, total]) => ({
    esgCategory,
    total,
    entryCount: byMetric
      .filter((m) => m.esgCategory === esgCategory)
      .reduce((a, m) => a + m.entryCount, 0),
  }));

  const byBoundaryScope = Array.from(byScopeMap.entries()).map(([boundaryScope, data]) => ({
    boundaryScope,
    total:      data.total,
    entryCount: data.entryCount,
    metrics:    data.metrics,
  }));

  const totals = {
    E: byCategoryMap.get('E') || 0,
    S: byCategoryMap.get('S') || 0,
    G: byCategoryMap.get('G') || 0,
  };

  // ── dataSourceBreakdown ───────────────────────────────────────────────────────
  const breakdown = { byInputType: {}, bySubmissionSource: {} };
  for (const e of entries) {
    const v = resolveEntryValue(e);
    if (v === null) continue;
    const it = e.inputType        || 'manual';
    const ss = e.submissionSource || 'contributor';
    if (!breakdown.byInputType[it])        breakdown.byInputType[it]        = { count: 0, combinedValue: 0 };
    if (!breakdown.bySubmissionSource[ss]) breakdown.bySubmissionSource[ss] = { count: 0, combinedValue: 0 };
    breakdown.byInputType[it].count++;
    breakdown.byInputType[it].combinedValue += v;
    breakdown.bySubmissionSource[ss].count++;
    breakdown.bySubmissionSource[ss].combinedValue += v;
  }

  // ── byLocation ────────────────────────────────────────────────────────────────
  const locationMap = new Map();
  const byNodeArr   = Array.from(byNodeMap.values());
  for (const nodeSummary of byNodeArr) {
    const meta = nodeMap.get(nodeSummary.nodeId) || {};
    const d    = (typeof meta === 'string' ? {} : (meta.details || {}));
    const hasStructured = d.country || d.state || d.city || d.siteName;
    const locKey   = hasStructured
      ? [d.country, d.state, d.city, d.siteName].filter(Boolean).join('|')
      : (d.locationLabel || d.location || 'Unspecified');
    const locLabel = d.locationLabel || d.location || locKey;

    if (!locationMap.has(locKey)) {
      locationMap.set(locKey, {
        locationKey:   locKey,
        locationLabel: locLabel,
        country:       d.country   || '',
        state:         d.state     || '',
        city:          d.city      || '',
        siteName:      d.siteName  || '',
        latitude:      d.latitude  || null,
        longitude:     d.longitude || null,
        nodeIds:       [],
        nodeCount:     0,
        combinedValue: 0,
        totals:        { E: 0, S: 0, G: 0 },
      });
    }
    const loc = locationMap.get(locKey);
    loc.nodeIds.push(nodeSummary.nodeId);
    loc.nodeCount++;
    for (const m of nodeSummary.metrics) {
      const v = m.value || 0;
      loc.combinedValue += v;
      if (m.esgCategory === 'E') loc.totals.E += v;
      if (m.esgCategory === 'S') loc.totals.S += v;
      if (m.esgCategory === 'G') loc.totals.G += v;
    }
  }
  const byLocation = [...locationMap.values()].sort((a, b) => b.combinedValue - a.combinedValue);

  return {
    byMetric,
    byNode:              byNodeArr,
    byCategory,
    byBoundaryScope,
    byLocation,
    totals,
    dataSourceBreakdown: breakdown,
  };
}

// ─── Enrich entries with boundary metricsDetails metadata ────────────────────

function enrichEntriesFromBoundary(entries, boundary) {
  const mappingMeta = new Map();
  for (const node of boundary.nodes || []) {
    for (const md of node.metricsDetails || []) {
      if (!md._id) continue;
      mappingMeta.set(md._id.toString(), {
        metricId:       md.metricId,
        metricCode:     md.metricCode,
        metricName:     md.metricName,
        metricType:     md.metricType,
        rollUpBehavior: md.rollUpBehavior || 'sum',
        boundaryScope:  md.boundaryScope  || '',
      });
    }
  }

  return entries.map((entry) => {
    const meta = mappingMeta.get(entry.mappingId) || {};
    return {
      ...entry,
      metricId:       meta.metricId       || entry.metricId,
      metricCode:     meta.metricCode     || entry.metricCode,
      metricName:     meta.metricName     || entry.metricName,
      metricType:     meta.metricType     || entry.metricType,
      rollUpBehavior: meta.rollUpBehavior || 'sum',
      boundaryScope:  meta.boundaryScope  !== undefined ? meta.boundaryScope : (entry.boundaryScope || ''),
    };
  });
}

// ─── Enrich entries with esgCategory + subcategoryCode from EsgMetric library ─

async function enrichEntriesFromMetricLibrary(entries) {
  const uniqueIds = [...new Set(
    entries.map((e) => e.metricId).filter(Boolean).map((id) => id.toString())
  )];
  if (uniqueIds.length === 0) return entries;

  const metrics = await EsgMetric.find(
    { _id: { $in: uniqueIds } },
    { esgCategory: 1, subcategoryCode: 1, primaryUnit: 1 }
  ).lean();

  const metricMeta = new Map(
    metrics.map((m) => [m._id.toString(), {
      esgCategory:     m.esgCategory     || '',
      subcategoryCode: m.subcategoryCode || '',
      primaryUnit:     m.primaryUnit     || '',
    }])
  );

  return entries.map((entry) => {
    const idStr = entry.metricId ? entry.metricId.toString() : '';
    const lib   = metricMeta.get(idStr) || {};
    return {
      ...entry,
      esgCategory:     lib.esgCategory     || entry.esgCategory     || '',
      subcategoryCode: lib.subcategoryCode || entry.subcategoryCode || '',
      primaryUnit:     lib.primaryUnit     || entry.primaryUnit     || entry.unitOfMeasurement || '',
    };
  });
}

// ─── Core: compute and save ───────────────────────────────────────────────────

async function computeAndSaveSummary(clientId, boundaryDocId, periodDef) {
  const start = Date.now();
  let _step = 'init';

  try {
    _step = 'findBoundary';
    const boundary = await EsgLinkBoundary.findOne({ _id: boundaryDocId, clientId, isDeleted: false });
    if (!boundary) return null;

    _step = 'buildNodeMap';
    const nodeMap = new Map();
    for (const node of boundary.nodes || []) {
      nodeMap.set(node.id, { label: node.label || node.id, type: node.type || '', details: node.details || {} });
    }

    _step = 'findEntries';
    const rawEntries = await EsgDataEntry.find({
      clientId,
      boundaryDocId,
      ...periodDef.dbFilter,
      isDeleted:      false,
      workflowStatus: { $nin: ['superseded', 'rejected'] },
    }).lean();

    // For financial_year: apply JS post-filter to scope entries to exact date range
    const filteredEntries = periodDef.jsFilter ? rawEntries.filter(periodDef.jsFilter) : rawEntries;

    _step = 'enrichFromBoundary';
    // Step 1: enrich from boundary metricsDetails (code, name, type, rollUpBehavior)
    const boundaryEnriched = enrichEntriesFromBoundary(filteredEntries, boundary);

    _step = 'enrichFromLibrary';
    // Step 2: enrich esgCategory + subcategoryCode from EsgMetric library
    const entries = await enrichEntriesFromMetricLibrary(boundaryEnriched);

    _step = 'classify';
    const buckets = { approved: [], reviewerPending: [], approverPending: [], draft: [] };
    for (const entry of entries) {
      const bucket = classifyEntry(entry);
      if (bucket) buckets[bucket].push(entry);
    }

    _step = 'buildLayers';
    const approvedSummary        = buildLayer(buckets.approved,        nodeMap);
    const reviewerPendingSummary = buildLayer(buckets.reviewerPending, nodeMap);
    const approverPendingSummary = buildLayer(buckets.approverPending, nodeMap);
    const draftSummary           = buildLayer(buckets.draft,           nodeMap);

    const filter = {
      clientId,
      boundaryDocId,
      periodType: periodDef.periodType,
      periodKey:  periodDef.periodKey,
    };

    const update = {
      $set: {
        periodYear:  periodDef.periodYear,
        periodStart: periodDef.periodStart,
        periodEnd:   periodDef.periodEnd,
        approvedSummary,
        reviewerPendingSummary,
        approverPendingSummary,
        draftSummary,
        lastComputedAt:        new Date(),
        computationDurationMs: Date.now() - start,
        totalEntries:          filteredEntries.length,
      },
    };

    _step = 'save';
    let doc;
    try {
      doc = await EsgBoundarySummary.findOneAndUpdate(filter, update, { upsert: true, new: true });
    } catch (saveErr) {
      if (saveErr.code === 11000) {
        // Two concurrent requests raced to upsert the same period — read the winner's doc back.
        doc = await EsgBoundarySummary.findOne(filter).lean();
        if (!doc) throw saveErr;
      } else {
        throw saveErr;
      }
    }

    // Real-time broadcast after save
    _step = 'broadcast';
    esgSocket.emitSummaryUpdated(
      clientId,
      boundaryDocId,
      periodDef.periodType,
      periodDef.periodKey,
      doc.approvedSummary?.totals,
      doc.totalEntries
    );

    return doc;
  } catch (err) {
    console.error(
      `[ESG Summary] computeAndSaveSummary failed at step "${_step}" ` +
      `(${periodDef.periodType}:${periodDef.periodKey}, client=${clientId}): ${err.message}`
    );
    console.error(err.stack || err);
    throw err;
  }
}

// ─── Financial year helper (April–March) ─────────────────────────────────────

function getFinancialYearForDate(d) {
  if (!d) return null;
  const month = d.getMonth() + 1; // 1–12
  const year  = d.getFullYear();
  const fyStartYear = month >= 4 ? year : year - 1;
  const fyEndYear   = fyStartYear + 1;
  const fyStart = `${fyStartYear}-04-01`;
  const fyEnd   = `${fyEndYear}-03-31`;
  return resolvePeriod({ periodType: 'financial_year', fyStart, fyEnd });
}

// Build all 4 periodDefs from an entry's period sub-document
function resolveAllPeriodsFromEntry(period) {
  const rawLabel = (period && period.periodLabel) || '';
  const label    = normalisePeriodLabel(rawLabel); // handle DD-MM-YYYY → YYYY-MM-DD
  const year     = (period && period.year) || new Date().getFullYear();
  const parts    = label.split('-');

  const periods = [];

  // 1. Always: yearly
  periods.push(resolvePeriod({ periodType: 'year', year }));

  // 2. Monthly (if periodLabel has at least year+month)
  if (parts.length >= 2) {
    periods.push(resolvePeriod({
      periodType: 'month',
      year:  parseInt(parts[0], 10),
      month: parseInt(parts[1], 10),
    }));
  }

  // 3. Daily (if periodLabel has year+month+day)
  if (parts.length === 3) {
    periods.push(resolvePeriod({ periodType: 'day', date: label }));
  }

  // 4. Financial year (April–March) for the representative date
  const representativeDate = parsePeriodLabelToDate(label) || new Date(year, 0, 1);
  const fyDef = getFinancialYearForDate(representativeDate);
  if (fyDef) periods.push(fyDef);

  return periods;
}

// ─── Fire-and-forget ─────────────────────────────────────────────────────────

function triggerSummaryRefresh(clientId, boundaryDocId, periodDef) {
  setImmediate(async () => {
    try {
      await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
    } catch (err) {
      console.error('[ESG Summary] refresh error:', err.message);
    }
  });
}

// Trigger all 4 period-type summaries in one fire-and-forget call
function triggerAllPeriodSummaryRefresh(clientId, boundaryDocId, period) {
  const allPeriods = resolveAllPeriodsFromEntry(period);
  setImmediate(async () => {
    for (const periodDef of allPeriods) {
      try {
        await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
      } catch (err) {
        console.error(`[ESG Summary] refresh error (${periodDef.periodType}:${periodDef.periodKey}):`, err.message);
      }
    }
  });
}

// ─── Cached read ─────────────────────────────────────────────────────────────

const SUMMARY_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getCachedSummary(clientId, boundaryDocId, periodDef, { forceRefresh = false } = {}) {
  if (forceRefresh) {
    try {
      return await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
    } catch (err) {
      console.error(`[ESG Summary] forceRefresh compute failed for ${periodDef.periodType}:${periodDef.periodKey}:`, err.message);
      return null;
    }
  }

  const doc = await EsgBoundarySummary.findOne({
    clientId,
    boundaryDocId,
    periodType: periodDef.periodType,
    periodKey:  periodDef.periodKey,
  }).lean();

  if (!doc) {
    try {
      return await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
    } catch (err) {
      // computeAndSaveSummary already logs the step-level error; return null so
      // callers get a 404 (no data) rather than an unhandled 500.
      return null;
    }
  }

  // Stale-while-revalidate: serve cached doc immediately, recompute in background
  if (Date.now() - new Date(doc.lastComputedAt).getTime() > SUMMARY_STALE_MS) {
    setImmediate(() => computeAndSaveSummary(clientId, boundaryDocId, periodDef).catch(() => {}));
  }
  return doc;
}

// ─── Role-scoped summary ─────────────────────────────────────────────────────

async function getSummaryForUser(user, clientId, boundaryDocId, periodDef, options = {}) {
  const { forceRefresh = false, allowedLayers = ['approved'] } = options;
  const summaryDoc = await getCachedSummary(clientId, boundaryDocId, periodDef, { forceRefresh });
  if (!summaryDoc) return null;

  const result = {
    clientId,
    boundaryDocId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    periodStart: periodDef.periodStart,
    periodEnd:   periodDef.periodEnd,
    lastComputedAt: summaryDoc.lastComputedAt,
    totalEntries:   summaryDoc.totalEntries,
  };

  if (allowedLayers.includes('approved'))         result.approvedSummary        = summaryDoc.approvedSummary;
  if (allowedLayers.includes('reviewer_pending')) result.reviewerPendingSummary = summaryDoc.reviewerPendingSummary;
  if (allowedLayers.includes('approver_pending')) result.approverPendingSummary = summaryDoc.approverPendingSummary;
  if (allowedLayers.includes('draft'))            result.draftSummary           = summaryDoc.draftSummary;

  return result;
}

// ─── Hierarchy summary ────────────────────────────────────────────────────────

async function getHierarchySummary(clientId, boundaryDocId, periodDef, options = {}) {
  const summaryDoc = await getCachedSummary(clientId, boundaryDocId, periodDef, options);
  if (!summaryDoc) return null;

  const boundary = await EsgLinkBoundary.findOne({ _id: boundaryDocId, clientId, isDeleted: false }).lean();
  if (!boundary) return null;

  const nodeMetaMap = new Map();
  for (const node of boundary.nodes || []) {
    nodeMetaMap.set(node.id, { id: node.id, label: node.label, type: node.type });
  }

  const approvedByNode = (summaryDoc.approvedSummary || {}).byNode || [];
  const hierarchy = approvedByNode.map((nodeSummary) => ({
    node:    nodeMetaMap.get(nodeSummary.nodeId) || { id: nodeSummary.nodeId },
    metrics: nodeSummary.metrics || [],
  }));

  return {
    clientId,
    boundaryDocId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    periodStart: periodDef.periodStart,
    periodEnd:   periodDef.periodEnd,
    lastComputedAt: summaryDoc.lastComputedAt,
    hierarchy,
    overallTotals:  (summaryDoc.approvedSummary || {}).totals || {},
  };
}

// ─── Dashboard summary ────────────────────────────────────────────────────────

async function getDashboardSummary(clientId, periodDef) {
  const boundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false }).select('_id').lean();

  const summaryDocs = await Promise.all(
    boundaries.map((b) => getCachedSummary(clientId, b._id, periodDef).catch(() => null))
  );

  const results = [];
  for (let i = 0; i < boundaries.length; i++) {
    const summaryDoc = summaryDocs[i];
    if (summaryDoc) {
      results.push({
        boundaryDocId:         boundaries[i]._id,
        approvedTotals:        (summaryDoc.approvedSummary        || {}).totals || {},
        reviewerPendingTotals: (summaryDoc.reviewerPendingSummary || {}).totals || {},
        approverPendingTotals: (summaryDoc.approverPendingSummary || {}).totals || {},
        lastComputedAt:        summaryDoc.lastComputedAt,
      });
    }
  }

  const combined = { E: 0, S: 0, G: 0 };
  for (const r of results) {
    for (const k of ['E', 'S', 'G']) combined[k] += (r.approvedTotals[k] || 0);
  }

  return {
    clientId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    periodStart: periodDef.periodStart,
    periodEnd:   periodDef.periodEnd,
    boundaries: results,
    combinedApprovedTotals: combined,
  };
}

// ─── Reviewer pending (own assignments) ──────────────────────────────────────

async function getReviewerPendingForReviewer(userId, clientId, periodDef) {
  const userIdStr  = userId.toString();
  const boundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false }).lean();
  const assignedMappingIds = new Set();

  for (const boundary of boundaries) {
    for (const node of boundary.nodes || []) {
      const nodeReviewerIds = (node.nodeReviewerIds || []).map((id) => id.toString());
      for (const md of node.metricsDetails || []) {
        const reviewers = md.inheritNodeReviewers
          ? nodeReviewerIds
          : (md.reviewers || []).map((id) => id.toString());
        if (reviewers.includes(userIdStr)) {
          assignedMappingIds.add(md._id ? md._id.toString() : '');
        }
      }
    }
  }

  const rawEntries = await EsgDataEntry.find({
    clientId,
    ...periodDef.dbFilter,
    workflowStatus: { $in: ['submitted', 'clarification_requested', 'resubmitted'] },
    isDeleted:      false,
    mappingId:      { $in: Array.from(assignedMappingIds) },
  }).lean();

  const pendingEntries = periodDef.jsFilter ? rawEntries.filter(periodDef.jsFilter) : rawEntries;

  return {
    clientId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    assignedPendingEntries: pendingEntries,
    count: pendingEntries.length,
  };
}

// ─── Approver pending (own assignments) ──────────────────────────────────────

async function getApproverPendingForApprover(userId, clientId, periodDef) {
  const userIdStr  = userId.toString();
  const boundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false }).lean();
  const assignedMappingIds = new Set();

  for (const boundary of boundaries) {
    for (const node of boundary.nodes || []) {
      const nodeApproverIds = (node.nodeApproverIds || []).map((id) => id.toString());
      for (const md of node.metricsDetails || []) {
        const approvers = md.inheritNodeApprovers
          ? nodeApproverIds
          : (md.approvers || []).map((id) => id.toString());
        if (approvers.includes(userIdStr)) {
          assignedMappingIds.add(md._id ? md._id.toString() : '');
        }
      }
    }
  }

  const rawEntries = await EsgDataEntry.find({
    clientId,
    ...periodDef.dbFilter,
    workflowStatus:                   'under_review',
    'approvalDecisions.approverId':   userId,
    'approvalDecisions.decision':     'pending',
    isDeleted:                        false,
    mappingId:                        { $in: Array.from(assignedMappingIds) },
  }).lean();

  const pendingEntries = periodDef.jsFilter ? rawEntries.filter(periodDef.jsFilter) : rawEntries;

  return {
    clientId,
    periodType:  periodDef.periodType,
    periodKey:   periodDef.periodKey,
    periodYear:  periodDef.periodYear,
    assignedPendingEntries: pendingEntries,
    count: pendingEntries.length,
  };
}

// ─── My-view (role-scoped) ────────────────────────────────────────────────────

async function getMyViewSummary(user, clientId, periodDef) {
  const userId = (user._id || user.id).toString();
  const role   = user.userType;

  if (role === 'reviewer')    return getReviewerPendingForReviewer(userId, clientId, periodDef);
  if (role === 'approver')    return getApproverPendingForApprover(userId, clientId, periodDef);
  if (role === 'contributor') {
    const rawEntries = await EsgDataEntry.find({
      clientId,
      ...periodDef.dbFilter,
      submittedBy: userId,
      isDeleted:   false,
    }).lean();
    const myEntries = periodDef.jsFilter ? rawEntries.filter(periodDef.jsFilter) : rawEntries;
    return {
      clientId,
      periodType: periodDef.periodType,
      periodKey:  periodDef.periodKey,
      periodYear: periodDef.periodYear,
      myEntries,
      count: myEntries.length,
    };
  }
  return getDashboardSummary(clientId, periodDef);
}

// ─── Available periods for a boundary ────────────────────────────────────────

async function getAvailablePeriods(clientId, boundaryDocId) {
  const docs = await EsgBoundarySummary.find(
    { clientId, boundaryDocId },
    { periodType: 1, periodKey: 1, periodYear: 1, periodStart: 1, periodEnd: 1, lastComputedAt: 1, totalEntries: 1 }
  ).sort({ periodType: 1, periodKey: 1 }).lean();

  return docs.map((d) => ({
    periodType:     d.periodType,
    periodKey:      d.periodKey,
    periodYear:     d.periodYear,
    periodStart:    d.periodStart,
    periodEnd:      d.periodEnd,
    lastComputedAt: d.lastComputedAt,
    totalEntries:   d.totalEntries,
  }));
}

// ─── Refresh all 4 period types for every period found in EsgDataEntry ───────

async function refreshAllBoundaryPeriods(clientId, boundaryDocId) {
  // Collect every unique (periodLabel, periodYear) pair that has data
  const combos = await EsgDataEntry.aggregate([
    {
      $match: {
        clientId,
        boundaryDocId,
        isDeleted:      false,
        workflowStatus: { $nin: ['superseded', 'rejected'] },
      },
    },
    {
      $group: {
        _id: {
          periodLabel: '$period.periodLabel',
          periodYear:  '$period.year',
        },
      },
    },
  ]);

  const results = [];
  const seen    = new Set(); // avoid duplicate periodDef keys

  for (const combo of combos) {
    const period  = { year: combo._id.periodYear, periodLabel: combo._id.periodLabel || '' };
    const allDefs = resolveAllPeriodsFromEntry(period);

    for (const periodDef of allDefs) {
      const dedupKey = `${periodDef.periodType}:${periodDef.periodKey}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      try {
        await computeAndSaveSummary(clientId, boundaryDocId, periodDef);
        results.push({ periodType: periodDef.periodType, periodKey: periodDef.periodKey, success: true });
      } catch (err) {
        results.push({ periodType: periodDef.periodType, periodKey: periodDef.periodKey, success: false, error: err.message });
      }
    }
  }

  return results;
}

// ─── Helper: resolve dbFilter for a period from query params ─────────────────

function _buildDbFilter(periodDef) {
  return periodDef ? periodDef.dbFilter : {};
}

// =============================================================================
// GROUP 2 — Period Comparison & Trends
// =============================================================================

/**
 * Merge all 4 workflow layers of an EsgBoundarySummary doc into one combined view.
 * Dashboard for consultant_admin shows all layers summed — compare must match this.
 * Each entry lives in exactly ONE layer at any time, so summing is correct.
 */
function _mergeLayers(doc) {
  const LAYER_KEYS = ['approvedSummary', 'approverPendingSummary', 'reviewerPendingSummary', 'draftSummary'];
  const totals    = { E: 0, S: 0, G: 0 };
  const metricMap = new Map();
  const nodeMap   = new Map();

  for (const key of LAYER_KEYS) {
    const layer = doc?.[key];
    if (!layer) continue;

    totals.E += layer.totals?.E || 0;
    totals.S += layer.totals?.S || 0;
    totals.G += layer.totals?.G || 0;

    for (const m of layer.byMetric || []) {
      if (!m.metricCode) continue;
      if (!metricMap.has(m.metricCode)) {
        metricMap.set(m.metricCode, {
          metricCode:      m.metricCode,
          metricName:      m.metricName,
          esgCategory:     m.esgCategory,
          subcategoryCode: m.subcategoryCode,
          primaryUnit:     m.primaryUnit,
          combinedValue:   0,
        });
      }
      metricMap.get(m.metricCode).combinedValue += m.combinedValue || 0;
    }

    for (const n of layer.byNode || []) {
      if (!n.nodeId) continue;
      if (!nodeMap.has(n.nodeId)) {
        nodeMap.set(n.nodeId, {
          nodeId:    n.nodeId,
          nodeLabel: n.nodeLabel || n.nodeId,
          metrics:   new Map(),
        });
      }
      const nodeEntry = nodeMap.get(n.nodeId);
      // prefer the label from the first layer that has it
      if (n.nodeLabel && nodeEntry.nodeLabel === nodeEntry.nodeId) {
        nodeEntry.nodeLabel = n.nodeLabel;
      }
      for (const m of n.metrics || []) {
        if (!m.metricCode) continue;
        if (!nodeEntry.metrics.has(m.metricCode)) {
          nodeEntry.metrics.set(m.metricCode, { ...m, value: 0 });
        }
        nodeEntry.metrics.get(m.metricCode).value += m.value || 0;
      }
    }
  }

  return {
    totals,
    byMetric: Array.from(metricMap.values()),
    byNode:   Array.from(nodeMap.values()).map((n) => ({
      nodeId:    n.nodeId,
      nodeLabel: n.nodeLabel,
      metrics:   Array.from(n.metrics.values()),
    })),
  };
}

/**
 * Compare two or more periods side-by-side for a client.
 * periodsArray: [{periodType, year, month, date, fyStart, fyEnd}, ...]
 */
async function comparePeriodsForClient(clientId, periodsArray, user, options = {}) {
  const { boundaryId: filterBoundaryId } = options;

  let allBoundaries = await EsgLinkBoundary.find({ clientId, isDeleted: { $ne: true } })
    .select('_id boundaryName')
    .lean();

  if (filterBoundaryId) {
    allBoundaries = allBoundaries.filter((b) => String(b._id) === String(filterBoundaryId));
  }

  const results = await Promise.all(
    periodsArray.map(async (params) => {
      const pDef = resolvePeriod(params);

      // Fetch all summaries for this period in one query
      const summaries = await EsgBoundarySummary.find({
        clientId,
        boundaryDocId: { $in: allBoundaries.map((b) => b._id) },
        periodType: pDef.periodType,
        periodKey:  pDef.periodKey,
      }).lean();

      const summaryByBoundary = new Map(summaries.map((s) => [String(s.boundaryDocId), s]));

      // Merge all 4 workflow layers per boundary (approved + pending + draft)
      // so compare shows same data as the dashboard for consultant_admin
      const mergedBySummary = new Map(
        summaries.map((s) => [String(s.boundaryDocId), _mergeLayers(s)])
      );

      // Build per-boundary list
      const boundaries = allBoundaries.map((b) => {
        const merged = mergedBySummary.get(String(b._id));
        return {
          boundaryDocId:  b._id,
          boundaryName:   b.boundaryName || String(b._id),
          approvedTotals: merged?.totals || { E: 0, S: 0, G: 0 },
          totalEntries:   summaryByBoundary.get(String(b._id))?.totalEntries || 0,
        };
      });

      // Combined E/S/G totals across all boundaries (all layers)
      const combinedTotals = boundaries.reduce(
        (acc, b) => {
          acc.E += b.approvedTotals.E || 0;
          acc.S += b.approvedTotals.S || 0;
          acc.G += b.approvedTotals.G || 0;
          return acc;
        },
        { E: 0, S: 0, G: 0 }
      );

      // Aggregate byMetric across all boundaries (all layers merged)
      const metricMap = new Map();
      for (const merged of mergedBySummary.values()) {
        for (const m of merged.byMetric || []) {
          if (!m.metricCode) continue;
          if (!metricMap.has(m.metricCode)) {
            metricMap.set(m.metricCode, { ...m, combinedValue: 0 });
          }
          metricMap.get(m.metricCode).combinedValue += m.combinedValue || 0;
        }
      }
      const byMetric = Array.from(metricMap.values());

      // Aggregate byNode across all boundaries (all layers merged) — per-node metric breakdown
      const nodeMap = new Map();
      for (const merged of mergedBySummary.values()) {
        for (const n of merged.byNode || []) {
          if (!n.nodeId) continue;
          if (!nodeMap.has(n.nodeId)) {
            nodeMap.set(n.nodeId, {
              nodeId:    n.nodeId,
              nodeLabel: n.nodeLabel || n.nodeId,
              totals:    { E: 0, S: 0, G: 0 },
              metricMap: new Map(),
            });
          }
          const node = nodeMap.get(n.nodeId);
          // prefer a human-readable label if we have one
          if (n.nodeLabel && n.nodeLabel !== n.nodeId) node.nodeLabel = n.nodeLabel;

          for (const m of n.metrics || []) {
            if (!m.metricCode) continue;
            if (!node.metricMap.has(m.metricCode)) {
              node.metricMap.set(m.metricCode, {
                metricCode:      m.metricCode,
                metricName:      m.metricName,
                esgCategory:     m.esgCategory,
                subcategoryCode: m.subcategoryCode,
                unit:            m.unit || '',
                value:           0,
              });
            }
            const entry = node.metricMap.get(m.metricCode);
            entry.value += m.value || 0;
            if (m.esgCategory) {
              node.totals[m.esgCategory] = (node.totals[m.esgCategory] || 0) + (m.value || 0);
            }
          }
        }
      }

      const byNode = Array.from(nodeMap.values()).map((n) => {
        const { metricMap: mm, ...rest } = n;
        return { ...rest, byMetric: Array.from(mm.values()) };
      });

      return {
        periodKey:      pDef.periodKey,
        periodType:     pDef.periodType,
        periodStart:    pDef.periodStart,
        combinedTotals,
        boundaries,
        byMetric,
        byNode,
      };
    })
  );

  return { periods: results };
}

/**
 * Time-series trend for a category or specific metric across recent periods.
 * category: 'E' | 'S' | 'G' | 'overall'
 * periodType: 'year' | 'month'
 * count: number of past periods to fetch (default 12)
 */
async function getTrendForClient(clientId, category = 'overall', periodType = 'year', count = 12) {
  // Only aggregate active boundaries — same as getDashboardSummary
  const activeBoundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false })
    .select('_id').lean();
  const activeBoundaryIds = activeBoundaries.map((b) => b._id);

  const summaries = await EsgBoundarySummary.find({
    clientId,
    boundaryDocId: { $in: activeBoundaryIds },
    periodType,
  })
    .sort({ periodStart: -1 })
    .limit(count * 5) // over-fetch across multiple boundaries
    .lean();

  // Aggregate by periodKey — include full E/S/G breakdown per period
  const byPeriod = {};
  for (const s of summaries) {
    const key = s.periodKey;
    if (!byPeriod[key]) {
      byPeriod[key] = {
        periodKey:     key,
        periodStart:   s.periodStart,
        value:         0,
        approvedTotals: { E: 0, S: 0, G: 0 },
      };
    }
    const totals = s.approvedSummary?.totals || {};
    byPeriod[key].approvedTotals.E += totals.E || 0;
    byPeriod[key].approvedTotals.S += totals.S || 0;
    byPeriod[key].approvedTotals.G += totals.G || 0;
    byPeriod[key].value += totals[category] || 0;
  }

  const series = Object.values(byPeriod)
    .sort((a, b) => new Date(a.periodStart) - new Date(b.periodStart))
    .slice(-count);

  return { category, periodType, series };
}

/**
 * List all periods that have saved summary data for a client (all boundaries combined).
 */
async function listAllClientPeriods(clientId) {
  const docs = await EsgBoundarySummary.find({ clientId })
    .select('periodType periodKey periodYear periodStart periodEnd lastComputedAt totalEntries')
    .lean();

  const seen = new Map();
  for (const d of docs) {
    const key = `${d.periodType}:${d.periodKey}`;
    if (!seen.has(key)) {
      seen.set(key, {
        periodType: d.periodType,
        periodKey: d.periodKey,
        periodYear: d.periodYear,
        periodStart: d.periodStart,
        periodEnd: d.periodEnd,
        lastComputedAt: d.lastComputedAt,
      });
    }
  }

  return Array.from(seen.values()).sort((a, b) => new Date(b.periodStart) - new Date(a.periodStart));
}

// =============================================================================
// GROUP 3 — Category Deep-Dive & Top/Bottom
// =============================================================================

/**
 * E/S/G category breakdown with subcategory drill-down for a client & period.
 */
function _mergeSummaryMetrics(categories, summariesList, nodes) {
  for (const s of summariesList) {
    const layer = s.approvedSummary || {};
    for (const metric of layer.byMetric || []) {
      const cat    = metric.esgCategory;
      const subcat = metric.subcategoryCode || 'OTHER';
      if (!categories[cat]) continue;
      if (!categories[cat][subcat]) {
        categories[cat][subcat] = { subcategoryCode: subcat, total: 0, entryCount: 0, metrics: [] };
      }
      categories[cat][subcat].total      += metric.combinedValue || 0;
      categories[cat][subcat].entryCount += metric.entryCount   || 0;
      // Merge into existing metric entry to avoid duplicates across daily docs
      const existing = categories[cat][subcat].metrics.find((m) => m.metricCode === metric.metricCode);
      if (existing) {
        existing.combinedValue = (existing.combinedValue || 0) + (metric.combinedValue || 0);
        existing.entryCount    = (existing.entryCount    || 0) + (metric.entryCount    || 0);
      } else {
        categories[cat][subcat].metrics.push({
          metricId:      metric.metricId,
          metricCode:    metric.metricCode,
          metricName:    metric.metricName,
          combinedValue: metric.combinedValue,
          primaryUnit:   metric.primaryUnit,
          entryCount:    metric.entryCount,
        });
      }

      // Merge per-node contributions for the Facility view
      if (nodes && nodes[cat]) {
        for (const n of metric.contributingNodes || []) {
          if (!n.nodeId) continue;
          if (!nodes[cat][n.nodeId]) {
            nodes[cat][n.nodeId] = { nodeId: n.nodeId, nodeLabel: n.nodeLabel, total: 0, metrics: new Map() };
          }
          const nodeEntry = nodes[cat][n.nodeId];
          nodeEntry.nodeLabel = nodeEntry.nodeLabel || n.nodeLabel;
          nodeEntry.total += n.value || 0;

          const mKey = metric.metricCode;
          if (!nodeEntry.metrics.has(mKey)) {
            nodeEntry.metrics.set(mKey, {
              metricId:    metric.metricId,
              metricCode:  metric.metricCode,
              metricName:  metric.metricName,
              primaryUnit: metric.primaryUnit,
              value:       0,
            });
          }
          nodeEntry.metrics.get(mKey).value += n.value || 0;
        }
      }
    }
  }
}

async function getCategoryBreakdown(clientId, periodDef) {
  let summaries = await EsgBoundarySummary.find({
    clientId,
    periodType: periodDef.periodType,
    periodKey:  periodDef.periodKey,
  }).lean();

  const categories = { E: {}, S: {}, G: {} };
  const nodes      = { E: {}, S: {}, G: {} };
  _mergeSummaryMetrics(categories, summaries, nodes);

  let isEmpty = Object.values(categories).every((cat) => Object.keys(cat).length === 0);

  // For a single-day request with a stale/empty boundary summary (byMetric not
  // yet computed for this day), recompute on demand from raw entries and retry.
  if (isEmpty && periodDef.periodType === 'day') {
    const activeBoundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false })
      .select('_id').lean();
    for (const b of activeBoundaries) {
      try {
        await computeAndSaveSummary(clientId, b._id, periodDef);
      } catch (err) {
        // Log and continue — fall back to whatever summaries already exist
        // rather than failing the whole request.
        console.error(`computeAndSaveSummary failed for boundary ${b._id}:`, err.message);
      }
    }
    summaries = await EsgBoundarySummary.find({
      clientId,
      periodType: periodDef.periodType,
      periodKey:  periodDef.periodKey,
    }).lean();
    _mergeSummaryMetrics(categories, summaries, nodes);
    isEmpty = Object.values(categories).every((cat) => Object.keys(cat).length === 0);
  }

  // If monthly period returned no approved data, aggregate from daily boundary summaries.
  // This handles the case where the summary doc was computed before entries were approved.
  if (isEmpty && periodDef.periodType === 'month') {
    const activeBoundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false })
      .select('_id').lean();
    const activeBoundaryIds = activeBoundaries.map((b) => b._id);
    const dailySummaries = await EsgBoundarySummary.find({
      clientId,
      boundaryDocId: { $in: activeBoundaryIds },
      periodType: 'day',
      periodKey:  { $regex: `^${periodDef.periodKey}-` },
    }).lean();
    _mergeSummaryMetrics(categories, dailySummaries, nodes);
  }

  const format = (catMap) => Object.values(catMap).sort((a, b) => b.total - a.total);
  const formatNodes = (nodeMap) => Object.values(nodeMap)
    .map((n) => ({
      nodeId:    n.nodeId,
      nodeLabel: n.nodeLabel,
      total:     n.total,
      metrics:   Array.from(n.metrics.values()),
    }))
    .sort((a, b) => b.total - a.total);

  return {
    E: { subcategories: format(categories.E), byNode: formatNodes(nodes.E) },
    S: { subcategories: format(categories.S), byNode: formatNodes(nodes.S) },
    G: { subcategories: format(categories.G), byNode: formatNodes(nodes.G) },
  };
}

/**
 * Top N metrics by approved value, bottom N by completeness.
 */
async function getTopBottomMetrics(clientId, periodDef, n = 5) {
  // Only aggregate active boundaries — same as getDashboardSummary — to avoid
  // stale/deleted boundary summaries inflating values (e.g. showing 5343 instead of 10)
  const activeBoundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false })
    .select('_id').lean();
  const activeBoundaryIds = activeBoundaries.map((b) => b._id);

  const summaries = await EsgBoundarySummary.find({
    clientId,
    boundaryDocId: { $in: activeBoundaryIds },
    periodType: periodDef.periodType,
    periodKey:  periodDef.periodKey,
  }).lean();

  const metricMap = {};
  for (const s of summaries) {
    for (const metric of s.approvedSummary?.byMetric || []) {
      const id = metric.metricCode || metric.metricId?.toString();
      if (!metricMap[id]) {
        metricMap[id] = { ...metric, combinedValue: 0, entryCount: 0 };
      }
      metricMap[id].combinedValue += metric.combinedValue || 0;
      metricMap[id].entryCount    += metric.entryCount    || 0;
    }
  }

  const all = Object.values(metricMap);
  const topByValue = [...all].sort((a, b) => b.combinedValue - a.combinedValue).slice(0, n).map((m) => ({
    metricCode: m.metricCode, metricName: m.metricName, esgCategory: m.esgCategory,
    subcategoryCode: m.subcategoryCode, combinedValue: m.combinedValue, primaryUnit: m.primaryUnit,
  }));

  const bottomByValue = [...all].sort((a, b) => a.combinedValue - b.combinedValue).slice(0, n).map((m) => ({
    metricCode: m.metricCode, metricName: m.metricName, esgCategory: m.esgCategory,
    subcategoryCode: m.subcategoryCode, combinedValue: m.combinedValue, primaryUnit: m.primaryUnit,
  }));

  return { topByValue, bottomByValue };
}

// =============================================================================
// GROUP 4 — Coverage & Data Quality
// =============================================================================

/**
 * Metric coverage: how many assigned mappings have data vs are missing.
 */
async function getMetricCoverage(clientId, periodDef) {
  const boundaries = await EsgLinkBoundary.find({ clientId, isDeleted: { $ne: true } }).lean();

  const dbFilter = periodDef ? periodDef.dbFilter : {};

  // Collect all mappingIds (MetricDetailSchema._id) assigned
  const allMappingIds = [];
  const mappingMeta   = {};
  for (const b of boundaries) {
    for (const node of b.nodes || []) {
      for (const md of node.metricsDetails || []) {
        const id = md._id.toString();
        allMappingIds.push(id);
        mappingMeta[id] = {
          metricCode: md.metricCode,
          metricName: md.metricName,
          esgCategory: null, // enriched below from EsgMetric if needed
          nodeId: node.id,
          nodeLabel: node.label,
          boundaryDocId: b._id,
        };
      }
    }
  }

  // Get all entries for this period
  const entries = await EsgDataEntry.find({
    clientId,
    isDeleted: { $ne: true },
    ...dbFilter,
  }).select('mappingId workflowStatus').lean();

  const hasDraftSet    = new Set();
  const hasApprovedSet = new Set();
  for (const e of entries) {
    const mid = e.mappingId?.toString();
    if (!mid) continue;
    if (e.workflowStatus === 'approved') hasApprovedSet.add(mid);
    else hasDraftSet.add(mid);
  }

  // Enrich with esgCategory from metric library
  const metricIds = [...new Set(
    boundaries.flatMap((b) =>
      (b.nodes || []).flatMap((n) =>
        (n.metricsDetails || []).map((md) => md.metricId?.toString()).filter(Boolean)
      )
    )
  )];
  const metrics = await EsgMetric.find({ _id: { $in: metricIds } }).select('_id esgCategory subcategoryCode').lean();
  const metricCatMap = {};
  for (const m of metrics) metricCatMap[m._id.toString()] = { esgCategory: m.esgCategory, subcategoryCode: m.subcategoryCode };

  // Enrich mappingMeta
  for (const b of boundaries) {
    for (const node of b.nodes || []) {
      for (const md of node.metricsDetails || []) {
        const id  = md._id.toString();
        const cat = metricCatMap[md.metricId?.toString()];
        if (cat && mappingMeta[id]) {
          mappingMeta[id].esgCategory     = cat.esgCategory;
          mappingMeta[id].subcategoryCode = cat.subcategoryCode;
        }
      }
    }
  }

  const byCategory = { E: { assigned: 0, submitted: 0, approved: 0, missing: 0 },
                       S: { assigned: 0, submitted: 0, approved: 0, missing: 0 },
                       G: { assigned: 0, submitted: 0, approved: 0, missing: 0 } };
  let assigned = 0, submitted = 0, approved = 0, missing = 0;

  for (const id of allMappingIds) {
    const cat = mappingMeta[id]?.esgCategory;
    assigned++;
    if (hasApprovedSet.has(id)) {
      approved++;
      if (cat && byCategory[cat]) byCategory[cat].approved++;
    } else if (hasDraftSet.has(id)) {
      submitted++;
      if (cat && byCategory[cat]) byCategory[cat].submitted++;
    } else {
      missing++;
      if (cat && byCategory[cat]) byCategory[cat].missing++;
    }
    if (cat && byCategory[cat]) byCategory[cat].assigned++;
  }

  const completionPct = assigned > 0 ? Math.round((approved / assigned) * 100) : 0;
  for (const cat of Object.keys(byCategory)) {
    const c = byCategory[cat];
    c.completionPct = c.assigned > 0 ? Math.round((c.approved / c.assigned) * 100) : 0;
  }

  return { overall: { assigned, submitted, approved, missing, completionPct }, byCategory };
}

/**
 * Data quality statistics: OCR confidence, validation pass rate, source breakdown.
 */
async function getDataQualityStats(clientId, periodDef) {
  const dbFilter = periodDef ? periodDef.dbFilter : {};
  const entries = await EsgDataEntry.find({
    clientId, isDeleted: { $ne: true }, ...dbFilter,
  }).select('ocrConfidence validationResult evidence inputType submissionSource').lean();

  if (!entries.length) return { total: 0, ocrConfidenceAvg: null, validationPassRate: null, evidenceAttachmentRate: null, byInputType: {}, bySubmissionSource: {} };

  let ocrSum = 0, ocrCount = 0, validPass = 0, validTotal = 0, evidenceCount = 0;
  const byInputType = {};
  const bySubmissionSource = {};

  for (const e of entries) {
    if (e.ocrConfidence != null) { ocrSum += e.ocrConfidence; ocrCount++; }
    if (e.validationResult?.passed != null) { validTotal++; if (e.validationResult.passed) validPass++; }
    if ((e.evidence || []).length > 0) evidenceCount++;

    const it = e.inputType || 'manual';
    byInputType[it] = (byInputType[it] || 0) + 1;

    const ss = e.submissionSource || 'contributor';
    bySubmissionSource[ss] = (bySubmissionSource[ss] || 0) + 1;
  }

  return {
    total: entries.length,
    ocrConfidenceAvg: ocrCount > 0 ? Math.round((ocrSum / ocrCount) * 100) / 100 : null,
    validationPassRate: validTotal > 0 ? Math.round((validPass / validTotal) * 100) : null,
    evidenceAttachmentRate: Math.round((evidenceCount / entries.length) * 100),
    byInputType,
    bySubmissionSource,
  };
}

/**
 * Metrics with zero entries for the period (missing data gaps).
 */
async function getMissingMetrics(clientId, periodDef) {
  const boundaries = await EsgLinkBoundary.find({ clientId, isDeleted: { $ne: true } }).lean();
  const dbFilter   = periodDef ? periodDef.dbFilter : {};

  const existingEntries = await EsgDataEntry.find({
    clientId, isDeleted: { $ne: true }, ...dbFilter,
    workflowStatus: { $nin: ['rejected', 'superseded'] },
  }).select('mappingId').lean();

  const existingSet = new Set(existingEntries.map((e) => e.mappingId?.toString()).filter(Boolean));

  // Enrich with category info
  const metricIds = [...new Set(
    boundaries.flatMap((b) =>
      (b.nodes || []).flatMap((n) => (n.metricsDetails || []).map((md) => md.metricId?.toString()).filter(Boolean))
    )
  )];
  const metrics = await EsgMetric.find({ _id: { $in: metricIds } }).select('_id esgCategory subcategoryCode metricCode metricName').lean();
  const metricMap = {};
  for (const m of metrics) metricMap[m._id.toString()] = m;

  const missing = [];
  for (const b of boundaries) {
    for (const node of b.nodes || []) {
      for (const md of node.metricsDetails || []) {
        const mid = md._id.toString();
        if (!existingSet.has(mid)) {
          const meta = metricMap[md.metricId?.toString()] || {};
          missing.push({
            mappingId: mid,
            metricCode: md.metricCode || meta.metricCode,
            metricName: md.metricName || meta.metricName,
            esgCategory: meta.esgCategory,
            subcategoryCode: meta.subcategoryCode,
            nodeId: node.id,
            nodeLabel: node.label,
            boundaryDocId: b._id,
          });
        }
      }
    }
  }

  return { missing, count: missing.length };
}

// =============================================================================
// GROUP 5 — Workflow Analytics
// =============================================================================

/**
 * Count of entries per workflow status for a client & period.
 */
async function getWorkflowStatusCounts(clientId, periodDef) {
  const dbFilter = periodDef ? periodDef.dbFilter : {};
  const agg = await EsgDataEntry.aggregate([
    { $match: { clientId, isDeleted: { $ne: true }, ...dbFilter } },
    { $group: { _id: '$workflowStatus', count: { $sum: 1 } } },
  ]);

  const result = { draft: 0, submitted: 0, under_review: 0, clarification_requested: 0, resubmitted: 0, approved: 0, rejected: 0, total: 0 };
  for (const row of agg) {
    const status = row._id;
    if (status && Object.prototype.hasOwnProperty.call(result, status)) result[status] = row.count;
    result.total += row.count;
  }
  return result;
}

/**
 * Workflow aging: how long entries have been waiting in each non-approved stage.
 */
async function getWorkflowAging(clientId, periodDef) {
  const dbFilter = periodDef ? periodDef.dbFilter : {};
  const entries  = await EsgDataEntry.find({
    clientId, isDeleted: { $ne: true }, ...dbFilter,
    workflowStatus: { $nin: ['approved', 'rejected', 'superseded'] },
  }).select('workflowStatus submittedAt updatedAt').lean();

  const now    = Date.now();
  const groups = {};

  for (const e of entries) {
    const status   = e.workflowStatus;
    const refDate  = e.submittedAt || e.updatedAt;
    const ageDays  = refDate ? Math.floor((now - new Date(refDate).getTime()) / 86400000) : 0;

    if (!groups[status]) groups[status] = { count: 0, totalDays: 0, maxDays: 0, over7: 0, over14: 0 };
    groups[status].count++;
    groups[status].totalDays += ageDays;
    if (ageDays > groups[status].maxDays) groups[status].maxDays = ageDays;
    if (ageDays > 7)  groups[status].over7++;
    if (ageDays > 14) groups[status].over14++;
  }

  const byStatus = {};
  for (const [status, g] of Object.entries(groups)) {
    byStatus[status] = {
      count: g.count,
      avgAgeDays: g.count > 0 ? Math.round(g.totalDays / g.count) : 0,
      maxAgeDays: g.maxDays,
      stuckOver7Days: g.over7,
      stuckOver14Days: g.over14,
    };
  }

  return { byStatus };
}

// =============================================================================
// GROUP 6 — Reviewer Dashboard
// =============================================================================

/**
 * Reviewer's full entry queue with details and daysWaiting.
 */
async function getReviewerQueue(userId, clientId, periodDef) {
  let rawEntries;

  if (!userId) {
    // Full-access / admin view — return ALL pending-review entries for this client
    const raw = await EsgDataEntry.find({
      clientId,
      ...periodDef.dbFilter,
      workflowStatus: { $in: ['submitted', 'clarification_requested', 'resubmitted'] },
      isDeleted: false,
    }).lean();
    rawEntries = periodDef.jsFilter ? raw.filter(periodDef.jsFilter) : raw;
  } else {
    const { assignedPendingEntries } = await getReviewerPendingForReviewer(userId, clientId, periodDef);
    rawEntries = assignedPendingEntries;
  }

  const now = Date.now();
  return rawEntries.map((e) => ({
    entryId:         e._id,
    metricCode:      e.metricCode,
    metricName:      e.metricName,
    esgCategory:     e.esgCategory,
    nodeId:          e.nodeId,
    nodeLabel:       e.nodeLabel,
    workflowStatus:  e.workflowStatus,
    submittedAt:     e.submittedAt,
    daysWaiting:     e.submittedAt ? Math.floor((now - new Date(e.submittedAt).getTime()) / 86400000) : 0,
    submittedBy:     e.submittedBy,
    periodLabel:     e.period?.periodLabel,
  }));
}

/**
 * Reviewer stats: historical performance metrics.
 */
async function getAssignedMetricsByCategory(userId, clientId, role) {
  const userIdStr = userId ? userId.toString() : null;
  const boundaries = await EsgLinkBoundary.find({ clientId, isActive: true, isDeleted: false }).lean();
  const assignedMetricIds = new Set();

  for (const b of boundaries) {
    for (const node of b.nodes || []) {
      for (const mapping of node.metricsDetails || []) {
        let isAssigned = false;
        if (role === 'reviewer') {
          isAssigned = (mapping.reviewers || []).some((id) => String(id) === userIdStr) ||
            (mapping.inheritNodeReviewers && (node.nodeReviewerIds || []).some((id) => String(id) === userIdStr));
        } else if (role === 'approver') {
          isAssigned = (mapping.approvers || []).some((id) => String(id) === userIdStr) ||
            (mapping.inheritNodeApprovers && (node.nodeApproverIds || []).some((id) => String(id) === userIdStr));
        }
        if (!userIdStr) isAssigned = true; // admin full-access: count all
        if (isAssigned && mapping.metricId) {
          assignedMetricIds.add(mapping.metricId.toString());
        }
      }
    }
  }

  const byCategory = { E: 0, S: 0, G: 0 };
  if (assignedMetricIds.size === 0) return byCategory;

  const metrics = await EsgMetric.find({ _id: { $in: [...assignedMetricIds] } }).select('_id esgCategory').lean();
  for (const m of metrics) {
    const cat = m.esgCategory;
    if (cat && Object.prototype.hasOwnProperty.call(byCategory, cat)) byCategory[cat]++;
  }
  return byCategory;
}

async function getReviewerStats(userId, clientId) {
  const entries = await EsgDataEntry.find({
    clientId,
    workflowStatus: { $in: ['under_review', 'approved', 'rejected', 'clarification_requested'] },
    isDeleted: { $ne: true },
  }).select('workflowStatus submittedAt updatedAt reviewerIds').lean();

  // When userId is null (admin full-access), aggregate stats across ALL entries
  const userIdStr = userId ? userId.toString() : null;
  let totalReviewed = 0, totalDays = 0, clarifications = 0, forwarded = 0;
  const last30Cutoff = new Date(Date.now() - 30 * 86400000);
  let last30 = 0;

  for (const e of entries) {
    if (userIdStr) {
      const wasHandledByThisReviewer =
        (e.reviewerIds || []).some((id) => id?.toString() === userIdStr) ||
        e.workflowStatus === 'under_review' ||
        e.workflowStatus === 'clarification_requested';
      if (!wasHandledByThisReviewer) continue;
    }
    totalReviewed++;
    const refDate = e.updatedAt || e.submittedAt;
    if (refDate && e.submittedAt) {
      totalDays += Math.floor((new Date(refDate) - new Date(e.submittedAt)) / 86400000);
    }
    if (e.workflowStatus === 'clarification_requested') clarifications++;
    if (e.workflowStatus === 'under_review') forwarded++;
    if (refDate && new Date(refDate) >= last30Cutoff) last30++;
  }

  const byCategory = await getAssignedMetricsByCategory(userId, clientId, 'reviewer');

  return {
    totalReviewed,
    avgReviewDays: totalReviewed > 0 ? Math.round(totalDays / totalReviewed) : 0,
    clarificationRate: totalReviewed > 0 ? Math.round((clarifications / totalReviewed) * 100) : 0,
    forwardedToApprovalRate: totalReviewed > 0 ? Math.round((forwarded / totalReviewed) * 100) : 0,
    last30Days: last30,
    byCategory,
  };
}

/**
 * Reviewer aging queue with urgency flags.
 */
async function getReviewerAgingQueue(userId, clientId, periodDef) {
  const queue = await getReviewerQueue(userId, clientId, periodDef);
  return queue.map((e) => ({
    ...e,
    urgencyLevel: e.daysWaiting >= 14 ? 'high' : e.daysWaiting >= 7 ? 'medium' : 'low',
  }));
}

// =============================================================================
// GROUP 7 — Approver Dashboard
// =============================================================================

/**
 * Approver's queue with quorum progress details.
 */
async function getApproverQueue(userId, clientId, periodDef) {
  let rawEntries;

  if (!userId) {
    // Full-access / admin view — return ALL under-review entries for this client
    const raw = await EsgDataEntry.find({
      clientId,
      ...periodDef.dbFilter,
      workflowStatus: 'under_review',
      isDeleted: false,
    }).lean();
    rawEntries = periodDef.jsFilter ? raw.filter(periodDef.jsFilter) : raw;
  } else {
    const { assignedPendingEntries } = await getApproverPendingForApprover(userId, clientId, periodDef);
    rawEntries = assignedPendingEntries;
  }

  const now = Date.now();
  return rawEntries.map((e) => {
    const decisions    = e.approvalDecisions || [];
    const approvedCnt  = decisions.filter((d) => d.decision === 'approved').length;
    const rejectedCnt  = decisions.filter((d) => d.decision === 'rejected').length;
    const totalApprovers = decisions.length || 1;
    const reviewerNotes = decisions.filter((d) => d.note).map((d) => d.note);

    const sentToApprovalAt = decisions[0]?.decidedAt || e.submittedAt;
    const daysInApprovalStage = sentToApprovalAt
      ? Math.floor((now - new Date(sentToApprovalAt).getTime()) / 86400000)
      : 0;

    return {
      entryId:             e._id,
      metricCode:          e.metricCode,
      metricName:          e.metricName,
      esgCategory:         e.esgCategory,
      nodeId:              e.nodeId,
      nodeLabel:           e.nodeLabel,
      workflowStatus:      e.workflowStatus,
      reviewerNotes,
      quorumProgress:      { approvedCount: approvedCnt, rejectedCount: rejectedCnt, totalApprovers },
      daysInApprovalStage,
      periodLabel:         e.period?.periodLabel,
    };
  });
}

/**
 * Approver stats: decision history summary.
 */
async function getApproverStats(userId, clientId) {
  const userIdStr = userId ? userId.toString() : null;

  // When userId is null (admin full-access), query all entries with any approval decision
  const query = { clientId, isDeleted: { $ne: true } };
  if (userIdStr) query['approvalDecisions.approverId'] = userId;
  else           query['approvalDecisions.0'] = { $exists: true }; // has at least one decision

  const entries = await EsgDataEntry.find(query).select('approvalDecisions submittedAt').lean();

  let totalDecisions = 0, approvedCount = 0, rejectedCount = 0, totalDays = 0;

  for (const e of entries) {
    for (const d of e.approvalDecisions || []) {
      if (userIdStr && d.approverId?.toString() !== userIdStr) continue;
      if (d.decision === 'pending') continue;
      totalDecisions++;
      if (d.decision === 'approved') approvedCount++;
      if (d.decision === 'rejected') rejectedCount++;
      if (d.decidedAt && e.submittedAt) {
        totalDays += Math.floor((new Date(d.decidedAt) - new Date(e.submittedAt)) / 86400000);
      }
    }
  }

  const byCategory = await getAssignedMetricsByCategory(userId, clientId, 'approver');

  return {
    totalDecisions,
    approvedCount,
    rejectedCount,
    avgDecisionDays: totalDecisions > 0 ? Math.round(totalDays / totalDecisions) : 0,
    byCategory,
  };
}

/**
 * Approver decision history with context.
 */
async function getApproverDecisionHistory(userId, clientId, periodDef) {
  const userIdStr = userId ? userId.toString() : null;
  const dbFilter  = periodDef ? periodDef.dbFilter : {};

  // When userId is null (admin full-access), return all decisions across all approvers
  const query = { clientId, isDeleted: { $ne: true }, ...dbFilter,
    'approvalDecisions.decision': { $ne: 'pending' } };
  if (userId) query['approvalDecisions.approverId'] = userId;

  const entries = await EsgDataEntry.find(query)
    .select('metricId nodeId mappingId period approvalDecisions').lean();

  // Enrich with metric info
  const metricIds = [...new Set(entries.map((e) => e.metricId?.toString()).filter(Boolean))];
  const metrics   = await EsgMetric.find({ _id: { $in: metricIds } }).select('_id metricCode metricName').lean();
  const metricMap = {};
  for (const m of metrics) metricMap[m._id.toString()] = m;

  const result = [];
  for (const e of entries) {
    const meta = metricMap[e.metricId?.toString()] || {};
    for (const d of e.approvalDecisions || []) {
      if (userIdStr && d.approverId?.toString() !== userIdStr) continue; // scoped filter
      if (d.decision === 'pending') continue;
      result.push({
        entryId:     e._id,
        metricCode:  meta.metricCode,
        metricName:  meta.metricName,
        nodeId:      e.nodeId,
        periodLabel: e.period?.periodLabel,
        decision:    d.decision,
        note:        d.note || null,
        decidedAt:   d.decidedAt,
      });
    }
  }

  return result.sort((a, b) => new Date(b.decidedAt) - new Date(a.decidedAt));
}

// =============================================================================
// GROUP 8 — Contributor Dashboard
// =============================================================================

/**
 * All entries submitted by this contributor for a period.
 * updatedAtFilter is a plain Mongoose query fragment like
 * { updatedAt: { $gte: ..., $lt: ... } } or {} for no filter.
 */
async function getContributorSubmissions(userId, clientId, updatedAtFilter = {}) {
  // When userId is null (admin full-access), return ALL submissions for the client
  const query = { clientId, isDeleted: { $ne: true }, ...updatedAtFilter };
  if (userId) query.submittedBy = userId;
  const entries  = await EsgDataEntry.find(query)
    .select('metricId nodeId workflowStatus submittedAt updatedAt period mappingId submittedBy').lean();

  const metricIds = [...new Set(entries.map((e) => e.metricId?.toString()).filter(Boolean))];
  const metrics   = await EsgMetric.find({ _id: { $in: metricIds } }).select('_id metricCode metricName esgCategory').lean();
  const metricMap = {};
  for (const m of metrics) metricMap[m._id.toString()] = m;

  return entries.map((e) => {
    const meta = metricMap[e.metricId?.toString()] || {};
    return {
      entryId:        e._id,
      metricCode:     meta.metricCode,
      metricName:     meta.metricName,
      esgCategory:    meta.esgCategory,
      nodeId:         e.nodeId,
      workflowStatus: e.workflowStatus,
      submittedAt:    e.submittedAt,
      updatedAt:      e.updatedAt,
      periodLabel:    e.period?.periodLabel,
    };
  });
}

/**
 * Coverage: metrics this contributor is assigned to vs what they've submitted.
 * updatedAtFilter is a plain Mongoose query fragment like
 * { updatedAt: { $gte: ..., $lt: ... } } or {} for no filter.
 */
async function getContributorCoverage(userId, clientId, updatedAtFilter = {}) {
  // When userId is null (admin full-access), return client-wide metric coverage
  if (!userId) {
    const result = await getMetricCoverage(clientId, null);
    // Flatten to match the per-user coverage shape the component expects
    return {
      assigned:      result.overall?.assigned      ?? 0,
      submitted:     result.overall?.submitted     ?? 0,
      approved:      result.overall?.approved      ?? 0,
      completionPct: result.overall?.completionPct ?? 0,
      byCategory:    result.byCategory             || {},
    };
  }

  const userIdStr  = userId.toString();
  const boundaries = await EsgLinkBoundary.find({ clientId, isDeleted: { $ne: true } }).lean();

  // Build mappingId → metricId map for all assigned mappings
  const assignedMappingIds  = new Set();
  const mappingMetricIdMap  = {}; // mappingId → metricId string

  for (const b of boundaries) {
    for (const node of b.nodes || []) {
      for (const md of node.metricsDetails || []) {
        const contributors = (md.contributors || []).map((id) => id.toString());
        if (contributors.includes(userIdStr)) {
          const mid = md._id.toString();
          assignedMappingIds.add(mid);
          if (md.metricId) mappingMetricIdMap[mid] = md.metricId.toString();
        }
      }
    }
  }

  if (!assignedMappingIds.size) return { assigned: 0, submitted: 0, approved: 0, completionPct: 0, byCategory: {} };

  // Resolve esgCategory for every assigned metric
  const uniqueMetricIds = [...new Set(Object.values(mappingMetricIdMap))];
  const metrics         = await EsgMetric.find({ _id: { $in: uniqueMetricIds } }).select('_id esgCategory').lean();
  const metricCatMap    = {};
  for (const m of metrics) metricCatMap[m._id.toString()] = m.esgCategory;

  // Build mappingId → esgCategory
  const mappingCategoryMap = {};
  for (const [mid, metricId] of Object.entries(mappingMetricIdMap)) {
    mappingCategoryMap[mid] = metricCatMap[metricId] || null;
  }

  const byCategory = {
    E: { assigned: 0, submitted: 0, approved: 0 },
    S: { assigned: 0, submitted: 0, approved: 0 },
    G: { assigned: 0, submitted: 0, approved: 0 },
  };

  // Increment assigned counts per category
  for (const mid of assignedMappingIds) {
    const cat = mappingCategoryMap[mid];
    if (cat && byCategory[cat]) byCategory[cat].assigned++;
  }

  // Fetch ALL entries for the assigned mappings (not limited to submittedBy this user)
  // because API/IoT-connected metrics are not submitted by the user directly, but still
  // count toward their coverage — the user is assigned to the metric regardless of data source.
  // Filter by updatedAt date range (when data was entered) rather than period.year (fiscal year label).
  const entries = await EsgDataEntry.find({
    clientId, isDeleted: { $ne: true }, ...updatedAtFilter,
    mappingId: { $in: [...assignedMappingIds] },
  }).select('mappingId workflowStatus').lean();

  const submittedSet = new Set();
  const approvedSet  = new Set();

  for (const e of entries) {
    const mid = e.mappingId?.toString();
    if (!mid) continue;
    submittedSet.add(mid);
    if (e.workflowStatus === 'approved') approvedSet.add(mid);
  }

  // Populate byCategory from Sets (one count per unique mappingId)
  for (const mid of submittedSet) {
    const cat = mappingCategoryMap[mid];
    if (cat && byCategory[cat]) byCategory[cat].submitted++;
  }
  for (const mid of approvedSet) {
    const cat = mappingCategoryMap[mid];
    if (cat && byCategory[cat]) byCategory[cat].approved++;
  }

  const assigned  = assignedMappingIds.size;
  const submitted = submittedSet.size;
  const approved  = approvedSet.size;

  // Add completionPct per category
  for (const cat of Object.keys(byCategory)) {
    const c = byCategory[cat];
    c.completionPct = c.assigned > 0 ? Math.round((c.submitted / c.assigned) * 100) : 0;
  }

  return {
    assigned,
    submitted,
    approved,
    completionPct: assigned > 0 ? Math.round((submitted / assigned) * 100) : 0,
    byCategory,
  };
}

/**
 * Entries needing action from the contributor:
 *   - draft: not yet submitted
 *   - clarification_requested: reviewer sent back for clarification
 *   - rejected: explicitly rejected and needs resubmission
 * 'submitted' / 'under_review' / 'approved' require no contributor action.
 */
async function getContributorPendingActions(userId, clientId) {
  // Build base query — when userId is null (admin full-access), return all pending for the client
  const query = {
    clientId,
    workflowStatus: { $in: ['draft', 'clarification_requested', 'rejected'] },
    isDeleted: { $ne: true },
  };

  if (userId) {
    // Cast to ObjectId so Mongoose matches the stored ObjectId field reliably
    let userIdValue = userId;
    try { userIdValue = new mongoose.Types.ObjectId(userId.toString()); } catch (_) { /* keep as-is */ }
    query.submittedBy = userIdValue;
  }

  const entries = await EsgDataEntry.find(query)
    .select('metricId nodeId approvalDecisions dataValues submittedAt updatedAt period mappingId workflowStatus submittedBy').lean();

  const metricIds = [...new Set(entries.map((e) => e.metricId?.toString()).filter(Boolean))];
  const metrics   = await EsgMetric.find({ _id: { $in: metricIds } }).select('_id metricCode metricName').lean();
  const metricMap = {};
  for (const m of metrics) metricMap[m._id.toString()] = m;

  return entries.map((e) => {
    const meta        = metricMap[e.metricId?.toString()] || {};
    const lastDecision = (e.approvalDecisions || []).slice(-1)[0];
    return {
      entryId:                  e._id,
      metricCode:               meta.metricCode,
      metricName:               meta.metricName,
      nodeId:                   e.nodeId,
      workflowStatus:           e.workflowStatus,
      reviewerNote:             lastDecision?.note || null,
      submittedAt:              e.submittedAt,
      actionRequiredAt:         e.updatedAt,
      periodLabel:              e.period?.periodLabel,
    };
  });
}

// =============================================================================
// GROUP 9 — Boundary Comparison
// =============================================================================

/**
 * Compare multiple boundaries for the same period.
 */
async function compareBoundaries(clientId, periodDef, boundaryIds) {
  const idList = boundaryIds && boundaryIds.length ? boundaryIds : null;
  const query  = idList
    ? { clientId, isDeleted: { $ne: true }, _id: { $in: idList } }
    : { clientId, isDeleted: { $ne: true } };

  const boundaries = await EsgLinkBoundary.find(query).select('_id boundaryName').lean();

  const results = await Promise.all(
    boundaries.map(async (b) => {
      const s = await EsgBoundarySummary.findOne({
        clientId, boundaryDocId: b._id,
        periodType: periodDef.periodType, periodKey: periodDef.periodKey,
      }).lean();

      const approved = s?.approvedSummary || {};
      return {
        boundaryDocId: b._id,
        boundaryName: b.boundaryName || b._id,
        totals: approved.totals || { E: 0, S: 0, G: 0 },
        byCategory: approved.byCategory || [],
        totalEntries: s?.totalEntries || 0,
      };
    })
  );

  return { boundaries: results };
}

// =============================================================================
// GROUP 10 — Scorecard & Report-Readiness
// =============================================================================

/**
 * ESG Scorecard: E/S/G scores based on approved coverage × value.
 */
async function getEsgScorecard(clientId, periodDef) {
  const [coverage, catBreakdown] = await Promise.all([
    getMetricCoverage(clientId, periodDef),
    getCategoryBreakdown(clientId, periodDef),
  ]);

  const score = (cat) => {
    const c = coverage.byCategory[cat] || {};
    return c.assigned > 0 ? Math.round((c.approved / c.assigned) * 100) : 0;
  };

  const eScore = score('E');
  const sScore = score('S');
  const gScore = score('G');

  // Subcategory breakdown from category drill-down
  const bySubcategory = {};
  for (const cat of ['E', 'S', 'G']) {
    const subcats = catBreakdown[cat]?.subcategories || [];
    for (const sub of subcats) {
      bySubcategory[sub.subcategoryCode] = {
        esgCategory: cat,
        subcategoryCode: sub.subcategoryCode,
        total: sub.total,
        entryCount: sub.entryCount,
      };
    }
  }

  // Historical trend (last 6 periods of same type)
  const historicalSummaries = await EsgBoundarySummary.find({ clientId, periodType: periodDef.periodType })
    .sort({ periodStart: -1 }).limit(30).lean();

  const trendByPeriod = {};
  for (const s of historicalSummaries) {
    const key = s.periodKey;
    if (!trendByPeriod[key]) trendByPeriod[key] = { periodKey: key, E: 0, S: 0, G: 0 };
    const t = s.approvedSummary?.totals || {};
    trendByPeriod[key].E += t.E || 0;
    trendByPeriod[key].S += t.S || 0;
    trendByPeriod[key].G += t.G || 0;
  }

  const trend = Object.values(trendByPeriod).slice(-6).map((t) => ({
    periodKey: t.periodKey,
    E: t.E,
    S: t.S,
    G: t.G,
  }));

  return { eScore, sScore, gScore, bySubcategory, trend };
}

/**
 * Report readiness checklist.
 */
async function getReportReadiness(clientId, periodDef) {
  const [coverage, wfStatus, quality] = await Promise.all([
    getMetricCoverage(clientId, periodDef),
    getWorkflowStatusCounts(clientId, periodDef),
    getDataQualityStats(clientId, periodDef),
  ]);

  const checks = [
    {
      name: 'Data Completeness >= 80%',
      passed: coverage.overall.completionPct >= 80,
      detail: `${coverage.overall.completionPct}% of assigned metrics have approved entries`,
    },
    {
      name: 'No entries in Draft/Submitted',
      passed: wfStatus.draft === 0 && wfStatus.submitted === 0,
      detail: `${wfStatus.draft + wfStatus.submitted} entries still in early stages`,
    },
    {
      name: 'No clarification pending',
      passed: wfStatus.clarification_requested === 0,
      detail: `${wfStatus.clarification_requested} entries need clarification`,
    },
    {
      name: 'All submitted entries approved',
      passed: wfStatus.under_review === 0 && wfStatus.resubmitted === 0,
      detail: `${wfStatus.under_review + wfStatus.resubmitted} entries awaiting approval`,
    },
    {
      name: 'Evidence attachment rate >= 50%',
      passed: quality.evidenceAttachmentRate >= 50,
      detail: `${quality.evidenceAttachmentRate}% of entries have evidence attached`,
    },
  ];

  const passedCount   = checks.filter((c) => c.passed).length;
  const completionPct = Math.round((passedCount / checks.length) * 100);
  const isReady       = checks.every((c) => c.passed);

  return { isReady, completionPct, checks, coverage: coverage.overall };
}

// =============================================================================
// GROUP 1 — Portfolio (Consultant / Consultant_Admin only)
// =============================================================================

/**
 * Portfolio dashboard: all assigned clients with E/S/G scores.
 */
async function getPortfolioDashboard(user) {
  const clients = await _getAssignedClients(user);
  if (!clients.length) return { clients: [], total: 0 };

  const clientIds = clients.map((c) => c.clientId);

  // ── 3 batched queries instead of 3-per-client ─────────────────────────────

  // Query 1: latest periodYear per client
  const latestYears = await EsgBoundarySummary.aggregate([
    { $match: { clientId: { $in: clientIds }, periodType: 'year' } },
    { $sort:  { periodYear: -1 } },
    { $group: { _id: '$clientId', latestYear: { $first: '$periodYear' } } },
  ]);
  const latestYearMap = new Map(latestYears.map((r) => [r._id?.toString(), r.latestYear]));

  // Query 2: all active boundaries across all clients
  const allBoundaries = await EsgLinkBoundary.find({
    clientId: { $in: clientIds }, isActive: true, isDeleted: false,
  }).select('_id clientId').lean();
  const allActiveBoundaryIds = allBoundaries.map((b) => b._id);

  // Query 3: all year-period summary docs for those boundaries
  const allYearDocs = await EsgBoundarySummary.find({
    boundaryDocId: { $in: allActiveBoundaryIds },
    periodType:    'year',
  }).select('clientId boundaryDocId approvedSummary totalEntries lastComputedAt periodKey periodYear').lean();

  // Group year docs by clientId for O(1) lookup
  const yearDocsByClient = new Map();
  for (const doc of allYearDocs) {
    const key = doc.clientId?.toString();
    if (!yearDocsByClient.has(key)) yearDocsByClient.set(key, []);
    yearDocsByClient.get(key).push(doc);
  }

  // ── Build per-client results (coverage/wfStatus still per-client service calls) ──
  const results = await Promise.all(
    clients.map(async (c) => {
      try {
        const clientIdStr = c.clientId?.toString();
        const latestYear  = latestYearMap.get(clientIdStr);

        const totals = { E: 0, S: 0, G: 0 };
        let lastActivity  = null;
        let lastPeriodKey = null;
        let totalEntries  = 0;

        if (latestYear != null) {
          const clientYearDocs = (yearDocsByClient.get(clientIdStr) || [])
            .filter((d) => d.periodYear === latestYear);

          for (const doc of clientYearDocs) {
            const t = doc.approvedSummary?.totals || {};
            totals.E += t.E || 0;
            totals.S += t.S || 0;
            totals.G += t.G || 0;
            totalEntries += doc.totalEntries || 0;
            if (!lastActivity || new Date(doc.lastComputedAt) > new Date(lastActivity)) {
              lastActivity  = doc.lastComputedAt;
              lastPeriodKey = doc.periodKey;
            }
          }
        }

        const [coverage, wfStatus] = await Promise.all([
          getMetricCoverage(c.clientId, null).catch(() => ({ overall: { completionPct: 0 } })),
          getWorkflowStatusCounts(c.clientId, null).catch(() => ({})),
        ]);

        return {
          clientId:        c.clientId,
          clientName:      c.clientName || c.clientId,
          eScore:          totals.E,
          sScore:          totals.S,
          gScore:          totals.G,
          coveragePct:     coverage.overall?.completionPct || 0,
          pendingReview:   (wfStatus.submitted || 0) + (wfStatus.resubmitted || 0),
          pendingApproval: wfStatus.under_review || 0,
          lastPeriodKey,
          lastActivity,
          totalEntries,
        };
      } catch {
        return { clientId: c.clientId, clientName: c.clientName || c.clientId, error: true };
      }
    })
  );

  return { clients: results, total: results.length };
}

/**
 * Client health summary: extended portfolio with data quality and stuck entries.
 */
async function getClientHealthSummary(user) {
  const clients = await _getAssignedClients(user);
  if (!clients.length) return { clients: [], total: 0 };

  const clientIds = clients.map((c) => c.clientId);

  // Batch query: last submission date per client (replaces per-client findOne)
  const lastSubmissionRows = await EsgDataEntry.aggregate([
    { $match: { clientId: { $in: clientIds }, isDeleted: { $ne: true } } },
    { $sort:  { submittedAt: -1 } },
    { $group: { _id: '$clientId', lastSubmissionDate: { $first: '$submittedAt' } } },
  ]);
  const lastSubmissionMap = new Map(
    lastSubmissionRows.map((r) => [r._id?.toString(), r.lastSubmissionDate])
  );

  const results = await Promise.all(
    clients.map(async (c) => {
      try {
        const [coverage, wfAging, quality] = await Promise.all([
          getMetricCoverage(c.clientId, null).catch(() => ({ overall: { completionPct: 0 } })),
          getWorkflowAging(c.clientId, null).catch(() => ({ byStatus: {} })),
          getDataQualityStats(c.clientId, null).catch(() => ({ ocrConfidenceAvg: null })),
        ]);

        const stuckEntries = Object.values(wfAging.byStatus || {}).reduce((sum, s) => sum + (s.stuckOver7Days || 0), 0);

        return {
          clientId:            c.clientId,
          clientName:          c.clientName || c.clientId,
          coveragePct:         coverage.overall?.completionPct || 0,
          stuckEntries,
          avgDataQuality:      quality.ocrConfidenceAvg,
          evidenceAttachRate:  quality.evidenceAttachmentRate || 0,
          lastSubmissionDate:  lastSubmissionMap.get(c.clientId?.toString()) || null,
        };
      } catch {
        return { clientId: c.clientId, clientName: c.clientName || c.clientId, error: true };
      }
    })
  );

  return { clients: results, total: results.length };
}

/**
 * Internal helper: get all clients accessible to a consultant/consultant_admin.
 * Mirrors isConsultantAdminForClient from submissionPermissions.js.
 */
async function _getAssignedClients(user) {
  const role   = user.userType;
  const uid    = (user._id || user.id).toString();
  const uidObj = new mongoose.Types.ObjectId(uid);

  if (role === 'super_admin') {
    return Client.find({ isDeleted: { $ne: true } }).select('clientId clientName').lean();
  }

  if (role === 'consultant_admin') {
    // Find all consultants managed by this admin, then include them in the search
    const managedConsultants = await User.find({ consultantAdminId: uid }).select('_id').lean();
    const managedIds = managedConsultants.map((c) => c._id);
    managedIds.push(uidObj);

    return Client.find({
      isDeleted: { $ne: true },
      $or: [
        { 'leadInfo.consultantAdminId':           { $in: [uid, ...managedIds] } },
        { 'leadInfo.assignedConsultantId':         { $in: managedIds } },
        { 'workflowTracking.assignedConsultantId': { $in: managedIds } },
      ],
    }).select('clientId clientName').lean();
  }

  if (role === 'consultant') {
    return Client.find({
      isDeleted: { $ne: true },
      $or: [
        { 'leadInfo.assignedConsultantId':         uidObj },
        { 'workflowTracking.assignedConsultantId': uidObj },
      ],
    }).select('clientId clientName').lean();
  }

  return [];
}

// ─── Cache invalidation helper ────────────────────────────────────────────────

async function invalidateBoundarySummary(clientId, boundaryDocId) {
  await EsgBoundarySummary.deleteMany({ clientId, boundaryDocId });
}

module.exports = {
  resolvePeriod,
  resolvePeriodFromEntry,
  resolveAllPeriodsFromEntry,
  computeAndSaveSummary,
  triggerSummaryRefresh,
  triggerAllPeriodSummaryRefresh,
  getCachedSummary,
  getSummaryForUser,
  getHierarchySummary,
  getDashboardSummary,
  getAvailablePeriods,
  refreshAllBoundaryPeriods,
  getReviewerPendingForReviewer,
  getApproverPendingForApprover,
  getMyViewSummary,
  // Group 1 — Portfolio
  getPortfolioDashboard,
  getClientHealthSummary,
  // Group 2 — Period comparison
  comparePeriodsForClient,
  getTrendForClient,
  listAllClientPeriods,
  // Group 3 — Category
  getCategoryBreakdown,
  getTopBottomMetrics,
  // Group 4 — Coverage & Quality
  getMetricCoverage,
  getDataQualityStats,
  getMissingMetrics,
  // Group 5 — Workflow
  getWorkflowStatusCounts,
  getWorkflowAging,
  // Group 6 — Reviewer
  getReviewerQueue,
  getReviewerStats,
  getReviewerAgingQueue,
  // Group 7 — Approver
  getApproverQueue,
  getApproverStats,
  getApproverDecisionHistory,
  // Group 8 — Contributor
  getContributorSubmissions,
  getContributorCoverage,
  getContributorPendingActions,
  // Group 9 — Boundaries
  compareBoundaries,
  // Group 10 — Scorecard
  getEsgScorecard,
  getReportReadiness,
  // Cache invalidation
  invalidateBoundarySummary,
};
