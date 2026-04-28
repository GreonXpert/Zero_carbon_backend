'use strict';

/**
 * Unit tests for emissionSummaryScopeService — pure logic, no DB required.
 *
 * Run: node src/tests/m3/test.emissionScope.js
 * Exit 0 = all pass, Exit 1 = failures.
 */

const assert = require('assert');
const {
  getScopesForBoundary,
  extractCO2eForScopeBoundary,
} = require('../../modules/zero-carbon/m3/services/emissionSummaryScopeService');

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

// ─── getScopesForBoundary ──────────────────────────────────────────────────────

console.log('\ngetScopesForBoundary');

test('S1 returns only Scope 1', () => {
  assert.deepStrictEqual(getScopesForBoundary('S1'), ['Scope 1']);
});

test('S1S2 returns Scope 1 and Scope 2', () => {
  assert.deepStrictEqual(getScopesForBoundary('S1S2'), ['Scope 1', 'Scope 2']);
});

test('S3 returns only Scope 3', () => {
  assert.deepStrictEqual(getScopesForBoundary('S3'), ['Scope 3']);
});

test('S1S2S3 returns all three scopes in order', () => {
  assert.deepStrictEqual(getScopesForBoundary('S1S2S3'), ['Scope 1', 'Scope 2', 'Scope 3']);
});

test('Unknown boundary throws 422', () => {
  try {
    getScopesForBoundary('INVALID');
    assert.fail('Expected error to be thrown');
  } catch (e) {
    assert.strictEqual(e.status, 422);
  }
});

// ─── extractCO2eForScopeBoundary ──────────────────────────────────────────────

console.log('\nextractCO2eForScopeBoundary');

const mockDoc = {
  _id: 'mock-id',
  emissionSummary: {
    totalEmissions: { CO2e: 900 },
    byScope: {
      'Scope 1': { CO2e: 300 },
      'Scope 2': { CO2e: 200 },
      'Scope 3': { CO2e: 400 },
    },
  },
};

test('S1 uses only Scope 1', () => {
  const { CO2e } = extractCO2eForScopeBoundary(mockDoc, 'S1');
  assert.strictEqual(CO2e, 300);
});

test('S1S2 sums Scope 1 + Scope 2', () => {
  const { CO2e } = extractCO2eForScopeBoundary(mockDoc, 'S1S2');
  assert.strictEqual(CO2e, 500);
});

test('S3 uses only Scope 3', () => {
  const { CO2e } = extractCO2eForScopeBoundary(mockDoc, 'S3');
  assert.strictEqual(CO2e, 400);
});

test('S1S2S3 sums all three scopes', () => {
  const { CO2e } = extractCO2eForScopeBoundary(mockDoc, 'S1S2S3');
  assert.strictEqual(CO2e, 900);
});

test('S1S2S3 result equals Scope1+Scope2+Scope3 not totalEmissions', () => {
  const docWithDifferentTotal = {
    _id: 'x',
    emissionSummary: {
      totalEmissions: { CO2e: 9999 },
      byScope: {
        'Scope 1': { CO2e: 100 },
        'Scope 2': { CO2e: 100 },
        'Scope 3': { CO2e: 100 },
      },
    },
  };
  const { CO2e } = extractCO2eForScopeBoundary(docWithDifferentTotal, 'S1S2S3');
  assert.strictEqual(CO2e, 300);
});

test('Missing byScope falls back to totalEmissions.CO2e', () => {
  const docNoByScopeData = {
    _id: 'y',
    emissionSummary: { totalEmissions: { CO2e: 777 } },
  };
  const { CO2e, usedFallback } = extractCO2eForScopeBoundary(docNoByScopeData, 'S1S2');
  assert.strictEqual(CO2e, 777);
  assert.strictEqual(usedFallback, true);
});

test('Missing individual scope key treated as 0', () => {
  const docMissingS3 = {
    _id: 'z',
    emissionSummary: {
      totalEmissions: { CO2e: 500 },
      byScope: {
        'Scope 1': { CO2e: 300 },
        'Scope 2': { CO2e: 200 },
        // Scope 3 absent
      },
    },
  };
  const { CO2e } = extractCO2eForScopeBoundary(docMissingS3, 'S1S2S3');
  assert.strictEqual(CO2e, 500); // 300+200+0
});

test('scopeBreakdown contains all three values', () => {
  const { scopeBreakdown } = extractCO2eForScopeBoundary(mockDoc, 'S1');
  assert.strictEqual(scopeBreakdown.scope1, 300);
  assert.strictEqual(scopeBreakdown.scope2, 200);
  assert.strictEqual(scopeBreakdown.scope3, 400);
});

test('usedFallback is false when byScope is present', () => {
  const { usedFallback } = extractCO2eForScopeBoundary(mockDoc, 'S1S2');
  assert.strictEqual(usedFallback, false);
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
