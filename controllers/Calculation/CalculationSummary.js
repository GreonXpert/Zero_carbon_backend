// controllers/Calculation/CalculationSummary.js

const EmissionSummary = require('../../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../../models/DataEntry');
const Flowchart = require('../../models/Flowchart');
const Client = require('../../models/Client');
const moment = require('moment');

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

/**
 * [FIXED] Helper function to safely extract emission values from calculated emissions
 * and convert them to tonnes
 */
function extractEmissionValues(calculatedEmissions) {
  const defaultValues = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 };

  // FIX: The incoming object is the emissions object. The check for a nested '.emissions' property was incorrect.
  if (!calculatedEmissions) {
    return defaultValues;
  }

  const emissions = calculatedEmissions; // Use the object directly
  let totalValues = { ...defaultValues };

  const extractAndConvert = (value) => {
    const num = parseFloat(value) || 0;
    return num;
  };

  // Extract from cumulative values (preferred for summary)
  if (emissions.cumulative && typeof emissions.cumulative === 'object') {
    // Mongoose Map with .lean() becomes an object, so Object.entries is correct
    for (const [key, value] of Object.entries(emissions.cumulative)) {
      if (value && typeof value === 'object') {
        totalValues.CO2e += extractAndConvert(value.CO2e || value.emission || 0);
        totalValues.CO2 += extractAndConvert(value.CO2 || 0);
        totalValues.CH4 += extractAndConvert(value.CH4 || 0);
        totalValues.N2O += extractAndConvert(value.N2O || 0);
        totalValues.uncertainty += extractAndConvert(value.combinedUncertainty || 0);
      }
    }
  }
  
  // If no cumulative, fall back to incoming values
  if (totalValues.CO2e === 0 && emissions.incoming && typeof emissions.incoming === 'object') {
    for (const [key, value] of Object.entries(emissions.incoming)) {
      if (value && typeof value === 'object') {
        totalValues.CO2e += extractAndConvert(value.CO2e || value.emission || 0);
        totalValues.CO2 += extractAndConvert(value.CO2 || 0);
        totalValues.CH4 += extractAndConvert(value.CH4 || 0);
        totalValues.N2O += extractAndConvert(value.N2O || 0);
        totalValues.uncertainty += extractAndConvert(value.combinedUncertainty || 0);
      }
    }
  }

  // Round to reasonable precision (6 decimal places)
  totalValues.CO2e = Math.round(totalValues.CO2e * 1000000) / 1000000;
  totalValues.CO2 = Math.round(totalValues.CO2 * 1000000) / 1000000;
  totalValues.CH4 = Math.round(totalValues.CH4 * 1000000) / 1000000;
  totalValues.N2O = Math.round(totalValues.N2O * 1000000) / 1000000;
  totalValues.uncertainty = Math.round(totalValues.uncertainty * 1000000) / 1000000;

  return totalValues;
}


/**
 * Helper function to add emission values to a target object
 * Values should already be in tonnes
 */
function addEmissionValues(target, values, dataPointCount = 1) {
  target.CO2e = (target.CO2e || 0) + (values.CO2e || 0);
  target.CO2 = (target.CO2 || 0) + (values.CO2 || 0);
  target.CH4 = (target.CH4 || 0) + (values.CH4 || 0);
  target.N2O = (target.N2O || 0) + (values.N2O || 0);
  target.uncertainty = (target.uncertainty || 0) + (values.uncertainty || 0);
  target.dataPointCount = (target.dataPointCount || 0) + dataPointCount;
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
    
    if (dataEntries.length === 0) {
      console.log(`No processed data entries found for client ${clientId} in the specified period.`);
      return {
        clientId,
        period: { type: periodType, year, month, week, day, from, to },
        totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
        byScope: {
            'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
        },
        byCategory: new Map(), byActivity: new Map(), byNode: new Map(),
        byDepartment: new Map(), byLocation: new Map(), byInputType: {},
        byEmissionFactor: new Map(),
        metadata: { totalDataPoints: 0, dataEntriesIncluded: [], lastCalculated: new Date(), isComplete: true, hasErrors: false, errors: [] }
      };
    }
    
    console.log(`Found ${dataEntries.length} data entries to process`);
    
    const activeChart = await getActiveFlowchart(clientId);
if (!activeChart) {
  return res.status(404).json({ message: 'No active flowchart found' });
}
const flowchart = activeChart.chart;
    if (!flowchart) {
      console.error(`No active flowchart found for client ${clientId}`);
      return null;
    }
    
    const nodeMap = new Map();
    flowchart.nodes.forEach(node => {
      nodeMap.set(node.id, {
        id: node.id,
        label: node.label,
        department: node.details?.department || 'Unknown',
        location: node.details?.location || 'Unknown',
        scopeDetails: node.details?.scopeDetails || []
      });
    });
    
    const summary = {
      clientId,
      period: { type: periodType, year, month, week, day, date: periodType === 'daily' ? from : null, from, to },
      totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
      byScope: {
        'Scope 1': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        'Scope 2': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        'Scope 3': { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
      },
      byCategory: new Map(), byActivity: new Map(), byNode: new Map(),
      byDepartment: new Map(), byLocation: new Map(),
      byInputType: {
        manual: { CO2e: 0, dataPointCount: 0 },
        API: { CO2e: 0, dataPointCount: 0 },
        IOT: { CO2e: 0, dataPointCount: 0 }
      },
      byEmissionFactor: new Map(),
      metadata: {
        totalDataPoints: dataEntries.length,
        dataEntriesIncluded: dataEntries.map(e => e._id),
        lastCalculated: new Date(),
        calculatedBy: userId,
        version: 1, isComplete: true, hasErrors: false, errors: []
      }
    };

    for (const entry of dataEntries) {
      try {
        const emissionValues = extractEmissionValues(entry.calculatedEmissions);
        
        if (emissionValues.CO2e === 0) {
          console.log(`Skipping entry ${entry._id} with zero emissions`);
          continue;
        }

        const nodeContext = nodeMap.get(entry.nodeId);
        if (!nodeContext) {
          summary.metadata.errors.push(`Node ${entry.nodeId} not found in flowchart`);
          continue;
        }

        const scopeDetail = nodeContext.scopeDetails.find(s => s.scopeIdentifier === entry.scopeIdentifier);
        const categoryName = scopeDetail?.categoryName || entry.categoryName || 'Unknown Category';
        const activity = scopeDetail?.activity || entry.activity || 'Unknown Activity';

        addEmissionValues(summary.totalEmissions, emissionValues);
        if (summary.byScope[entry.scopeType]) {
          addEmissionValues(summary.byScope[entry.scopeType], emissionValues);
        }

        const categoryEntry = ensureMapEntry(summary.byCategory, categoryName, { scopeType: entry.scopeType, activities: new Map() });
        addEmissionValues(categoryEntry, emissionValues);
        
        const activityInCategory = ensureMapEntry(categoryEntry.activities, activity);
        addEmissionValues(activityInCategory, emissionValues);

        const activityEntry = ensureMapEntry(summary.byActivity, activity, { scopeType: entry.scopeType, categoryName });
        addEmissionValues(activityEntry, emissionValues);

        const nodeEntry = ensureMapEntry(summary.byNode, entry.nodeId, {
          nodeLabel: nodeContext.label, department: nodeContext.department, location: nodeContext.location,
          byScope: {
            'Scope 1': { CO2e: 0, dataPointCount: 0 },
            'Scope 2': { CO2e: 0, dataPointCount: 0 },
            'Scope 3': { CO2e: 0, dataPointCount: 0 }
          }
        });
        addEmissionValues(nodeEntry, emissionValues);
        addEmissionValues(nodeEntry.byScope[entry.scopeType], emissionValues);

        const deptEntry = ensureMapEntry(summary.byDepartment, nodeContext.department);
        addEmissionValues(deptEntry, emissionValues);

        const locEntry = ensureMapEntry(summary.byLocation, nodeContext.location);
        addEmissionValues(locEntry, emissionValues);

        if (summary.byInputType[entry.inputType]) {
          summary.byInputType[entry.inputType].CO2e += emissionValues.CO2e;
          summary.byInputType[entry.inputType].dataPointCount += 1;
        }

        const efEntry = ensureMapEntry(summary.byEmissionFactor, entry.emissionFactor || 'Unknown', {
          scopeTypes: { 'Scope 1': 0, 'Scope 2': 0, 'Scope 3': 0 }
        });
        addEmissionValues(efEntry, emissionValues);
        efEntry.scopeTypes[entry.scopeType] += 1;

      } catch (entryError) {
        console.error(`Error processing entry ${entry._id}:`, entryError);
        summary.metadata.errors.push(`Error processing entry ${entry._id}: ${entryError.message}`);
        summary.metadata.hasErrors = true;
      }
    }

    const uniqueNodesByDept = new Map();
    const uniqueNodesByLoc = new Map();
    for (const [nodeId, nodeData] of summary.byNode) {
      if (!uniqueNodesByDept.has(nodeData.department)) uniqueNodesByDept.set(nodeData.department, new Set());
      uniqueNodesByDept.get(nodeData.department).add(nodeId);
      if (!uniqueNodesByLoc.has(nodeData.location)) uniqueNodesByLoc.set(nodeData.location, new Set());
      uniqueNodesByLoc.get(nodeData.location).add(nodeId);
    }
    for (const [dept, nodeSet] of uniqueNodesByDept) {
      if (summary.byDepartment.has(dept)) summary.byDepartment.get(dept).nodeCount = nodeSet.size;
    }
    for (const [loc, nodeSet] of uniqueNodesByLoc) {
      if (summary.byLocation.has(loc)) summary.byLocation.get(loc).nodeCount = nodeSet.size;
    }

    if (periodType !== 'all-time') {
      try {
        const previousPeriod = getPreviousPeriod(periodType, year, month, week, day);
        const previousSummary = await EmissionSummary.findOne({
          clientId, 'period.type': periodType, 'period.year': previousPeriod.year,
          'period.month': previousPeriod.month, 'period.week': previousPeriod.week, 'period.day': previousPeriod.day
        }).lean();
        if (previousSummary) summary.trends = calculateTrends(summary, previousSummary);
      } catch (trendError) {
        console.error('Error calculating trends:', trendError);
        summary.metadata.errors.push(`Error calculating trends: ${trendError.message}`);
      }
    }

    summary.metadata.calculationDuration = Date.now() - summary.metadata.lastCalculated.getTime();

    console.log(`📊 Summary totals (tonnes):`, {
      totalCO2e: summary.totalEmissions.CO2e,
      scope1: summary.byScope['Scope 1'].CO2e,
      scope2: summary.byScope['Scope 2'].CO2e,
      scope3: summary.byScope['Scope 3'].CO2e
    });

    return summary;

  } catch (error) {
    console.error('Error calculating emission summary:', error);
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




/**
 * [FIXED] Save or update emission summary
 * Uses findOneAndUpdate with upsert to avoid duplicate key errors and data loss.
 */
const saveEmissionSummary = async (summaryData) => {
  if (!summaryData) {
    console.log('ℹ️ No summary data to save.');
    return null;
  }

  console.log('📊 Starting saveEmissionSummary with data:', JSON.stringify({
    clientId: summaryData.clientId, period: summaryData.period
  }, null, 2));

  try {
    const query = {
      clientId: summaryData.clientId,
      'period.type': summaryData.period.type
    };
    if (summaryData.period.year) query['period.year'] = summaryData.period.year;
    if (summaryData.period.month) query['period.month'] = summaryData.period.month;
    if (summaryData.period.week) query['period.week'] = summaryData.period.week;
    if (summaryData.period.day) query['period.day'] = summaryData.period.day;

    console.log('🔍 Query for finding summary:', JSON.stringify(query, null, 2));

    const existingSummary = await EmissionSummary.findOne(query).lean();
    console.log('🔍 Existing summary found:', !!existingSummary);

    // Prepare the complete update object
    const updateData = {
      totalEmissions: summaryData.totalEmissions,
      byScope: summaryData.byScope,
      byCategory: summaryData.byCategory,
      byActivity: summaryData.byActivity,
      byNode: summaryData.byNode,
      byDepartment: summaryData.byDepartment,
      byLocation: summaryData.byLocation,
      byInputType: summaryData.byInputType,
      byEmissionFactor: summaryData.byEmissionFactor,
      trends: summaryData.trends,
      metadata: {
        ...summaryData.metadata,
        version: (existingSummary?.metadata?.version || 0) + 1,
        lastCalculated: new Date()
      }
    };

    const options = {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true
    };

    // Use findOneAndUpdate with $set to update fields without replacing the whole document
    const savedSummary = await EmissionSummary.findOneAndUpdate(
      query,
      { 
        $set: updateData,
        $setOnInsert: {
            clientId: summaryData.clientId,
            period: summaryData.period
        }
      },
      options
    );

    console.log('✅ Summary saved successfully:', savedSummary._id);

    emitSummaryUpdate(existingSummary ? 'summary-updated' : 'summary-created', {
      clientId: summaryData.clientId,
      totalEmissions: savedSummary.totalEmissions,
      byScope: savedSummary.byScope,
      byCategory: savedSummary.byCategory,
      byNode: savedSummary.byNode,
      metadata: savedSummary.metadata
      
    });
    // NEW: keep SBTi emission progress in sync (only does work for YEARLY summaries)
    await syncSbtiProgressFromSummary(savedSummary);

    return savedSummary;
  } catch (error) {
    console.error('❌ Error saving emission summary:', error);
    console.error('Error stack:', error.stack);
    throw error;
  }
};


/**
 * Automatically update summaries when new data is processed
 */
const updateSummariesOnDataChange = async (dataEntry) => {
  try {
    console.log(`📊 Updating summaries for new data entry: ${dataEntry._id}`);
    const { clientId } = dataEntry;
    const entryDate = moment.utc(dataEntry.timestamp);
    
    await recalculateAndSaveSummary(clientId, 'daily', entryDate.year(), entryDate.month() + 1, null, entryDate.date());
    await recalculateAndSaveSummary(clientId, 'monthly', entryDate.year(), entryDate.month() + 1);
    await recalculateAndSaveSummary(clientId, 'yearly', entryDate.year());
    await recalculateAndSaveSummary(clientId, 'all-time');
    
    console.log(`✅ Successfully updated summaries for client: ${clientId}`);
  } catch (error) {
    console.error('❌ Error updating summaries on data change:', error);
  }
};

/**
 * Recalculate and save a specific summary
 */
const recalculateAndSaveSummary = async (clientId, periodType, year, month, week, day, userId = null) => {
  try {
    const summaryData = await calculateEmissionSummary(clientId, periodType, year, month, week, day, userId);
    if (!summaryData) return null;
    if ((summaryData.metadata?.totalDataPoints ?? 0) === 0) return null; // ← do not save "zero" snapshot
    return await saveEmissionSummary(summaryData);
  } catch (err) {
    console.error(`Error recalculating ${periodType} summary for client ${clientId}:`, err);
    throw err;
  }
};


// ========== API Controllers ==========

const getEmissionSummary = async (req, res) => {
  try {
    const { clientId } = req.params;
    const {
      periodType = 'monthly',
      year, month, week, day,
      recalculate = 'false',
      preferLatest = 'true',
    } = req.query;

    if (!['daily','weekly','monthly','yearly','all-time'].includes(periodType)) {
      return res.status(400).json({ success:false, message:'Invalid period type.' });
    }

    const y = year ? parseInt(year) : moment.utc().year();
    const m = month ? parseInt(month) : moment.utc().month() + 1;
    const w = week ? parseInt(week) : moment.utc().isoWeek();
    const d = day ? parseInt(day) : moment.utc().date();

    let summary;

    // If no explicit period parts, return the latest available snapshot for this type
    const noSpecificParts = !year && !month && !week && !day;

    if (recalculate === 'true') {
      summary = await recalculateAndSaveSummary(clientId, periodType, y, m, w, d, req.user?._id);
    } else {
      const baseQuery = { clientId, 'period.type': periodType };

      if (noSpecificParts) {
        // latest
        summary = await EmissionSummary
          .findOne(baseQuery)
          .sort({ 'period.to': -1, 'period.year': -1, 'period.month': -1, 'period.week': -1, 'period.day': -1, updatedAt: -1 })
          .lean();
      } else {
        // exact period
        const exactQuery = { ...baseQuery };
        if (year) exactQuery['period.year'] = y;
        if (month) exactQuery['period.month'] = m;
        if (week) exactQuery['period.week'] = w;
        if (day) exactQuery['period.day'] = d;

        summary = await EmissionSummary.findOne(exactQuery).lean();

        // If not found or stale -> recompute
        const isStale = summary && (Date.now() - new Date(summary.metadata.lastCalculated).getTime()) > 3600000; // 1h
        if (!summary || isStale) {
          const recomputed = await recalculateAndSaveSummary(clientId, periodType, y, m, w, d, req.user?._id);
          // If recompute produced nothing AND preferLatest is on, fall back to latest available
          if (recomputed && (recomputed.metadata?.totalDataPoints ?? 0) > 0) {
            summary = recomputed;
          } else if (preferLatest === 'true') {
            const endOfRequested = buildDateRange(periodType, y, m, w, d).to; // use your existing helper
            summary = await EmissionSummary
              .findOne({ ...baseQuery, 'period.to': { $lte: endOfRequested } })
              .sort({ 'period.to': -1, 'period.year': -1, 'period.month': -1, 'period.week': -1, 'period.day': -1, updatedAt: -1 })
              .lean();

            if (summary) {
              // annotate that this is a fallback for transparency (front-end can show a small note)
              summary.metadata = {
                ...summary.metadata,
                fallbackFor: { type: periodType, year: y, month: m, week: w, day: d }
              };
            }
          }
        }
      }
    }

    if (!summary) {
      return res.status(404).json({ success: false, message: 'No data found for the specified period' });
    }

    // Convert Map fields to plain objects before sending
    const responseData = { ...summary };
    for (const key of ['byCategory','byActivity','byNode','byDepartment','byLocation','byEmissionFactor']) {
      if (responseData[key] instanceof Map) {
        responseData[key] = Object.fromEntries(responseData[key]);
      }
    }
     // NEW: attach SBTi target progress (if any SBTi target exists for this client)
    const sbtiProgress = await buildSbtiProgressForSummary(clientId, summary);
    if (sbtiProgress) {
      responseData.sbtiProgress = sbtiProgress;
    }

    return res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    console.error('Error getting emission summary:', error);
    return res.status(500).json({ success: false, message: 'Failed to get emission summary', error: error.message });
  }
};

const getMultipleSummaries = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { periodType = 'monthly', startYear, startMonth, endYear, endMonth, limit = 12 } = req.query;
    const query = { clientId, 'period.type': periodType };

    if (startYear && endYear) {
      query.$and = [
        { 'period.year': { $gte: parseInt(startYear) } },
        { 'period.year': { $lte: parseInt(endYear) } }
      ];
      if (startMonth) query.$and.push({ 'period.month': { $gte: parseInt(startMonth) } });
      if (endMonth) query.$and.push({ 'period.month': { $lte: parseInt(endMonth) } });
    }

    const summaries = await EmissionSummary.find(query)
      .sort({ 'period.year': -1, 'period.month': -1, 'period.week': -1, 'period.day': -1 })
      .limit(parseInt(limit))
      .lean();

    const formattedSummaries = summaries.map(summary => {
        const formatted = { ...summary };
        for (const key of ['byCategory', 'byActivity', 'byNode', 'byDepartment', 'byLocation', 'byEmissionFactor']) {
            if (formatted[key] instanceof Map) {
                formatted[key] = Object.fromEntries(formatted[key]);
            }
        }
        return formatted;
    });

    res.status(200).json({ success: true, data: formattedSummaries, count: formattedSummaries.length });
  } catch (error) {
    console.error('Error getting multiple summaries:', error);
    res.status(500).json({ success: false, message: 'Failed to get multiple summaries', error: error.message });
  }
};




const getFilteredSummary = async (req, res) => {
  try {
    const { clientId } = req.params;
    const {
      // period selection (same as before)
      periodType,
      year,
      month,
      day,
      week,

      // OLD single filters (kept for backward compatibility)
      scope,
      category,
      nodeId,
      department,
      activity,
      location,

      // NEW multi-filters
      scopes,
      locations,
      nodeIds,
      departments,
      activities,
      categories,
      emissionFactors,
      sources,

      // NEW sorting / extra controls
      sortBy: sortByRaw,
      sortDirection: sortDirectionRaw,
      sortOrder: sortOrderRaw,
      limit: limitRaw,
      minCO2e: minCO2eRaw,
      maxCO2e: maxCO2eRaw,
    } = req.query;

    // ---------- helpers ----------
    const normalizeArray = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) {
        return val
          .flatMap(v => v.split(','))
          .map(v => v.trim())
          .filter(Boolean);
      }
      if (typeof val === 'string') {
        return val
          .split(',')
          .map(v => v.trim())
          .filter(Boolean);
      }
      return [];
    };

    const safeNum = (v) => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const toEntries = (maybeMap) => {
      if (!maybeMap) return [];
      if (maybeMap instanceof Map) return Array.from(maybeMap.entries());
      if (typeof maybeMap === 'object') return Object.entries(maybeMap);
      return [];
    };

    // ---------- Step 1: fetch base summary (same logic as before) ----------
    let query = { clientId };
    let fullSummary = null;

    if (periodType) {
      query['period.type'] = periodType;
      if (year) query['period.year'] = parseInt(year);
      if (month) query['period.month'] = parseInt(month);
      if (day) query['period.day'] = parseInt(day);
      if (week) query['period.week'] = parseInt(week);

      fullSummary = await EmissionSummary.findOne(query).lean();
    } else {
      // latest by period.to
      fullSummary = await EmissionSummary.findOne({ clientId })
        .sort({ 'period.to': -1 })
        .lean();
    }

    if (!fullSummary) {
      return res.status(404).json({
        success: false,
        message: 'No summary data found for the specified client and period.'
      });
    }

    // ---------- Step 2: determine if we use ADVANCED multi-filter mode ----------

    const multiScopes = normalizeArray(scopes);
    // 🔹 CHANGED: allow single `location` to be treated as advanced
    const multiLocations = normalizeArray(locations || location);
    const multiNodeIds = normalizeArray(nodeIds);
    const multiDepartments = normalizeArray(departments);
    const multiActivities = normalizeArray(activities);
    const multiCategories = normalizeArray(categories);
    const multiEmissionFactors = normalizeArray(emissionFactors || sources);

    const hasAdvancedFilters =
      multiScopes.length ||
      multiLocations.length ||
      multiNodeIds.length ||
      multiDepartments.length ||
      multiActivities.length ||
      multiCategories.length ||
      multiEmissionFactors.length ||
      sortByRaw ||
      sortDirectionRaw ||
      sortOrderRaw ||
      limitRaw ||
      minCO2eRaw ||
      maxCO2eRaw;

    // ---------- Step 3: ADVANCED MODE (multi scopes, locations, nodes, sorting) ----------
    if (hasAdvancedFilters) {
      // Which scopes we consider. If none provided, take all 3.
      const scopeUniverse = ['Scope 1', 'Scope 2', 'Scope 3'];
      const selectedScopes = multiScopes.length ? multiScopes : scopeUniverse;

      // sorting config
      const sortBy = (sortByRaw || 'node').toLowerCase(); // 'node' | 'location' | 'department' | 'scope'
      const dirRaw = (sortDirectionRaw || sortOrderRaw || 'desc').toLowerCase();
      const sortDirection = (dirRaw === 'asc' || dirRaw === 'low') ? 'asc' : 'desc';

      const limit = limitRaw ? parseInt(limitRaw) : null;
      const minCO2e = minCO2eRaw != null ? Number(minCO2eRaw) : null;
      const maxCO2e = maxCO2eRaw != null ? Number(maxCO2eRaw) : null;

      // ---- 3.1 Build node array with selected-scope CO2e ----
      const nodeEntries = toEntries(fullSummary.byNode);
      let nodes = nodeEntries.map(([id, nodeData]) => {
        const byScope = nodeData.byScope || {};

        const scopeTotals = {
          'Scope 1': safeNum(byScope['Scope 1']?.CO2e),
          'Scope 2': safeNum(byScope['Scope 2']?.CO2e),
          'Scope 3': safeNum(byScope['Scope 3']?.CO2e),
        };

        const selectedScopeCO2e = selectedScopes.reduce(
          (sum, s) => sum + (scopeTotals[s] || 0),
          0
        );

        return {
          nodeId: id,
          nodeLabel: nodeData.nodeLabel,
          department: nodeData.department,
          location: nodeData.location,
          byScope: scopeTotals,
          totalCO2e: safeNum(nodeData.CO2e),       // total all scopes
          selectedScopeCO2e,                       // only selected scopes
          CO2: safeNum(nodeData.CO2),
          CH4: safeNum(nodeData.CH4),
          N2O: safeNum(nodeData.N2O),
          uncertainty: safeNum(nodeData.uncertainty),
        };
      });

      // ---- 3.2 Apply node-level filters (multi locations, nodeIds, departments) ----
      if (multiNodeIds.length) {
        const idSet = new Set(multiNodeIds);
        nodes = nodes.filter(n => idSet.has(n.nodeId));
      }

      if (multiLocations.length) {
        const locSet = new Set(multiLocations.map(s => s.toLowerCase()));
        nodes = nodes.filter(n => locSet.has((n.location || '').toLowerCase()));
      }

      if (multiDepartments.length) {
        const deptSet = new Set(multiDepartments.map(s => s.toLowerCase()));
        nodes = nodes.filter(n => deptSet.has((n.department || '').toLowerCase()));
      }

      if (minCO2e != null) {
        nodes = nodes.filter(n => n.selectedScopeCO2e >= minCO2e);
      }

      if (maxCO2e != null) {
        nodes = nodes.filter(n => n.selectedScopeCO2e <= maxCO2e);
      }

      // If after filters nothing remains, return empty but consistent shape
      if (!nodes.length) {
        return res.status(200).json({
          success: true,
          filterType: 'advanced',
          filtersApplied: {
            scopes: selectedScopes,
            locations: multiLocations,
            nodeIds: multiNodeIds,
            departments: multiDepartments,
            activities: multiActivities,
            categories: multiCategories,
            emissionFactors: multiEmissionFactors
          },
          data: {
            period: fullSummary.period,
            totalEmissions: fullSummary.totalEmissions,
            totalFilteredEmissions: {
              CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0
            },
            byScope: {},
            byLocation: [],
            byDepartment: [],
            nodes: [],
            primary: [],
            // 🔹 NEW: empty dropdowns for UI
            dropdowns: {
              locations: [],
              departments: [],
              scopes: [],
              categories: [],
              nodes: []
            }
          }
        });
      }

      // ---- 3.3 Aggregate filtered totals (by scope, location, department) ----
      const emptyTotals = () => ({
        CO2e: 0,
        CO2: 0,
        CH4: 0,
        N2O: 0,
        uncertainty: 0,
        dataPointCount: 0
      });

      const totalFilteredEmissions = { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 };
      const byScopeFiltered = {};
      const byLocationFiltered = new Map();
      const byDepartmentFiltered = new Map();

      selectedScopes.forEach(s => { byScopeFiltered[s] = emptyTotals(); });

      for (const n of nodes) {
        // sum totals only from selected scopes
        totalFilteredEmissions.CO2e += n.selectedScopeCO2e;
        totalFilteredEmissions.CO2 += safeNum(n.CO2);
        totalFilteredEmissions.CH4 += safeNum(n.CH4);
        totalFilteredEmissions.N2O += safeNum(n.N2O);
        totalFilteredEmissions.uncertainty += safeNum(n.uncertainty);

        // by-scope
        for (const s of selectedScopes) {
          const val = n.byScope[s] || 0;
          byScopeFiltered[s].CO2e += val;
          byScopeFiltered[s].dataPointCount += val > 0 ? 1 : 0;
        }

        // by-location
        const locKey = n.location || 'Unknown';
        if (!byLocationFiltered.has(locKey)) {
          byLocationFiltered.set(locKey, emptyTotals());
        }
        const locAgg = byLocationFiltered.get(locKey);
        locAgg.CO2e += n.selectedScopeCO2e;
        locAgg.dataPointCount += 1;

        // by-department
        const deptKey = n.department || 'Unknown';
        if (!byDepartmentFiltered.has(deptKey)) {
          byDepartmentFiltered.set(deptKey, emptyTotals());
        }
        const deptAgg = byDepartmentFiltered.get(deptKey);
        deptAgg.CO2e += n.selectedScopeCO2e;
        deptAgg.dataPointCount += 1;
      }

      // ---- 3.4 Build arrays for sorting ----
      const locationsArr = Array.from(byLocationFiltered.entries()).map(([name, data]) => ({
        location: name,
        ...data
      }));

      const departmentsArr = Array.from(byDepartmentFiltered.entries()).map(([name, data]) => ({
        department: name,
        ...data
      }));

      const scopesArr = Object.entries(byScopeFiltered).map(([scopeName, data]) => ({
        scopeType: scopeName,
        ...data
      }));

      // 🔹 NEW: categories array (NOT location-specific; filtered by scope/category if given)
      const categoriesArr = [];
      for (const [catName, catData] of toEntries(fullSummary.byCategory)) {
        if (multiScopes.length && !selectedScopes.includes(catData.scopeType)) continue;
        if (multiCategories.length && !multiCategories.includes(catName)) continue;

        categoriesArr.push({
          categoryName: catName,
          scopeType: catData.scopeType,
          CO2e: safeNum(catData.CO2e),
          CO2: safeNum(catData.CO2),
          CH4: safeNum(catData.CH4),
          N2O: safeNum(catData.N2O),
          uncertainty: safeNum(catData.uncertainty),
          dataPointCount: safeNum(catData.dataPointCount)
        });
      }

      // choose primary array for sorting (node / location / department / scope)
      let primaryArr;
      switch (sortBy) {
        case 'location':
          primaryArr = locationsArr;
          break;
        case 'department':
          primaryArr = departmentsArr;
          break;
        case 'scope':
        case 'scopes':
          primaryArr = scopesArr;
          break;
        case 'node':
        default:
          primaryArr = nodes;
          break;
      }

      const sortFn = (a, b) => {
        const va = safeNum(a.CO2e ?? a.selectedScopeCO2e ?? a.totalCO2e);
        const vb = safeNum(b.CO2e ?? b.selectedScopeCO2e ?? b.totalCO2e);
        return sortDirection === 'asc' ? va - vb : vb - va;
      };

      primaryArr.sort(sortFn);

      if (limit && limit > 0) {
        primaryArr = primaryArr.slice(0, limit);
      }

      // 🔹 NEW: dropdown lists for cascading filters on FRONTEND
      const dropdownLocations = Array.from(
        new Set(nodes.map(n => n.location || 'Unknown'))
      ).sort();

      const dropdownDepartments = Array.from(
        new Set(nodes.map(n => n.department || 'Unknown'))
      ).sort();

      const dropdownScopes = scopesArr
        .filter(s => s.CO2e > 0 || s.dataPointCount > 0)
        .map(s => s.scopeType);

      const dropdownCategories = categoriesArr
        .map(c => c.categoryName)
        .sort();

      const dropdownNodes = nodes.map(n => ({
        nodeId: n.nodeId,
        nodeLabel: n.nodeLabel,
        location: n.location,
        department: n.department,
        CO2e: n.selectedScopeCO2e
      }));

      return res.status(200).json({
        success: true,
        filterType: 'advanced',
        filtersApplied: {
          scopes: selectedScopes,
          locations: multiLocations,
          nodeIds: multiNodeIds,
          departments: multiDepartments,
          activities: multiActivities,
          categories: multiCategories,
          emissionFactors: multiEmissionFactors
        },
        sort: {
          sortBy,
          sortDirection,
          limit: limit || null
        },
        data: {
          period: fullSummary.period,
          totalEmissions: fullSummary.totalEmissions,
          totalFilteredEmissions,
          byScope: byScopeFiltered,
          byLocation: locationsArr,
          byDepartment: departmentsArr,
          nodes,          // full filtered node list
          primary: primaryArr,  // main sorted list (nodes / locations / departments / scopes)
          categories: categoriesArr,
          dropdowns: {
            locations: dropdownLocations,
            departments: dropdownDepartments,
            scopes: dropdownScopes,
            categories: dropdownCategories,
            nodes: dropdownNodes
          }
        }
      });
    }

    // ---------- Step 4: LEGACY MODE (SINGLE FILTERS – your existing behaviour) ----------

    let filteredData = {};
    let filterType = 'none';

    if (scope) {
      filterType = 'scope';
      if (!['Scope 1', 'Scope 2', 'Scope 3'].includes(scope)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid scope type. Use "Scope 1", "Scope 2", or "Scope 3".'
        });
      }
      if (!fullSummary.byScope || !fullSummary.byScope[scope]) {
        return res.status(404).json({
          success: false,
          message: `Scope '${scope}' has no data in this summary period.`
        });
      }

      filteredData = {
        scopeType: scope,
        period: fullSummary.period,
        emissions: fullSummary.byScope[scope] || {},
        categories: {},
        activities: {},
        nodes: {}
      };

      const categoryEntries = fullSummary.byCategory instanceof Map
        ? fullSummary.byCategory.entries()
        : Object.entries(fullSummary.byCategory || {});
      for (const [catName, catData] of categoryEntries) {
        if (catData.scopeType === scope) filteredData.categories[catName] = catData;
      }

      const activityEntries = fullSummary.byActivity instanceof Map
        ? fullSummary.byActivity.entries()
        : Object.entries(fullSummary.byActivity || {});
      for (const [actName, actData] of activityEntries) {
        if (actData.scopeType === scope) filteredData.activities[actName] = actData;
      }

      const nodeEntries = fullSummary.byNode instanceof Map
        ? fullSummary.byNode.entries()
        : Object.entries(fullSummary.byNode || {});
      for (const [nId, nodeData] of nodeEntries) {
        if (nodeData.byScope?.[scope]?.CO2e > 0) {
          filteredData.nodes[nId] = { ...nodeData, scopeEmissions: nodeData.byScope[scope] };
        }
      }

    } else if (category) {
      filterType = 'category';
      const categoryData =
        fullSummary.byCategory?.get?.(category) ||
        fullSummary.byCategory?.[category];

      if (!categoryData) {
        return res.status(404).json({
          success: false,
          message: `Category '${category}' not found in this summary period.`
        });
      }
      filteredData = {
        categoryName: category,
        period: fullSummary.period,
        emissions: categoryData,
        activities: categoryData.activities || {},
        scopeType: categoryData.scopeType,
        percentage:
          fullSummary.totalEmissions.CO2e > 0
            ? ((categoryData.CO2e / fullSummary.totalEmissions.CO2e) * 100).toFixed(2)
            : 0
      };

    } else if (nodeId) {
      filterType = 'node';
      const nodeData =
        fullSummary.byNode?.get?.(nodeId) ||
        fullSummary.byNode?.[nodeId];

      if (!nodeData) {
        return res.status(404).json({
          success: false,
          message: `Node ID '${nodeId}' not found in this summary period.`
        });
      }
      filteredData = {
        nodeId,
        nodeLabel: nodeData.nodeLabel,
        department: nodeData.department,
        location: nodeData.location,
        period: fullSummary.period,
        totalEmissions: {
          CO2e: nodeData.CO2e,
          CO2: nodeData.CO2,
          CH4: nodeData.CH4,
          N2O: nodeData.N2O,
          uncertainty: nodeData.uncertainty
        },
        byScope: nodeData.byScope,
        percentage:
          fullSummary.totalEmissions.CO2e > 0
            ? ((nodeData.CO2e / fullSummary.totalEmissions.CO2e) * 100).toFixed(2)
            : 0
      };

    } else if (department) {
      filterType = 'department';
      const departmentData =
        fullSummary.byDepartment?.get?.(department) ||
        fullSummary.byDepartment?.[department];

      if (!departmentData) {
        return res.status(404).json({
          success: false,
          message: `Department '${department}' not found in this summary period.`
        });
      }
      const departmentNodes = {};
      const nodeEntries = fullSummary.byNode instanceof Map
        ? fullSummary.byNode.entries()
        : Object.entries(fullSummary.byNode || {});
      for (const [id, nodeData] of nodeEntries) {
        if (nodeData.department === department) departmentNodes[id] = nodeData;
      }
      filteredData = {
        departmentName: department,
        period: fullSummary.period,
        emissions: departmentData,
        nodes: departmentNodes,
        nodeCount: departmentData.nodeCount,
        percentage:
          fullSummary.totalEmissions.CO2e > 0
            ? ((departmentData.CO2e / fullSummary.totalEmissions.CO2e) * 100).toFixed(2)
            : 0
      };

    } else if (activity) {
      filterType = 'activity';
      const activityData =
        fullSummary.byActivity?.get?.(activity) ||
        fullSummary.byActivity?.[activity];

      if (!activityData) {
        return res.status(404).json({
          success: false,
          message: `Activity '${activity}' not found in this summary period.`
        });
      }
      filteredData = {
        activityName: activity,
        period: fullSummary.period,
        emissions: activityData,
        scopeType: activityData.scopeType,
        categoryName: activityData.categoryName,
        percentage:
          fullSummary.totalEmissions.CO2e > 0
            ? ((activityData.CO2e / fullSummary.totalEmissions.CO2e) * 100).toFixed(2)
            : 0
      };

    } else if (location) {
      filterType = 'location';
      const locationData =
        fullSummary.byLocation?.get?.(location) ||
        fullSummary.byLocation?.[location];

      if (!locationData) {
        return res.status(404).json({
          success: false,
          message: `Location '${location}' not found in this summary period.`
        });
      }

      const locationNodes = {};
      const nodeEntries = fullSummary.byNode instanceof Map
        ? fullSummary.byNode.entries()
        : Object.entries(fullSummary.byNode || {});

      // 🔹 NEW: aggregate byScope & byDepartment ONLY for this location (legacy mode)
      const scopeTotals = {
        'Scope 1': { CO2e: 0, dataPointCount: 0 },
        'Scope 2': { CO2e: 0, dataPointCount: 0 },
        'Scope 3': { CO2e: 0, dataPointCount: 0 }
      };
      const departmentAgg = {};

      for (const [id, nodeData] of nodeEntries) {
        if (nodeData.location === location) {
          locationNodes[id] = nodeData;

          // scopes
          if (nodeData.byScope) {
            for (const s of ['Scope 1', 'Scope 2', 'Scope 3']) {
              const sData = nodeData.byScope[s];
              if (!sData) continue;
              scopeTotals[s].CO2e += safeNum(sData.CO2e);
              if (safeNum(sData.CO2e) > 0) scopeTotals[s].dataPointCount += 1;
            }
          }

          // departments
          const deptName = nodeData.department || 'Unknown';
          if (!departmentAgg[deptName]) {
            departmentAgg[deptName] = { CO2e: 0, nodeCount: 0 };
          }
          departmentAgg[deptName].CO2e += safeNum(nodeData.CO2e);
          departmentAgg[deptName].nodeCount += 1;
        }
      }

      filteredData = {
        locationName: location,
        period: fullSummary.period,
        emissions: locationData,
        nodes: locationNodes,
        nodeCount: locationData.nodeCount,
        byScope: scopeTotals,
        byDepartment: departmentAgg,
        percentage:
          fullSummary.totalEmissions.CO2e > 0
            ? ((locationData.CO2e / fullSummary.totalEmissions.CO2e) * 100).toFixed(2)
            : 0
      };

    } else {
      filterType = 'full';
      filteredData = fullSummary;
    }

    return res.status(200).json({
      success: true,
      filterType,
      data: filteredData
    });

  } catch (error) {
    console.error('Error in getFilteredSummary:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get filtered summary',
      error: error.message
    });
  }
};



// ---- Scope 1 + Scope 2 latest-total helper ---------------------------------
/**
 * Robust number caster (handles null/undefined/NaN/strings)
 */
const toNum = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Extract Scope 1 & Scope 2 CO2e from a "byScope" container which could be:
 *  - a Map<string, {...}>
 *  - a plain object with keys like "Scope 1", "Scope 2"
 *  - an Array<{ scopeType: 'Scope 1'|'Scope 2', CO2e: number, ... }>
 */
const extractS1S2FromByScope = (byScope) => {
  let s1 = 0, s2 = 0;

  if (!byScope) return { s1, s2 };

  // 1) Array form
  if (Array.isArray(byScope)) {
    for (const item of byScope) {
      const label = (item?.scopeType || item?.scope || '').toString().toLowerCase().replace(/\s+/g, '');
      if (label === 'scope1') s1 += toNum(item?.CO2e);
      if (label === 'scope2') s2 += toNum(item?.CO2e);
    }
    return { s1, s2 };
  }

  // 2) Map form
  if (typeof byScope?.keys === 'function' && typeof byScope?.get === 'function') {
    for (const k of byScope.keys()) {
      const key = k.toString().toLowerCase().replace(/\s+/g, '');
      const v = byScope.get(k);
      if (key === 'scope1') s1 += toNum(v?.CO2e ?? v);
      if (key === 'scope2') s2 += toNum(v?.CO2e ?? v);
      // also allow value objects that themselves carry scopeType
      const vt = (v?.scopeType || v?.scope || '').toString().toLowerCase().replace(/\s+/g, '');
      if (vt === 'scope1') s1 += toNum(v?.CO2e);
      if (vt === 'scope2') s2 += toNum(v?.CO2e);
    }
    return { s1, s2 };
  }

  // 3) Plain object form
  if (typeof byScope === 'object') {
    for (const [k, v] of Object.entries(byScope)) {
      const key = k.toString().toLowerCase().replace(/\s+/g, '');
      if (key === 'scope1') s1 += toNum(v?.CO2e ?? v);
      if (key === 'scope2') s2 += toNum(v?.CO2e ?? v);
      // also check embedded scopeType
      const vt = (v?.scopeType || v?.scope || '').toString().toLowerCase().replace(/\s+/g, '');
      if (vt === 'scope1') s1 += toNum(v?.CO2e);
      if (vt === 'scope2') s2 += toNum(v?.CO2e);
    }
  }

  return { s1, s2 };
};

/**
 * GET /api/summaries/:clientId/scope12-total
 * Always fetches the latest EmissionSummary for a client and returns:
 *  - latestPeriod (period object)
 *  - scope1CO2e
 *  - scope2CO2e
 *  - scope12TotalCO2e (= scope1 + scope2)
 *  - sourceSummaryId
 */
const getLatestScope12Total = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: 'clientId is required',
        timestamp: new Date().toISOString()
      });
    }

    // Find the latest summary — prefer the period.to date, then updatedAt/createdAt
    const latest = await EmissionSummary
      .findOne({ clientId })
      .sort({ 'period.to': -1, updatedAt: -1, createdAt: -1 })
      .lean();

    if (!latest) {
      return res.status(404).json({
        success: false,
        message: 'No emission summary found for this client',
        timestamp: new Date().toISOString()
      });
    }

    // Primary: sum from high-level byScope
    let { s1, s2 } = extractS1S2FromByScope(latest.byScope);

    // Optional fallback: if byScope missing/zero, try aggregating from byNode.* if your schema has it
    if ((s1 + s2) === 0 && latest.byNode) {
      const nodeValues = Array.isArray(latest.byNode)
        ? latest.byNode
        : typeof latest.byNode === 'object'
          ? Object.values(latest.byNode)
          : [];

      for (const nv of nodeValues) {
        // common shapes handled:
        // 1) nv.byScope in any of the forms (Map/object/array)
        if (nv?.byScope) {
          const part = extractS1S2FromByScope(nv.byScope);
          s1 += toNum(part.s1);
          s2 += toNum(part.s2);
        }
        // 2) direct keys (rare but safe)
        if (nv?.scope1) s1 += toNum(nv.scope1?.CO2e ?? nv.scope1);
        if (nv?.scope2) s2 += toNum(nv.scope2?.CO2e ?? nv.scope2);
      }
    }

    const payload = {
      success: true,
      message: 'Latest Scope 1 + Scope 2 total fetched successfully',
      data: {
        clientId,
        latestPeriod: latest.period || null,
        scope1CO2e: s1,
        scope2CO2e: s2,
        scope12TotalCO2e: s1 + s2,
        sourceSummaryId: latest._id || null
      },
      timestamp: new Date().toISOString()
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('getLatestScope12Total error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch Scope 1 + Scope 2 total',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};


// Get top & low emitters by category, scope and emission source (emission factor)
const getTopLowEmissionStats = async (req, res) => {
  try {
    const { clientId } = req.params;
    const {
      periodType,  // daily | weekly | monthly | yearly | all-time (optional)
      year,
      month,
      day,
      week,
      limit: limitRaw, // how many top / bottom items to return, default 5
    } = req.query;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: 'clientId is required',
      });
    }

    // ---------- small helpers ----------
    const safeNum = (v) => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const toEntries = (maybeMap) => {
      if (!maybeMap) return [];
      if (maybeMap instanceof Map) return Array.from(maybeMap.entries());
      if (typeof maybeMap === 'object') return Object.entries(maybeMap);
      return [];
    };

    const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10)) : 5;

    // ---------- Step 1: fetch base summary (same logic style as getFilteredSummary) ----------
    let query = { clientId };
    let fullSummary = null;

    if (periodType) {
      query['period.type'] = periodType;
      if (year) query['period.year'] = parseInt(year, 10);
      if (month) query['period.month'] = parseInt(month, 10);
      if (day) query['period.day'] = parseInt(day, 10);
      if (week) query['period.week'] = parseInt(week, 10);

      fullSummary = await EmissionSummary.findOne(query).lean();
    } else {
      // if periodType not specified, just take the latest summary
      fullSummary = await EmissionSummary.findOne({ clientId })
        .sort({ 'period.to': -1 })
        .lean();
    }

    if (!fullSummary) {
      return res.status(404).json({
        success: false,
        message: 'No summary data found for the specified client and period.',
      });
    }

    // This includes type, year, month, etc. so you know *which period* these top/low stats belong to
    const period = fullSummary.period;
    const totalCO2e = safeNum(fullSummary.totalEmissions?.CO2e);

    // ---------- Step 2: categories (top / low) ----------
    const categoryEntries = toEntries(fullSummary.byCategory);
    const categoryList = categoryEntries.map(([name, data]) => {
      const co2e = safeNum(data?.CO2e);
      return {
        categoryName: name,
        scopeType: data?.scopeType || null,
        CO2e: co2e,
        percentage:
          totalCO2e > 0
            ? Number(((co2e / totalCO2e) * 100).toFixed(2))
            : 0,
      };
    });

    const sortedCategoriesDesc = [...categoryList].sort((a, b) => b.CO2e - a.CO2e);

    const topCategories = sortedCategoriesDesc.slice(0, limit);
    const bottomCategories = [...categoryList]
      .filter(c => c.CO2e > 0)
      .sort((a, b) => a.CO2e - b.CO2e)
      .slice(0, limit);

    const highestCategory = topCategories[0] || null;
    const lowestCategory = bottomCategories[0] || null;

    // ---------- Step 3: scopes (Scope 1 / 2 / 3, high & low) ----------
    const scopeTypes = ['Scope 1', 'Scope 2', 'Scope 3'];
    const scopeList = [];

    for (const scopeType of scopeTypes) {
      const sData = fullSummary.byScope?.[scopeType];
      if (!sData) continue;

      const co2e = safeNum(sData.CO2e);
      scopeList.push({
        scopeType,
        CO2e: co2e,
        breakdown: sData, // keep full object (CO2, CH4, etc.)
        percentage:
          totalCO2e > 0
            ? Number(((co2e / totalCO2e) * 100).toFixed(2))
            : 0,
      });
    }

    const sortedScopesDesc = [...scopeList].sort((a, b) => b.CO2e - a.CO2e);
    const sortedScopesAsc = [...scopeList].sort((a, b) => a.CO2e - b.CO2e);

    const highestScope = sortedScopesDesc[0] || null;
    const lowestScope = sortedScopesAsc.find(s => s.CO2e > 0) || null;

    // ---------- Step 4: activities (top / low) ----------
    // Uses byActivity: key = activityName, value = { scopeType, categoryName, CO2e, ... }
    const activityEntries = toEntries(fullSummary.byActivity);
    const activityList = activityEntries.map(([name, data]) => {
      const co2e = safeNum(data?.CO2e);
      return {
        activityName: name,
        scopeType: data?.scopeType || null,
        categoryName: data?.categoryName || null,
        CO2e: co2e,
        percentage:
          totalCO2e > 0
            ? Number(((co2e / totalCO2e) * 100).toFixed(2))
            : 0,
      };
    });

    const sortedActivitiesDesc = [...activityList].sort((a, b) => b.CO2e - a.CO2e);
    const topActivities = sortedActivitiesDesc.slice(0, limit);
    const bottomActivities = [...activityList]
      .filter(a => a.CO2e > 0)
      .sort((a, b) => a.CO2e - b.CO2e)
      .slice(0, limit);

    const highestActivity = topActivities[0] || null;
    const lowestActivity = bottomActivities[0] || null;

    // ---------- Step 5: departments (top / low) ----------
    // Uses byDepartment: key = departmentName, value = { CO2e, CO2, CH4, N2O, uncertainty, dataPointCount, nodeCount }
    const departmentEntries = toEntries(fullSummary.byDepartment);
    const departmentList = departmentEntries.map(([name, data]) => {
      const co2e = safeNum(data?.CO2e);
      return {
        departmentName: name,
        CO2e: co2e,
        nodeCount: safeNum(data?.nodeCount),
        percentage:
          totalCO2e > 0
            ? Number(((co2e / totalCO2e) * 100).toFixed(2))
            : 0,
      };
    });

    const sortedDepartmentsDesc = [...departmentList].sort((a, b) => b.CO2e - a.CO2e);
    const topDepartments = sortedDepartmentsDesc.slice(0, limit);
    const bottomDepartments = [...departmentList]
      .filter(d => d.CO2e > 0)
      .sort((a, b) => a.CO2e - b.CO2e)
      .slice(0, limit);

    const highestDepartment = topDepartments[0] || null;
    const lowestDepartment = bottomDepartments[0] || null;

    // ---------- Step 6: emission sources (byEmissionFactor) ----------
    // This is your "emission source" breakdown in the model
    const sourceEntries = toEntries(fullSummary.byEmissionFactor);
    const sourceList = sourceEntries.map(([name, data]) => {
      const co2e = safeNum(data?.CO2e);
      const dataPointCount = safeNum(data?.dataPointCount);
      const scopeTypesFromSource = Array.isArray(data?.scopeTypes)
        ? data.scopeTypes
        : data?.scopeTypes && typeof data.scopeTypes === 'object'
          ? Object.keys(data.scopeTypes)
          : [];

      return {
        sourceName: name,
        CO2e: co2e,
        dataPointCount,
        scopeTypes: scopeTypesFromSource,
        percentage:
          totalCO2e > 0
            ? Number(((co2e / totalCO2e) * 100).toFixed(2))
            : 0,
      };
    });

    const sortedSourcesDesc = [...sourceList].sort((a, b) => b.CO2e - a.CO2e);
    const topSources = sortedSourcesDesc.slice(0, limit);
    const bottomSources = [...sourceList]
      .filter(s => s.CO2e > 0)
      .sort((a, b) => a.CO2e - b.CO2e)
      .slice(0, limit);

    const highestSource = topSources[0] || null;
    const lowestSource = bottomSources[0] || null;

    // ---------- Step 7: respond ----------
    return res.status(200).json({
      success: true,
      data: {
        clientId,

        // 👇 This tells you exactly which period: type, year, month, etc.
        period,

        totalEmissions: fullSummary.totalEmissions || null,

        categories: {
          highest: highestCategory,
          lowest: lowestCategory,
          top: topCategories,
          bottom: bottomCategories,
          count: categoryList.length,
        },

        scopes: {
          highest: highestScope,
          lowest: lowestScope,
          all: scopeList,
        },

        activities: {
          highest: highestActivity,
          lowest: lowestActivity,
          top: topActivities,
          bottom: bottomActivities,
          count: activityList.length,
        },

        departments: {
          highest: highestDepartment,
          lowest: lowestDepartment,
          top: topDepartments,
          bottom: bottomDepartments,
          count: departmentList.length,
        },

        emissionSources: {
          highest: highestSource,
          lowest: lowestSource,
          top: topSources,
          bottom: bottomSources,
          count: sourceList.length,
        },
      },
    });
  } catch (error) {
    console.error('Error in getTopLowEmissionStats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get top/low emission stats',
      error: error.message,
    });
  }
};

/**
 * Get highest / lowest emitting scopeIdentifier (and dates) using raw DataEntry documents,
 * and provide hierarchical breakdown (within each scopeIdentifier) by:
 *   - nodes (which nodes contribute most for that scopeIdentifier)
 *   - locations
 *   - departments
 *
 * All scopeIdentifiers are sorted from highest → lowest total CO2e.
 *
 * GET /api/summaries/:clientId/scope-identifiers/extremes
 *
 * Query params (all optional):
 *   - periodType = daily | weekly | monthly | yearly | all-time (default: monthly)
 *   - year, month, week, day (same pattern as getEmissionSummary)
 */
const getScopeIdentifierEmissionExtremes = async (req, res) => {
  try {
    const { clientId } = req.params;
    let { periodType = 'monthly', year, month, week, day } = req.query;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: 'clientId is required',
      });
    }

    const allowedTypes = ['daily', 'weekly', 'monthly', 'yearly', 'all-time'];
    if (!allowedTypes.includes(periodType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid periodType. Use one of: ${allowedTypes.join(', ')}`,
      });
    }

    // Same defaulting style as getEmissionSummary
    const now = moment.utc();
    const y = year ? parseInt(year, 10) : now.year();
    const m = month ? parseInt(month, 10) : now.month() + 1;
    const w = week ? parseInt(week, 10) : now.isoWeek();
    const d = day ? parseInt(day, 10) : now.date();

    const { from, to } = buildDateRange(periodType, y, m, w, d);

    // Only processed entries, like calculateEmissionSummary
    const dataEntries = await DataEntry.find({
      clientId,
      processingStatus: 'processed',
      timestamp: { $gte: from, $lte: to },
    }).lean();

    if (!dataEntries.length) {
      return res.status(404).json({
        success: false,
        message: 'No processed data entries found for this client in the requested period',
      });
    }

    // Try to get node metadata (department, location, label) from active flowchart.
    // If no flowchart is found, we still return stats, but department/location will be "Unknown".
    let nodeMetaMap = new Map();
    try {
      const activeChart = await getActiveFlowchart(clientId);
      const flowchart = activeChart?.chart;
      if (flowchart && Array.isArray(flowchart.nodes)) {
        flowchart.nodes.forEach(node => {
          nodeMetaMap.set(node.id, {
            nodeId: node.id,
            label: node.label || 'Unnamed node',
            department: node.details?.department || 'Unknown',
            location: node.details?.location || 'Unknown',
          });
        });
      }
    } catch (e) {
      console.warn(
        'getScopeIdentifierEmissionExtremes: failed to load active flowchart, using Unknown for department/location',
        e?.message
      );
      nodeMetaMap = new Map();
    }

    // Helper: format a "DD:MM:YYYY" string from entry
    const getDateStringFromEntry = (entry) => {
      if (entry.date && typeof entry.date === 'string') {
        // already in "DD:MM:YYYY" format from DataEntry model
        return entry.date;
      }
      if (entry.timestamp) {
        const dt = moment.utc(entry.timestamp);
        const dayStr = String(dt.date()).padStart(2, '0');
        const monthStr = String(dt.month() + 1).padStart(2, '0');
        const yearStr = String(dt.year());
        return `${dayStr}:${monthStr}:${yearStr}`;
      }
      return null;
    };

    const safeNum = (v) => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // Build stats per scopeIdentifier
    const scopeStatsMap = new Map();

    for (const entry of dataEntries) {
      const scopeIdentifier = entry.scopeIdentifier || 'Unknown';
      const emissionValues = extractEmissionValues(entry.calculatedEmissions);
      const co2e = safeNum(emissionValues?.CO2e);
      const dateStr = getDateStringFromEntry(entry);
      const nodeId = entry.nodeId || 'Unknown';

      const nodeMeta = nodeMetaMap.get(nodeId) || {};
      const nodeLabel = nodeMeta.label || null;
      const department = nodeMeta.department || 'Unknown';
      const location = nodeMeta.location || 'Unknown';

      if (!scopeStatsMap.has(scopeIdentifier)) {
        scopeStatsMap.set(scopeIdentifier, {
          scopeIdentifier,
          totalCO2e: 0,
          entriesCount: 0,
          maxEntry: null,
          minEntry: null,
          dailyTotals: new Map(),      // date -> total CO2e for that date
          nodes: new Map(),            // nodeId -> { nodeId, nodeLabel, department, location, totalCO2e, entriesCount }
          locations: new Map(),        // location -> { location, totalCO2e, entriesCount }
          departments: new Map(),      // department -> { department, totalCO2e, entriesCount }
        });
      }

      const stat = scopeStatsMap.get(scopeIdentifier);

      stat.totalCO2e += co2e;
      stat.entriesCount += 1;

      // Track per-entry max/min (for “on which date” at entry level)
      const entryInfo = {
        entryId: entry._id,
        nodeId,
        scopeType: entry.scopeType,
        CO2e: co2e,
        date: dateStr,
        time: entry.time || null,
        timestamp: entry.timestamp,
        inputType: entry.inputType,
      };

      // Max single entry for this scopeIdentifier
      if (!stat.maxEntry || co2e > stat.maxEntry.CO2e) {
        stat.maxEntry = entryInfo;
      }

      // Min single entry for this scopeIdentifier (ignore zero emissions)
      if (co2e > 0) {
        if (!stat.minEntry || co2e < stat.minEntry.CO2e) {
          stat.minEntry = entryInfo;
        }
      }

      // Track daily totals for this scopeIdentifier
      if (dateStr) {
        const prev = stat.dailyTotals.get(dateStr) || 0;
        stat.dailyTotals.set(dateStr, prev + co2e);
      }

      // ---------- node aggregation within this scopeIdentifier ----------
      if (!stat.nodes.has(nodeId)) {
        stat.nodes.set(nodeId, {
          nodeId,
          nodeLabel,
          department,
          location,
          totalCO2e: 0,
          entriesCount: 0,
        });
      }
      const nodeStat = stat.nodes.get(nodeId);
      nodeStat.totalCO2e += co2e;
      nodeStat.entriesCount += 1;

      // ---------- location aggregation within this scopeIdentifier ----------
      const locKey = location || 'Unknown';
      if (!stat.locations.has(locKey)) {
        stat.locations.set(locKey, {
          location: locKey,
          totalCO2e: 0,
          entriesCount: 0,
        });
      }
      const locStat = stat.locations.get(locKey);
      locStat.totalCO2e += co2e;
      locStat.entriesCount += 1;

      // ---------- department aggregation within this scopeIdentifier ----------
      const deptKey = department || 'Unknown';
      if (!stat.departments.has(deptKey)) {
        stat.departments.set(deptKey, {
          department: deptKey,
          totalCO2e: 0,
          entriesCount: 0,
        });
      }
      const deptStat = stat.departments.get(deptKey);
      deptStat.totalCO2e += co2e;
      deptStat.entriesCount += 1;
    }

    // Convert map → plain arrays and compute max/min day per scopeIdentifier
    let allStats = Array.from(scopeStatsMap.values()).map((stat) => {
      const dailyTotalsArray = Array.from(stat.dailyTotals.entries()).map(([date, value]) => ({
        date,
        CO2e: value,
      }));

      let maxDay = null;
      let minDay = null;

      if (dailyTotalsArray.length) {
        maxDay = dailyTotalsArray.reduce(
          (max, cur) => (cur.CO2e > max.CO2e ? cur : max),
          dailyTotalsArray[0]
        );

        const positiveDays = dailyTotalsArray.filter((d) => d.CO2e > 0);
        if (positiveDays.length) {
          minDay = positiveDays.reduce(
            (min, cur) => (cur.CO2e < min.CO2e ? cur : min),
            positiveDays[0]
          );
        }
      }

      // Convert inner maps (nodes / locations / departments) to sorted arrays high → low
      const nodesArray = Array.from(stat.nodes.values()).sort(
        (a, b) => b.totalCO2e - a.totalCO2e
      );

      const locationsArray = Array.from(stat.locations.values()).sort(
        (a, b) => b.totalCO2e - a.totalCO2e
      );

      const departmentsArray = Array.from(stat.departments.values()).sort(
        (a, b) => b.totalCO2e - a.totalCO2e
      );

      return {
        scopeIdentifier: stat.scopeIdentifier,
        totalCO2e: stat.totalCO2e,
        entriesCount: stat.entriesCount,
        maxEntry: stat.maxEntry,        // single entry with highest emission
        minEntry: stat.minEntry,        // single entry with lowest (non-zero) emission
        dailyTotals: dailyTotalsArray,  // all days for this scopeIdentifier
        maxDay,                         // day with highest total CO2e for this scopeIdentifier
        minDay,                         // day with lowest positive total CO2e
        nodes: nodesArray,              // node-wise hierarchy, high → low
        locations: locationsArray,      // location-wise within this scopeIdentifier
        departments: departmentsArray,  // department-wise within this scopeIdentifier
      };
    });

    if (!allStats.length) {
      return res.status(404).json({
        success: false,
        message: 'No scopeIdentifier statistics could be computed',
      });
    }

    // Sort all scopeIdentifiers high → low for a hierarchical view
    allStats.sort((a, b) => b.totalCO2e - a.totalCO2e);

    // Overall highest & lowest scopeIdentifier by TOTAL emissions
    const highestByTotal = allStats[0] || null;
    const lowestByTotal =
      allStats
        .slice()
        .reverse()
        .find((s) => s.totalCO2e > 0) || null;

    // Build period object (similar style to getEmissionSummary)
    const period = {
      type: periodType,
      from,
      to,
    };
    if (periodType !== 'all-time') {
      period.year = y;
    }
    if (periodType === 'monthly' || periodType === 'daily') {
      period.month = m;
    }
    if (periodType === 'weekly') {
      period.week = w;
    }
    if (periodType === 'daily') {
      period.day = d;
    }

    return res.status(200).json({
      success: true,
      data: {
        clientId,
        period,
        scopeIdentifiers: {
          highestByTotal, // includes maxDay + maxEntry (with date)
          lowestByTotal,  // includes minDay + minEntry (with date)
          // full list of scopeIdentifiers, high → low, with nodes/locations/departments inside each
          all: allStats,
        },
      },
    });
  } catch (error) {
    console.error('Error in getScopeIdentifierEmissionExtremes:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to compute scopeIdentifier emission stats',
      error: error.message,
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
const getScopeIdentifierHierarchy = async (req, res) => {
  try {
    const { clientId } = req.params;
    let { periodType = 'monthly', year, month, week, day } = req.query;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: 'clientId is required',
      });
    }

    const allowedTypes = ['daily', 'weekly', 'monthly', 'yearly', 'all-time'];
    if (!allowedTypes.includes(periodType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid periodType. Use one of: ${allowedTypes.join(', ')}`,
      });
    }

    // --------- Resolve period parts (fall back to "now" if not provided) ---------
    const now = moment.utc();
    const y = year ? parseInt(year, 10) : now.year();
    const m = month ? parseInt(month, 10) : now.month() + 1;
    const w = week ? parseInt(week, 10) : now.isoWeek();
    const d = day ? parseInt(day, 10) : now.date();

    const { from, to } = buildDateRange(periodType, y, m, w, d);

    // --------- Load processed entries for the client & period ---------
    const dataEntries = await DataEntry.find({
      clientId,
      processingStatus: 'processed',
      timestamp: { $gte: from, $lte: to },
    }).lean();

    if (!dataEntries.length) {
      return res.status(404).json({
        success: false,
        message: 'No processed data entries found for this client in the requested period',
      });
    }

    // --------- Load active flowchart to get node metadata (department, location, label) ---------
    const flowchartDoc = await Flowchart.findOne({ clientId, isActive: true }).lean();
    const nodeMetaMap = new Map(); // nodeId -> { nodeId, label, department, location }

    if (flowchartDoc && flowchartDoc.chart && Array.isArray(flowchartDoc.chart.nodes)) {
      flowchartDoc.chart.nodes.forEach((node) => {
        nodeMetaMap.set(node.id, {
          nodeId: node.id,
          label: node.label || 'Unnamed node',
          department: node.details?.department || 'Unknown',
          location: node.details?.location || 'Unknown',
        });
      });
    }

    // --------- Small helpers ---------
    const safeNum = (v) => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const getDateStringFromEntry = (entry) => {
      if (entry.date && typeof entry.date === 'string') {
        // already in "DD:MM:YYYY" format from DataEntry model
        return entry.date;
      }
      if (entry.timestamp) {
        const dt = moment.utc(entry.timestamp);
        const dayStr = String(dt.date()).padStart(2, '0');
        const monthStr = String(dt.month() + 1).padStart(2, '0');
        const yearStr = String(dt.year());
        return `${dayStr}:${monthStr}:${yearStr}`;
      }
      return null;
    };

    // ───────────────────────────────────────────────
    // MAPS for hierarchy
    // ───────────────────────────────────────────────

    // scopeIdentifier → node → entries
    const scopeIdentifierMap = new Map();

    // Global node totals (across all scopeIdentifiers)
    const globalNodeMap = new Map();

    // location → node → entries
    const locationMap = new Map();

    // department → node → entries
    const departmentMap = new Map();

    // scopeType ("Scope 1/2/3") → scopeIdentifier → node → entries
    const scopeTypeMap = new Map();

    let totalCO2e = 0;

    // ───────────────────────────────────────────────
    // MAIN LOOP – one pass over DataEntry
    // ───────────────────────────────────────────────
    for (const entry of dataEntries) {
      const scopeIdentifier = entry.scopeIdentifier || 'Unknown';
      const nodeId = entry.nodeId || 'Unknown';
      const scopeType = entry.scopeType || 'Unknown';

      const nodeMeta = nodeMetaMap.get(nodeId) || {};
      const nodeLabel = nodeMeta.label || null;
      const department = nodeMeta.department || 'Unknown';
      const location = nodeMeta.location || 'Unknown';

      const emissionValues = extractEmissionValues(entry.calculatedEmissions);
      const co2e = safeNum(emissionValues?.CO2e);
      const dateStr = getDateStringFromEntry(entry);

      totalCO2e += co2e;

      const entryInfo = {
        entryId: entry._id,
        nodeId,
        nodeLabel,
        department,
        location,
        scopeType,
        scopeIdentifier,
        CO2e: co2e,
        date: dateStr,
        time: entry.time || null,
        timestamp: entry.timestamp,
        inputType: entry.inputType,
        dataValues: entry.dataValues || null,
      };

      // ---------- 1) scopeIdentifier → node → entries ----------
      if (!scopeIdentifierMap.has(scopeIdentifier)) {
        scopeIdentifierMap.set(scopeIdentifier, {
          scopeIdentifier,
          totalCO2e: 0,
          entriesCount: 0,
          nodes: new Map(), // nodeId -> nodeStat
          entries: [],      // all entries under this scopeIdentifier
        });
      }
      const scopeStat = scopeIdentifierMap.get(scopeIdentifier);
      scopeStat.totalCO2e += co2e;
      scopeStat.entriesCount += 1;
      scopeStat.entries.push(entryInfo);

      if (!scopeStat.nodes.has(nodeId)) {
        scopeStat.nodes.set(nodeId, {
          nodeId,
          nodeLabel,
          department,
          location,
          totalCO2e: 0,
          entriesCount: 0,
          entries: [],
        });
      }
      const scopeNodeStat = scopeStat.nodes.get(nodeId);
      scopeNodeStat.totalCO2e += co2e;
      scopeNodeStat.entriesCount += 1;
      scopeNodeStat.entries.push(entryInfo);

      // ---------- 2) Global node totals (node wise) ----------
      if (!globalNodeMap.has(nodeId)) {
        globalNodeMap.set(nodeId, {
          nodeId,
          nodeLabel,
          department,
          location,
          totalCO2e: 0,
          entriesCount: 0,
          entries: [],
        });
      }
      const globalNodeStat = globalNodeMap.get(nodeId);
      globalNodeStat.totalCO2e += co2e;
      globalNodeStat.entriesCount += 1;
      globalNodeStat.entries.push(entryInfo);

      // ---------- 3) location → node → entries ----------
      const locationKey = location || 'Unknown';
      if (!locationMap.has(locationKey)) {
        locationMap.set(locationKey, {
          location: locationKey,
          totalCO2e: 0,
          entriesCount: 0,
          nodes: new Map(),
          entries: [],
        });
      }
      const locStat = locationMap.get(locationKey);
      locStat.totalCO2e += co2e;
      locStat.entriesCount += 1;
      locStat.entries.push(entryInfo);

      if (!locStat.nodes.has(nodeId)) {
        locStat.nodes.set(nodeId, {
          nodeId,
          nodeLabel,
          department,
          location: locationKey,
          totalCO2e: 0,
          entriesCount: 0,
          entries: [],
        });
      }
      const locNodeStat = locStat.nodes.get(nodeId);
      locNodeStat.totalCO2e += co2e;
      locNodeStat.entriesCount += 1;
      locNodeStat.entries.push(entryInfo);

      // ---------- 4) department → node → entries ----------
      const departmentKey = department || 'Unknown';
      if (!departmentMap.has(departmentKey)) {
        departmentMap.set(departmentKey, {
          department: departmentKey,
          totalCO2e: 0,
          entriesCount: 0,
          nodes: new Map(),
          entries: [],
        });
      }
      const deptStat = departmentMap.get(departmentKey);
      deptStat.totalCO2e += co2e;
      deptStat.entriesCount += 1;
      deptStat.entries.push(entryInfo);

      if (!deptStat.nodes.has(nodeId)) {
        deptStat.nodes.set(nodeId, {
          nodeId,
          nodeLabel,
          department: departmentKey,
          location,
          totalCO2e: 0,
          entriesCount: 0,
          entries: [],
        });
      }
      const deptNodeStat = deptStat.nodes.get(nodeId);
      deptNodeStat.totalCO2e += co2e;
      deptNodeStat.entriesCount += 1;
      deptNodeStat.entries.push(entryInfo);

      // ---------- 5) scopeType ("Scope 1/2/3") → scopeIdentifier → node → entries ----------
      const scopeTypeKey = scopeType || 'Unknown';
      if (!scopeTypeMap.has(scopeTypeKey)) {
        scopeTypeMap.set(scopeTypeKey, {
          scopeType: scopeTypeKey,
          totalCO2e: 0,
          entriesCount: 0,
          scopeIdentifiers: new Map(), // scopeIdentifier -> { ... }
          entries: [],
        });
      }
      const scopeTypeStat = scopeTypeMap.get(scopeTypeKey);
      scopeTypeStat.totalCO2e += co2e;
      scopeTypeStat.entriesCount += 1;
      scopeTypeStat.entries.push(entryInfo);

      if (!scopeTypeStat.scopeIdentifiers.has(scopeIdentifier)) {
        scopeTypeStat.scopeIdentifiers.set(scopeIdentifier, {
          scopeIdentifier,
          totalCO2e: 0,
          entriesCount: 0,
          nodes: new Map(), // nodeId -> nodeStat
          entries: [],
        });
      }
      const stScopeStat = scopeTypeStat.scopeIdentifiers.get(scopeIdentifier);
      stScopeStat.totalCO2e += co2e;
      stScopeStat.entriesCount += 1;
      stScopeStat.entries.push(entryInfo);

      if (!stScopeStat.nodes.has(nodeId)) {
        stScopeStat.nodes.set(nodeId, {
          nodeId,
          nodeLabel,
          department,
          location,
          totalCO2e: 0,
          entriesCount: 0,
          entries: [],
        });
      }
      const stNodeStat = stScopeStat.nodes.get(nodeId);
      stNodeStat.totalCO2e += co2e;
      stNodeStat.entriesCount += 1;
      stNodeStat.entries.push(entryInfo);
    }

    if (!scopeIdentifierMap.size) {
      return res.status(404).json({
        success: false,
        message: 'No scopeIdentifier statistics could be computed',
      });
    }

    // ───────────────────────────────────────────────
    // Convert maps → plain arrays and sort high → low
    // ───────────────────────────────────────────────

    // --- scopeIdentifier hierarchy ---
    let scopeList = Array.from(scopeIdentifierMap.values()).map((scopeStat) => {
      const nodesArray = Array.from(scopeStat.nodes.values()).map((nodeStat) => {
        nodeStat.entries.sort((a, b) => b.CO2e - a.CO2e); // entries high → low
        return nodeStat;
      });

      nodesArray.sort((a, b) => b.totalCO2e - a.totalCO2e); // nodes high → low
      scopeStat.entries.sort((a, b) => b.CO2e - a.CO2e);     // all entries high → low

      return {
        scopeIdentifier: scopeStat.scopeIdentifier,
        totalCO2e: scopeStat.totalCO2e,
        entriesCount: scopeStat.entriesCount,
        nodes: nodesArray,
        entries: scopeStat.entries,
      };
    });

    scopeList.sort((a, b) => b.totalCO2e - a.totalCO2e);

    const highestScopeIdentifier = scopeList[0] || null;
    const lowestScopeIdentifier =
      scopeList
        .slice()
        .reverse()
        .find((s) => s.totalCO2e > 0) || null;

    // --- global node ranking (node wise) ---
    let nodeList = Array.from(globalNodeMap.values()).map((nodeStat) => {
      nodeStat.entries.sort((a, b) => b.CO2e - a.CO2e);
      return nodeStat;
    });
    nodeList.sort((a, b) => b.totalCO2e - a.totalCO2e);

    const highestNode = nodeList[0] || null;
    const lowestNode =
      nodeList
        .slice()
        .reverse()
        .find((n) => n.totalCO2e > 0) || null;

    // --- location hierarchy ---
    let locationList = Array.from(locationMap.values()).map((locStat) => {
      const nodesArray = Array.from(locStat.nodes.values()).map((nodeStat) => {
        nodeStat.entries.sort((a, b) => b.CO2e - a.CO2e);
        return nodeStat;
      });

      nodesArray.sort((a, b) => b.totalCO2e - a.totalCO2e);
      locStat.entries.sort((a, b) => b.CO2e - a.CO2e);

      return {
        location: locStat.location,
        totalCO2e: locStat.totalCO2e,
        entriesCount: locStat.entriesCount,
        nodes: nodesArray,
        entries: locStat.entries,
      };
    });

    locationList.sort((a, b) => b.totalCO2e - a.totalCO2e);

    const highestLocation = locationList[0] || null;
    const lowestLocation =
      locationList
        .slice()
        .reverse()
        .find((l) => l.totalCO2e > 0) || null;

    // --- department hierarchy ---
    let departmentList = Array.from(departmentMap.values()).map((deptStat) => {
      const nodesArray = Array.from(deptStat.nodes.values()).map((nodeStat) => {
        nodeStat.entries.sort((a, b) => b.CO2e - a.CO2e);
        return nodeStat;
      });

      nodesArray.sort((a, b) => b.totalCO2e - a.totalCO2e);
      deptStat.entries.sort((a, b) => b.CO2e - a.CO2e);

      return {
        department: deptStat.department,
        totalCO2e: deptStat.totalCO2e,
        entriesCount: deptStat.entriesCount,
        nodes: nodesArray,
        entries: deptStat.entries,
      };
    });

    departmentList.sort((a, b) => b.totalCO2e - a.totalCO2e);

    const highestDepartment = departmentList[0] || null;
    const lowestDepartment =
      departmentList
        .slice()
        .reverse()
        .find((dpt) => dpt.totalCO2e > 0) || null;

    // --- scopeType hierarchy ("Scope 1/2/3") ---
    let scopeTypeList = Array.from(scopeTypeMap.values()).map((scopeTypeStat) => {
      const scopesArray = Array.from(scopeTypeStat.scopeIdentifiers.values()).map((stScopeStat) => {
        const nodesArray = Array.from(stScopeStat.nodes.values()).map((nodeStat) => {
          nodeStat.entries.sort((a, b) => b.CO2e - a.CO2e);
          return nodeStat;
        });

        nodesArray.sort((a, b) => b.totalCO2e - a.totalCO2e);
        stScopeStat.entries.sort((a, b) => b.CO2e - a.CO2e);

        return {
          scopeIdentifier: stScopeStat.scopeIdentifier,
          totalCO2e: stScopeStat.totalCO2e,
          entriesCount: stScopeStat.entriesCount,
          nodes: nodesArray,
          entries: stScopeStat.entries,
        };
      });

      scopesArray.sort((a, b) => b.totalCO2e - a.totalCO2e);
      scopeTypeStat.entries.sort((a, b) => b.CO2e - a.CO2e);

      return {
        scopeType: scopeTypeStat.scopeType,
        totalCO2e: scopeTypeStat.totalCO2e,
        entriesCount: scopeTypeStat.entriesCount,
        scopeIdentifiers: scopesArray,
        entries: scopeTypeStat.entries,
      };
    });

    scopeTypeList.sort((a, b) => b.totalCO2e - a.totalCO2e);

    const highestScopeType = scopeTypeList[0] || null;
    const lowestScopeType =
      scopeTypeList
        .slice()
        .reverse()
        .find((st) => st.totalCO2e > 0) || null;

    // ───────────────────────────────────────────────
    // Build period object (similar to other controllers)
    // ───────────────────────────────────────────────
    const period = {
      type: periodType,
      from,
      to,
    };
    if (periodType !== 'all-time') {
      period.year = y;
    }
    if (periodType === 'monthly' || periodType === 'daily') {
      period.month = m;
    }
    if (periodType === 'weekly') {
      period.week = w;
    }
    if (periodType === 'daily') {
      period.day = d;
    }

    const totalEntries = dataEntries.length;

    return res.status(200).json({
      success: true,
      data: {
        clientId,
        period,
        totals: {
          totalEntries,
          totalCO2e,
        },

        // ⬇️ ScopeIdentifier → Node → Entries (what you already had)
        scopeIdentifierHierarchy: {
          highestScopeIdentifier,
          lowestScopeIdentifier,
          list: scopeList, // full hierarchy high → low
        },

        // ⬇️ Global node ranking (node wise – also kept as "nodeTotals" for backwards compatibility)
        nodeTotals: {
          highestNode,
          lowestNode,
          list: nodeList,
        },
        nodeHierarchy: {
          highestNode,
          lowestNode,
          list: nodeList,
        },

        // ⬇️ Location wise hierarchy
        locationHierarchy: {
          highestLocation,
          lowestLocation,
          list: locationList,
        },

        // ⬇️ Department wise hierarchy
        departmentHierarchy: {
          highestDepartment,
          lowestDepartment,
          list: departmentList,
        },

        // ⬇️ Scope wise hierarchy (Scope 1 / 2 / 3)
        scopeTypeHierarchy: {
          highestScopeType,
          lowestScopeType,
          list: scopeTypeList,
        },
      },
    });
  } catch (error) {
    console.error('Error in getScopeIdentifierHierarchy:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to compute scopeIdentifier hierarchy',
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
    

};