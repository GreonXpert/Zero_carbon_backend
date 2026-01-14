// controllers/Calculation/CalculationSummary.js

const EmissionSummary = require('../../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../../models/Organization/DataEntry');
const Flowchart = require('../../models/Organization/Flowchart');
const Client = require('../../models/CMS/Client');
const moment = require('moment');
const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart'); 
const NetReductionEntry = require("../../models/Reduction/NetReductionEntry");
const Reduction = require("../../models/Reduction/Reduction");
const netReductionSummaryController = require('../Reduction/netReductionSummaryController');

// SBTi targets – to link summary emissions with SBTi trajectories
const SbtiTarget = require('../../models/Decarbonization/SbtiTarget');


const {getActiveFlowchart} = require ('../../utils/DataCollection/dataCollection');

// Import socket.io instance
let io;

// Function to set socket.io instance
const setSocketIO = (socketIO) => {
  io = socketIO;
};

// Function to emit real-time summary updates
const emitSummaryUpdate = (eventType, data) => {
  if (io) {
    // Emit to all connected clients in the same clientId room
    io.to(`client-${data.clientId}`).emit(eventType, {
      timestamp: new Date(),
      type: eventType,
      data: data
    });
    
    // Also emit to summary-specific room
    io.to(`summaries-${data.clientId}`).emit(eventType, {
      timestamp: new Date(),
      type: eventType,
      data: data
    });
  }
};

/**
 * [NEW] Helper function to sanitize keys for Mongoose Maps
 * Replaces forbidden characters like '.' with a safe character '_'
 * @param {string} key - The key to sanitize
 * @returns {string} The sanitized key
 */
function sanitizeMapKey(key) {
  if (typeof key !== 'string') {
    return 'invalid_key';
  }
  return key.replace(/\./g, '_');
}


/**
 * Helper function to convert emission values from kg to tonnes
 * @param {number} valueInKg - Value in kilograms
 * @returns {number} Value in tonnes
 */
function convertKgToTonnes(valueInKg) {
  if (typeof valueInKg !== 'number' || isNaN(valueInKg)) {
    return 0;
  }
  return valueInKg / 1000;
}

function extractEmissionValues(calculatedEmissions) {
  const totals = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0 };

  if (!calculatedEmissions || typeof calculatedEmissions !== "object") {
    return totals;
  }

  const addBucket = (bucketObj) => {
    if (!bucketObj || typeof bucketObj !== "object") return;

    // Handle Map (if it comes from mongoose as a Map) or Object
    const keys = (bucketObj instanceof Map) ? bucketObj.keys() : Object.keys(bucketObj);

    for (const bucketKey of keys) {
      const item = (bucketObj instanceof Map) ? bucketObj.get(bucketKey) : bucketObj[bucketKey];
      
      if (!item || typeof item !== "object") continue;

      const co2e =
        Number(item.CO2e ??
              item.emission ??
              item.CO2eWithUncertainty ??
              item.emissionWithUncertainty) || 0;

      totals.CO2e += co2e;
      totals.CO2 += Number(item.CO2) || 0;
      totals.CH4 += Number(item.CH4) || 0;
      totals.N2O += Number(item.N2O) || 0;
    }
  };

  // 🔴 FIX: Only add INCOMING emissions. 
  // Do NOT add cumulative, or you will double-count historical data.
  addBucket(calculatedEmissions.incoming);
  
  // REMOVED: addBucket(calculatedEmissions.cumulative); 

  return totals;
}



/**
 * Helper function to add emission values to a target object
 * Values should already be in tonnes
 */
function addEmissionValues(target, source) {
  target.CO2e += source.CO2e;
  target.CO2 += source.CO2;
  target.CH4 += source.CH4;
  target.N2O += source.N2O;
}

function ensureMapEntry(map, key, defaultValue = {}) {
  if (!map.has(key)) {
    map.set(key, {
      CO2e: 0,
      CO2: 0,
      CH4: 0,
      N2O: 0,
      dataPointCount: 0,
      ...defaultValue
    });
  }
  return map.get(key);
}

/**
 * Helper function to ensure Map structure exists
 */
function ensureMapEntry(map, key, defaultValue = {}) {
  const sanitizedKey = sanitizeMapKey(key); // Sanitize the key before using it
  if (!map.has(sanitizedKey)) {
    map.set(sanitizedKey, { 
      CO2e: 0, CO2: 0, CH4: 0, N2O: 0, 
      uncertainty: 0, dataPointCount: 0,
      ...defaultValue 
    });
  }
  return map.get(sanitizedKey);
}




/**
 * Calculate comprehensive emission summary for a client
 * All values are converted to tonnes
 * OUTPUT NOW MATCHES THE NEW MODEL STRUCTURE:
 *
 * {
 *   clientId,
 *   period: { ... },
 *   emissionSummary: {
 *       period,
 *       totalEmissions,
 *       byScope,
 *       byCategory,
 *       byActivity,
 *       byNode,
 *       byDepartment,
 *       byLocation,
 *       byInputType,
 *       byEmissionFactor,
 *       trends,
 *       metadata
 *   },
 *   metadata: { ... }   // root-level document metadata unchanged
 * }
 */
const calculateEmissionSummary = async (clientId, periodType, year, month, week, day, userId = null) => {
  try {
    console.log(`📊 Calculating ${periodType} emission summary for client: ${clientId}`);

    const { from, to } = buildDateRange(periodType, year, month, week, day);

    const query = {
      clientId,
      processingStatus: 'processed',
      timestamp: { $gte: from, $lte: to }
    };

    const dataEntries = await DataEntry.find(query).lean();

    // ============================================================
    // CASE 1: NO DATA FOUND
    // ============================================================
    if (dataEntries.length === 0) {
      console.log(`No processed data entries found for ${clientId} in this period.`);

      return {
        clientId,
        period: { type: periodType, year, month, week, day, from, to },

        emissionSummary: {
          period: { type: periodType, year, month, week, day, from, to },

          totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },

          byScope: {
            'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
          },

          byCategory: new Map(),
          byActivity: new Map(),
          byNode: new Map(),
          byDepartment: new Map(),
          byLocation: new Map(),

          byInputType: {
            manual: { CO2e: 0, dataPointCount: 0 },
            API: { CO2e: 0, dataPointCount: 0 },
            IOT: { CO2e: 0, dataPointCount: 0 }
          },

          byEmissionFactor: new Map(),

          trends: {},

          metadata: {
            totalDataPoints: 0,
            dataEntriesIncluded: [],
            lastCalculated: new Date(),
            calculatedBy: userId,
            isComplete: true,
            hasErrors: false,
            errors: [],
            version: 1,
            calculationDuration: 0
          }
        },

        metadata: {
          lastCalculated: new Date(),
          isComplete: true,
          hasErrors: false,
          errors: []
        }
      };
    }

    // ============================================================
    // CASE 2: FLOWCHART + NODES PREPARATION
    // ============================================================
    console.log(`Found ${dataEntries.length} data entries.`);

    const activeChart = await getActiveFlowchart(clientId);
    if (!activeChart || !activeChart.chart) {
      console.error(`No active flowchart found for ${clientId}`);
      return null;
    }

    const flowchart = activeChart.chart;

    const nodeMap = new Map();
    flowchart.nodes.forEach(node => {
      nodeMap.set(node.id, {
        id: node.id,
        label: node.label,
        department: node.details?.department || "Unknown",
        location: node.details?.location || "Unknown",
        scopeDetails: node.details?.scopeDetails || []
      });
    });

    // ============================================================
    // NEW SUMMARY OBJECT (matches new model)
    // ============================================================
    const emissionSummary = {
      period: { type: periodType, year, month, week, day, date: periodType === "daily" ? from : null, from, to },

      totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },

      byScope: {
        "Scope 1": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        "Scope 2": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        "Scope 3": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
      },

      byCategory: new Map(),
      byActivity: new Map(),
      byNode: new Map(),
      byDepartment: new Map(),
      byLocation: new Map(),

      byInputType: {
        manual: { CO2e: 0, dataPointCount: 0 },
        API: { CO2e: 0, dataPointCount: 0 },
        IOT: { CO2e: 0, dataPointCount: 0 }
      },

      byEmissionFactor: new Map(),

      trends: {},

      metadata: {
        totalDataPoints: dataEntries.length,
        dataEntriesIncluded: dataEntries.map(e => e._id),
        calculatedBy: userId,
        lastCalculated: new Date(),
        errors: [],
        hasErrors: false,
        isComplete: true,
        version: 1,
        calculationDuration: 0
      }
    };

    // ============================================================
    // PROCESS EACH DATA ENTRY
    // ============================================================
    for (const entry of dataEntries) {
      try {
        const emissionValues = extractEmissionValues(entry.calculatedEmissions);
        if (emissionValues.CO2e === 0) continue;

        const nodeContext = nodeMap.get(entry.nodeId);
        if (!nodeContext) {
          emissionSummary.metadata.errors.push(`Node ${entry.nodeId} not found`);
          continue;
        }

        const scopeDetail = nodeContext.scopeDetails.find(s => s.scopeIdentifier === entry.scopeIdentifier);
        const categoryName = scopeDetail?.categoryName || entry.categoryName || "Unknown Category";
        const activity = scopeDetail?.activity || entry.activity || "Unknown Activity";

        // === TOTALS ===
        addEmissionValues(emissionSummary.totalEmissions, emissionValues);

        // === BY SCOPE ===
        if (emissionSummary.byScope[entry.scopeType]) {
          addEmissionValues(emissionSummary.byScope[entry.scopeType], emissionValues);
        }

        // === BY CATEGORY ===
        const cat = ensureMapEntry(
          emissionSummary.byCategory,
          categoryName,
          { scopeType: entry.scopeType, activities: new Map() }
        );
        addEmissionValues(cat, emissionValues);

        // CATEGORY → ACTIVITY
        const a1 = ensureMapEntry(cat.activities, activity);
        addEmissionValues(a1, emissionValues);

        // === BY ACTIVITY ===
        const a2 = ensureMapEntry(
          emissionSummary.byActivity,
          activity,
          { scopeType: entry.scopeType, categoryName }
        );
        addEmissionValues(a2, emissionValues);

        // === BY NODE ===
        const node = ensureMapEntry(
          emissionSummary.byNode,
          entry.nodeId,
          {
            nodeLabel: nodeContext.label,
            department: nodeContext.department,
            location: nodeContext.location,
            byScope: {
              "Scope 1": { CO2e: 0, dataPointCount: 0 },
              "Scope 2": { CO2e: 0, dataPointCount: 0 },
              "Scope 3": { CO2e: 0, dataPointCount: 0 }
            }
          }
        );
        addEmissionValues(node, emissionValues);
        addEmissionValues(node.byScope[entry.scopeType], emissionValues);

        // === BY DEPARTMENT ===
        const dept = ensureMapEntry(emissionSummary.byDepartment, nodeContext.department);
        addEmissionValues(dept, emissionValues);

        // === BY LOCATION ===
        const loc = ensureMapEntry(emissionSummary.byLocation, nodeContext.location);
        addEmissionValues(loc, emissionValues);

        // === BY INPUT TYPE ===
        if (emissionSummary.byInputType[entry.inputType]) {
          emissionSummary.byInputType[entry.inputType].CO2e += emissionValues.CO2e;
          emissionSummary.byInputType[entry.inputType].dataPointCount += 1;
        }

        // === BY EMISSION FACTOR ===
        const eff = ensureMapEntry(
          emissionSummary.byEmissionFactor,
          entry.emissionFactor || "Unknown",
          {
            scopeTypes: { "Scope 1": 0, "Scope 2": 0, "Scope 3": 0 }
          }
        );
        addEmissionValues(eff, emissionValues);
        eff.scopeTypes[entry.scopeType] += 1;

      } catch (err) {
        emissionSummary.metadata.errors.push(`Entry ${entry._id} error: ${err.message}`);
        emissionSummary.metadata.hasErrors = true;
      }
    }

    // ============================================================
    // NODE COUNTS FOR DEPARTMENT + LOCATION
    // ============================================================
    const uniqueDept = new Map();
    const uniqueLoc = new Map();

    for (const [nodeId, n] of emissionSummary.byNode) {
      if (!uniqueDept.has(n.department)) uniqueDept.set(n.department, new Set());
      uniqueDept.get(n.department).add(nodeId);

      if (!uniqueLoc.has(n.location)) uniqueLoc.set(n.location, new Set());
      uniqueLoc.get(n.location).add(nodeId);
    }

    for (const [d, set] of uniqueDept) {
      if (emissionSummary.byDepartment.has(d)) {
        emissionSummary.byDepartment.get(d).nodeCount = set.size;
      }
    }

    for (const [l, set] of uniqueLoc) {
      if (emissionSummary.byLocation.has(l)) {
        emissionSummary.byLocation.get(l).nodeCount = set.size;
      }
    }

    // ============================================================
    // TRENDS (ONLY FOR NON ALL-TIME PERIODS)
    // ============================================================
    if (periodType !== "all-time") {
      try {
        const prev = getPreviousPeriod(periodType, year, month, week, day);

        const previousSummary = await EmissionSummary.findOne({
          clientId,
          "period.type": periodType,
          "period.year": prev.year,
          "period.month": prev.month,
          "period.week": prev.week,
          "period.day": prev.day
        }).lean();

        if (previousSummary?.emissionSummary) {
          emissionSummary.trends = calculateTrends(
            emissionSummary,
            previousSummary.emissionSummary
          );
        }
      } catch (trendErr) {
        emissionSummary.metadata.errors.push(`Trend calc error: ${trendErr.message}`);
      }
    }

    emissionSummary.metadata.calculationDuration =
      Date.now() - emissionSummary.metadata.lastCalculated.getTime();

    console.log("📊 NEW emissionSummary totals:", {
      totalCO2e: emissionSummary.totalEmissions.CO2e,
      s1: emissionSummary.byScope["Scope 1"].CO2e,
      s2: emissionSummary.byScope["Scope 2"].CO2e,
      s3: emissionSummary.byScope["Scope 3"].CO2e
    });

    // ============================================================
    // RETURN FULL DOCUMENT STRUCTURE
    // ============================================================
    return {
      clientId,
      period: emissionSummary.period,
      emissionSummary,
      metadata: {
        lastCalculated: new Date(),
        isComplete: true,
        hasErrors: emissionSummary.metadata.hasErrors,
        errors: emissionSummary.metadata.errors
      }
    };

  } catch (error) {
    console.error("❌ Error calculating emission summary:", error);
    throw error;
  }
};


/**
 * Build date range based on period type
 */
function buildDateRange(periodType, year, month, week, day) {
  const now = new Date();
  let from, to;

  switch (periodType) {
    case 'daily':
      from = moment.utc({ year, month: month - 1, day }).startOf('day').toDate();
      to = moment.utc(from).endOf('day').toDate();
      break;
    case 'weekly':
      from = moment.utc({ year, week }).startOf('isoWeek').toDate();
      to = moment.utc(from).endOf('isoWeek').toDate();
      break;
    case 'monthly':
      from = moment.utc({ year, month: month - 1 }).startOf('month').toDate();
      to = moment.utc(from).endOf('month').toDate();
      break;
    case 'yearly':
      from = moment.utc({ year }).startOf('year').toDate();
      to = moment.utc(from).endOf('year').toDate();
      break;
    case 'all-time':
      from = new Date(Date.UTC(2000, 0, 1));
      to = new Date();
      break;
    default:
      throw new Error(`Invalid period type: ${periodType}`);
  }
  return { from, to };
}

/**
 * Get previous period for trend calculation
 */
function getPreviousPeriod(periodType, year, month, week, day) {
  switch (periodType) {
    case 'daily':
      const prevDay = moment.utc({ year, month: month - 1, day }).subtract(1, 'day');
      return { year: prevDay.year(), month: prevDay.month() + 1, day: prevDay.date() };
    case 'weekly':
      const prevWeek = moment.utc({ year, week }).subtract(1, 'week');
      return { year: prevWeek.year(), week: prevWeek.isoWeek() };
    case 'monthly':
      const prevMonth = moment.utc({ year, month: month - 1 }).subtract(1, 'month');
      return { year: prevMonth.year(), month: prevMonth.month() + 1 };
    case 'yearly':
      return { year: year - 1 };
    default:
      return {};
  }
}

/**
 * Calculate trends between current and previous period
 */
function calculateTrends(current, previous) {
  function getTrendData(currentValue, previousValue) {
    const change = currentValue - previousValue;
    const percentage = previousValue > 0 ? (change / previousValue * 100) : (currentValue > 0 ? 100 : 0);
    const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'same';
    return { value: change, percentage: Math.round(percentage * 100) / 100, direction };
  }
  return {
    totalEmissionsChange: getTrendData(current.totalEmissions.CO2e, previous.totalEmissions.CO2e),
    scopeChanges: {
      'Scope 1': getTrendData(current.byScope['Scope 1'].CO2e, previous.byScope['Scope 1'].CO2e),
      'Scope 2': getTrendData(current.byScope['Scope 2'].CO2e, previous.byScope['Scope 2'].CO2e),
      'Scope 3': getTrendData(current.byScope['Scope 3'].CO2e, previous.byScope['Scope 3'].CO2e)
    }
  };
}



/**
 * GET /api/summaries/:clientId/sbti-progress
 *
 * Returns SBTi target progress for the SAME YEAR
 * using yearly summary OR fallback summary.
 */
const getSbtiProgress = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({ success: false, message: "clientId is required" });
    }

    // Step 1: Load latest or yearly summary to compute progress
    const baseSummary = await EmissionSummary.findOne({ clientId })
      .sort({ "period.year": -1, createdAt: -1 })
      .lean();

    if (!baseSummary) {
      return res.status(404).json({
        success: false,
        message: "No summary found for SBTi evaluation",
      });
    }

    // Step 2: Build progress using helper you already have
    const progress = await buildSbtiProgressForSummary(clientId, baseSummary);

    return res.status(200).json({
      success: true,
      data: progress || null,
    });
  } catch (err) {
    console.error("Error in getSbtiProgress:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to build SBTi progress",
      error: err.message,
    });
  }
};

/**
 * Helper: get CO2e value for a given scope from a plain object or a Mongoose Map
 */
function getScopeCO2eFromContainer(container, scopeName) {
  if (!container) return 0;

  let entry;
  if (container instanceof Map) {
    entry = container.get(scopeName);
  } else {
    entry = container[scopeName];
  }

  if (!entry || typeof entry !== 'object') return 0;

  const raw = entry.CO2e ?? entry.co2e ?? 0;
  const num = typeof raw === 'number' ? raw : parseFloat(raw) || 0;
  return num;
}

/**
 * Sync SBTi emission progress whenever a YEARLY summary is saved.
 * This writes into SbtiTarget.emissionProgress for that client + year.
 */
async function syncSbtiProgressFromSummary(summaryDoc) {
  try {
    if (!summaryDoc || !summaryDoc.clientId || !summaryDoc.period) return;
    if (summaryDoc.period.type !== 'yearly') return; // we only track yearly vs SBTi

    const clientId = summaryDoc.clientId;
    const year = summaryDoc.period.year;

    // Extract emissions from the summary per scope (tCO2e)
    const byScope = summaryDoc.byScope || {};
    const scope1 = getScopeCO2eFromContainer(byScope, 'Scope 1');
    const scope2 = getScopeCO2eFromContainer(byScope, 'Scope 2');
    const scope3 = getScopeCO2eFromContainer(byScope, 'Scope 3');

    const targets = await SbtiTarget.find({ clientId }).exec();
    if (!targets || !targets.length) return;

    for (const target of targets) {
      const baseRaw = target.baseEmission_tCO2e;
      const base = typeof baseRaw === 'number' ? baseRaw : parseFloat(baseRaw) || 0;
      if (!base || base <= 0) continue;

      const scopeSet = target.scopeSet || 'S1S2';
      const actualEmission = scopeSet === 'S3' ? scope3 : (scope1 + scope2);

      const trajectory = Array.isArray(target.trajectory) ? target.trajectory : [];
      let trajPoint = trajectory.find(p => p.year === year);

      if (!trajPoint && trajectory.length) {
        const sorted = [...trajectory].sort((a, b) => a.year - b.year);
        if (year < sorted[0].year) {
          trajPoint = sorted[0];
        } else {
          trajPoint = sorted[sorted.length - 1];
        }
      }

      const targetEmissionRaw = trajPoint?.targetEmission_tCO2e;
      const targetEmission = typeof targetEmissionRaw === 'number'
        ? targetEmissionRaw
        : (parseFloat(targetEmissionRaw) || base);

      const requiredReduction = Math.max(0, base - targetEmission);
      const achievedReduction = Math.max(0, base - actualEmission);

      const requiredReductionPercent = base > 0 ? (requiredReduction / base) * 100 : 0;
      const achievedReductionPercent = base > 0 ? (achievedReduction / base) * 100 : 0;
      const percentOfTargetAchieved =
        requiredReduction > 0 ? (achievedReduction / requiredReduction) * 100 : 0;

      const progressRow = {
        year,
        scopeSet,
        baselineEmission_tCO2e: base,
        targetEmission_tCO2e: targetEmission,
        actualEmission_tCO2e: actualEmission,
        requiredReduction_tCO2e: requiredReduction,
        achievedReduction_tCO2e: achievedReduction,
        requiredReductionPercent: Number(requiredReductionPercent.toFixed(4)),
        achievedReductionPercent: Number(achievedReductionPercent.toFixed(4)),
        percentOfTargetAchieved: Number(percentOfTargetAchieved.toFixed(4)),
        isOnTrack: actualEmission <= targetEmission,
        lastUpdatedFromSummaryId: summaryDoc._id,
      };

      if (!Array.isArray(target.emissionProgress)) {
        target.emissionProgress = [];
      }

      const idx = target.emissionProgress.findIndex(
        (row) => row.year === year && row.scopeSet === scopeSet
      );

      if (idx >= 0) {
        target.emissionProgress[idx] = progressRow;
      } else {
        target.emissionProgress.push(progressRow);
      }

      target.markModified('emissionProgress');
      await target.save();
    }
  } catch (err) {
    console.error('Error syncing SBTi emission progress from summary:', err);
  }
}

/**
 * Build a SBTi progress view to send along with the summary API.
 * Uses YEARLY summary for the same year so progress is "this year's emissions vs this year's target".
 */
async function buildSbtiProgressForSummary(clientId, baseSummary) {
  try {
    if (!baseSummary || !baseSummary.period) return null;

    const year = baseSummary.period.year || new Date().getUTCFullYear();

    // Prefer the yearly summary for this client/year
    let summaryForProgress = baseSummary;
    if (baseSummary.period.type !== 'yearly') {
      const yearly = await EmissionSummary.findOne({
        clientId,
        'period.type': 'yearly',
        'period.year': year,
      }).lean();
      if (yearly) {
        summaryForProgress = yearly;
      }
    }

    const byScope = summaryForProgress.byScope || {};
    const scope1 = getScopeCO2eFromContainer(byScope, 'Scope 1');
    const scope2 = getScopeCO2eFromContainer(byScope, 'Scope 2');
    const scope3 = getScopeCO2eFromContainer(byScope, 'Scope 3');

    const targets = await SbtiTarget.find({ clientId }).lean();
    if (!targets || !targets.length) return null;

    const items = [];

    for (const target of targets) {
      const baseRaw = target.baseEmission_tCO2e;
      const base = typeof baseRaw === 'number' ? baseRaw : parseFloat(baseRaw) || 0;
      if (!base || base <= 0) continue;

      const scopeSet = target.scopeSet || 'S1S2';
      const actualEmission = scopeSet === 'S3' ? scope3 : (scope1 + scope2);

      // Try to reuse stored emissionProgress row for that year/scope if available
      let storedRow = Array.isArray(target.emissionProgress)
        ? target.emissionProgress.find(
            (row) => row.year === year && row.scopeSet === scopeSet
          )
        : null;

      if (!storedRow) {
        const trajectory = Array.isArray(target.trajectory) ? target.trajectory : [];
        let trajPoint = trajectory.find((p) => p.year === year);

        if (!trajPoint && trajectory.length) {
          const sorted = [...trajectory].sort((a, b) => a.year - b.year);
          if (year < sorted[0].year) {
            trajPoint = sorted[0];
          } else {
            trajPoint = sorted[sorted.length - 1];
          }
        }

        const targetEmissionRaw = trajPoint?.targetEmission_tCO2e;
        const targetEmission = typeof targetEmissionRaw === 'number'
          ? targetEmissionRaw
          : (parseFloat(targetEmissionRaw) || base);

        const requiredReduction = Math.max(0, base - targetEmission);
        const achievedReduction = Math.max(0, base - actualEmission);

        const requiredReductionPercent = base > 0 ? (requiredReduction / base) * 100 : 0;
        const achievedReductionPercent = base > 0 ? (achievedReduction / base) * 100 : 0;
        const percentOfTargetAchieved =
          requiredReduction > 0 ? (achievedReduction / requiredReduction) * 100 : 0;

        storedRow = {
          year,
          scopeSet,
          baselineEmission_tCO2e: base,
          targetEmission_tCO2e: targetEmission,
          actualEmission_tCO2e: actualEmission,
          requiredReduction_tCO2e: requiredReduction,
          achievedReduction_tCO2e: achievedReduction,
          requiredReductionPercent: Number(requiredReductionPercent.toFixed(4)),
          achievedReductionPercent: Number(achievedReductionPercent.toFixed(4)),
          percentOfTargetAchieved: Number(percentOfTargetAchieved.toFixed(4)),
          isOnTrack: actualEmission <= targetEmission,
        };
      }

      items.push({
        targetId: target._id,
        targetName: target.targetName,
        targetType: target.targetType,       // 'near_term' | 'net_zero'
        scopeSet,
        baseYear: target.baseYear,
        targetYear: target.targetYear,
        baseEmission_tCO2e: base,
        ...storedRow,
      });
    }

    if (!items.length) return null;

    // Pick a primary item for quick display (near-term S1+S2 first)
    const primary =
      items.find((x) => x.targetType === 'near_term' && x.scopeSet === 'S1S2') ||
      items.find((x) => x.targetType === 'near_term') ||
      items[0];

    return { year, items, primary };
  } catch (err) {
    console.error('Error building SBTi progress for summary:', err);
    return null;
  }
}

function mapToObj(value) {
  // Null or undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Convert Maps → Objects
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([k, v]) => [k, mapToObj(v)])
    );
  }

  // If plain object → process children
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = {};

    for (const key in value) {
      const v = value[key];

      // Numeric fields must be cast safely
      if (["CO2e", "CO2", "CH4", "N2O", "uncertainty", "dataPointCount"].includes(key)) {
        obj[key] =
          typeof v === "number" && !Number.isNaN(v)
            ? v
            : 0; // <-- FIXED: always return 0, never {}
        continue;
      }

      // Recurse
      obj[key] = mapToObj(v);
    }

    return obj;
  }

  // Return primitives as-is
  return value;
}






/**
 * Persist an emission summary in STRUCTURE A:
 *
 * {
 *   clientId,
 *   period,
 *   emissionSummary: { ...full emission structure... },
 *   reductionSummary: { ... }   // preserved unless explicitly overwritten
 *   metadata: { ...root metadata... }
 * }
 */
async function saveEmissionSummary(summaryData) {
  if (!summaryData) throw new Error("saveEmissionSummary: summaryData is required");

  const { clientId, period } = summaryData;
  if (!clientId || !period || !period.type) {
    throw new Error("saveEmissionSummary: missing clientId or period.type");
  }

  // ✅ Normalize period key fields strictly by type (prevents duplicate docs)
  const normalizePeriodKey = (p) => {
    const t = p.type;
    const out = { type: t };

    if (t === "daily") {
      out.year = p.year;
      out.month = p.month;
      out.day = p.day;
    } else if (t === "weekly") {
      out.year = p.year;
      out.week = p.week;
    } else if (t === "monthly") {
      out.year = p.year;
      out.month = p.month;
    } else if (t === "yearly") {
      out.year = p.year;
    } else if (t === "all-time") {
      // nothing else
    }
    return out;
  };

  const normalizedPeriod = {
    ...normalizePeriodKey(period),
    // keep from/to if you pass them (safe)
    ...(period.from ? { from: period.from } : {}),
    ...(period.to ? { to: period.to } : {}),
  };

  // ------------------------------------------------------------------
  // 1) Build query (clientId + normalized period keys only)
  // ------------------------------------------------------------------
  const query = {
    clientId,
    "period.type": normalizedPeriod.type,
  };

  if (normalizedPeriod.year != null) query["period.year"] = normalizedPeriod.year;
  if (normalizedPeriod.month != null) query["period.month"] = normalizedPeriod.month;
  if (normalizedPeriod.week != null) query["period.week"] = normalizedPeriod.week;
  if (normalizedPeriod.day != null) query["period.day"] = normalizedPeriod.day;

  const existing = await EmissionSummary.findOne(query).lean();

  // ✅ Use the nested emissionSummary if present
  const es = summaryData.emissionSummary || summaryData;

  // ------------------------------------------------------------------
  // 2) Build emissionSummary (nested object)
  // ------------------------------------------------------------------
  const emissionSummaryToSave = {
    period: normalizedPeriod,
    totalEmissions: es.totalEmissions || {
      CO2e: 0,
      CO2: 0,
      CH4: 0,
      N2O: 0,
      uncertainty: 0,
    },

    byScope: mapToObj(es.byScope),
    byCategory: mapToObj(es.byCategory),
    byActivity: mapToObj(es.byActivity),
    byNode: mapToObj(es.byNode),
    byDepartment: mapToObj(es.byDepartment),
    byLocation: mapToObj(es.byLocation),
    byEmissionFactor: mapToObj(es.byEmissionFactor),

    trends: es.trends || {
      totalEmissionsChange: { value: 0, percentage: 0, direction: "same" },
      scopeChanges: {
        "Scope 1": { value: 0, percentage: 0, direction: "same" },
        "Scope 2": { value: 0, percentage: 0, direction: "same" },
        "Scope 3": { value: 0, percentage: 0, direction: "same" },
      },
    },

    metadata: {
      ...(es.metadata || {}),
      totalDataPoints:
        es.metadata?.totalDataPoints ??
        (Array.isArray(es.metadata?.dataEntriesIncluded)
          ? es.metadata.dataEntriesIncluded.length
          : 0),
      dataEntriesIncluded: es.metadata?.dataEntriesIncluded || es.dataEntriesIncluded || [],
      lastCalculated: es.metadata?.lastCalculated || new Date(),
      calculationDuration: es.metadata?.calculationDuration ?? 0,
      calculatedBy: es.metadata?.calculatedBy ?? null,
      isComplete: es.metadata?.isComplete ?? true,
      hasErrors: es.metadata?.hasErrors ?? false,
      errors: es.metadata?.errors || [],
      version: (existing?.emissionSummary?.metadata?.version || 0) + 1,
    },
  };

  // ------------------------------------------------------------------
  // 3) ROOT metadata (mirror)
  // ------------------------------------------------------------------
  const rootMetadata = {
    ...(existing?.metadata || {}),
    lastCalculated: emissionSummaryToSave.metadata.lastCalculated,
    totalDataPoints: emissionSummaryToSave.metadata.totalDataPoints,
    dataEntriesIncluded: emissionSummaryToSave.metadata.dataEntriesIncluded,
    calculationDuration: emissionSummaryToSave.metadata.calculationDuration,
    isComplete: emissionSummaryToSave.metadata.isComplete,
    hasErrors: emissionSummaryToSave.metadata.hasErrors,
    errors: emissionSummaryToSave.metadata.errors || [],
    version: (existing?.metadata?.version || 0) + 1,

    // keep reduction flags
    hasReductionSummary:
      existing?.metadata?.hasReductionSummary ?? !!existing?.reductionSummary,
    lastReductionSummaryCalculatedAt:
      existing?.metadata?.lastReductionSummaryCalculatedAt || null,
  };

  // ------------------------------------------------------------------
  // 4) Update object (do NOT wipe reductionSummary)
  // ------------------------------------------------------------------
  const update = {
    clientId,
    period: normalizedPeriod,
    emissionSummary: emissionSummaryToSave,
    metadata: rootMetadata,
  };

  // Preserve reductionSummary if it exists
  if (existing?.reductionSummary) {
    update.reductionSummary = existing.reductionSummary;
  }

  // If caller provided reductionSummary explicitly, overwrite intentionally
  if (es.reductionSummary) {
    update.reductionSummary = es.reductionSummary;
    update.metadata.hasReductionSummary = true;
    update.metadata.lastReductionSummaryCalculatedAt =
      es.reductionSummaryLastCalculated || new Date();
  }

  // ------------------------------------------------------------------
  // 5) Upsert
  // ------------------------------------------------------------------
  const saved = await EmissionSummary.findOneAndUpdate(query, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  return saved.toObject();
}




/**
 * Automatically update summaries when new data is processed
 * (Option-B: full duplication → updates emissionSummary subtree)
 */
const updateSummariesOnDataChange = async (dataEntry) => {
  try {
    console.log(`📊 Updating summaries for new data entry: ${dataEntry._id}`);

    const { clientId } = dataEntry;
    const entryDate = moment.utc(dataEntry.timestamp);

    // DAILY
    await recalculateAndSaveSummary(
      clientId,
      'daily',
      entryDate.year(),
      entryDate.month() + 1,
      null,
      entryDate.date()
    );

    // MONTHLY
    await recalculateAndSaveSummary(
      clientId,
      'monthly',
      entryDate.year(),
      entryDate.month() + 1
    );

    // YEARLY
    await recalculateAndSaveSummary(clientId, 'yearly', entryDate.year());

    // ALL-TIME
    await recalculateAndSaveSummary(clientId, 'all-time');

    console.log(`✅ Successfully updated summaries for client: ${clientId}`);

  } catch (error) {
    console.error('❌ Error updating summaries on data change:', error);
  }
};

function buildPeriodDateRange(periodType, year, month, week, day) {
  const start = moment.utc();

  if (periodType === "daily") {
    start.year(year).month(month - 1).date(day).startOf("day");
    return { from: start.toDate(), to: start.endOf("day").toDate() };
  }

  if (periodType === "monthly") {
    start.year(year).month(month - 1).startOf("month");
    return { from: start.toDate(), to: start.endOf("month").toDate() };
  }

  if (periodType === "yearly") {
    start.year(year).startOf("year");
    return { from: start.toDate(), to: start.endOf("year").toDate() };
  }

  return { from: new Date(0), to: new Date() }; // all-time fallback
}

/**
 * Recalculate and persist summary for a client + period.
 * - Uses calculateEmissionSummary(...) to compute emissions.
 * - Persists using saveEmissionSummary(...) in Structure A.
 */
const recalculateAndSaveSummary = async (
  clientId,
  periodType,
  year,
  month,
  week,
  day,
  userId = null
) => {
  try {
    const summaryData = await calculateEmissionSummary(
      clientId,
      periodType,
      year,
      month,
      week,
      day,
      userId
    );

    // If nothing to save, return null
    if (!summaryData) {
      return null;
    }

    // We now always save, even if totalDataPoints is 0
    // (so that empty months/years still have a summary doc)
    const saved = await saveEmissionSummary(summaryData);
    return saved;
  } catch (err) {
    console.error(
      `❌ Error recalculating ${periodType} summary for client ${clientId}:`,
      err
    );
    throw err;
  }
};




// ========== API Controllers ==========

const getEmissionSummary = async (req, res) => {
  try {
    const { clientId } = req.params;
    const {
      periodType = "monthly",
      year,
      month,
      week,
      day,
      recalculate = "false",
      preferLatest = "true",
      type = "both" // "emission" | "reduction" | "both"
    } = req.query;

    if (!["daily", "weekly", "monthly", "yearly", "all-time"].includes(periodType)) {
      return res.status(400).json({ success: false, message: "Invalid period type." });
    }

    const y = year ? parseInt(year) : moment.utc().year();
    const m = month ? parseInt(month) : moment.utc().month() + 1;
    const w = week ? parseInt(week) : moment.utc().isoWeek();
    const d = day ? parseInt(day) : moment.utc().date();

    const noParts = !year && !month && !week && !day;

    const baseQuery = { clientId, "period.type": periodType };

    let summary;

    // ----------------------------------------------------
    // 1) Load or recalculate summary
    // ----------------------------------------------------
    if (recalculate === "true") {
      summary = await recalculateAndSaveSummary(
        clientId,
        periodType,
        y,
        m,
        w,
        d,
        req.user?._id
      );
    } else {
      if (noParts) {
        summary = await EmissionSummary.findOne(baseQuery)
          .sort({ "period.to": -1, updatedAt: -1 })
          .lean();
      } else {
        const exactQuery = { ...baseQuery };
        if (year) exactQuery["period.year"] = y;
        if (month) exactQuery["period.month"] = m;
        if (week) exactQuery["period.week"] = w;
        if (day) exactQuery["period.day"] = d;

        summary = await EmissionSummary.findOne(exactQuery).lean();

        const stale =
          summary &&
          summary.metadata &&
          (Date.now() - new Date(summary.metadata.lastCalculated).getTime()) > 3600000;

        if (!summary || stale) {
          const recomputed = await recalculateAndSaveSummary(
            clientId,
            periodType,
            y,
            m,
            w,
            d,
            req.user?._id
          );

          if (recomputed) {
            summary = recomputed;
          } else if (preferLatest === "true") {
            summary = await EmissionSummary.findOne(baseQuery)
              .sort({ "period.to": -1, updatedAt: -1 })
              .lean();
          }
        }
      }
    }

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: "No data found for the specified period."
      });
    }

    // ----------------------------------------------------
    // 2) Normalise Maps → plain objects for emissionSummary
    // ----------------------------------------------------
    const convertMap = (value) => {
      if (value instanceof Map) return Object.fromEntries(value);
      if (Array.isArray(value)) return value.map(convertMap);
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const out = {};
        for (const k of Object.keys(value)) {
          out[k] = convertMap(value[k]);
        }
        return out;
      }
      return value;
    };

    const emissionSummary = convertMap(summary.emissionSummary || {});
    const reductionSummary = summary.reductionSummary || {
      totalNetReduction: 0,
      entriesCount: 0,
      byProject: [],
      byCategory: {},
      byScope: {},
      byLocation: {},
      byProjectActivity: {},
      byMethodology: {}
    };

    const baseResponse = {
      clientId: summary.clientId,
      period: summary.period,
      emissionSummary,
      reductionSummary,
      metadata: summary.metadata || {}
    };

    // ----------------------------------------------------
    // 3) type-based responses
    // ----------------------------------------------------
    if (type === "emission") {
      return res.status(200).json({
        success: true,
        type: "emission",
        data: {
          clientId: baseResponse.clientId,
          period: baseResponse.period,
          emissionSummary: baseResponse.emissionSummary,
          metadata: baseResponse.metadata
        }
      });
    }

    if (type === "reduction") {
      return res.status(200).json({
        success: true,
        type: "reduction",
        data: {
          clientId: baseResponse.clientId,
          period: baseResponse.period,
          reductionSummary: baseResponse.reductionSummary,
          metadata: baseResponse.metadata
        }
      });
    }

    // both
    return res.status(200).json({
      success: true,
      type: "both",
      data: baseResponse
    });
  } catch (error) {
    console.error("❌ Error getting emission summary:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get emission summary",
      error: error.message
    });
  }
};




const getMultipleSummaries = async (req, res) => {
  try {
    const { clientId } = req.params;
    const {
      periodType = "monthly",
      startYear,
      startMonth,
      endYear,
      endMonth,
      limit = 12,
      type = "both"
    } = req.query;

    // Validate
    if (!["daily", "weekly", "monthly", "yearly", "all-time"].includes(periodType)) {
      return res.status(400).json({ success: false, message: "Invalid period type" });
    }

    // ---------------------------------------------
    // 1) BUILD QUERY
    // ---------------------------------------------
    const query = { clientId, "period.type": periodType };

    if (startYear && endYear) {
      query["period.year"] = {
        $gte: parseInt(startYear),
        $lte: parseInt(endYear)
      };
    }

    if (startMonth) {
      query["period.month"] = {
        ...(query["period.month"] || {}),
        $gte: parseInt(startMonth)
      };
    }

    if (endMonth) {
      query["period.month"] = {
        ...(query["period.month"] || {}),
        $lte: parseInt(endMonth)
      };
    }

    // ---------------------------------------------
    // 2) FETCH DOCUMENTS
    // ---------------------------------------------
    const summaries = await EmissionSummary.find(query)
      .sort({ "period.year": -1, "period.month": -1 })
      .limit(parseInt(limit))
      .lean();

    // ---------------------------------------------
    // 3) deepConvert helper (same as getEmissionSummary)
    // ---------------------------------------------
    const deepConvert = (value) => {
      if (value instanceof Map) {
        return Object.fromEntries(
          [...value.entries()].map(([k, v]) => [k, deepConvert(v)])
        );
      }
      if (Array.isArray(value)) {
        return value.map(deepConvert);
      }
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const out = {};
        for (const k of Object.keys(value)) {
          out[k] = deepConvert(value[k]);
        }
        return out;
      }
      return value;
    };

    // ---------------------------------------------
    // 4) FORMAT EACH SUMMARY
    // ---------------------------------------------
    const formatted = summaries.map((doc) => {
      const emissionSummary  = deepConvert(doc.emissionSummary || {});
      const reductionSummary = deepConvert(doc.reductionSummary || {});

      const metadata = doc.metadata || {};

      // EMISSION ONLY
      if (type === "emission") {
        return {
          clientId: doc.clientId,
          period: doc.period,
          emissionSummary,
          metadata
        };
      }

      // REDUCTION ONLY
      if (type === "reduction") {
        return {
          clientId: doc.clientId,
          period: doc.period,
          reductionSummary,
          netReductions: doc.netReductions || { totalNetReduction: reductionSummary.totalNetReduction },
          metadata
        };
      }

      // BOTH
      return {
        clientId: doc.clientId,
        period: doc.period,
        emissionSummary,
        reductionSummary,
        netReductions: doc.netReductions || { totalNetReduction: reductionSummary.totalNetReduction },
        metadata
      };
    });

    // ---------------------------------------------
    // 5) RETURN RESPONSE
    // ---------------------------------------------
    return res.status(200).json({
      success: true,
      type,
      count: formatted.length,
      data: formatted
    });

  } catch (error) {
    console.error("❌ Error getting multiple summaries:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get multiple summaries",
      error: error.message
    });
  }
};







// Make sure you have this import somewhere above in the file:
// const EmissionSummary = require("../../models/CalculationEmission/EmissionSummary");

/**
 * Filtered Summary (Advanced + Legacy)
 * Supports:
 *  - emissionSummary (emissions)
 *  - reductionSummary (net reduction)
 *
 * Use query ?summaryKind=emission|reduction (or summaryType=...)
 * Default = "emission"
 */
const getFilteredSummary = async (req, res) => {
  try {
    const { clientId } = req.params;

    const {
      // period
      periodType,
      year,
      month,
      week,
      day,

      // summary selector
      summaryKind: summaryKindRaw,
      summaryType: summaryTypeRaw,

      // common filters (single + multi)
      scope,
      scopes,
      location,
      locations,
      department,
      departments,
      nodeId,
      nodeIds,

      // reduction filters
      projectId,
      projectIds,
      category,
      categories,
      activity,
      activities,
      methodology,
      methodologies,

      // sorting
      sortBy: sortByRaw,
      sortDirection: sortDirectionRaw,
      sortOrder: sortOrderRaw,
      limit: limitRaw,
      minCO2e: minCO2eRaw,
      maxCO2e: maxCO2eRaw,
    } = req.query;

    const normalizeArray = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) {
        return val.flatMap((v) => String(v).split(","))
          .map((v) => v.trim())
          .filter(Boolean);
      }
      return String(val).split(",").map((v) => v.trim()).filter(Boolean);
    };

    const safeNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const toLowerSet = (arr) => new Set((arr || []).map((x) => String(x).toLowerCase()));

    const summaryKind = (summaryKindRaw || summaryTypeRaw || "emission").toLowerCase(); // emission|reduction|both

    // -------------------------------------------
    // 1) Load summary doc (exact period or latest)
    // -------------------------------------------
    let query = { clientId };
    let fullSummary;

    if (periodType) {
      query["period.type"] = periodType;
      if (year) query["period.year"] = parseInt(year);
      if (month) query["period.month"] = parseInt(month);
      if (week) query["period.week"] = parseInt(week);
      if (day) query["period.day"] = parseInt(day);

      fullSummary = await EmissionSummary.findOne(query).lean();
    } else {
      fullSummary = await EmissionSummary.findOne({ clientId })
        .sort({ "period.to": -1, updatedAt: -1 })
        .lean();
    }

    if (!fullSummary) {
      return res.status(404).json({ success: false, message: "No summary data found." });
    }

    // -------------------------------------------
    // 2) Normalize data
    // -------------------------------------------
    const es = fullSummary.emissionSummary || {};
    const rs = fullSummary.reductionSummary || {};

    const byNode = es.byNode || {};
    const byScope = es.byScope || {};
    const totalEmissions = es.totalEmissions || { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 };

    // Build node rows (main emission “records”)
    let nodes = Object.entries(byNode).map(([id, n]) => {
      const s1 = safeNum(n?.byScope?.["Scope 1"]?.CO2e);
      const s2 = safeNum(n?.byScope?.["Scope 2"]?.CO2e);
      const s3 = safeNum(n?.byScope?.["Scope 3"]?.CO2e);

      return {
        nodeId: id,
        nodeLabel: n?.nodeLabel || "",
        department: n?.department || "",
        location: n?.location || "",
        byScope: { "Scope 1": s1, "Scope 2": s2, "Scope 3": s3 },
        CO2e: safeNum(n?.CO2e),
        CO2: safeNum(n?.CO2),
        CH4: safeNum(n?.CH4),
        N2O: safeNum(n?.N2O),
        uncertainty: safeNum(n?.uncertainty),
      };
    });

    // Build project rows (main reduction “records”)
    let projects = Array.isArray(rs.byProject) ? rs.byProject.map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName || p.projectId,
      scope: p.scope || "",
      category: p.category || "",
      location: p.location || "",
      methodology: p.methodology || "",
      projectActivity: p.projectActivity || "",
      totalNetReduction: safeNum(p.totalNetReduction),
      entriesCount: p.entriesCount || 0,
    })) : [];

    // -------------------------------------------
    // 3) Parse filters
    // -------------------------------------------
    const selectedScopes = normalizeArray(scopes || scope);
    const selectedLocations = normalizeArray(locations || location);
    const selectedDepartments = normalizeArray(departments || department);
    const selectedNodeIds = normalizeArray(nodeIds || nodeId);

    const selectedProjectIds = normalizeArray(projectIds || projectId);
    const selectedCategories = normalizeArray(categories || category);
    const selectedActivities = normalizeArray(activities || activity);
    const selectedMethodologies = normalizeArray(methodologies || methodology);

    const locSet = toLowerSet(selectedLocations);
    const deptSet = toLowerSet(selectedDepartments);
    const nodeSet = new Set(selectedNodeIds);

    const projSet = new Set(selectedProjectIds);
    const catSet = toLowerSet(selectedCategories);
    const actSet = toLowerSet(selectedActivities);
    const methSet = toLowerSet(selectedMethodologies);

    const minCO2e = minCO2eRaw != null ? Number(minCO2eRaw) : null;
    const maxCO2e = maxCO2eRaw != null ? Number(maxCO2eRaw) : null;

    const limit = limitRaw ? parseInt(limitRaw) : null;

    const sortBy = (sortByRaw || "co2e").toLowerCase();
    const direction = (sortDirectionRaw || sortOrderRaw || "desc").toLowerCase();
    const sortDirection = direction === "asc" || direction === "low" ? "asc" : "desc";

    // -------------------------------------------
    // 4) Filter EMISSION nodes
    // -------------------------------------------
    if (selectedNodeIds.length) {
      nodes = nodes.filter((n) => nodeSet.has(n.nodeId));
    }
    if (selectedLocations.length) {
      nodes = nodes.filter((n) => locSet.has(String(n.location).toLowerCase()));
    }
    if (selectedDepartments.length) {
      nodes = nodes.filter((n) => deptSet.has(String(n.department).toLowerCase()));
    }

    // Scope selection affects “selectedScopeCO2e”
    const scopeUniverse = ["Scope 1", "Scope 2", "Scope 3"];
    const scopesForSum = selectedScopes.length ? selectedScopes : scopeUniverse;

    nodes = nodes.map((n) => ({
      ...n,
      selectedScopeCO2e: scopesForSum.reduce((sum, sc) => sum + safeNum(n.byScope?.[sc]), 0),
    }));

    if (minCO2e != null) nodes = nodes.filter((n) => n.selectedScopeCO2e >= minCO2e);
    if (maxCO2e != null) nodes = nodes.filter((n) => n.selectedScopeCO2e <= maxCO2e);

    // Sort nodes
    const nodeSort = (a, b) => {
      const dir = sortDirection === "asc" ? 1 : -1;

      const val = (x) => {
        if (sortBy === "label" || sortBy === "nodelabel") return String(x.nodeLabel || "").toLowerCase();
        if (sortBy === "department") return String(x.department || "").toLowerCase();
        if (sortBy === "location") return String(x.location || "").toLowerCase();
        if (sortBy === "scope1") return safeNum(x.byScope["Scope 1"]);
        if (sortBy === "scope2") return safeNum(x.byScope["Scope 2"]);
        if (sortBy === "scope3") return safeNum(x.byScope["Scope 3"]);
        if (sortBy === "selectedscopeco2e") return safeNum(x.selectedScopeCO2e);
        return safeNum(x.selectedScopeCO2e ?? x.CO2e);
      };

      const va = val(a);
      const vb = val(b);

      if (typeof va === "string" || typeof vb === "string") {
        return va.localeCompare(vb) * dir;
      }
      return (va - vb) * dir;
    };
    nodes.sort(nodeSort);

    // Compute emission aggregates from filtered nodes
    const emissionAgg = {
      totalFilteredEmissions: {
        CO2e: nodes.reduce((s, n) => s + safeNum(n.selectedScopeCO2e), 0),
        CO2: nodes.reduce((s, n) => s + safeNum(n.CO2), 0),
        CH4: nodes.reduce((s, n) => s + safeNum(n.CH4), 0),
        N2O: nodes.reduce((s, n) => s + safeNum(n.N2O), 0),
        uncertainty: 0,
      },
      byScope: {},
      byLocation: {},
      byDepartment: {},
    };

    for (const sc of scopesForSum) {
      emissionAgg.byScope[sc] = {
        CO2e: nodes.reduce((s, n) => s + safeNum(n.byScope?.[sc]), 0),
        nodeCount: nodes.filter((n) => safeNum(n.byScope?.[sc]) > 0).length,
      };
    }

    for (const n of nodes) {
      const lk = n.location || "Unknown";
      if (!emissionAgg.byLocation[lk]) emissionAgg.byLocation[lk] = { CO2e: 0, nodeCount: 0 };
      emissionAgg.byLocation[lk].CO2e += safeNum(n.selectedScopeCO2e);
      emissionAgg.byLocation[lk].nodeCount += 1;

      const dk = n.department || "Unknown";
      if (!emissionAgg.byDepartment[dk]) emissionAgg.byDepartment[dk] = { CO2e: 0, nodeCount: 0 };
      emissionAgg.byDepartment[dk].CO2e += safeNum(n.selectedScopeCO2e);
      emissionAgg.byDepartment[dk].nodeCount += 1;
    }

    // Facets for cascading UI filters
    const facetsEmission = {
      locations: Object.entries(emissionAgg.byLocation)
        .map(([k, v]) => ({ value: k, ...v }))
        .sort((a, b) => b.CO2e - a.CO2e),
      departments: Object.entries(emissionAgg.byDepartment)
        .map(([k, v]) => ({ value: k, ...v }))
        .sort((a, b) => b.CO2e - a.CO2e),
      scopes: Object.entries(emissionAgg.byScope)
        .map(([k, v]) => ({ value: k, ...v }))
        .sort((a, b) => b.CO2e - a.CO2e),
    };

    let nodesPrimary = nodes;
    if (limit) nodesPrimary = nodes.slice(0, limit);

    // -------------------------------------------
    // 5) Filter REDUCTION projects (multi-stage)
    // -------------------------------------------
    if (selectedProjectIds.length) {
      projects = projects.filter((p) => projSet.has(p.projectId));
    }
    if (selectedLocations.length) {
      projects = projects.filter((p) => locSet.has(String(p.location).toLowerCase()));
    }
    if (selectedCategories.length) {
      projects = projects.filter((p) => catSet.has(String(p.category).toLowerCase()));
    }
    if (selectedActivities.length) {
      projects = projects.filter((p) => actSet.has(String(p.projectActivity).toLowerCase()));
    }
    if (selectedMethodologies.length) {
      projects = projects.filter((p) => methSet.has(String(p.methodology).toLowerCase()));
    }
    if (selectedScopes.length) {
      const sSet = toLowerSet(selectedScopes);
      projects = projects.filter((p) => sSet.has(String(p.scope).toLowerCase()));
    }

    if (minCO2e != null) projects = projects.filter((p) => p.totalNetReduction >= minCO2e);
    if (maxCO2e != null) projects = projects.filter((p) => p.totalNetReduction <= maxCO2e);

    const projectSort = (a, b) => {
      const dir = sortDirection === "asc" ? 1 : -1;

      const val = (x) => {
        if (sortBy === "projectname") return String(x.projectName || "").toLowerCase();
        if (sortBy === "entriescount") return safeNum(x.entriesCount);
        return safeNum(x.totalNetReduction);
      };

      const va = val(a);
      const vb = val(b);

      if (typeof va === "string" || typeof vb === "string") {
        return va.localeCompare(vb) * dir;
      }
      return (va - vb) * dir;
    };
    projects.sort(projectSort);

    let projectsPrimary = projects;
    if (limit) projectsPrimary = projects.slice(0, limit);

    const reductionAgg = {
      totalFilteredNetReduction: projects.reduce((s, p) => s + safeNum(p.totalNetReduction), 0),
      byScope: {},
      byLocation: {},
      byCategory: {},
      byProjectActivity: {},
      byMethodology: {},
    };

    const bump = (obj, key, val) => {
      const k = key || "Unknown";
      if (!obj[k]) obj[k] = { totalNetReduction: 0, projectCount: 0 };
      obj[k].totalNetReduction += val;
      obj[k].projectCount += 1;
    };

    for (const p of projects) {
      const v = safeNum(p.totalNetReduction);
      bump(reductionAgg.byScope, p.scope, v);
      bump(reductionAgg.byLocation, p.location, v);
      bump(reductionAgg.byCategory, p.category, v);
      bump(reductionAgg.byProjectActivity, p.projectActivity, v);
      bump(reductionAgg.byMethodology, p.methodology, v);
    }

    const facetsReduction = {
      scopes: Object.entries(reductionAgg.byScope).map(([k, v]) => ({ value: k, ...v })).sort((a, b) => b.totalNetReduction - a.totalNetReduction),
      locations: Object.entries(reductionAgg.byLocation).map(([k, v]) => ({ value: k, ...v })).sort((a, b) => b.totalNetReduction - a.totalNetReduction),
      categories: Object.entries(reductionAgg.byCategory).map(([k, v]) => ({ value: k, ...v })).sort((a, b) => b.totalNetReduction - a.totalNetReduction),
      activities: Object.entries(reductionAgg.byProjectActivity).map(([k, v]) => ({ value: k, ...v })).sort((a, b) => b.totalNetReduction - a.totalNetReduction),
      methodologies: Object.entries(reductionAgg.byMethodology).map(([k, v]) => ({ value: k, ...v })).sort((a, b) => b.totalNetReduction - a.totalNetReduction),
    };

    // -------------------------------------------
    // 6) Response (emission / reduction / both)
    // -------------------------------------------
    const response = {
      success: true,
      clientId,
      period: fullSummary.period,
      metadata: fullSummary.metadata || {},
    };

    if (summaryKind === "emission") {
      response.summaryKind = "emission";
      response.data = {
        totalEmissions,
        byScope, // original period totals (not filtered)
        nodes,
        primary: nodesPrimary,
        aggregates: emissionAgg,
        facets: facetsEmission,
      };
      return res.status(200).json(response);
    }

    if (summaryKind === "reduction") {
      response.summaryKind = "reduction";
      response.data = {
        totalNetReduction: safeNum(rs.totalNetReduction),
        projects,
        primary: projectsPrimary,
        aggregates: reductionAgg,
        facets: facetsReduction,
      };
      return res.status(200).json(response);
    }

    // both
    response.summaryKind = "both";
    response.data = {
      emission: {
        totalEmissions,
        nodes,
        primary: nodesPrimary,
        aggregates: emissionAgg,
        facets: facetsEmission,
      },
      reduction: {
        totalNetReduction: safeNum(rs.totalNetReduction),
        projects,
        primary: projectsPrimary,
        aggregates: reductionAgg,
        facets: facetsReduction,
      },
    };
    return res.status(200).json(response);

  } catch (error) {
    console.error("❌ Error in getFilteredSummary:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get filtered summary",
      error: error.message,
    });
  }
};




// ============================================================================
// ========================  EMISSION SUMMARY HELPERS  ========================
// ============================================================================
// Highly standardized, robust utilities to extract Scope 1, Scope 2,
// category totals, node totals, etc. from the NEW EmissionSummary model.
//
// This fully supports:
//  - nested paths inside emissionSummary
//  - Map, Object, Array formats
//  - safe numeric extraction (CO2e, CO2, CH4, N2O)
//  - flexible scope keys ("Scope 1", "scope1", "SCOPE1")
// ============================================================================


// ============================= BASIC NORMALIZERS =============================

/**
 * Normalize keys consistently.
 * Examples:
 *   "Scope 1" → "scope1"
 *   "Scope    2" → "scope2"
 *   "SCOPE 1" → "scope1"
 */
const normalizeKey = (key) => {
  if (!key) return "";
  return key.toString().trim().toLowerCase().replace(/\s+/g, "");
};

/**
 * Robust numeric caster.
 * Ensures:
 *   toNum(undefined) → 0
 *   toNum("10") → 10
 *   toNum("abc") → 0
 */
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Extract CO2e cleanly from:
 *   - { CO2e: 10 }
 *   - { CO2: 10, CH4: ..., N2O: ... }
 *   - 10 (direct numeric)
 */
const extractCO2e = (item) => {
  if (!item) return 0;
  if (typeof item === "number") return item;
  if (typeof item.CO2e === "number") return toNum(item.CO2e);
  return 0;
};


// ========================== GENERALIZED EXTRACTOR ============================

/**
 * Universal extractor for any grouped object or Map.
 * categoryObj = {
 *   Cement: { CO2e: 100 },
 *   Steel: { CO2e: 50 }
 * }
 *
 * OR Map<string, {...}>
 *
 * Returns:
 *   { total: 150, breakdown: { Cement: 100, Steel: 50 } }
 */
const extractFromMapOrObj = (input) => {
  const breakdown = {};
  let total = 0;

  if (!input) return { total, breakdown };

  // CASE 1: Map
  if (typeof input.get === "function" && typeof input.keys === "function") {
    for (const key of input.keys()) {
      const val = input.get(key);
      const co2e = extractCO2e(val);
      breakdown[key] = co2e;
      total += co2e;
    }
    return { total, breakdown };
  }

  // CASE 2: Plain Object
  if (typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      const co2e = extractCO2e(v);
      breakdown[k] = co2e;
      total += co2e;
    }
  }

  return { total, breakdown };
};


// ========================== SCOPE 1 + SCOPE 2 EXTRACTOR ======================

/**
 * Extracts Scope 1 and Scope 2 totals from:
 *   - Array form: [{ scopeType: "Scope 1", CO2e: ... }]
 *   - Map form: Map("Scope 1" => {CO2e})
 *   - Object form: { "Scope 1": {CO2e}, "Scope 2": {CO2e} }
 */
const extractS1S2FromByScope = (byScope) => {
  let s1 = 0;
  let s2 = 0;

  if (!byScope) return { s1, s2 };

  // ---------------- Array Format ----------------
  if (Array.isArray(byScope)) {
    for (const item of byScope) {
      const key = normalizeKey(item?.scopeType || item.scope);
      if (key === "scope1") s1 += extractCO2e(item);
      if (key === "scope2") s2 += extractCO2e(item);
    }
    return { s1, s2 };
  }

  // ---------------- Map Format ------------------
  if (typeof byScope.get === "function" && typeof byScope.keys === "function") {
    for (const keyRaw of byScope.keys()) {
      const val = byScope.get(keyRaw);
      const norm = normalizeKey(keyRaw);
      if (norm === "scope1") s1 += extractCO2e(val);
      if (norm === "scope2") s2 += extractCO2e(val);

      const vKey = normalizeKey(val?.scopeType || val?.scope);
      if (vKey === "scope1") s1 += extractCO2e(val);
      if (vKey === "scope2") s2 += extractCO2e(val);
    }
    return { s1, s2 };
  }

  // --------------- Object Format ----------------
  if (typeof byScope === "object") {
    for (const [k, v] of Object.entries(byScope)) {
      const norm = normalizeKey(k);
      if (norm === "scope1") s1 += extractCO2e(v);
      if (norm === "scope2") s2 += extractCO2e(v);

      const vKey = normalizeKey(v?.scopeType || v?.scope);
      if (vKey === "scope1") s1 += extractCO2e(v);
      if (vKey === "scope2") s2 += extractCO2e(v);
    }
  }

  return { s1, s2 };
};


// =========================== NODE TOTALS EXTRACTOR ===========================

/**
 * Extract totals for all nodes:
 * byNode = {
 *   "node123": { CO2e: 100, byScope: {...} },
 *   "node456": { CO2e: 200, byScope: {...} }
 * }
 */
const extractNodeTotals = (byNode) => {
  const nodes = {};
  let total = 0;

  if (!byNode) return { total, nodes };

  for (const [nodeId, node] of Object.entries(byNode)) {
    const co2e = extractCO2e(node);
    nodes[nodeId] = co2e;
    total += co2e;
  }

  return { total, nodes };
};


// ========================= CATEGORY / ACTIVITY / DEPARTMENT ==================

const extractCategoryTotals = (obj) => extractFromMapOrObj(obj);
const extractActivityTotals = (obj) => extractFromMapOrObj(obj);
const extractDepartmentTotals = (obj) => extractFromMapOrObj(obj);
const extractLocationTotals = (obj) => extractFromMapOrObj(obj);
const extractInputTypeTotals = (obj) => extractFromMapOrObj(obj);
const extractEmissionFactorTotals = (obj) => extractFromMapOrObj(obj);


const getLatestScope12Total = async (req, res) => {
  try {
    const { clientId } = req.params;
    const summaryKind = (req.query.summaryKind || "emission").toLowerCase(); // "emission" | "reduction"

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: "clientId is required",
        timestamp: new Date().toISOString()
      });
    }

    // =====================================================
    // 1) Fetch the LATEST summary document for this client
    // =====================================================
    const latest = await EmissionSummary.findOne({ clientId })
      .sort({ "period.to": -1, updatedAt: -1 })
      .lean();

    if (!latest) {
      return res.status(404).json({
        success: false,
        message: "No summary available for this client",
        summaryKind,
        timestamp: new Date().toISOString()
      });
    }

    // =====================================================
    // 2) Handle EMISSION SUMMARY mode
    // =====================================================
    if (summaryKind === "emission") {
      const byScopeMain =
        latest.byScope || latest.emissionSummary?.byScope || null;

      let { s1, s2 } = extractS1S2FromByScope(byScopeMain);

      // ------------------------------------------
      // Fallback #1: compute from each node
      // ------------------------------------------
      if ((s1 + s2) === 0) {
        const byNodeMain =
          latest.byNode || latest.emissionSummary?.byNode || {};

        const nodeList = Array.isArray(byNodeMain)
          ? byNodeMain
          : typeof byNodeMain === "object"
            ? Object.values(byNodeMain)
            : [];

        for (const node of nodeList) {
          if (node?.byScope) {
            const part = extractS1S2FromByScope(node.byScope);
            s1 += part.s1;
            s2 += part.s2;
          }

          // Rare backward-compatible direct fields:
          if (node?.scope1)
            s1 += toNum(node.scope1?.CO2e ?? node.scope1);
          if (node?.scope2)
            s2 += toNum(node.scope2?.CO2e ?? node.scope2);
        }
      }

      return res.status(200).json({
        success: true,
        summaryKind: "emission",
        message: "Latest Scope 1 & Scope 2 totals (emissions)",
        data: {
          clientId,
          latestPeriod: latest.period || latest.emissionSummary?.period || null,
          scope1CO2e: s1,
          scope2CO2e: s2,
          scope12TotalCO2e: s1 + s2,
          sourceSummaryId: latest._id
        },
        timestamp: new Date().toISOString()
      });
    }

    // =====================================================
    // 3) Handle REDUCTION SUMMARY mode
    //     (NEW — supports reductions byScope)
    // =====================================================
    if (summaryKind === "reduction") {
      const byScopeRed =
        latest.reductionSummary?.byScope || null;

      let { s1, s2 } = extractS1S2FromByScope(byScopeRed);

      // If summary has project-level breakdown only:
      if ((s1 + s2) === 0) {
        const byProject = latest.reductionSummary?.byProject || [];

        for (const p of byProject) {
          if (p.scope) {
            const k = p.scope.toString().toLowerCase().replace(/\s+/g, "");
            if (k === "scope1") s1 += toNum(p.totalNetReduction);
            if (k === "scope2") s2 += toNum(p.totalNetReduction);
          }
        }
      }

      return res.status(200).json({
        success: true,
        summaryKind: "reduction",
        message: "Latest Scope 1 & Scope 2 totals (reductions)",
        data: {
          clientId,
          latestPeriod: latest.period || null,
          scope1NetReduction: s1,
          scope2NetReduction: s2,
          scope12NetReductionTotal: s1 + s2,
          sourceSummaryId: latest._id
        },
        timestamp: new Date().toISOString()
      });
    }

    // =====================================================
    // Unknown summaryKind
    // =====================================================
    return res.status(400).json({
      success: false,
      message: `Invalid summaryKind: ${summaryKind}. Must be 'emission' or 'reduction'.`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("getLatestScope12Total error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch Scope 1 & Scope 2 totals",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};



/**
 * GET /api/summaries/:clientId/top-low-stats
 *
 * Supports:
 *    ➤ Emission Summary   (?summaryKind=emission)
 *    ➤ Reduction Summary  (?summaryKind=reduction)
 *
 * Default = emission
 */
const getTopLowEmissionStats = async (req, res) => {
  try {
    const { clientId } = req.params;
    const summaryKind = (req.query.summaryKind || "emission").toLowerCase();

    const {
      periodType,
      year, month, day, week,
      limit: limitRaw
    } = req.query;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: "clientId is required",
      });
    }

    // Helpers
    const limit = limitRaw ? Math.max(1, parseInt(limitRaw)) : 5;

    const safeNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const toEntries = (value) => {
      if (!value) return [];
      if (value instanceof Map) return [...value.entries()];
      if (typeof value === "object") return Object.entries(value);
      return [];
    };

    const normalize = (rootValue, groupedValue) => {
      if (rootValue) return rootValue;
      if (groupedValue) return groupedValue;
      return {};
    };

    // -------------------------------------------------------
    // Step 1: Fetch correct summary document
    // -------------------------------------------------------
    let query = { clientId };
    let fullSummary = null;

    if (periodType) {
      query["period.type"] = periodType;
      if (year) query["period.year"] = Number(year);
      if (month) query["period.month"] = Number(month);
      if (day) query["period.day"] = Number(day);
      if (week) query["period.week"] = Number(week);

      fullSummary = await EmissionSummary.findOne(query).lean();
    } else {
      fullSummary = await EmissionSummary.findOne({ clientId })
        .sort({ "period.to": -1 })
        .lean();
    }

    if (!fullSummary) {
      return res.status(404).json({
        success: false,
        message: "No summary found",
      });
    }

    const period =
      fullSummary.period ||
      fullSummary.emissionSummary?.period ||
      fullSummary.reductionSummary?.period ||
      null;

    // ======================================================
    // MODE 1: EMISSION SUMMARY
    // ======================================================
    if (summaryKind === "emission") {
      // Extract emission paths
      const totalEmissions =
        fullSummary.totalEmissions ||
        fullSummary.emissionSummary?.totalEmissions ||
        { CO2e: 0 };

      const totalCO2e = safeNum(totalEmissions.CO2e);

      const byCategory = normalize(fullSummary.byCategory, fullSummary.emissionSummary?.byCategory);
      const byScope = normalize(fullSummary.byScope, fullSummary.emissionSummary?.byScope);
      const byActivity = normalize(fullSummary.byActivity, fullSummary.emissionSummary?.byActivity);
      const byDepartment = normalize(fullSummary.byDepartment, fullSummary.emissionSummary?.byDepartment);
      const byEmissionFactor = normalize(fullSummary.byEmissionFactor, fullSummary.emissionSummary?.byEmissionFactor);

      // ----------------------------------------------------
      // Categories
      // ----------------------------------------------------
      const categoryEntries = toEntries(byCategory);
      const categoryList = categoryEntries.map(([name, val]) => {
        const co2e = safeNum(val?.CO2e);
        return {
          categoryName: name,
          scopeType: val?.scopeType || null,
          CO2e: co2e,
          percentage: totalCO2e > 0 ? Number(((co2e / totalCO2e) * 100).toFixed(2)) : 0,
        };
      });

      const topCategories = [...categoryList].sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
      const bottomCategories = [...categoryList]
        .filter(c => c.CO2e > 0)
        .sort((a, b) => a.CO2e - b.CO2e)
        .slice(0, limit);

      // ----------------------------------------------------
      // Scope-level Stats
      // ----------------------------------------------------
      const scopeOrder = ["Scope 1", "Scope 2", "Scope 3"];
      const scopeList = [];

      for (const s of scopeOrder) {
        const val = byScope[s];
        if (!val) continue;

        const co2e = safeNum(val.CO2e);
        scopeList.push({
          scopeType: s,
          CO2e: co2e,
          breakdown: val,
          percentage: totalCO2e > 0 ? Number(((co2e / totalCO2e) * 100).toFixed(2)) : 0,
        });
      }

      const highestScope = [...scopeList].sort((a, b) => b.CO2e - a.CO2e)[0] || null;
      const lowestScope = scopeList.find(s => s.CO2e > 0) || null;

      // ----------------------------------------------------
      // Activities
      // ----------------------------------------------------
      const activityEntriesList = toEntries(byActivity);
      const activityList = activityEntriesList.map(([name, data]) => {
        const co2e = safeNum(data?.CO2e);
        return {
          activityName: name,
          scopeType: data?.scopeType || null,
          categoryName: data?.categoryName || null,
          CO2e: co2e,
          percentage: totalCO2e > 0 ? Number(((co2e / totalCO2e) * 100).toFixed(2)) : 0,
        };
      });

      const topActivities = [...activityList].sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
      const bottomActivities = [...activityList]
        .filter(a => a.CO2e > 0)
        .sort((a, b) => a.CO2e - b.CO2e)
        .slice(0, limit);

      // ----------------------------------------------------
      // Departments
      // ----------------------------------------------------
      const deptEntries = toEntries(byDepartment);
      const deptList = deptEntries.map(([name, data]) => {
        const co2e = safeNum(data?.CO2e);
        return {
          departmentName: name,
          CO2e: co2e,
          nodeCount: safeNum(data?.nodeCount),
          percentage: totalCO2e > 0 ? Number(((co2e / totalCO2e) * 100).toFixed(2)) : 0,
        };
      });

      const topDepartments = [...deptList].sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
      const bottomDepartments = [...deptList]
        .filter(d => d.CO2e > 0)
        .sort((a, b) => a.CO2e - b.CO2e)
        .slice(0, limit);

      // ----------------------------------------------------
      // Emission Sources (EF-based)
      // ----------------------------------------------------
      const srcEntries = toEntries(byEmissionFactor);
      const srcList = srcEntries.map(([name, data]) => {
        const co2e = safeNum(data?.CO2e);
        return {
          sourceName: name,
          CO2e: co2e,
          dataPointCount: safeNum(data?.dataPointCount),
          scopeTypes: Array.isArray(data?.scopeTypes) ? data.scopeTypes : [],
          percentage: totalCO2e > 0 ? Number(((co2e / totalCO2e) * 100).toFixed(2)) : 0,
        };
      });

      const topSources = [...srcList].sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
      const bottomSources = [...srcList]
        .filter(s => s.CO2e > 0)
        .sort((a, b) => a.CO2e - b.CO2e)
        .slice(0, limit);

      return res.status(200).json({
        success: true,
        summaryKind: "emission",
        data: {
          clientId,
          period,
          totalEmissions,

          categories: {
            top: topCategories,
            bottom: bottomCategories,
          },

          scopes: {
            highest: highestScope,
            lowest: lowestScope,
            all: scopeList,
          },

          activities: {
            top: topActivities,
            bottom: bottomActivities,
          },

          departments: {
            top: topDepartments,
            bottom: bottomDepartments,
          },

          emissionSources: {
            top: topSources,
            bottom: bottomSources,
          },
        },
      });
    }

    // ======================================================
    // MODE 2: REDUCTION SUMMARY
    // ======================================================
    if (summaryKind === "reduction") {
      const RS = fullSummary.reductionSummary || {};

      const totalNetReduction = safeNum(RS.totalNetReduction);
      const total = totalNetReduction > 0 ? totalNetReduction : 1; // avoid /0

      // ----------------------------------------------------
      //  Categories
      // ----------------------------------------------------
      const { breakdown: catBreak } = extractFromMapOrObj(RS.byCategory);
      const categoryList = Object.entries(catBreak).map(([name, co2e]) => ({
        categoryName: name,
        CO2e: safeNum(co2e),
        percentage: Number(((safeNum(co2e) / total) * 100).toFixed(2)),
      }));

      const topCategories = [...categoryList].sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
      const bottomCategories = [...categoryList]
        .filter(c => c.CO2e > 0)
        .sort((a, b) => a.CO2e - b.CO2e)
        .slice(0, limit);

      // ----------------------------------------------------
      // Scopes
      // ----------------------------------------------------
      const { breakdown: scopeBreak } = extractFromMapOrObj(RS.byScope);
      const scopeList = Object.entries(scopeBreak).map(([name, co2e]) => ({
        scopeType: name,
        CO2e: safeNum(co2e),
        percentage: Number(((safeNum(co2e) / total) * 100).toFixed(2)),
      }));

      const highestScope = [...scopeList].sort((a, b) => b.CO2e - a.CO2e)[0] || null;
      const lowestScope = scopeList.find(s => s.CO2e > 0) || null;

      // ----------------------------------------------------
      // Locations
      // ----------------------------------------------------
      const { breakdown: locBreak } = extractFromMapOrObj(RS.byLocation);
      const locationList = Object.entries(locBreak).map(([name, co2e]) => ({
        locationName: name,
        CO2e: safeNum(co2e),
        percentage: Number(((safeNum(co2e) / total) * 100).toFixed(2)),
      }));

      const topLocations = [...locationList].sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
      const bottomLocations = [...locationList]
        .filter(a => a.CO2e > 0)
        .sort((a, b) => a.CO2e - b.CO2e)
        .slice(0, limit);

      // ----------------------------------------------------
      // Project Activity Breakdown
      // ----------------------------------------------------
      const { breakdown: actBreak } = extractFromMapOrObj(RS.byProjectActivity);
      const projectActivityList = Object.entries(actBreak).map(([name, co2e]) => ({
        projectActivity: name,
        CO2e: safeNum(co2e),
        percentage: Number(((safeNum(co2e) / total) * 100).toFixed(2)),
      }));

      const topActivities = [...projectActivityList].sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
      const bottomActivities = [...projectActivityList]
        .filter(a => a.CO2e > 0)
        .sort((a, b) => a.CO2e - b.CO2e)
        .slice(0, limit);

      // ----------------------------------------------------
      // Projects
      // ----------------------------------------------------
      const byProject = Array.isArray(RS.byProject) ? RS.byProject : [];

      const projectList = byProject.map(p => ({
        projectId: p.projectId,
        projectName: p.projectName,
        scope: p.scope,
        category: p.category,
        location: p.location,
        projectActivity: p.projectActivity,
        CO2e: safeNum(p.totalNetReduction),
        entriesCount: p.entriesCount || 0,
        percentage: Number(((safeNum(p.totalNetReduction) / total) * 100).toFixed(2)),
      }));

      const topProjects = [...projectList].sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
      const bottomProjects = [...projectList]
        .filter(a => a.CO2e > 0)
        .sort((a, b) => a.CO2e - b.CO2e)
        .slice(0, limit);

      return res.status(200).json({
        success: true,
        summaryKind: "reduction",
        data: {
          clientId,
          period,
          totalNetReduction,

          categories: {
            top: topCategories,
            bottom: bottomCategories,
          },

          scopes: {
            highest: highestScope,
            lowest: lowestScope,
            all: scopeList,
          },

          locations: {
            top: topLocations,
            bottom: bottomLocations,
          },

          projectActivities: {
            top: topActivities,
            bottom: bottomActivities,
          },

          projects: {
            top: topProjects,
            bottom: bottomProjects,
          },
        },
      });
    }

    // If summaryKind is invalid:
    return res.status(400).json({
      success: false,
      message: `Invalid summaryKind '${summaryKind}'. Use 'emission' or 'reduction'`,
    });

  } catch (error) {
    console.error("Error in getTopLowEmissionStats:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get top/low stats",
      error: error.message,
    });
  }
};


/**
 * Get highest / lowest emitting scopeIdentifier (and dates),
 * including node/location/department breakdown.
 * Fully updated to align with NEW Option-B EmissionSummary model.
 */
const getScopeIdentifierEmissionExtremes = async (req, res) => {
  try {
    const { clientId } = req.params;
    let { periodType = "monthly", year, month, week, day } = req.query;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: "clientId is required"
      });
    }

    const allowedTypes = ["daily", "weekly", "monthly", "yearly", "all-time"];
    if (!allowedTypes.includes(periodType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid periodType. Allowed: ${allowedTypes.join(", ")}`
      });
    }

    // ----------------------------------------------
    // Resolve period (same as calculateEmissionSummary)
    // ----------------------------------------------
    const now = moment.utc();
    const y = year ? Number(year) : now.year();
    const m = month ? Number(month) : now.month() + 1;
    const w = week ? Number(week) : now.isoWeek();
    const d = day ? Number(day) : now.date();

    const { from, to } = buildDateRange(periodType, y, m, w, d);

    // ----------------------------------------------
    // Fetch all processed data entries for period
    // ----------------------------------------------
    const dataEntries = await DataEntry.find({
      clientId,
      processingStatus: "processed",
      timestamp: { $gte: from, $lte: to }
    }).lean();

    if (!dataEntries.length) {
      return res.status(404).json({
        success: false,
        message: "No processed entries for this period"
      });
    }

    // ----------------------------------------------
    // Get active flowchart for node metadata
    // If not found, fallback to EmissionSummary.byNode
    // ----------------------------------------------
    let nodeMetaMap = new Map();

    try {
      const activeChart = await getActiveFlowchart(clientId);
      const flowchart = activeChart?.chart;

      if (flowchart?.nodes?.length) {
        flowchart.nodes.forEach(n => {
          nodeMetaMap.set(n.id, {
            nodeId: n.id,
            label: n.label || "Unnamed node",
            department: n.details?.department || "Unknown",
            location: n.details?.location || "Unknown"
          });
        });
      }
    } catch (errFlow) {
      console.warn("⚠ No active flowchart found:", errFlow?.message);
    }

    // ----------------------------------------------
    // If flowchart metadata missing → use EmissionSummary metadata
    // ----------------------------------------------
    if (nodeMetaMap.size === 0) {
      const latestSummary = await EmissionSummary.findOne({ clientId })
        .sort({ "period.to": -1 })
        .lean();

      if (latestSummary) {
        const byNode =
          latestSummary.byNode ||
          latestSummary.emissionSummary?.byNode ||
          {};

        for (const [nodeId, nd] of Object.entries(byNode)) {
          nodeMetaMap.set(nodeId, {
            nodeId,
            label: nd.nodeLabel || "Unnamed node",
            department: nd.department || "Unknown",
            location: nd.location || "Unknown"
          });
        }
      }
    }

    // ----------------------------------------------
    // Helpers
    // ----------------------------------------------
    const safeNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const getDateStringFromEntry = (entry) => {
      if (entry.date) return entry.date;
      const dt = moment.utc(entry.timestamp);
      return `${dt.date().toString().padStart(2, "0")}:${(dt.month()+1)
        .toString()
        .padStart(2, "0")}:${dt.year()}`;
    };

    // ----------------------------------------------
    // Build stats grouped by scopeIdentifier
    // ----------------------------------------------
    const scopeStatsMap = new Map();

    for (const entry of dataEntries) {
      const scopeIdentifier = entry.scopeIdentifier || "Unknown";
      const meta = nodeMetaMap.get(entry.nodeId) || {};

      const emissions = extractEmissionValues(entry.calculatedEmissions);
      const co2e = safeNum(emissions.CO2e);
      const dateStr = getDateStringFromEntry(entry);

      if (!scopeStatsMap.has(scopeIdentifier)) {
        scopeStatsMap.set(scopeIdentifier, {
          scopeIdentifier,
          totalCO2e: 0,
          entriesCount: 0,
          maxEntry: null,
          minEntry: null,
          dailyTotals: new Map(),
          nodes: new Map(),
          locations: new Map(),
          departments: new Map()
        });
      }

      const stat = scopeStatsMap.get(scopeIdentifier);

      // Accumulate totals
      stat.totalCO2e += co2e;
      stat.entriesCount += 1;

      const entryInfo = {
        entryId: entry._id,
        nodeId: entry.nodeId,
        scopeType: entry.scopeType,
        CO2e: co2e,
        date: dateStr,
        time: entry.time,
        timestamp: entry.timestamp,
        inputType: entry.inputType
      };

      // Max entry
      if (!stat.maxEntry || co2e > stat.maxEntry.CO2e) {
        stat.maxEntry = entryInfo;
      }

      // Min entry (positive only)
      if (co2e > 0) {
        if (!stat.minEntry || co2e < stat.minEntry.CO2e) {
          stat.minEntry = entryInfo;
        }
      }

      // Daily totals
      stat.dailyTotals.set(dateStr, (stat.dailyTotals.get(dateStr) || 0) + co2e);

      // Node-level aggregation
      if (!stat.nodes.has(entry.nodeId)) {
        stat.nodes.set(entry.nodeId, {
          nodeId: entry.nodeId,
          nodeLabel: meta.label,
          department: meta.department,
          location: meta.location,
          totalCO2e: 0,
          entriesCount: 0
        });
      }
      const ns = stat.nodes.get(entry.nodeId);
      ns.totalCO2e += co2e;
      ns.entriesCount += 1;

      // Location-level
      const locKey = meta.location || "Unknown";
      if (!stat.locations.has(locKey)) {
        stat.locations.set(locKey, { location: locKey, totalCO2e: 0, entriesCount: 0 });
      }
      const ls = stat.locations.get(locKey);
      ls.totalCO2e += co2e;
      ls.entriesCount += 1;

      // Department-level
      const deptKey = meta.department || "Unknown";
      if (!stat.departments.has(deptKey)) {
        stat.departments.set(deptKey, { department: deptKey, totalCO2e: 0, entriesCount: 0 });
      }
      const ds = stat.departments.get(deptKey);
      ds.totalCO2e += co2e;
      ds.entriesCount += 1;
    }

    // ----------------------------------------------
    // Convert internal maps → arrays + compute extremes
    // ----------------------------------------------
    let allStats = Array.from(scopeStatsMap.values()).map(stat => {

      const dailyTotalsArray = Array.from(stat.dailyTotals.entries()).map(([date, CO2e]) => ({
        date, CO2e
      }));

      const maxDay = dailyTotalsArray.length
        ? dailyTotalsArray.reduce((a, b) => (b.CO2e > a.CO2e ? b : a), dailyTotalsArray[0])
        : null;

      const positiveDays = dailyTotalsArray.filter(d => d.CO2e > 0);
      const minDay = positiveDays.length
        ? positiveDays.reduce((a, b) => (b.CO2e < a.CO2e ? b : a), positiveDays[0])
        : null;

      return {
        scopeIdentifier: stat.scopeIdentifier,
        totalCO2e: stat.totalCO2e,
        entriesCount: stat.entriesCount,
        maxEntry: stat.maxEntry,
        minEntry: stat.minEntry,
        dailyTotals: dailyTotalsArray,
        maxDay,
        minDay,
        nodes: Array.from(stat.nodes.values()).sort((a, b) => b.totalCO2e - a.totalCO2e),
        locations: Array.from(stat.locations.values()).sort((a, b) => b.totalCO2e - a.totalCO2e),
        departments: Array.from(stat.departments.values()).sort((a, b) => b.totalCO2e - a.totalCO2e)
      };
    });

    if (!allStats.length) {
      return res.status(404).json({
        success: false,
        message: "No results could be computed"
      });
    }

    // Sort by total descending
    allStats.sort((a, b) => b.totalCO2e - a.totalCO2e);

    const highestByTotal = allStats[0];
    const lowestByTotal = [...allStats].reverse().find(s => s.totalCO2e > 0) || null;

    // ----------------------------------------------
    // Build unified period object (matches new model)
    // ----------------------------------------------
    const period = {
      type: periodType,
      from,
      to,
      year: y
    };
    if (["monthly", "daily"].includes(periodType)) period.month = m;
    if (periodType === "weekly") period.week = w;
    if (periodType === "daily") period.day = d;

    // ----------------------------------------------
    // Final response
    // ----------------------------------------------
    return res.status(200).json({
      success: true,
      data: {
        clientId,
        period,
        scopeIdentifiers: {
          highestByTotal,
          lowestByTotal,
          all: allStats
        }
      }
    });

  } catch (error) {
    console.error("Error in getScopeIdentifierEmissionExtremes:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to compute scopeIdentifier emission stats",
      error: error.message
    });
  }
};




/**
 * Hierarchical emissions view:
 *  - scopeIdentifier  → node → entries
 *  - node             → entries (global node ranking)
 *  - location         → node → entries
 *  - department       → node → entries
 *  - scopeType        → scopeIdentifier → node → entries
 *
 * For a given client + period, this returns:
 *  - all scopeIdentifiers, sorted from highest to lowest total CO2e
 *  - under each scopeIdentifier, all nodes, sorted high → low
 *  - under each node, all entries, sorted high → low
 *  - global node ranking (which node has more / less emissions overall)
 *  - location-wise hierarchy (high → low)
 *  - department-wise hierarchy (high → low)
 *  - scopeType-wise hierarchy (Scope 1/2/3, high → low)
 *
 * GET /api/summaries/:clientId/scope-identifiers/hierarchy
 *
 * Query params (all optional):
 *   - periodType = daily | weekly | monthly | yearly | all-time (default: monthly)
 *   - year, month, week, day (same pattern as getEmissionSummary)
 */
/**
 * GET /api/summaries/:clientId/scope-identifiers/hierarchy
 */
/**
 * GET /api/summaries/:clientId/scope-identifiers/hierarchy
 * NEW VERSION USING EmissionSummary MODEL
 */
// ======================= SCOPE IDENTIFIER HIERARCHY (USING DATAENTRY) =======================

/**
 * Build hierarchical emissions view from DataEntry:
 *
 * Scope Type
 *   → Category
 *     → Activity
 *       → Scope Identifier
 *         → { CO2e, CO2, CH4, N2O }
 *
 * Also returns simple node/location/department/scopeType hierarchies
 * in the SAME response shape that your frontend already expects.
 *
 * Route (to be added):
 *   GET /api/summaries/:clientId/scope-identifiers/hierarchy
 */
const getScopeIdentifierHierarchy = async (req, res) => {
  try {
    const { clientId } = req.params;

    // ✅ NEW: add filter params
    let {
      periodType = "monthly",
      year,
      month,
      day,
      from,
      to,

      // Filters (single or comma-separated)
      location,
      department,
      nodeId,
      scopeIdentifier,
      scopeType,
      category,
      activity,
    } = req.query;

    if (!clientId) {
      return res.status(400).json({ success: false, message: "clientId is required" });
    }

    // ---------------------------- PERIOD RANGE ----------------------------
    const now = moment.utc();
    const y = parseInt(year) || now.year();
    const m = parseInt(month) || now.month() + 1;
    const d = parseInt(day) || now.date();

    let startDate, endDate;

    if (periodType === "custom" && (from || to)) {
      startDate = moment.utc(from).startOf("day");
      endDate = moment.utc(to).endOf("day");
    } else if (periodType === "yearly") {
      startDate = moment.utc({ year: y }).startOf("year");
      endDate = moment.utc({ year: y }).endOf("year");
    } else if (periodType === "daily") {
      startDate = moment.utc({ year: y, month: m - 1, day: d }).startOf("day");
      endDate = moment.utc({ year: y, month: m - 1, day: d }).endOf("day");
    } else {
      startDate = moment.utc({ year: y, month: m - 1 }).startOf("month");
      endDate = moment.utc({ year: y, month: m - 1 }).endOf("month");
    }

    // ---------------------------- helpers ----------------------------
    const toList = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
      return String(v)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    };

    const locFilter = toList(location);
    const deptFilter = toList(department);
    const nodeFilter = toList(nodeId);
    const sidFilter = toList(scopeIdentifier);
    const scopeTypeFilter = toList(scopeType);
    const categoryFilter = toList(category);
    const activityFilter = toList(activity);

    const matches = (value, allowedList) => {
      if (!allowedList?.length) return true;
      return allowedList.includes(value);
    };

    // ---------------------------- LOAD FLOWCHART METADATA ----------------------------
    const orgChart = await Flowchart.findOne({ clientId, isActive: true }).lean();
    const processChart = await ProcessFlowchart.findOne({ clientId, isDeleted: false }).lean();

    const allNodes = {};
    const allScopes = {};

    const ingestChart = (chart) => {
      if (!chart?.nodes) return;
      for (const node of chart.nodes) {
        allNodes[node.id] = {
          label: node.label || "Unknown Node",
          department: node.details?.department || null,
          location: node.details?.location || null
        };

        for (const s of node.details?.scopeDetails || []) {
          allScopes[`${node.id}::${s.scopeIdentifier}`] = {
            scopeType: s.scopeType,
            categoryName: s.categoryName,
            activity: s.activity
          };
        }
      }
    };

    ingestChart(orgChart);
    ingestChart(processChart);

    // ---------------------------- LOAD DATAENTRY (DB-level filters where possible) ----------------------------
    const findQuery = {
      clientId,
      timestamp: { $gte: startDate.toDate(), $lte: endDate.toDate() },
      processingStatus: "processed"
    };

    // ✅ these exist on DataEntry (your code already uses them)
    if (nodeFilter.length) findQuery.nodeId = { $in: nodeFilter };
    if (sidFilter.length) findQuery.scopeIdentifier = { $in: sidFilter };
    if (scopeTypeFilter.length) findQuery.scopeType = { $in: scopeTypeFilter };

    const entries = await DataEntry.find(findQuery).lean();

    if (!entries.length) {
      return res.status(200).json({
        success: true,
        data: {
          clientId,
          period: { type: periodType, year: y, month: m, day: d, from: startDate, to: endDate },
          totals: { totalEntries: 0, totalCO2e: 0 },
          scopeIdentifierHierarchy: { list: [] },
          nodeHierarchy: { list: [] },
          locationHierarchy: { list: [] },
          departmentHierarchy: { list: [] },
          scopeTypeHierarchy: { list: [] },
          filtersApplied: {
            location: locFilter,
            department: deptFilter,
            nodeId: nodeFilter,
            scopeIdentifier: sidFilter,
            scopeType: scopeTypeFilter,
            category: categoryFilter,
            activity: activityFilter
          }
        },
        message: "No summary found for this period (or filters)"
      });
    }

    // ---------------------------- AGGREGATION MAPS ----------------------------
    const scopeTree = new Map();
    const nodeMap = new Map();
    const locMap = new Map();
    const deptMap = new Map();
    const scopeTypeMap = new Map();

    const safe = (v) => (v ? Number(v) : 0);

    const sumFromEntry = (entry) => {
      const src = entry.calculatedEmissions?.incoming || entry.calculatedEmissions?.cumulative || {};
      const totals = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0 };

      for (const bucket of Object.values(src)) {
        totals.CO2e += safe(bucket.CO2e);
        totals.CO2  += safe(bucket.CO2);
        totals.CH4  += safe(bucket.CH4);
        totals.N2O  += safe(bucket.N2O);
      }
      return totals;
    };

    const pushSum = (map, key, label, emissions) => {
      if (!map.has(key)) map.set(key, { id: key, label, CO2e: 0, CO2: 0, CH4: 0, N2O: 0 });
      const obj = map.get(key);
      obj.CO2e += emissions.CO2e;
      obj.CO2  += emissions.CO2;
      obj.CH4  += emissions.CH4;
      obj.N2O  += emissions.N2O;
    };

    // ---------------------------- PROCESS EACH DATAENTRY ----------------------------
    let grandTotal = 0;
    let usedCount = 0;

    for (const entry of entries) {
      const emissions = sumFromEntry(entry);
      if (!emissions.CO2e) continue;

      // Extract metadata from Flowchart
      const scopeKey = `${entry.nodeId}::${entry.scopeIdentifier}`;
      const meta = allScopes[scopeKey] || {};

      const resolvedScopeType = meta.scopeType || entry.scopeType || "Unknown Scope";
      const resolvedCategory = meta.categoryName || "Uncategorized";
      const resolvedActivity = meta.activity || "Unspecified";

      const nodeMeta = allNodes[entry.nodeId] || {};
      const nodeLabel = nodeMeta.label || "Unknown Node";
      const resolvedDepartment = nodeMeta.department || "Unknown Department";
      const resolvedLocation = nodeMeta.location || "Unknown Location";
      const resolvedScopeIdentifier = entry.scopeIdentifier || "Unknown Scope Identifier";

      // ✅ IN-MEMORY FILTERS (for derived fields)
      if (!matches(resolvedLocation, locFilter)) continue;
      if (!matches(resolvedDepartment, deptFilter)) continue;
      if (!matches(resolvedScopeType, scopeTypeFilter)) continue;
      if (!matches(resolvedCategory, categoryFilter)) continue;
      if (!matches(resolvedActivity, activityFilter)) continue;

      // if we reach here, entry is included
      usedCount += 1;
      grandTotal += emissions.CO2e;

      // ----------------- NESTED HIERARCHY -----------------
      if (!scopeTree.has(resolvedScopeType)) {
        scopeTree.set(resolvedScopeType, {
          id: resolvedScopeType,
          label: resolvedScopeType,
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0,
          categories: new Map()
        });
      }
      const scopeNode = scopeTree.get(resolvedScopeType);
      scopeNode.CO2e += emissions.CO2e;
      scopeNode.CO2  += emissions.CO2;
      scopeNode.CH4  += emissions.CH4;
      scopeNode.N2O  += emissions.N2O;

      // Category level
      if (!scopeNode.categories.has(resolvedCategory)) {
        scopeNode.categories.set(resolvedCategory, {
          id: `${resolvedScopeType}::${resolvedCategory}`,
          label: resolvedCategory,
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0,
          activities: new Map()
        });
      }
      const catNode = scopeNode.categories.get(resolvedCategory);
      catNode.CO2e += emissions.CO2e;
      catNode.CO2  += emissions.CO2;
      catNode.CH4  += emissions.CH4;
      catNode.N2O  += emissions.N2O;

      // Activity level
      if (!catNode.activities.has(resolvedActivity)) {
        catNode.activities.set(resolvedActivity, {
          id: `${resolvedScopeType}::${resolvedCategory}::${resolvedActivity}`,
          label: resolvedActivity,
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0,
          scopeIds: new Map() // ✅ aggregate by scopeIdentifier instead of pushing duplicates
        });
      }
      const actNode = catNode.activities.get(resolvedActivity);
      actNode.CO2e += emissions.CO2e;
      actNode.CO2  += emissions.CO2;
      actNode.CH4  += emissions.CH4;
      actNode.N2O  += emissions.N2O;

      if (!actNode.scopeIds.has(resolvedScopeIdentifier)) {
        actNode.scopeIds.set(resolvedScopeIdentifier, {
          id: `${resolvedScopeType}::${resolvedCategory}::${resolvedActivity}::${resolvedScopeIdentifier}`,
          label: resolvedScopeIdentifier,
          CO2e: 0, CO2: 0, CH4: 0, N2O: 0
        });
      }
      const sidNode = actNode.scopeIds.get(resolvedScopeIdentifier);
      sidNode.CO2e += emissions.CO2e;
      sidNode.CO2  += emissions.CO2;
      sidNode.CH4  += emissions.CH4;
      sidNode.N2O  += emissions.N2O;

      // ----------------- FLAT HIERARCHIES -----------------
      pushSum(nodeMap, entry.nodeId, nodeLabel, emissions);
      pushSum(locMap, resolvedLocation, resolvedLocation, emissions);
      pushSum(deptMap, resolvedDepartment, resolvedDepartment, emissions);
      pushSum(scopeTypeMap, resolvedScopeType, resolvedScopeType, emissions);
    }

    // if filters removed everything
    if (!usedCount) {
      return res.status(200).json({
        success: true,
        data: {
          clientId,
          period: { type: periodType, year: y, month: m, day: d, from: startDate, to: endDate },
          totals: { totalEntries: 0, totalCO2e: 0 },
          scopeIdentifierHierarchy: { list: [] },
          nodeHierarchy: { list: [] },
          locationHierarchy: { list: [] },
          departmentHierarchy: { list: [] },
          scopeTypeHierarchy: { list: [] },
          filtersApplied: {
            location: locFilter,
            department: deptFilter,
            nodeId: nodeFilter,
            scopeIdentifier: sidFilter,
            scopeType: scopeTypeFilter,
            category: categoryFilter,
            activity: activityFilter
          }
        },
        message: "No results after applying filters"
      });
    }

    // ---------------------------- FORMAT FINAL TREE ----------------------------
    const scopeList = [];

    for (const [, scopeObj] of scopeTree.entries()) {
      const catList = [];

      for (const [, catObj] of scopeObj.categories.entries()) {
        const actList = [];

        for (const [, actObj] of catObj.activities.entries()) {
          // convert aggregated map -> array
          const children = Array.from(actObj.scopeIds.values()).sort((a, b) => b.CO2e - a.CO2e);
          actObj.children = children;
          delete actObj.scopeIds;

          actList.push(actObj);
        }

        actList.sort((a, b) => b.CO2e - a.CO2e);
        catObj.children = actList;
        delete catObj.activities;

        catList.push(catObj);
      }

      catList.sort((a, b) => b.CO2e - a.CO2e);
      scopeObj.children = catList;
      delete scopeObj.categories;

      scopeList.push(scopeObj);
    }

    scopeList.sort((a, b) => b.CO2e - a.CO2e);

    const sortFlat = (arr) => arr.sort((a, b) => b.CO2e - a.CO2e);

    // ---------------------------- FINAL RESPONSE ----------------------------
    return res.status(200).json({
      success: true,
      data: {
        clientId,
        period: { type: periodType, year: y, month: m, day: d, from: startDate, to: endDate },
        totals: { totalEntries: usedCount, totalCO2e: grandTotal },
        scopeIdentifierHierarchy: { list: scopeList },
        nodeHierarchy: { list: sortFlat(Array.from(nodeMap.values())) },
        locationHierarchy: { list: sortFlat(Array.from(locMap.values())) },
        departmentHierarchy: { list: sortFlat(Array.from(deptMap.values())) },
        scopeTypeHierarchy: { list: sortFlat(Array.from(scopeTypeMap.values())) },
        filtersApplied: {
          location: locFilter,
          department: deptFilter,
          nodeId: nodeFilter,
          scopeIdentifier: sidFilter,
          scopeType: scopeTypeFilter,
          category: categoryFilter,
          activity: activityFilter
        }
      }
    });

  } catch (error) {
    console.error("Hierarchy Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};







/**
 * GET /api/summaries/:clientId/reduction/hierarchy
 *
 * Builds hierarchies FROM NetReductionEntry collection.
 * Does NOT use EmissionSummary.
 *
 * Supported periodType:
 *  - monthly (default)
 *  - yearly
 *  - daily
 *  - custom?from&to
 */



const getReductionSummaryHierarchy = async (req, res) => {
  try {
    const { clientId } = req.params;
    let { projectId, periodType = "monthly", year, month, day, from, to } =
      req.query;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: "clientId is required",
      });
    }

    // -------------------------------
    // 1) RESOLVE PERIOD RANGE
    // -------------------------------
    const now = moment.utc();

    const y = parseInt(year) || now.year();
    const m = parseInt(month) || now.month() + 1;
    const d = parseInt(day) || now.date();

    let start, end;

    if (periodType === "custom") {
      start = from ? moment.utc(from).startOf("day") : moment.utc().startOf("year");
      end = to ? moment.utc(to).endOf("day") : moment.utc().endOf("year");
    } else if (periodType === "yearly") {
      start = moment.utc({ year: y }).startOf("year");
      end = moment.utc({ year: y }).endOf("year");
    } else if (periodType === "daily") {
      start = moment.utc({ year: y, month: m - 1, day: d }).startOf("day");
      end = moment.utc({ year: y, month: m - 1, day: d }).endOf("day");
    } else {
      // default monthly
      start = moment.utc({ year: y, month: m - 1 }).startOf("month");
      end = moment.utc({ year: y, month: m - 1 }).endOf("month");
    }

    const rangeQuery = {
      timestamp: {
        $gte: start.toDate(),
        $lte: end.toDate(),
      },
    };

    // -------------------------------
    // 2) LOAD ALL NET REDUCTION ENTRIES
    // -------------------------------
    const filters = {
      clientId,
      ...rangeQuery,
    };

    if (projectId) filters.projectId = projectId;

    const rows = await NetReductionEntry.find(filters).lean();

    if (!rows.length) {
      return res.status(200).json({
        success: true,
        message: "No net reduction data for this range",
        data: {
          clientId,
          period: {
            type: periodType,
            year: y,
            month: m,
            day: d,
            from: start,
            to: end,
          },
          totals: {
            totalEntries: 0,
            totalNetReduction: 0,
          },
          projectHierarchy: { list: [] },
          categoryHierarchy: { list: [] },
          methodologyHierarchy: { list: [] },
          locationHierarchy: { list: [] }, // safe empty
          scopeHierarchy: { list: [] }, // safe empty
        },
      });
    }

    // -------------------------------
    // 3) SAFE HELPERS
    // -------------------------------
    const safe = (n) => (isNaN(n) ? 0 : Number(n));

    // Map → list(sorted)
    const toList = (map) =>
      Array.from(map.values()).sort((a, b) => safe(b.total) - safe(a.total));

    // -------------------------------
    // 4) BUILD HIERARCHY MAPS
    // -------------------------------
    const projectMap = new Map();
    const categoryMap = new Map();
    const methodologyMap = new Map();

    let grandTotal = 0;

    for (const row of rows) {
      const project = row.projectId;
      const meth = row.calculationMethodology;
      const net = safe(row.netReduction);

      grandTotal += net;

      // ---------------------------------
      // PROJECT HIERARCHY
      // ---------------------------------
      if (!projectMap.has(project)) {
        projectMap.set(project, {
          id: project,
          label: project,
          total: 0,
          methodologies: new Map(),
        });
      }
      const pObj = projectMap.get(project);
      pObj.total += net;

      // METHODOLOGY UNDER PROJECT
      if (!pObj.methodologies.has(meth)) {
        pObj.methodologies.set(meth, {
          id: `${project}::${meth}`,
          label: meth,
          total: 0,
        });
      }
      pObj.methodologies.get(meth).total += net;

      // ---------------------------------
      // CATEGORY HIERARCHY (for M3 items)
      // fallback for M1/M2: put into generic categories
      // ---------------------------------
      if (meth === "methodology3") {
        // Add baseline
        for (const x of row.m3?.breakdown?.baseline || []) {
          const key = `Baseline::${x.id}`;
          if (!categoryMap.has(key)) {
            categoryMap.set(key, {
              id: key,
              label: `${project} - Baseline ${x.id}`,
              total: 0,
            });
          }
          categoryMap.get(key).total += safe(x.value);
        }

        // Project group
        for (const x of row.m3?.breakdown?.project || []) {
          const key = `Project::${x.id}`;
          if (!categoryMap.has(key)) {
            categoryMap.set(key, {
              id: key,
              label: `${project} - Project ${x.id}`,
              total: 0,
            });
          }
          categoryMap.get(key).total += safe(x.value);
        }

        // Leakage group
        for (const x of row.m3?.breakdown?.leakage || []) {
          const key = `Leakage::${x.id}`;
          if (!categoryMap.has(key)) {
            categoryMap.set(key, {
              id: key,
              label: `${project} - Leakage ${x.id}`,
              total: 0,
            });
          }
          categoryMap.get(key).total += safe(x.value);
        }
      } else if (meth === "methodology2") {
        const key = `Formula:${project}`;
        if (!categoryMap.has(key)) {
          categoryMap.set(key, {
            id: key,
            label: `${project} - Formula`,
            total: 0,
          });
        }
        categoryMap.get(key).total += net;
      } else {
        // M1
        const key = `Value:${project}`;
        if (!categoryMap.has(key)) {
          categoryMap.set(key, {
            id: key,
            label: `${project} - Value Based`,
            total: 0,
          });
        }
        categoryMap.get(key).total += net;
      }

      // ---------------------------------
      // METHODOLOGY HIERARCHY (GLOBAL)
      // ---------------------------------
      if (!methodologyMap.has(meth)) {
        methodologyMap.set(meth, {
          id: meth,
          label: meth,
          total: 0,
        });
      }
      methodologyMap.get(meth).total += net;
    }

    // -------------------------------
    // 5) FINAL_FORMATTING
    // -------------------------------
    const projectList = Array.from(projectMap.values()).map((p) => {
      return {
        ...p,
        methodologies: toList(p.methodologies),
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        clientId,
        period: {
          type: periodType,
          year: y,
          month: m,
          day: d,
          from: start,
          to: end,
        },
        totals: {
          totalEntries: rows.length,
          totalNetReduction: grandTotal,
        },

        projectHierarchy: { list: projectList },
        categoryHierarchy: { list: toList(categoryMap) },
        methodologyHierarchy: { list: toList(methodologyMap) },

        // optional empty (no location/scope fields exist in NetReductionEntry)
        locationHierarchy: { list: [] },
        scopeHierarchy: { list: [] },
      },
    });
  } catch (error) {
    console.error("getReductionSummaryHierarchy error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to build reduction summary hierarchy",
      error: error.message,
    });
  }
};


module.exports = {
  setSocketIO,
  calculateEmissionSummary,
  saveEmissionSummary,
  updateSummariesOnDataChange,
  recalculateAndSaveSummary,
  getEmissionSummary,
  getMultipleSummaries,
  getFilteredSummary,
  getLatestScope12Total,
  getTopLowEmissionStats,
  getScopeIdentifierEmissionExtremes,
  getScopeIdentifierHierarchy, 
  getSbtiProgress,
  getReductionSummaryHierarchy,
    

};