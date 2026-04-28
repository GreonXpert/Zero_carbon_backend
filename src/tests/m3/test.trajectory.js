'use strict';

/**
 * Unit tests for trajectory row-assembly logic — pure logic, no DB required.
 *
 * The row-building algorithm is extracted inline below so these tests run
 * without a MongoDB connection. Integration tests using the real service
 * should be run against a seeded test database.
 *
 * Run: node src/tests/m3/test.trajectory.js
 * Exit 0 = all pass, Exit 1 = failures.
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

// ─── Row assembly — inline mirror of trajectoryService logic ─────────────────

function buildTrajectoryRows(target, pathwayRows, snapshots) {
  const { base_year, target_year, base_year_emissions, target_reduction_pct } = target;
  const base = base_year_emissions ?? null;
  const finalTargetEmissions =
    base !== null && target_reduction_pct !== null
      ? parseFloat((base * (1 - target_reduction_pct / 100)).toFixed(4))
      : null;

  const pathwayByYear  = {};
  for (const p of pathwayRows) pathwayByYear[p.calendar_year] = p;

  const snapshotByYear = {};
  for (const s of snapshots) snapshotByYear[s.calendar_year] = s;

  const rows = [];
  let prevAllowed = null;
  let prevActual  = null;

  for (let year = base_year; year <= target_year; year++) {
    if (year === base_year) {
      rows.push({
        year,
        is_base_year:                true,
        required_allowed_emissions:  base,
        required_decrease_from_base: 0,
        required_annual_decrease:    0,
        actual_emissions:            base,
        actual_decrease_from_base:   0,
        actual_annual_decrease:      0,
        achieved:                    true,
        gap_to_allowed:              0,
        remaining_to_final_target:
          finalTargetEmissions !== null && base !== null
            ? Math.max(parseFloat((base - finalTargetEmissions).toFixed(4)), 0)
            : null,
        progress_status: null,
        data_status:     'AVAILABLE',
        m1_summary_id:   null,
      });
      prevAllowed = base;
      prevActual  = base;
      continue;
    }

    const pathwayRow = pathwayByYear[year] || null;
    const snapshot   = snapshotByYear[year] || null;

    const requiredAllowed        = pathwayRow ? pathwayRow.allowed_emissions : null;
    const requiredDecreaseFromBase =
      requiredAllowed !== null && base !== null
        ? parseFloat((base - requiredAllowed).toFixed(4)) : null;
    const requiredAnnualDecrease =
      requiredAllowed !== null && prevAllowed !== null
        ? parseFloat((prevAllowed - requiredAllowed).toFixed(4)) : null;

    const actualEmissions       = snapshot ? snapshot.actual_emissions : null;
    const actualDecreaseFromBase =
      actualEmissions !== null && base !== null
        ? parseFloat((base - actualEmissions).toFixed(4)) : null;
    const actualAnnualDecrease  =
      actualEmissions !== null && prevActual !== null
        ? parseFloat((prevActual - actualEmissions).toFixed(4)) : null;

    const achieved =
      actualEmissions !== null && requiredAllowed !== null
        ? actualEmissions <= requiredAllowed : null;

    const gapToAllowed =
      actualEmissions !== null && requiredAllowed !== null
        ? parseFloat((actualEmissions - requiredAllowed).toFixed(4)) : null;

    const remainingToFinalTarget =
      actualEmissions !== null && finalTargetEmissions !== null
        ? Math.max(parseFloat((actualEmissions - finalTargetEmissions).toFixed(4)), 0) : null;

    rows.push({
      year,
      is_base_year:                false,
      required_allowed_emissions:  requiredAllowed,
      required_decrease_from_base: requiredDecreaseFromBase,
      required_annual_decrease:    requiredAnnualDecrease,
      actual_emissions:            actualEmissions,
      actual_decrease_from_base:   actualDecreaseFromBase,
      actual_annual_decrease:      actualAnnualDecrease,
      achieved,
      gap_to_allowed:              gapToAllowed,
      remaining_to_final_target:   remainingToFinalTarget,
      progress_status:             snapshot ? snapshot.progress_status : null,
      data_status:                 snapshot ? 'AVAILABLE' : 'MISSING_ACTUAL',
      m1_summary_id:               snapshot ? (snapshot.m1_summary_id || null) : null,
    });

    if (requiredAllowed !== null) prevAllowed = requiredAllowed;
    if (actualEmissions !== null) prevActual  = actualEmissions;
  }
  return rows;
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const target = {
  base_year:            2022,
  target_year:          2025,
  base_year_emissions:  1000,
  target_reduction_pct: 50,
  scope_boundary:       'S1S2',
};

const pathway = [
  { calendar_year: 2023, allowed_emissions: 833.33 },
  { calendar_year: 2024, allowed_emissions: 666.67 },
  { calendar_year: 2025, allowed_emissions: 500 },
];

const snapshots = [
  { calendar_year: 2023, actual_emissions: 800, progress_status: 'Ahead_of_Target', m1_summary_id: 'sumId1' },
  { calendar_year: 2024, actual_emissions: 700, progress_status: 'Off_Track',        m1_summary_id: 'sumId2' },
];

const rows = buildTrajectoryRows(target, pathway, snapshots);

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\nBase-year row');

test('First row is base year', () => {
  assert.strictEqual(rows[0].year, 2022);
});

test('Base year has is_base_year=true', () => {
  assert.strictEqual(rows[0].is_base_year, true);
});

test('Base year actual equals base_year_emissions', () => {
  assert.strictEqual(rows[0].actual_emissions, 1000);
});

test('Base year allowed equals base_year_emissions', () => {
  assert.strictEqual(rows[0].required_allowed_emissions, 1000);
});

test('Base year data_status is AVAILABLE', () => {
  assert.strictEqual(rows[0].data_status, 'AVAILABLE');
});

test('Base year achieved is true', () => {
  assert.strictEqual(rows[0].achieved, true);
});

test('remaining_to_final_target on base year equals base-finalTarget', () => {
  // finalTarget = 1000 * (1 - 50/100) = 500; remaining = 1000 - 500 = 500
  assert.strictEqual(rows[0].remaining_to_final_target, 500);
});

console.log('\nYear with actuals (2023)');

test('2023 row exists', () => {
  assert.ok(rows.find(r => r.year === 2023));
});

test('2023 data_status is AVAILABLE', () => {
  const r = rows.find(r => r.year === 2023);
  assert.strictEqual(r.data_status, 'AVAILABLE');
});

test('2023 actual_emissions is correct', () => {
  const r = rows.find(r => r.year === 2023);
  assert.strictEqual(r.actual_emissions, 800);
});

test('2023 achieved is true (800 <= 833.33)', () => {
  const r = rows.find(r => r.year === 2023);
  assert.strictEqual(r.achieved, true);
});

test('2023 gap_to_allowed is negative (under target)', () => {
  const r = rows.find(r => r.year === 2023);
  assert.ok(r.gap_to_allowed < 0, `Expected gap < 0, got ${r.gap_to_allowed}`);
});

test('2023 required_decrease_from_base = 1000 - 833.33', () => {
  const r = rows.find(r => r.year === 2023);
  assert.strictEqual(r.required_decrease_from_base, 166.67);
});

test('2023 required_annual_decrease = base - 833.33 (first year)', () => {
  const r = rows.find(r => r.year === 2023);
  assert.strictEqual(r.required_annual_decrease, 166.67);
});

console.log('\nYear with actuals over target (2024)');

test('2024 achieved is false (700 > 666.67)', () => {
  const r = rows.find(r => r.year === 2024);
  assert.strictEqual(r.achieved, false);
});

test('2024 gap_to_allowed is positive (over target)', () => {
  const r = rows.find(r => r.year === 2024);
  assert.ok(r.gap_to_allowed > 0, `Expected gap > 0, got ${r.gap_to_allowed}`);
});

test('2024 required_annual_decrease = 833.33 - 666.67', () => {
  const r = rows.find(r => r.year === 2024);
  assert.strictEqual(r.required_annual_decrease, 166.66);
});

test('2024 actual_annual_decrease = 800 - 700 (prev actual was 800)', () => {
  const r = rows.find(r => r.year === 2024);
  assert.strictEqual(r.actual_annual_decrease, 100);
});

console.log('\nYear without actuals (2025)');

test('2025 data_status is MISSING_ACTUAL', () => {
  const r = rows.find(r => r.year === 2025);
  assert.strictEqual(r.data_status, 'MISSING_ACTUAL');
});

test('2025 actual_emissions is null', () => {
  const r = rows.find(r => r.year === 2025);
  assert.strictEqual(r.actual_emissions, null);
});

test('2025 achieved is null when no actual', () => {
  const r = rows.find(r => r.year === 2025);
  assert.strictEqual(r.achieved, null);
});

test('2025 gap_to_allowed is null when no actual', () => {
  const r = rows.find(r => r.year === 2025);
  assert.strictEqual(r.gap_to_allowed, null);
});

test('2025 remaining_to_final_target is null when no actual', () => {
  const r = rows.find(r => r.year === 2025);
  assert.strictEqual(r.remaining_to_final_target, null);
});

console.log('\nRow count and structure');

test('Total row count = target_year - base_year + 1 (inclusive)', () => {
  assert.strictEqual(rows.length, 4); // 2022,2023,2024,2025
});

test('Last row is target_year', () => {
  assert.strictEqual(rows[rows.length - 1].year, 2025);
});

test('Non-base rows all have is_base_year=false', () => {
  for (const r of rows.filter(x => x.year !== 2022)) {
    assert.strictEqual(r.is_base_year, false, `Year ${r.year} should have is_base_year=false`);
  }
});

test('All pathway years have required_allowed_emissions set', () => {
  for (const r of rows.filter(x => !x.is_base_year)) {
    assert.ok(r.required_allowed_emissions !== null, `Year ${r.year} missing required_allowed_emissions`);
  }
});

console.log('\nNo duplicate snapshots — same year upsert');

test('Building rows with duplicate snapshot year keeps last value', () => {
  // Simulates re-running computeProgress for same year; snapshotByYear map overwrites
  const dupSnapshots = [
    { calendar_year: 2023, actual_emissions: 850, progress_status: 'On_Track', m1_summary_id: null },
    { calendar_year: 2023, actual_emissions: 800, progress_status: 'Ahead_of_Target', m1_summary_id: null },
  ];
  const r = buildTrajectoryRows(target, pathway, dupSnapshots).find(x => x.year === 2023);
  // Last entry in the array wins in the snapshotByYear map
  assert.strictEqual(r.actual_emissions, 800);
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
