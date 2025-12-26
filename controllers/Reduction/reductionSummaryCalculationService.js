/**
 * services/Reduction/reductionSummaryCalculationService.js
 * ------------------------------------------------------
 * Builds the NEW calculationSummary object for ReductionSummary.
 *
 * ✅ Backward compatible: it only ADDS fields.
 * ✅ Uses MongoDB aggregations to avoid N+1 queries.
 * ✅ Safe math (divide-by-zero, missing target, empty data).
 */

const moment = require('moment');
const NetReductionEntry = require('../../models/Reduction/NetReductionEntry');
const Reduction = require('../../models/Reduction/Reduction');
const SbtiTarget = require('../../models/Decarbonization/SbtiTarget');

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function round6(n) {
  return Math.round(safeNumber(n) * 1e6) / 1e6;
}

function safePercent(numerator, denominator) {
  const num = safeNumber(numerator);
  const den = safeNumber(denominator);
  if (den <= 0) return 0;
  return (num / den) * 100;
}

function trendDirectionFromPercent(p) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return null;
  const v = Number(p);
  if (Math.abs(v) < 0.000001) return 'flat';
  return v > 0 ? 'up' : 'down';
}

function getPrevRange(periodType, from, to) {
  const start = moment.utc(from);
  const end = moment.utc(to);
  const durationMs = end.diff(start);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    // fallback: previous month
    const prevFrom = moment.utc(from).subtract(1, 'month').startOf('month');
    const prevTo = moment.utc(from).subtract(1, 'month').endOf('month');
    return { prevFrom: prevFrom.toDate(), prevTo: prevTo.toDate() };
  }

  // Keep “same length” window immediately before current window.
  const prevTo = start.clone().subtract(1, 'millisecond');
  const prevFrom = prevTo.clone().subtract(durationMs, 'milliseconds');
  return { prevFrom: prevFrom.toDate(), prevTo: prevTo.toDate() };
}

async function getClientTargetEmissionReduction(clientId) {
  // “SBTI Target is Decarbonisation” → SbtiTarget is our source of target.
  // We pick the most recently updated target for the client.
  const sbti = await SbtiTarget.findOne({ clientId }).sort({ updatedAt: -1, createdAt: -1 }).lean();
  if (!sbti) return 0;

  const base = safeNumber(sbti.baseEmission_tCO2e);

  // Prefer trajectory point for targetYear
  let targetEmission = null;
  if (Array.isArray(sbti.trajectory) && sbti.trajectory.length) {
    const tp = sbti.trajectory.find((t) => Number(t.year) === Number(sbti.targetYear)) || sbti.trajectory[sbti.trajectory.length - 1];
    targetEmission = tp ? safeNumber(tp.targetEmission_tCO2e) : null;
  }

  // Fallback: absolute method min reduction percent
  if (targetEmission === null) {
    const minRedPct = safeNumber(sbti.absolute?.minimumReductionPercent);
    if (minRedPct > 0 && base > 0) {
      targetEmission = base * (1 - minRedPct / 100);
    }
  }

  if (targetEmission === null) return 0;

  const requiredReduction = Math.max(0, base - targetEmission);
  return round6(requiredReduction);
}

function sourceLabelFromEntry(e) {
  const sd = e?.sourceDetails || {};
  return (
    sd.dataSource ||
    sd.apiEndpoint ||
    sd.iotDeviceId ||
    sd.fileName ||
    e.inputType ||
    'Unknown'
  );
}

/**
 * Compute trendPercent per project series by comparing each point with previous point.
 * Assumes series is sorted by periodKey.
 */
function attachSeriesTrend(series) {
  const byProject = new Map();
  for (const row of series) {
    const k = row.projectId;
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k).push(row);
  }
  for (const rows of byProject.values()) {
    // already sorted globally; just compute sequentially
    for (let i = 0; i < rows.length; i++) {
      const cur = rows[i];
      const prev = rows[i - 1];
      if (!prev) {
        cur.trendPercent = null;
        cur.trendDirection = null;
        continue;
      }
      const prevVal = safeNumber(prev.emissionReductionValue);
      const curVal = safeNumber(cur.emissionReductionValue);
      if (prevVal === 0) {
        cur.trendPercent = null;
        cur.trendDirection = null;
        continue;
      }
      const pct = ((curVal - prevVal) / prevVal) * 100;
      cur.trendPercent = round6(pct);
      cur.trendDirection = trendDirectionFromPercent(cur.trendPercent);
    }
  }
  return series;
}

async function buildTrendSeries({ clientId, to }) {
  const reductionColl = Reduction.collection.name;

  // Monthly: last 12 months
  const monthStart = moment.utc(to).startOf('month').subtract(11, 'months').toDate();
  const qStart = moment.utc(to).startOf('quarter').subtract(7, 'quarters').toDate();
  const yStart = moment.utc(to).startOf('year').subtract(4, 'years').toDate();

  const monthly = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: monthStart, $lte: to } } },
    {
      $addFields: {
        year: { $year: '$timestamp' },
        month: { $month: '$timestamp' },
      },
    },
    {
      $group: {
        _id: { projectId: '$projectId', year: '$year', month: '$month' },
        emissionReductionValue: { $sum: '$netReduction' },
      },
    },
    {
      $lookup: {
        from: reductionColl,
        localField: '_id.projectId',
        foreignField: 'projectId',
        as: 'project',
      },
    },
    { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        projectId: '$_id.projectId',
        projectName: { $ifNull: ['$project.projectName', '$_id.projectId'] },
        periodKey: {
          $concat: [
            { $toString: '$_id.year' },
            '-',
            {
              $cond: [
                { $lt: ['$_id.month', 10] },
                { $concat: ['0', { $toString: '$_id.month' }] },
                { $toString: '$_id.month' },
              ],
            },
          ],
        },
        emissionReductionValue: { $round: ['$emissionReductionValue', 6] },
      },
    },
    { $sort: { projectId: 1, periodKey: 1 } },
  ]);

  const quarterly = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: qStart, $lte: to } } },
    {
      $addFields: {
        year: { $year: '$timestamp' },
        month: { $month: '$timestamp' },
      },
    },
    {
      $addFields: {
        quarter: {
          $add: [{ $floor: { $divide: [{ $subtract: ['$month', 1] }, 3] } }, 1],
        },
      },
    },
    {
      $group: {
        _id: { projectId: '$projectId', year: '$year', quarter: '$quarter' },
        emissionReductionValue: { $sum: '$netReduction' },
      },
    },
    {
      $lookup: {
        from: reductionColl,
        localField: '_id.projectId',
        foreignField: 'projectId',
        as: 'project',
      },
    },
    { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        projectId: '$_id.projectId',
        projectName: { $ifNull: ['$project.projectName', '$_id.projectId'] },
        periodKey: {
          $concat: [
            { $toString: '$_id.year' },
            '-Q',
            { $toString: '$_id.quarter' },
          ],
        },
        emissionReductionValue: { $round: ['$emissionReductionValue', 6] },
      },
    },
    { $sort: { projectId: 1, periodKey: 1 } },
  ]);

  const yearly = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: yStart, $lte: to } } },
    { $addFields: { year: { $year: '$timestamp' } } },
    {
      $group: {
        _id: { projectId: '$projectId', year: '$year' },
        emissionReductionValue: { $sum: '$netReduction' },
      },
    },
    {
      $lookup: {
        from: reductionColl,
        localField: '_id.projectId',
        foreignField: 'projectId',
        as: 'project',
      },
    },
    { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        projectId: '$_id.projectId',
        projectName: { $ifNull: ['$project.projectName', '$_id.projectId'] },
        periodKey: { $toString: '$_id.year' },
        emissionReductionValue: { $round: ['$emissionReductionValue', 6] },
      },
    },
    { $sort: { projectId: 1, periodKey: 1 } },
  ]);

  return {
    monthly: attachSeriesTrend(monthly),
    quarterly: attachSeriesTrend(quarterly),
    yearly: attachSeriesTrend(yearly),
  };
}

async function buildPeriodTotals({ clientId, from, to }) {
  // total in current period
  const curAgg = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: from, $lte: to } } },
    { $group: { _id: null, total: { $sum: '$netReduction' } } },
  ]);
  const totalNetReduction = round6(curAgg?.[0]?.total || 0);
  return { totalNetReduction };
}

async function buildMechanismSplit({ clientId, from, to }) {
  const reductionColl = Reduction.collection.name;
  const rows = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: from, $lte: to } } },
    {
      $lookup: {
        from: reductionColl,
        localField: 'projectId',
        foreignField: 'projectId',
        as: 'project',
      },
    },
    { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: { activity: { $ifNull: ['$project.projectActivity', 'unknown'] } },
        total: { $sum: '$netReduction' },
      },
    },
  ]);

  let totalReduction = 0;
  let totalRemoval = 0;

  for (const r of rows) {
    const act = (r._id?.activity || 'unknown').toLowerCase();
    if (act === 'reduction') totalReduction += safeNumber(r.total);
    else if (act === 'removal') totalRemoval += safeNumber(r.total);
    // unknown is ignored in split totals
  }

  const grand = totalReduction + totalRemoval;
  return {
    totalReduction: round6(totalReduction),
    totalRemoval: round6(totalRemoval),
    reductionPercent: round6(safePercent(totalReduction, grand)),
    removalPercent: round6(safePercent(totalRemoval, grand)),
  };
}

async function buildTopSources({ clientId, from, to, prevFrom, prevTo }) {
  // We derive “source” from NetReductionEntry.sourceDetails.
  // Trend compares with previous period (same duration window).

  const cur = await NetReductionEntry.find({ clientId, timestamp: { $gte: from, $lte: to } })
    .select('projectId netReduction sourceDetails inputType')
    .lean();

  const prev = await NetReductionEntry.find({ clientId, timestamp: { $gte: prevFrom, $lte: prevTo } })
    .select('projectId netReduction sourceDetails inputType')
    .lean();

  const projectIds = [...new Set([...cur, ...prev].map((e) => e.projectId))];
  const projects = await Reduction.find({ clientId, projectId: { $in: projectIds } })
    .select('projectId projectActivity category')
    .lean();
  const projectMeta = new Map(projects.map((p) => [p.projectId, p]));

  function group(list) {
    const m = new Map();
    for (const e of list) {
      const meta = projectMeta.get(e.projectId) || {};
      const source = sourceLabelFromEntry(e);
      const type = meta.projectActivity || 'unknown';
      const category = meta.category || 'Unknown';
      const key = `${source}||${type}||${category}`;
      m.set(key, (m.get(key) || 0) + safeNumber(e.netReduction));
    }
    return m;
  }

  const curMap = group(cur);
  const prevMap = group(prev);

  const rows = [];
  for (const [key, val] of curMap.entries()) {
    const [source, type, category] = key.split('||');
    const prevVal = safeNumber(prevMap.get(key) || 0);
    const trend = prevVal > 0 ? round6(((val - prevVal) / prevVal) * 100) : null;
    rows.push({
      source,
      type,
      category,
      emissionReduction: round6(val),
      trend,
    });
  }

  rows.sort((a, b) => safeNumber(b.emissionReduction) - safeNumber(a.emissionReduction));
  return rows.slice(0, 50); // safety cap
}

async function buildProcessProductAnalysis({ clientId, from, to, prevFrom, prevTo }) {
  // Intensity: sum(netReduction) / sum(inputValue) if available.
  // processName/unit are not guaranteed in models → provide best-effort mapping.
  const curAgg = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: '$projectId',
        emissionReduction: { $sum: '$netReduction' },
        output: { $sum: { $ifNull: ['$inputValue', 0] } },
      },
    },
  ]);

  const prevAgg = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: prevFrom, $lte: prevTo } } },
    { $group: { _id: '$projectId', emissionReduction: { $sum: '$netReduction' } } },
  ]);
  const prevMap = new Map(prevAgg.map((r) => [r._id, safeNumber(r.emissionReduction)]));

  const projectIds = curAgg.map((r) => r._id);
  const projects = await Reduction.find({ clientId, projectId: { $in: projectIds } })
    .select('projectId projectName status processFlow')
    .lean();
  const meta = new Map(projects.map((p) => [p.projectId, p]));

  return curAgg
    .map((r) => {
      const p = meta.get(r._id) || {};
      const curVal = safeNumber(r.emissionReduction);
      const prevVal = safeNumber(prevMap.get(r._id) || 0);
      const trend = prevVal > 0 ? round6(((curVal - prevVal) / prevVal) * 100) : null;

      const output = safeNumber(r.output);
      const intensity = output > 0 ? round6(curVal / output) : null;

      // best effort processName
      const processName =
        p?.processFlow?.snapshot?.name ||
        p?.processFlow?.snapshot?.title ||
        p?.processFlow?.snapshot?.processName ||
        null;

      return {
        project: p.projectName || r._id,
        projectId: r._id,
        processName,
        unit: null,
        emissionReduction: round6(curVal),
        intensity,
        trend,
        status: p.status || 'unknown',
      };
    })
    .sort((a, b) => safeNumber(b.emissionReduction) - safeNumber(a.emissionReduction))
    .slice(0, 200);
}

async function buildPeriodComparison({ clientId, from, to, prevFrom, prevTo }) {
  const curAgg = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: from, $lte: to } } },
    { $group: { _id: '$projectId', emissionReduction: { $sum: '$netReduction' } } },
  ]);
  const prevAgg = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: prevFrom, $lte: prevTo } } },
    { $group: { _id: '$projectId', emissionReduction: { $sum: '$netReduction' } } },
  ]);

  const prevMap = new Map(prevAgg.map((r) => [r._id, safeNumber(r.emissionReduction)]));
  const projectIds = [...new Set([...curAgg, ...prevAgg].map((r) => r._id))];
  const projects = await Reduction.find({ clientId, projectId: { $in: projectIds } })
    .select('projectId projectName')
    .lean();
  const nameMap = new Map(projects.map((p) => [p.projectId, p.projectName]));

  const rows = projectIds.map((pid) => {
    const curVal = safeNumber(curAgg.find((x) => x._id === pid)?.emissionReduction || 0);
    const prevVal = safeNumber(prevMap.get(pid) || 0);
    const delta = round6(curVal - prevVal);
    const deltaPercent = prevVal > 0 ? round6((delta / prevVal) * 100) : null;
    return {
      project: nameMap.get(pid) || pid,
      projectId: pid,
      emissionReduction: round6(curVal),
      previousEmissionReduction: round6(prevVal),
      delta,
      deltaPercent,
    };
  });

  rows.sort((a, b) => safeNumber(b.emissionReduction) - safeNumber(a.emissionReduction));
  return rows;
}

async function buildCategoryPriorities({ clientId, from, to, prevFrom, prevTo, totalNetReduction }) {
  const cur = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: from, $lte: to } } },
    {
      $lookup: {
        from: Reduction.collection.name,
        localField: 'projectId',
        foreignField: 'projectId',
        as: 'project',
      },
    },
    { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: { $ifNull: ['$project.category', 'Unknown'] },
        total: { $sum: '$netReduction' },
      },
    },
  ]);

  const prev = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: prevFrom, $lte: prevTo } } },
    {
      $lookup: {
        from: Reduction.collection.name,
        localField: 'projectId',
        foreignField: 'projectId',
        as: 'project',
      },
    },
    { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
    { $group: { _id: { $ifNull: ['$project.category', 'Unknown'] }, total: { $sum: '$netReduction' } } },
  ]);
  const prevMap = new Map(prev.map((r) => [r._id, safeNumber(r.total)]));

  const rows = cur
    .map((r) => {
      const curVal = safeNumber(r.total);
      const prevVal = safeNumber(prevMap.get(r._id) || 0);
      const trend = prevVal > 0 ? round6(((curVal - prevVal) / prevVal) * 100) : null;
      return {
        category: r._id,
        totalEmissionReduction: round6(curVal),
        sharePercent: round6(safePercent(curVal, totalNetReduction)),
        trend,
      };
    })
    .sort((a, b) => safeNumber(b.totalEmissionReduction) - safeNumber(a.totalEmissionReduction));

  return rows;
}

async function buildDataCompleteness({ clientId, from, to }) {
  // Fallback completeness logic:
  //  - requiredPoints = count(active projects)
  //  - filledPoints = count(projects that have at least one entry in the period)

  const projects = await Reduction.find({ clientId, isDeleted: { $ne: true } })
    .select('projectId projectName status')
    .lean();

  const totalProjects = projects.length;
  if (totalProjects === 0) {
    return {
      overall: 0,
      byProject: [],
      meta: { totalProjects: 0, projectsWithData: 0, strategy: 'fallback_project_has_entry' },
    };
  }

  const withData = await NetReductionEntry.aggregate([
    { $match: { clientId, timestamp: { $gte: from, $lte: to } } },
    { $group: { _id: '$projectId' } },
  ]);
  const withDataSet = new Set(withData.map((x) => x._id));
  const projectsWithData = withDataSet.size;

  const byProject = projects.map((p) => ({
    projectName: p.projectName || p.projectId,
    projectId: p.projectId,
    percentage: withDataSet.has(p.projectId) ? 100 : 0,
  }));

  const overall = round6((projectsWithData / totalProjects) * 100);
  return {
    overall,
    byProject,
    meta: { totalProjects, projectsWithData, strategy: 'fallback_project_has_entry' },
  };
}

/**
 * MAIN BUILDER
 */
async function buildReductionCalculationSummary({ clientId, periodType, from, to }) {
  const computedAt = new Date();
  const { prevFrom, prevTo } = getPrevRange(periodType, from, to);

  const [{ totalNetReduction }, target, completeness, trendChart, mechanismSplit, topSources, processProductAnalysis, periodComparisonBase] =
    await Promise.all([
      buildPeriodTotals({ clientId, from, to }),
      getClientTargetEmissionReduction(clientId),
      buildDataCompleteness({ clientId, from, to }),
      buildTrendSeries({ clientId, to }),
      buildMechanismSplit({ clientId, from, to }),
      buildTopSources({ clientId, from, to, prevFrom, prevTo }),
      buildProcessProductAnalysis({ clientId, from, to, prevFrom, prevTo }),
      buildPeriodComparison({ clientId, from, to, prevFrom, prevTo }),
    ]);

  const totalTargetEmissionReduction = round6(target);
  const achievementPercentage = round6(safePercent(totalNetReduction, totalTargetEmissionReduction));

  const categoryPriorities = await buildCategoryPriorities({
    clientId,
    from,
    to,
    prevFrom,
    prevTo,
    totalNetReduction,
  });

  return {
    // 1) Core KPIs
    totalNetReduction: round6(totalNetReduction),
    totalTargetEmissionReduction,
    achievementPercentage,
    dataCompletenessPercentage: round6(completeness.overall),

    // 2) Trend Chart Data
    trendChart,

    // 3) GHG Mechanism Split
    ghgMechanismSplit: mechanismSplit,

    // 4) Top Source Table
    topSources,

    // 5) Process & Product Analysis
    processProductAnalysis,

    // 6) Period Comparison
    periodComparison: periodComparisonBase,

    // 7) Data Completeness Per Project
    dataCompletenessByProject: completeness.byProject,

    // 8) Category Priorities
    categoryPriorities,

    // Meta
    meta: {
      periodType,
      from,
      to,
      computedAt,
      prevFrom,
      prevTo,
      completenessStrategy: completeness.meta?.strategy || 'unknown',
    },
  };
}

module.exports = {
  buildReductionCalculationSummary,
};
