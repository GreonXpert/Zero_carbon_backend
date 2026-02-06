/**
 * Compare Mode (Selection A vs Selection B)
 * Robust version:
 *  - Works even if nodeIds/scopes are NOT provided (treats as "All")
 *  - Accepts BOTH request shapes:
 *      selectionA: { nodeIds: [...] }
 *    AND
 *      selectionA: { filters: { nodeIds: [...] } }
 *  - Fixes the BIG bug: if A has nodeIds/scopes but B is empty (All),
 *    DB query MUST NOT be restricted to A’s nodeIds/scopes (otherwise B becomes wrong).
 *
 * POST /api/summaries/:clientId/compare
 */
const compareSummarySelections = async (req, res) => {
  try {
    const { clientId } = req.params;
    const body = req.body || {};

    // Parse request parameters
    const periodType = String(body.periodType || req.query.periodType || "monthly").toLowerCase();
    
    const allowedBuckets = new Set(["monthly", "weekly", "daily"]);
    const bucket = allowedBuckets.has(String(body.bucket || req.query.bucket || "monthly").toLowerCase())
      ? String(body.bucket || req.query.bucket || "monthly").toLowerCase()
      : "monthly";

    const allowedStackBy = new Set(["scope", "category", "activity", "node", "department", "location"]);
    const stackBy = allowedStackBy.has(String(body.stackBy || req.query.stackBy || "category").toLowerCase())
      ? String(body.stackBy || req.query.stackBy || "category").toLowerCase()
      : "category";

    const selectionA = body.selectionA || {};
    const selectionB = body.selectionB || {};

    // -----------------------
    // Helpers: normalize filters
    // -----------------------
    const toArray = (v) => {
      if (v == null) return [];
      if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
      if (typeof v === "string") return v.split(",").map(s => s.trim()).filter(Boolean);
      return [];
    };

    const stripAllTokens = (arr) => {
      const lowered = arr.map(x => String(x).toLowerCase());
      const hasAll = lowered.some(x =>
        x === "all" ||
        x.includes("all locations") ||
        x.includes("all scopes") ||
        x.includes("all categories") ||
        x.includes("all activities") ||
        x.includes("all departments") ||
        x.includes("all nodes")
      );
      return hasAll ? [] : arr;
    };

    const unwrapSelection = (sel) => {
      if (!sel || typeof sel !== "object") return {};
      const f = sel.filters && typeof sel.filters === "object" ? sel.filters : {};
      return { ...sel, ...f };
    };

    const normalizeSelection = (sel) => {
      const s = unwrapSelection(sel);
      const nodeIds = s.nodeIds ?? s.nodeId ?? s.nodes;
      const scopes = s.scopes ?? s.scope ?? s.scopeTypes;

      return {
        locations: stripAllTokens(toArray(s.locations)),
        departments: stripAllTokens(toArray(s.departments)),
        nodeIds: stripAllTokens(toArray(nodeIds)),
        scopes: stripAllTokens(toArray(scopes)),
        categories: stripAllTokens(toArray(s.categories)),
        activities: stripAllTokens(toArray(s.activities)),
      };
    };

    const A = normalizeSelection(selectionA);
    const B = normalizeSelection(selectionB);

    // -----------------------
    // Resolve period
    // -----------------------
    const y = Number(body.year || req.query.year) || moment.utc().year();
    const m = Number(body.month || req.query.month) || (moment.utc().month() + 1);
    const w = Number(body.week || req.query.week) || 1;
    const d = Number(body.day || req.query.day) || 1;

    let startDate, endDate;

    if (body.from || req.query.from) {
      startDate = moment.utc(body.from || req.query.from);
      endDate = moment.utc(body.to || req.query.to || body.from || req.query.from);
      if (!endDate.isValid()) endDate = moment.utc(startDate).endOf("day");
    } else {
      if (periodType === "all-time") {
        startDate = moment.utc("1970-01-01").startOf("day");
        endDate = moment.utc().endOf("day");
      } else if (periodType === "daily") {
        startDate = moment.utc({ year: y, month: m - 1, day: d }).startOf("day");
        endDate = moment.utc({ year: y, month: m - 1, day: d }).endOf("day");
      } else if (periodType === "weekly") {
        startDate = moment.utc().year(y).isoWeek(w).startOf("isoWeek");
        endDate = moment.utc().year(y).isoWeek(w).endOf("isoWeek");
      } else if (periodType === "monthly") {
        startDate = moment.utc({ year: y, month: m - 1 }).startOf("month");
        endDate = moment.utc({ year: y, month: m - 1 }).endOf("month");
      } else {
        startDate = moment.utc({ year: y }).startOf("year");
        endDate = moment.utc({ year: y }).endOf("year");
      }
    }

    if (!startDate.isValid() || !endDate.isValid() || startDate.isAfter(endDate)) {
      return res.status(400).json({ success: false, message: "Invalid date range" });
    }

    // -----------------------
    // Query EmissionSummary documents
    // -----------------------
    const summaryQuery = {
      clientId,
      'period.from': { $lte: endDate.toDate() },
      'period.to': { $gte: startDate.toDate() },
    };

    // Match the bucket granularity if possible
    // For finer granularity, we'll aggregate multiple summaries
    const summaries = await EmissionSummary.find(summaryQuery)
      .select('period emissionSummary')
      .lean();

    console.log(`Found ${summaries.length} emission summaries in date range`);

    if (summaries.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          clientId,
          period: {
            type: periodType,
            year: y,
            month: m,
            from: startDate.toISOString(),
            to: endDate.toISOString(),
            bucket,
            stackBy,
          },
          selectionA: createEmptyResult(A),
          selectionB: createEmptyResult(B),
          comparison: {
            totalA: 0, totalB: 0, totalAPlusB: 0,
            deltaAminusB: 0, deltaPctVsB: null,
            lastBucketKey: null, lastBucketDeltaAminusB: 0
          }
        }
      });
    }

    // -----------------------
    // Aggregate summaries for each selection
    // -----------------------
    const outA = aggregateSummaries(summaries, A, stackBy, startDate, endDate, bucket);
    const outB = aggregateSummaries(summaries, B, stackBy, startDate, endDate, bucket);

    // -----------------------
    // Calculate comparison metrics
    // -----------------------
    const safeNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const aTotal = safeNum(outA.totals.CO2e);
    const bTotal = safeNum(outB.totals.CO2e);
    const delta = aTotal - bTotal;
    const deltaPct = bTotal === 0 ? null : (delta / bTotal) * 100;

    const bucketKeys = generateBucketKeys(startDate, endDate, bucket);
    const lastKey = bucketKeys.length ? bucketKeys[bucketKeys.length - 1] : null;
    const aLast = lastKey ? (outA.series.find(x => x.periodKey === lastKey)?.total?.CO2e || 0) : 0;
    const bLast = lastKey ? (outB.series.find(x => x.periodKey === lastKey)?.total?.CO2e || 0) : 0;

    return res.status(200).json({
      success: true,
      data: {
        clientId,
        period: {
          type: periodType,
          year: y,
          month: m,
          from: startDate.toISOString(),
          to: endDate.toISOString(),
          bucket,
          stackBy,
        },
        selectionA: outA,
        selectionB: outB,
        comparison: {
          totalA: aTotal,
          totalB: bTotal,
          totalAPlusB: aTotal + bTotal,
          deltaAminusB: delta,
          deltaPctVsB: deltaPct,
          lastBucketKey: lastKey,
          lastBucketDeltaAminusB: aLast - bLast,
        },
        metadata: {
          summariesProcessed: summaries.length,
          source: 'EmissionSummary',
          version: 'v2',
        }
      },
    });

  } catch (err) {
    console.error("compareSummarySelectionsV2 error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to compute comparison",
      error: err?.message || String(err),
    });
  }
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Create empty result structure
 */
function createEmptyResult(filters) {
  return {
    filters,
    totals: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0 },
    includedCount: 0,
    breakdown: {
      byScope: [],
      byCategory: [],
      byActivity: [],
      byNode: [],
      byDepartment: [],
      byLocation: [],
    },
    series: [],
  };
}

/**
 * Aggregate multiple EmissionSummary documents for a selection
 */
function aggregateSummaries(summaries, selection, stackBy, startDate, endDate, bucket) {
  const totals = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0 };
  const byScope = new Map();
  const byCategory = new Map();
  const byActivity = new Map();
  const byNode = new Map();
  const byDepartment = new Map();
  const byLocation = new Map();
  const series = buildEmptySeries(startDate, endDate, bucket);

  let includedSummaries = 0;

  for (const summary of summaries) {
    const es = summary.emissionSummary;
    if (!es) continue;

    // Get the period key for this summary
    const periodKey = getPeriodKey(summary.period, bucket);

    // Aggregate by scope
    if (es.byScope) {
      for (const [scopeType, scopeData] of Object.entries(es.byScope)) {
        if (!matchesFilter(selection.scopes, scopeType)) continue;

        addEmissions(totals, scopeData);
        bumpMap(byScope, scopeType, scopeData);

        // Add to time series
        if (periodKey && series.has(periodKey)) {
          const bucketObj = series.get(periodKey);
          addEmissions(bucketObj.total, scopeData);
          if (stackBy === 'scope') {
            bumpStack(bucketObj, scopeType, scopeType, scopeData);
          }
        }
      }
    }

    // Aggregate by category
    if (es.byCategory) {
      for (const [categoryName, categoryData] of Object.entries(es.byCategory)) {
        if (!matchesFilter(selection.categories, categoryName)) continue;
        if (!matchesFilter(selection.scopes, categoryData.scopeType)) continue;

        bumpMap(byCategory, categoryName, categoryData, { scopeType: categoryData.scopeType });

        if (stackBy === 'category' && periodKey && series.has(periodKey)) {
          const bucketObj = series.get(periodKey);
          bumpStack(bucketObj, categoryName, categoryName, categoryData);
        }
      }
    }

    // Aggregate by activity
    if (es.byActivity) {
      for (const [activityName, activityData] of Object.entries(es.byActivity)) {
        if (!matchesFilter(selection.activities, activityName)) continue;
        if (!matchesFilter(selection.categories, activityData.categoryName)) continue;
        if (!matchesFilter(selection.scopes, activityData.scopeType)) continue;

        bumpMap(byActivity, activityName, activityData, {
          categoryName: activityData.categoryName,
          scopeType: activityData.scopeType,
        });

        if (stackBy === 'activity' && periodKey && series.has(periodKey)) {
          const bucketObj = series.get(periodKey);
          bumpStack(bucketObj, activityName, activityName, activityData);
        }
      }
    }

    // Aggregate by node
    if (es.byNode) {
      for (const [nodeName, nodeData] of Object.entries(es.byNode)) {
        // Extract nodeId from nodeName or use nodeName as-is
        const nodeId = extractNodeId(nodeName);
        
        if (!matchesFilter(selection.nodeIds, nodeId) && !matchesFilter(selection.nodeIds, nodeName)) continue;
        if (!matchesFilter(selection.departments, nodeData.department)) continue;
        if (!matchesFilter(selection.locations, nodeData.location)) continue;

        bumpMap(byNode, nodeId, nodeData, {
          nodeLabel: nodeName,
          department: nodeData.department,
          location: nodeData.location,
        });

        if (stackBy === 'node' && periodKey && series.has(periodKey)) {
          const bucketObj = series.get(periodKey);
          bumpStack(bucketObj, nodeId, nodeName, nodeData);
        }
      }
    }

    // Aggregate by department
    if (es.byDepartment) {
      for (const [deptName, deptData] of Object.entries(es.byDepartment)) {
        if (!matchesFilter(selection.departments, deptName)) continue;

        bumpMap(byDepartment, deptName, deptData);

        if (stackBy === 'department' && periodKey && series.has(periodKey)) {
          const bucketObj = series.get(periodKey);
          bumpStack(bucketObj, deptName, deptName, deptData);
        }
      }
    }

    // Aggregate by location
    if (es.byLocation) {
      for (const [locName, locData] of Object.entries(es.byLocation)) {
        if (!matchesFilter(selection.locations, locName)) continue;

        bumpMap(byLocation, locName, locData);

        if (stackBy === 'location' && periodKey && series.has(periodKey)) {
          const bucketObj = series.get(periodKey);
          bumpStack(bucketObj, locName, locName, locData);
        }
      }
    }

    includedSummaries++;
  }

  // Finalize series
  const seriesArr = Array.from(series.values()).map(b => ({
    periodKey: b.periodKey,
    total: b.total,
    stacks: Array.from(b.stacks.values()).sort((x, y) => (y.CO2e || 0) - (x.CO2e || 0)),
  }));

  return {
    filters: selection,
    totals,
    includedCount: includedSummaries,
    breakdown: {
      byScope: finalizeMap(byScope),
      byCategory: finalizeMap(byCategory),
      byActivity: finalizeMap(byActivity),
      byNode: finalizeMap(byNode),
      byDepartment: finalizeMap(byDepartment),
      byLocation: finalizeMap(byLocation),
    },
    series: seriesArr,
  };
}

/**
 * Check if a value matches filter (empty filter = match all)
 */
function matchesFilter(filterArray, value) {
  if (!filterArray || filterArray.length === 0) return true; // No filter = match all
  if (!value) return false;
  return filterArray.some(f => 
    String(f).toLowerCase() === String(value).toLowerCase() ||
    String(value).toLowerCase().includes(String(f).toLowerCase())
  );
}

/**
 * Extract nodeId from node name (handles formats like "Node Name - ID" or "node-id")
 */
function extractNodeId(nodeName) {
  // Try to extract ID after dash or underscore
  const match = String(nodeName).match(/[-_]([a-zA-Z0-9]+)$/);
  if (match) return match[1];
  
  // Convert to lowercase and replace spaces with dashes
  return String(nodeName).toLowerCase().replace(/\s+/g, '-');
}

/**
 * Get period key from summary period
 */
function getPeriodKey(period, targetBucket) {
  if (!period || !period.from) return null;

  const dt = moment.utc(period.from);
  
  if (targetBucket === "daily") return dt.format("YYYY-MM-DD");
  if (targetBucket === "weekly") return dt.format("GGGG-[W]WW");
  return dt.format("YYYY-MM");
}

/**
 * Generate bucket keys for time series
 */
function generateBucketKeys(start, end, bucket) {
  const keys = [];
  const cursor = moment.utc(start);

  if (bucket === "daily") {
    cursor.startOf("day");
    const last = moment.utc(end).startOf("day");
    while (cursor.isSameOrBefore(last)) {
      keys.push(cursor.format("YYYY-MM-DD"));
      cursor.add(1, "day");
    }
    return keys;
  }

  if (bucket === "weekly") {
    cursor.startOf("isoWeek");
    const last = moment.utc(end).startOf("isoWeek");
    while (cursor.isSameOrBefore(last)) {
      keys.push(cursor.format("GGGG-[W]WW"));
      cursor.add(1, "week");
    }
    return keys;
  }

  cursor.startOf("month");
  const last = moment.utc(end).startOf("month");
  while (cursor.isSameOrBefore(last)) {
    keys.push(cursor.format("YYYY-MM"));
    cursor.add(1, "month");
  }
  return keys;
}

/**
 * Build empty time series structure
 */
function buildEmptySeries(startDate, endDate, bucket) {
  const series = new Map();
  const keys = generateBucketKeys(startDate, endDate, bucket);
  
  for (const k of keys) {
    series.set(k, {
      periodKey: k,
      total: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0 },
      stacks: new Map(),
    });
  }
  
  return series;
}

/**
 * Add emissions to target
 */
function addEmissions(target, source) {
  const safeNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  target.CO2e = (target.CO2e || 0) + safeNum(source.CO2e);
  target.CO2 = (target.CO2 || 0) + safeNum(source.CO2);
  target.CH4 = (target.CH4 || 0) + safeNum(source.CH4);
  target.N2O = (target.N2O || 0) + safeNum(source.N2O);
}

/**
 * Bump map with emissions
 */
function bumpMap(map, key, emissions, meta = null) {
  const k = key || "Unknown";
  if (!map.has(k)) {
    map.set(k, { 
      key: k, 
      ...(meta || {}), 
      CO2e: 0, CO2: 0, CH4: 0, N2O: 0, 
      dataPointCount: 0 
    });
  }
  const obj = map.get(k);
  addEmissions(obj, emissions);
  obj.dataPointCount += (emissions.dataPointCount || 1);
}

/**
 * Bump stack in time series bucket
 */
function bumpStack(bucketObj, stackKey, stackLabel, emissions) {
  const k = stackKey || "Unknown";
  if (!bucketObj.stacks.has(k)) {
    bucketObj.stacks.set(k, { 
      key: k, 
      label: stackLabel || k, 
      CO2e: 0, CO2: 0, CH4: 0, N2O: 0 
    });
  }
  const s = bucketObj.stacks.get(k);
  addEmissions(s, emissions);
}

/**
 * Finalize map to sorted array
 */
function finalizeMap(map) {
  return Array.from(map.values()).sort((a, b) => (b.CO2e || 0) - (a.CO2e || 0));
}

/**
 * Recalculate all emission summaries for a client after allocation update.
 * Called when ProcessFlowchart allocations are updated.
 */
const recalculateSummariesOnAllocationUpdate = async (
  clientId,
  affectedScopeIdentifiers = [],
  user = null
) => {
  try {
    console.log(`🔄 Recalculating emission summaries for client ${clientId} after allocation update`);
    console.log(`📌 Affected scopeIdentifiers:`, affectedScopeIdentifiers);

    const startTime = Date.now();
    const userId = user?._id || user?.id || null;

    // Find all existing summaries for this client
    const existingSummaries = await EmissionSummary.find({
      clientId,
      'period.type': { $in: ['daily', 'monthly', 'yearly', 'all-time'] }
    })
    .select('period metadata.preventAutoRecalculation metadata.migratedData')
    .lean();

    if (existingSummaries.length === 0) {
      console.log(`ℹ️ No existing summaries found for client ${clientId}`);
      return {
        success: true,
        clientId,
        recalculatedCount: 0,
        message: 'No existing summaries to recalculate'
      };
    }

    console.log(`📊 Found ${existingSummaries.length} existing summaries to recalculate`);

    // 🔒 FILTER OUT PROTECTED SUMMARIES
    const protectedSummaries = existingSummaries.filter(s => 
      s.metadata?.preventAutoRecalculation || s.metadata?.migratedData
    );
    
    const unprotectedSummaries = existingSummaries.filter(s => 
      !s.metadata?.preventAutoRecalculation && !s.metadata?.migratedData
    );

    if (protectedSummaries.length > 0) {
      console.log(`🔒 Skipping ${protectedSummaries.length} protected summaries (migratedData or preventAutoRecalculation)`);
    }

    if (unprotectedSummaries.length === 0) {
      console.log(`ℹ️ All summaries are protected from auto-recalculation`);
      return {
        success: true,
        clientId,
        recalculatedCount: 0,
        skippedCount: protectedSummaries.length,
        message: 'All summaries are protected from auto-recalculation'
      };
    }

    // Group UNPROTECTED summaries by period type
    const summariesByType = {
      daily: [],
      monthly: [],
      yearly: [],
      'all-time': []
    };

    for (const summary of unprotectedSummaries) {
      const { type, year, month, week, day } = summary.period;
      summariesByType[type].push({ type, year, month, week, day });
    }

    const recalculationResults = {
      success: [],
      failed: [],
      skipped: protectedSummaries.length
    };

    // Recalculate daily summaries (ONLY UNPROTECTED)
    for (const period of summariesByType.daily) {
      try {
        await recalculateAndSaveSummary(
          clientId,
          'daily',
          period.year,
          period.month,
          period.week,
          period.day,
          userId
        );
        recalculationResults.success.push({
          type: 'daily',
          year: period.year,
          month: period.month,
          day: period.day
        });
      } catch (error) {
        console.error(`❌ Failed to recalculate daily summary:`, error);
        recalculationResults.failed.push({
          type: 'daily',
          year: period.year,
          month: period.month,
          day: period.day,
          error: error.message
        });
      }
    }

    // Recalculate monthly summaries (ONLY UNPROTECTED)
    for (const period of summariesByType.monthly) {
      try {
        await recalculateAndSaveSummary(
          clientId,
          'monthly',
          period.year,
          period.month,
          null,
          null,
          userId
        );
        recalculationResults.success.push({
          type: 'monthly',
          year: period.year,
          month: period.month
        });
      } catch (error) {
        console.error(`❌ Failed to recalculate monthly summary:`, error);
        recalculationResults.failed.push({
          type: 'monthly',
          year: period.year,
          month: period.month,
          error: error.message
        });
      }
    }

    // Recalculate yearly summaries (ONLY UNPROTECTED)
    for (const period of summariesByType.yearly) {
      try {
        await recalculateAndSaveSummary(
          clientId,
          'yearly',
          period.year,
          null,
          null,
          null,
          userId
        );
        recalculationResults.success.push({
          type: 'yearly',
          year: period.year
        });
      } catch (error) {
        console.error(`❌ Failed to recalculate yearly summary:`, error);
        recalculationResults.failed.push({
          type: 'yearly',
          year: period.year,
          error: error.message
        });
      }
    }

    // Recalculate all-time summary (ONLY IF UNPROTECTED)
    if (summariesByType['all-time'].length > 0) {
      try {
        await recalculateAndSaveSummary(
          clientId,
          'all-time',
          null,
          null,
          null,
          null,
          userId
        );
        recalculationResults.success.push({
          type: 'all-time'
        });
      } catch (error) {
        console.error(`❌ Failed to recalculate all-time summary:`, error);
        recalculationResults.failed.push({
          type: 'all-time',
          error: error.message
        });
      }
    }

    // Emit real-time update to connected clients
    if (io) {
      emitSummaryUpdate('allocation_update', {
        clientId,
        affectedScopeIdentifiers,
        recalculatedCount: recalculationResults.success.length,
        skippedCount: recalculationResults.skipped,
        failedCount: recalculationResults.failed.length,
        timestamp: new Date()
      });
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Allocation update recalculation completed in ${duration}ms`);
    console.log(`   - Successful: ${recalculationResults.success.length}`);
    console.log(`   - Skipped (protected): ${recalculationResults.skipped}`);
    console.log(`   - Failed: ${recalculationResults.failed.length}`);

    return {
      success: true,
      clientId,
      affectedScopeIdentifiers,
      recalculatedCount: recalculationResults.success.length,
      skippedCount: recalculationResults.skipped,
      failedCount: recalculationResults.failed.length,
      duration,
      details: recalculationResults
    };

  } catch (error) {
    console.error(`❌ Error in recalculateSummariesOnAllocationUpdate:`, error);
    throw error;
  }
};

