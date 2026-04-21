'use strict';

// ============================================================================
// test-table-normalizer.js — Quick smoke-test for tableNormalizer.js
//
// Run with:  node src/modules/greon-iq/test-table-normalizer.js
// ============================================================================

const { normalizeTable } = require('./exporters/tableNormalizer');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

// ── Shape A: object cols + object rows (query response — primary path) ────────
console.log('\nShape A — object columns, object rows:');
const normA = normalizeTable({
  title: 'Emission Summaries',
  columns: [
    { key: 'period',         label: 'Period' },
    { key: 'totalEmissions', label: 'Total CO₂e (tCO₂e)' },
    { key: 'unit',           label: 'Unit' },
  ],
  rows: [
    { period: 'Apr 2026', totalEmissions: 69.942, unit: 'tCO₂e' },
    { period: 'Mar 2026', totalEmissions: 0,      unit: 'tCO₂e' },
  ],
  totalRows: 2,
});
assert(normA.columns.length === 3,                          'has 3 columns');
assert(normA.columns[0].key   === 'period',                 'col[0].key = period');
assert(normA.columns[1].label === 'Total CO₂e (tCO₂e)',    'col[1].label preserved');
assert(normA.rows.length === 2,                             'has 2 rows');
assert(normA.rows[0]['period'] === 'Apr 2026',              'row[0].period correct');
assert(normA.rows[0]['totalEmissions'] === 69.942,          'row[0].totalEmissions is number');
assert(typeof normA.rows[0]['totalEmissions'] === 'number', 'totalEmissions stays number type');
assert(normA.rows[1]['totalEmissions'] === 0,               'zero value preserved (not null)');
assert(normA.exportable === true,                           'exportable = true');
assert(normA.totalRows === 2,                               'totalRows = 2');

// ── Shape C: string cols + array rows (legacy reportService path) ─────────────
console.log('\nShape C — string columns, array rows (legacy):');
const normC = normalizeTable({
  title: 'Legacy Table',
  columns: ['Period', 'Emissions', 'Unit'],
  rows: [
    ['Jan 2026', 243.96, 'tCO₂e'],
    ['Feb 2026', 16.5,   'tCO₂e'],
  ],
  totalRows: 2,
});
assert(normC.columns[0].key   === 'col_0',    'string col gets synthetic key col_0');
assert(normC.columns[0].label === 'Period',   'string col label preserved');
assert(normC.rows[0]['col_0'] === 'Jan 2026', 'row[0].col_0 = Jan 2026 (positional)');
assert(normC.rows[0]['col_1'] === 243.96,     'row[0].col_1 = 243.96 (number preserved)');
assert(typeof normC.rows[0]['col_1'] === 'number', 'col_1 stays number type');
assert(normC.exportable === true,             'exportable = true');

// ── Null and zero values ──────────────────────────────────────────────────────
console.log('\nNull / zero / undefined edge cases:');
const normNull = normalizeTable({
  title: 'Null Test',
  columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
  rows: [
    { a: 0,    b: null },
    { a: null, b: 'text' },
  ],
  totalRows: 2,
});
assert(normNull.rows[0]['a'] === 0,        'zero stays 0 (not null)');
assert(normNull.rows[0]['b'] === null,     'null stays null');
assert(normNull.rows[1]['a'] === null,     'null from object row stays null');
assert(normNull.rows[1]['b'] === 'text',   'string value preserved');
assert(normNull.exportable === true,       'exportable true (has some non-null)');

// ── Empty table ───────────────────────────────────────────────────────────────
console.log('\nEmpty table:');
const normEmpty = normalizeTable({ title: 'Empty', columns: [], rows: [], totalRows: 0 });
assert(normEmpty.exportable === false, 'empty table not exportable');
assert(normEmpty.rows.length === 0,    'empty rows');

// ── keys.length null-key bug — no row should have undefined values ────────────
console.log('\nNo undefined in normalised rows (the keys.length null-key bug check):');
const allDefined = normA.rows.every((row) =>
  normA.columns.every((col) => row[col.key] !== undefined)
);
assert(allDefined, 'all cells are defined (not undefined) in Shape A');

const allDefinedC = normC.rows.every((row) =>
  normC.columns.every((col) => row[col.key] !== undefined)
);
assert(allDefinedC, 'all cells are defined (not undefined) in Shape C');

// ── Shape D: object cols + array rows ─────────────────────────────────────────
console.log('\nShape D — object columns, array rows:');
const normD = normalizeTable({
  title: 'Mixed',
  columns: [{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }],
  rows: [[10, 20], [30, 40]],
  totalRows: 2,
});
assert(normD.rows[0]['x'] === 10, 'Shape D row[0].x = 10');
assert(normD.rows[1]['y'] === 40, 'Shape D row[1].y = 40');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n─────────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
