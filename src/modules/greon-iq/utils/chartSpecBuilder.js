'use strict';

// ============================================================================
// chartSpecBuilder.js — Converts raw data arrays into chart JSON specs
//
// Chart specs are passed to the frontend as structured JSON.
// The frontend is responsible for rendering — this module only describes data.
// Supported types: bar, line, pie, stacked_bar, trend, top_n
// ============================================================================

/**
 * Build a bar chart spec.
 * @param {string} title
 * @param {Array<{label: string, value: number}>} dataPoints
 * @param {object} [options]
 */
function buildBarChart(title, dataPoints, options = {}) {
  return {
    type:   'bar',
    title,
    xAxis:  options.xLabel || 'Category',
    yAxis:  options.yLabel || 'Value',
    unit:   options.unit   || null,
    data:   dataPoints.map((p) => ({ label: p.label, value: _round(p.value) })),
    colors: options.colors || null,
  };
}

/**
 * Build a line/trend chart spec.
 * @param {string} title
 * @param {Array<{label: string, value: number}>} dataPoints
 * @param {object} [options]
 */
function buildLineChart(title, dataPoints, options = {}) {
  return {
    type:   options.isTrend ? 'trend' : 'line',
    title,
    xAxis:  options.xLabel || 'Period',
    yAxis:  options.yLabel || 'Value',
    unit:   options.unit   || null,
    data:   dataPoints.map((p) => ({ label: p.label, value: _round(p.value) })),
  };
}

/**
 * Build a pie/donut chart spec.
 * @param {string} title
 * @param {Array<{label: string, value: number}>} dataPoints
 * @param {object} [options]
 */
function buildPieChart(title, dataPoints, options = {}) {
  const total = dataPoints.reduce((s, p) => s + (p.value || 0), 0);
  return {
    type:    options.donut ? 'donut' : 'pie',
    title,
    unit:    options.unit || null,
    data:    dataPoints.map((p) => ({
      label:   p.label,
      value:   _round(p.value),
      percent: total > 0 ? _round((p.value / total) * 100) : 0,
    })),
  };
}

/**
 * Build a stacked bar chart spec.
 * @param {string} title
 * @param {string[]} categories  — bar labels (x axis)
 * @param {Array<{seriesName: string, values: number[]}>} series
 * @param {object} [options]
 */
function buildStackedBarChart(title, categories, series, options = {}) {
  return {
    type:       'stacked_bar',
    title,
    xAxis:      options.xLabel || 'Category',
    yAxis:      options.yLabel || 'Value',
    unit:       options.unit   || null,
    categories,
    series:     series.map((s) => ({
      name:   s.seriesName,
      values: s.values.map(_round),
    })),
  };
}

/**
 * Build a top-N ranked bar chart spec.
 * @param {string} title
 * @param {Array<{label: string, value: number}>} dataPoints — sorted descending
 * @param {number} [topN=10]
 * @param {object} [options]
 */
function buildTopNChart(title, dataPoints, topN = 10, options = {}) {
  const sliced = dataPoints.slice(0, topN);
  return {
    type:     'top_n',
    title,
    topN,
    xAxis:    options.xLabel || 'Item',
    yAxis:    options.yLabel || 'Value',
    unit:     options.unit   || null,
    data:     sliced.map((p, i) => ({ rank: i + 1, label: p.label, value: _round(p.value) })),
  };
}

// ── Convenience builders for common GreOn IQ charts ──────────────────────────

/**
 * Build a scope breakdown chart from emission summary byScope data.
 * @param {Array<{scope: string|number, totalEmissions: number, unit: string}>} byScopeData
 */
function buildScopeBreakdownChart(byScopeData) {
  const dataPoints = (byScopeData || []).map((s) => ({
    label: `Scope ${s.scope}`,
    value: s.totalEmissions || 0,
  }));
  const unit = byScopeData?.[0]?.unit || 'tCO₂e';
  return buildBarChart('Emissions by Scope', dataPoints, { yLabel: `Emissions (${unit})`, unit });
}

/**
 * Build a reduction progress chart.
 * @param {Array<{name: string, targetReduction: number, actualReduction: number}>} projects
 */
function buildReductionProgressChart(projects) {
  const categories = (projects || []).map((p) => p.name || 'Unknown');
  const series = [
    { seriesName: 'Target', values: (projects || []).map((p) => p.targetReduction || 0) },
    { seriesName: 'Actual', values: (projects || []).map((p) => p.actualReduction || 0) },
  ];
  return buildStackedBarChart('Reduction Progress', categories, series, { yLabel: 'tCO₂e' });
}

/**
 * Build an ESG status distribution pie chart.
 * @param {object} byStatus  — e.g. { approved: 10, pending: 3, draft: 2 }
 */
function buildEsgStatusChart(byStatus) {
  const dataPoints = Object.entries(byStatus || {}).map(([label, value]) => ({ label, value }));
  return buildPieChart('ESG Entries by Status', dataPoints);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _round(val, dp = 2) {
  if (typeof val !== 'number' || isNaN(val)) return val;
  return Math.round(val * 10 ** dp) / 10 ** dp;
}

module.exports = {
  buildBarChart,
  buildLineChart,
  buildPieChart,
  buildStackedBarChart,
  buildTopNChart,
  buildScopeBreakdownChart,
  buildReductionProgressChart,
  buildEsgStatusChart,
};
