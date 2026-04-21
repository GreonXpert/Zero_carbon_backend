'use strict';

// ============================================================================
// responseComposerService.js — Merges retrieval results + DeepSeek narrative
//
// This is the final assembly step before the API response is sent.
// It decides what to include (answer, tables, charts, exclusions, followups)
// based on the query plan's outputMode and supportsXxx flags.
//
// Security invariant: DeepSeek only receives data the retrieval layer returned.
// The retrieval layer has already applied all permission gates.
// ============================================================================

const deepseekProvider         = require('../providers/deepseekProvider');
const { generateSuggestions }  = require('./followupSuggestionService');
const { buildTrace }           = require('../utils/queryTraceBuilder');
const {
  buildScopeBreakdownChart,
  buildReductionProgressChart,
  buildEsgStatusChart,
  buildBarChart,
  buildPieChart,
} = require('../utils/chartSpecBuilder');
const { DENIAL_MESSAGES }      = require('../registry/promptRegistry');

/**
 * Compose the final API response from a retrieval result + query plan.
 *
 * @param {object} plan             — from queryPlannerService
 * @param {object} retrievalResult  — from the domain retriever
 * @param {object} accessContext
 * @returns {Promise<object>}       — composed response payload
 */
async function compose(plan, retrievalResult, accessContext) {
  const { outputMode, supportsCharts, supportsTables, sections } = plan;
  const { data, exclusions: retrieverExclusions, recordCount } = retrievalResult;

  const allExclusions = [...(retrieverExclusions || [])];

  // ── Handle no-data case — skip DeepSeek entirely ─────────────────────────
  const hasData = recordCount > 0;

  if (!hasData) {
    const noDataMsg = allExclusions.length
      ? allExclusions.join(' ')
      : `No data was found for the requested query. Please check that data has been entered for this client.`;
    return {
      answer:           noDataMsg,
      outputMode:       'plain',
      tables:           [],
      charts:           [],
      exclusions:       allExclusions,
      followupQuestions: generateSuggestions(plan, retrievalResult),
      recordCount:      0,
      hasData:          false,
      trace:            buildTrace(plan),
      _aiMeta:  { tokensIn: 0, tokensOut: 0, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat' },
      _aiError: null,
    };
  }

  // ── Build structured context for DeepSeek ────────────────────────────────
  const structuredData = _buildStructuredContext(plan, data, recordCount);

  // ── Call DeepSeek for narrative ───────────────────────────────────────────
  let aiAnswer  = '';
  let aiUsage   = null;
  let aiError   = null;

  if (outputMode === 'report') {
    const reportResult = await deepseekProvider.generateReport({
      reportData: structuredData,
      sections,
      accessContext,
    });
    if (reportResult.error) {
      aiError  = reportResult.error;
      aiAnswer = DENIAL_MESSAGES.provider_error;
    } else {
      aiAnswer = reportResult.content;
      aiUsage  = reportResult.usage;
    }
  } else {
    const answerResult = await deepseekProvider.generateAnswer({
      userQuestion:   plan.originalQuestion || '',
      accessContext,
      queryPlan:      plan,
      structuredData,
      outputMode,
      exclusions:     allExclusions,
    });
    if (answerResult.error) {
      aiError  = answerResult.error;
      aiAnswer = DENIAL_MESSAGES.provider_error;
    } else {
      aiAnswer = answerResult.content;
      aiUsage  = answerResult.usage;
    }
  }

  // ── Build tables ──────────────────────────────────────────────────────────
  const tables = supportsTables ? _buildTables(plan, data) : [];

  // ── Build charts ──────────────────────────────────────────────────────────
  const charts = supportsCharts ? _buildCharts(plan, data) : [];

  // ── Follow-up suggestions ─────────────────────────────────────────────────
  const followupQuestions = generateSuggestions(plan, retrievalResult);

  // ── Trace (safe, no sensitive IDs) ───────────────────────────────────────
  const trace = buildTrace(plan);

  return {
    answer:          aiAnswer,
    outputMode,
    tables,
    charts,
    exclusions:      allExclusions,
    followupQuestions,
    recordCount,
    hasData,
    trace,
    _aiMeta: {
      tokensIn:   aiUsage?.tokensIn  || 0,
      tokensOut:  aiUsage?.tokensOut || 0,
      model:      process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    },
    _aiError: aiError || null,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// Formats a period object from EmissionSummary into a human-readable string.
// DB shape: { type, year, from, to }  (not startDate/endDate, no label)
function _formatPeriod(period) {
  if (!period) return '—';
  if (period.label) return period.label;
  if (period.type === 'yearly' && period.year) return `Year ${period.year}`;
  if (period.type === 'monthly' && period.year && period.month) {
    const d = new Date(period.year, period.month - 1);
    return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  }
  const from = period.from || period.startDate;
  const to   = period.to   || period.endDate;
  if (from && to) {
    const fStr = new Date(from).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
    const tStr = new Date(to).toLocaleDateString('en-IN',   { month: 'short', year: 'numeric' });
    return `${fStr} – ${tStr}`;
  }
  return '—';
}

// Slims each summary record to the fields DeepSeek needs — strips ObjectId arrays,
// byActivity, byDepartment, byLocation, byEmissionFactor, and full metadata blobs.
// No record count cap: all records are passed but in compact form.
function _slimSummary(s) {
  const byScope = s.byScope && !Array.isArray(s.byScope)
    ? Object.fromEntries(
        Object.entries(s.byScope).map(([scope, v]) => [scope, { CO2e: v?.CO2e ?? 0 }])
      )
    : (Array.isArray(s.byScope) ? s.byScope.map((v) => ({ scope: v.scope, CO2e: v.CO2e ?? 0 })) : undefined);

  return {
    period:    _formatPeriod(s.period),
    totalCO2e: s.totalEmissions?.CO2e ?? s.totalEmissions ?? 0,
    unit:      s.metadata?.unit || 'tCO₂e',
    ...(byScope ? { byScope } : {}),
  };
}

function _buildStructuredContext(plan, data, recordCount) {
  const simplified = data.summaries?.length
    ? { ...data, summaries: data.summaries.map(_slimSummary) }
    : data;

  return {
    domain:    plan.domain,
    product:   plan.product,
    dateRange: plan.dateRange ? { label: plan.dateRange.label } : null,
    recordCount,
    data:      simplified,
  };
}

function _col(key, label) { return { key, label }; }

function _buildTables(plan, data) {
  const tables = [];

  if (data.summaries?.length) {
    tables.push({
      title:     'Emission Summaries',
      columns:   [_col('period', 'Period'), _col('totalEmissions', 'Total CO₂e (tCO₂e)'), _col('unit', 'Unit')],
      rows:      data.summaries.map((s) => ({
        period:         _formatPeriod(s.period),
        totalEmissions: s.totalEmissions?.CO2e ?? s.totalEmissions ?? '—',
        unit:           s.metadata?.unit || 'tCO₂e',
      })),
      totalRows:  data.summaries.length,
      exportable: true,
    });
  }

  if (data.dataEntries?.records?.length && !plan.domain?.startsWith('esg')) {
    const records = data.dataEntries.records;
    tables.push({
      title:    'Data Entries',
      columns:  [_col('node', 'Node'), _col('scope', 'Scope'), _col('type', 'Type'), _col('status', 'Status'), _col('date', 'Date')],
      rows:     records.map((r) => ({
        node:   r.nodeId || '—',
        scope:  r.scopeIdentifier || '—',
        type:   r.inputType || '—',
        status: r.status || '—',
        date:   r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN') : '—',
      })),
      totalRows:  data.dataEntries.totalCount,
      exportable: true,
    });
  }

  if (data.reductionProjects?.records?.length) {
    const records = data.reductionProjects.records;
    tables.push({
      title:    'Reduction Projects',
      columns:  [_col('name', 'Name'), _col('status', 'Status'), _col('target', 'Target'), _col('actual', 'Actual'), _col('unit', 'Unit')],
      rows:     records.map((r) => ({
        name:   r.name || '—',
        status: r.status || '—',
        target: r.targetReduction ?? '—',
        actual: r.actualReduction ?? '—',
        unit:   r.unit || 'tCO₂e',
      })),
      totalRows:  data.reductionProjects.totalCount,
      exportable: true,
    });
  }

  if (data.sbtiTargets?.records?.length) {
    const records = data.sbtiTargets.records;
    tables.push({
      title:    'SBTi Targets',
      columns:  [_col('type', 'Type'), _col('baselineYear', 'Baseline Year'), _col('targetYear', 'Target Year'), _col('reduction', 'Reduction %'), _col('scope', 'Scope'), _col('status', 'Status')],
      rows:     records.map((r) => ({
        type:         r.targetType || '—',
        baselineYear: r.baselineYear || '—',
        targetYear:   r.targetYear   || '—',
        reduction:    r.reductionTarget ?? '—',
        scope:        Array.isArray(r.scope) ? r.scope.join(', ') : (r.scope || '—'),
        status:       r.status || '—',
      })),
      totalRows:  data.sbtiTargets.totalCount,
      exportable: true,
    });
  }

  if (data.dataEntries?.records?.length && plan.domain?.startsWith('esg')) {
    const records = data.dataEntries.records;
    tables.push({
      title:    'ESG Data Entries',
      columns:  [_col('node', 'Node'), _col('period', 'Period'), _col('status', 'Status'), _col('value', 'Value'), _col('unit', 'Unit')],
      rows:     records.map((r) => ({
        node:   r.nodeId || '—',
        period: r.period?.periodLabel || r.period?.year || '—',
        status: r.workflowStatus || '—',
        value:  r.calculatedValue ?? '—',
        unit:   r.unitOfMeasurement || '—',
      })),
      totalRows:  data.dataEntries.totalCount,
      exportable: true,
    });
  }

  return tables;
}

function _buildCharts(plan, data) {
  const charts = [];
  const domain = plan.domain;

  if (domain === 'emission_summary' && data.summaries?.length) {
    const firstSummary = data.summaries[0];
    // byScope is an object { 'Scope 1': { CO2e, ... }, ... }, not an array
    const byScopeRaw = firstSummary?.byScope;
    if (byScopeRaw && typeof byScopeRaw === 'object' && !Array.isArray(byScopeRaw)) {
      const byScopeArray = Object.entries(byScopeRaw).map(([scope, d]) => ({
        scope, CO2e: d?.CO2e || 0, ...d,
      }));
      if (byScopeArray.length) charts.push(buildScopeBreakdownChart(byScopeArray));
    } else if (Array.isArray(byScopeRaw) && byScopeRaw.length) {
      charts.push(buildScopeBreakdownChart(byScopeRaw));
    }
    if (data.summaries.length > 1) {
      const trend = data.summaries
        .slice()
        .reverse()
        .map((s) => ({
          label: _formatPeriod(s.period),
          value: s.totalEmissions?.CO2e ?? s.totalEmissions ?? 0,
        }));
      charts.push({ type: 'trend', title: 'Emission Trend', data: trend, unit: 'tCO₂e' });
    }
  }

  if (domain === 'reduction' && data.reductionProjects?.records?.length) {
    charts.push(buildReductionProgressChart(data.reductionProjects.records));
    if (data.reductionProjects.stats?.byStatus) {
      charts.push(buildPieChart('Projects by Status',
        Object.entries(data.reductionProjects.stats.byStatus).map(([label, value]) => ({ label, value }))
      ));
    }
  }

  if ((domain === 'esg_data_entry' || domain === 'esg_summary') && data.dataEntries?.stats?.byStatus) {
    charts.push(buildEsgStatusChart(data.dataEntries.stats.byStatus));
  }

  if (domain === 'data_entry' && data.dataEntries?.stats) {
    const stats = data.dataEntries.stats;
    if (stats.byInputType) {
      charts.push(buildBarChart('Entries by Input Type',
        Object.entries(stats.byInputType).map(([label, value]) => ({ label, value })),
        { yLabel: 'Count' }
      ));
    }
  }

  return charts;
}

module.exports = { compose };
