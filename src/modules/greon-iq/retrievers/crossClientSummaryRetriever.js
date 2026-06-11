'use strict';

// ============================================================================
// crossClientSummaryRetriever.js — Ranks all accessible clients by their
// latest total emission summary.
//
// Called when intent === 'cross_client_summary' (e.g. "which client has the
// highest emissions", "rank all my clients by CO2e", "top emitting clients").
//
// plan.requestingUser is injected by the controller (same pattern as
// userDataRetriever) so the retriever can call resolveAccessibleClients.
// ============================================================================

const EmissionSummary = require('../../../modules/zero-carbon/calculation/EmissionSummary');
const Client          = require('../../client-management/client/Client');
const { resolveAccessibleClients } = require('../services/clientScopeResolver');

const MAX_CLIENTS = 100; // hard cap to keep the aggregate reasonable

async function retrieve(plan, _accessContext) {
  const { requestingUser, dateRange } = plan;

  if (!requestingUser) {
    return {
      data:        { clients: [], total: 0 },
      exclusions:  ['User context unavailable.'],
      recordCount: 0,
    };
  }

  // ── 1. Resolve accessible client list ────────────────────────────────────
  let accessibleClients;
  if (requestingUser.userType === 'super_admin') {
    const docs = await Client.find(
      { isDeleted: { $ne: true } },
      { clientId: 1, 'leadInfo.companyName': 1 }
    ).limit(MAX_CLIENTS).lean().catch(() => []);

    accessibleClients = docs.map((c) => ({
      clientId:    c.clientId,
      companyName: c.leadInfo?.companyName || c.clientId,
    }));
  } else {
    accessibleClients = await resolveAccessibleClients(requestingUser);
  }

  if (!accessibleClients || accessibleClients.length === 0) {
    return {
      data:        { clients: [], total: 0 },
      exclusions:  ['No accessible clients found for your account.'],
      recordCount: 0,
    };
  }

  const clientIds = accessibleClients.map((c) => c.clientId);
  const nameMap   = Object.fromEntries(accessibleClients.map((c) => [c.clientId, c.companyName || c.clientId]));

  // ── 2. Date filter ────────────────────────────────────────────────────────
  const matchStage = {
    clientId:  { $in: clientIds },
    isDeleted: { $ne: true },
  };
  if (dateRange?.startDate) matchStage['period.startDate'] = { $gte: dateRange.startDate };
  if (dateRange?.endDate)   matchStage['period.endDate']   = { $lte: dateRange.endDate };

  // ── 3. Aggregate: latest record per client ranked by total emissions ──────
  const pipeline = [
    { $match: matchStage },
    { $sort:  { 'period.startDate': -1, 'period.from': -1 } },
    {
      $group: {
        _id:          '$clientId',
        latestPeriod: { $first: '$period' },
        // prefer nested emissionSummary.totalEmissions.CO2e, fall back to legacy root fields
        totalCO2e: {
          $first: {
            $ifNull: [
              '$emissionSummary.totalEmissions.CO2e',
              { $ifNull: ['$totalEmissions.CO2e', '$totalEmissions'] },
            ],
          },
        },
        byScope: {
          $first: { $ifNull: ['$emissionSummary.byScope', '$byScope'] },
        },
      },
    },
    { $sort: { totalCO2e: -1 } },
    { $limit: 50 },
  ];

  const results = await EmissionSummary.aggregate(pipeline).catch(() => []);

  // ── 4. Shape output ───────────────────────────────────────────────────────
  const clients = results.map((r) => ({
    clientId:    r._id,
    companyName: nameMap[r._id] || r._id,
    period:      r.latestPeriod,
    totalCO2e:   typeof r.totalCO2e === 'number' ? r.totalCO2e : 0,
    byScope:     r.byScope || null,
  }));

  const exclusions = [];
  const noDataCount = clientIds.length - results.length;
  if (noDataCount > 0) {
    exclusions.push(`${noDataCount} client(s) had no emission records for the selected period`);
  }
  if (accessibleClients.length >= MAX_CLIENTS) {
    exclusions.push(`Results limited to ${MAX_CLIENTS} clients`);
  }

  return {
    data: {
      clients,
      total:              clients.length,
      totalClientsChecked: clientIds.length,
    },
    exclusions,
    recordCount: clients.length,
  };
}

module.exports = { retrieve };
