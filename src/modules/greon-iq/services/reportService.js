'use strict';

// ============================================================================
// reportService.js — Assembles structured report data from retrievers
//
// Reports use the same retrieval + permission pipeline as queries.
// reportService coordinates multi-domain retrieval and structures the output
// for the exporters (markdown, PDF, DOCX, Excel).
// ============================================================================

const { buildQueryPlan }    = require('./queryPlannerService');
const { generateSuggestions } = require('./followupSuggestionService');
const deepseekProvider      = require('../providers/deepseekProvider');
const RETRIEVERS = {
  emissionSummaryRetriever: require('../retrievers/emissionSummaryRetriever'),
  dataEntryRetriever:       require('../retrievers/dataEntryRetriever'),
  reductionRetriever:       require('../retrievers/reductionRetriever'),
  sbtiRetriever:            require('../retrievers/sbtiRetriever'),
  esgRetriever:             require('../retrievers/esgRetriever'),
};

/**
 * Assemble a full report data model for export.
 *
 * @param {object} opts
 * @param {string} opts.intent          — e.g. 'emission_summary'
 * @param {string} opts.question        — user's original report request
 * @param {object} opts.accessContext
 * @param {object} [opts.contextState]
 * @param {string} [opts.clientName]
 * @returns {Promise<{ meta, sections, exclusions, followupQuestions }>}
 */
async function assembleReportData(opts) {
  const { intent, question, accessContext, contextState = {}, clientName, requestedSections } = opts;

  const planResult = await buildQueryPlan({
    intent,
    question,
    accessContext,
    contextState,
  });

  if (planResult.error) {
    throw Object.assign(new Error(planResult.error), { code: planResult.code });
  }

  const plan = planResult.plan;

  // If the caller specified which sections to include, filter down to those
  // (intersect with the role-permitted sections so permissions still apply).
  if (Array.isArray(requestedSections) && requestedSections.length) {
    plan.sections = plan.sections.filter((s) => requestedSections.includes(s));
    if (!plan.sections.length) plan.sections = planResult.plan.sections; // fallback to all allowed
  }
  const retriever = RETRIEVERS[plan.retriever];
  if (!retriever) {
    throw new Error(`No retriever found for key: ${plan.retriever}`);
  }

  const retrievalResult = await retriever.retrieve(plan, accessContext);
  const { data, exclusions, recordCount } = retrievalResult;

  // Build narrative sections via DeepSeek
  const reportResult = await deepseekProvider.generateReport({
    reportData: { domain: plan.domain, product: plan.product, dateRange: plan.dateRange, recordCount, data },
    sections:   plan.sections,
  });

  const narrative = reportResult.error ? '[Narrative generation failed.]' : (reportResult.content || '');
  const aiUsage   = reportResult.usage || {};

  // Build table objects (reuse table builder from responseComposerService pattern)
  const tables = _extractTables(plan, data);

  return {
    meta: {
      title:      `GreOn IQ Report — ${_domainLabel(plan.domain)}`,
      clientName: clientName || String(accessContext.clientId),
      period:     plan.dateRange?.label || 'All periods',
      domain:     plan.domain,
    },
    sections: [
      {
        heading:   _domainLabel(plan.domain),
        narrative,
        tables,
      },
    ],
    exclusions:       exclusions || [],
    followupQuestions: generateSuggestions(plan, retrievalResult),
    _aiUsage: aiUsage,
    _plan:    plan,
    _recordCount: recordCount,
  };
}

// Mirrors responseComposerService._formatPeriod — handles all DB period shapes.
// Period objects are stored as { type, year, month?, from?, to? } with no .label.
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
  if (period.year) return `Year ${period.year}`;
  return '—';
}

function _extractTables(plan, data) {
  const tables = [];

  if (data.summaries?.length) {
    tables.push({
      title:   'Emission Summaries',
      // Use object-format columns so normalizeTable can key-lookup rows correctly
      columns: [
        { key: 'period',         label: 'Period' },
        { key: 'totalEmissions', label: 'Total CO₂e (tCO₂e)' },
        { key: 'unit',           label: 'Unit' },
      ],
      rows: data.summaries.map((s) => ({
        period:         _formatPeriod(s.period),
        // totalEmissions may be a plain number OR { CO2e, CH4, N2O, ... } object
        totalEmissions: s.totalEmissions?.CO2e ?? s.totalEmissions ?? '—',
        unit:           s.metadata?.unit || 'tCO₂e',
      })),
      totalRows:  data.summaries.length,
      exportable: true,
    });
  }

  if (data.dataEntries?.records?.length && !plan.domain?.startsWith('esg')) {
    const r = data.dataEntries.records;
    tables.push({
      title:   'Data Entries',
      columns: [
        { key: 'node',   label: 'Node' },
        { key: 'scope',  label: 'Scope' },
        { key: 'type',   label: 'Type' },
        { key: 'status', label: 'Status' },
        { key: 'date',   label: 'Date' },
      ],
      rows: r.map((d) => ({
        node:   d.nodeId           || '—',
        scope:  d.scopeIdentifier  || '—',
        type:   d.inputType        || '—',
        status: d.status           || '—',
        date:   d.createdAt ? new Date(d.createdAt).toLocaleDateString('en-IN') : '—',
      })),
      totalRows:  data.dataEntries.totalCount,
      exportable: true,
    });
  }

  if (data.reductionProjects?.records?.length) {
    const r = data.reductionProjects.records;
    tables.push({
      title:   'Reduction Projects',
      columns: [
        { key: 'name',   label: 'Name' },
        { key: 'status', label: 'Status' },
        { key: 'target', label: 'Target' },
        { key: 'actual', label: 'Actual' },
        { key: 'unit',   label: 'Unit' },
      ],
      rows: r.map((d) => ({
        name:   d.name            || '—',
        status: d.status          || '—',
        target: d.targetReduction ?? '—',
        actual: d.actualReduction ?? '—',
        unit:   d.unit            || 'tCO₂e',
      })),
      totalRows:  data.reductionProjects.totalCount,
      exportable: true,
    });
  }

  if (data.sbtiTargets?.records?.length) {
    const r = data.sbtiTargets.records;
    tables.push({
      title:   'SBTi Targets',
      columns: [
        { key: 'type',         label: 'Type' },
        { key: 'baselineYear', label: 'Baseline Year' },
        { key: 'targetYear',   label: 'Target Year' },
        { key: 'reduction',    label: 'Reduction %' },
        { key: 'status',       label: 'Status' },
      ],
      rows: r.map((d) => ({
        type:         d.targetType    || '—',
        baselineYear: d.baselineYear  || '—',
        targetYear:   d.targetYear    || '—',
        reduction:    d.reductionTarget ?? '—',
        status:       d.status        || '—',
      })),
      totalRows:  data.sbtiTargets.totalCount,
      exportable: true,
    });
  }

  if (data.dataEntries?.records?.length && plan.domain?.startsWith('esg')) {
    const r = data.dataEntries.records;
    tables.push({
      title:   'ESG Data Entries',
      columns: [
        { key: 'node',   label: 'Node' },
        { key: 'period', label: 'Period' },
        { key: 'status', label: 'Status' },
        { key: 'value',  label: 'Value' },
        { key: 'unit',   label: 'Unit' },
      ],
      rows: r.map((d) => ({
        node:   d.nodeId                          || '—',
        period: d.period?.periodLabel || d.period?.year || '—',
        status: d.workflowStatus                  || '—',
        value:  d.calculatedValue                 ?? '—',
        unit:   d.unitOfMeasurement               || '—',
      })),
      totalRows:  data.dataEntries.totalCount,
      exportable: true,
    });
  }

  return tables;
}

function _domainLabel(domain) {
  const labels = {
    emission_summary:       'Emission Summary',
    data_entry:             'Data Entries',
    reduction:              'Reduction Projects',
    decarbonization:        'SBTi Targets',
    esg_summary:            'ESG Summary',
    esg_data_entry:         'ESG Data Entries',
    esg_metrics:            'ESG Metrics',
    esg_boundary:           'ESG Boundary',
    cross_module_analysis:  'Cross-Module Analysis',
  };
  return labels[domain] || domain || 'Report';
}

module.exports = { assembleReportData };
