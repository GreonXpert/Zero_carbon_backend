'use strict';

// ============================================================================
// clientComparisonRetriever.js — Fetches emission summary data for multiple
// clients in parallel and returns a combined per-client payload.
//
// Called when intent === 'client_comparison'.
// plan.clientIds must be an array of ≥ 2 validated clientIds.
// ============================================================================

const EmissionSummary = require('../../../modules/zero-carbon/calculation/EmissionSummary');
const Client          = require('../../client-management/client/Client');
const { safeFindMany }        = require('../utils/decryptSafeReader');
const { explainNoData, explainTruncation } = require('../utils/exclusionExplainer');

const PER_CLIENT_LIMIT = 10;

async function retrieve(plan, _accessContext) {
  const { clientIds, dateRange, maxRecords } = plan;

  if (!Array.isArray(clientIds) || clientIds.length < 2) {
    return {
      data:       { clients: {}, clientIds: [] },
      exclusions: ['Comparison requires at least 2 clients.'],
      recordCount: 0,
    };
  }

  // ── Date filter ─────────────────────────────────────────────────────────────
  const dateFilter = {};
  if (dateRange?.startDate) dateFilter['period.startDate'] = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   dateFilter['period.endDate']   = { $lte: dateRange.endDate };

  // ── Fetch display names in one query ────────────────────────────────────────
  const clientDocs = await Client.find(
    { clientId: { $in: clientIds }, isDeleted: { $ne: true } },
    { clientId: 1, 'leadInfo.companyName': 1 }
  ).lean().catch(() => []);

  const clientNames = {};
  for (const doc of clientDocs) {
    clientNames[doc.clientId] = doc.leadInfo?.companyName || doc.clientId;
  }

  // ── Projection — overview + byScope only (comparison needs summary, not detail) ──
  const projection = {
    clientId: 1,
    period:   1,
    'emissionSummary.totalEmissions': 1,
    'emissionSummary.byScope':        1,
    totalEmissions: 1,   // backward-compat root fields
    byScope:        1,
  };

  const perLimit = Math.max(3, Math.floor(
    ((maxRecords || PER_CLIENT_LIMIT * clientIds.length) / clientIds.length)
  ));

  // ── Parallel fetch ───────────────────────────────────────────────────────────
  const results = await Promise.all(
    clientIds.map(async (clientId) => {
      try {
        const { docs, totalFound, wasTruncated } = await safeFindMany(
          EmissionSummary,
          { clientId, isDeleted: { $ne: true }, ...dateFilter },
          projection,
          { sort: { 'period.from': -1, 'period.startDate': -1 } },
          perLimit
        );

        const exclusions = [];
        if (wasTruncated)    exclusions.push(explainTruncation(totalFound, docs.length));
        if (docs.length === 0) exclusions.push(explainNoData('emission_summary', dateRange));

        return {
          clientId,
          companyName: clientNames[clientId] || clientId,
          summaries: docs.map((s) => ({
            period:         s.period,
            totalEmissions: s.emissionSummary?.totalEmissions ?? s.totalEmissions ?? null,
            byScope:        s.emissionSummary?.byScope        ?? s.byScope        ?? null,
          })),
          exclusions,
          recordCount: docs.length,
        };
      } catch (_) {
        return {
          clientId,
          companyName: clientNames[clientId] || clientId,
          summaries:   [],
          exclusions:  ['data unavailable'],
          recordCount: 0,
        };
      }
    })
  );

  // ── Combine ──────────────────────────────────────────────────────────────────
  const clients     = {};
  const allExclusions = [];
  let   totalRecords  = 0;

  for (const r of results) {
    clients[r.clientId] = { companyName: r.companyName, summaries: r.summaries };
    if (r.exclusions.length) {
      allExclusions.push(...r.exclusions.map((e) => `${r.companyName}: ${e}`));
    }
    totalRecords += r.recordCount;
  }

  return {
    data:        { clients, clientIds },
    exclusions:  allExclusions,
    recordCount: totalRecords,
  };
}

module.exports = { retrieve };
