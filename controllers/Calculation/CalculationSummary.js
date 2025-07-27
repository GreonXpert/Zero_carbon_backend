// controllers/Calculation/CalculationSummary.js

const EmissionSummary = require('../../models/CalculationEmission/EmissionSummary');
const DataEntry = require('../../models/DataEntry');
const Flowchart = require('../../models/Flowchart');
const Client = require('../../models/Client');
const moment = require('moment');

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
    
    const flowchart = await Flowchart.findOne({ clientId, isActive: true }).lean();
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
      summaryId: savedSummary._id,
      period: savedSummary.period,
      totalEmissions: savedSummary.totalEmissions
    });

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
    if (summaryData) {
      return await saveEmissionSummary(summaryData);
    }
    return null;
  } catch (error) {
    console.error(`Error recalculating ${periodType} summary for client ${clientId}:`, error);
    throw error;
  }
};

// ========== API Controllers ==========

const getEmissionSummary = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { periodType = 'monthly', year, month, week, day, recalculate = 'false' } = req.query;

    if (!['daily', 'weekly', 'monthly', 'yearly', 'all-time'].includes(periodType)) {
      return res.status(400).json({ success: false, message: 'Invalid period type.' });
    }

    let summary;
    const currentYear = year ? parseInt(year) : moment.utc().year();
    const currentMonth = month ? parseInt(month) : moment.utc().month() + 1;
    const currentWeek = week ? parseInt(week) : moment.utc().isoWeek();
    const currentDay = day ? parseInt(day) : moment.utc().date();

    if (recalculate === 'true') {
      summary = await recalculateAndSaveSummary(clientId, periodType, currentYear, currentMonth, currentWeek, currentDay, req.user?._id);
    } else {
      const query = { clientId, 'period.type': periodType };
      if (year) query['period.year'] = currentYear;
      if (month) query['period.month'] = currentMonth;
      if (week) query['period.week'] = currentWeek;
      if (day) query['period.day'] = currentDay;
      summary = await EmissionSummary.findOne(query).lean();
      if (!summary || (Date.now() - new Date(summary.metadata.lastCalculated).getTime()) > 3600000) {
        summary = await recalculateAndSaveSummary(clientId, periodType, currentYear, currentMonth, currentWeek, currentDay, req.user?._id);
      }
    }

    if (!summary) {
      return res.status(404).json({ success: false, message: 'No data found for the specified period' });
    }

    const responseData = { ...summary };
    for (const key of ['byCategory', 'byActivity', 'byNode', 'byDepartment', 'byLocation', 'byEmissionFactor']) {
        if (responseData[key] instanceof Map) {
            responseData[key] = Object.fromEntries(responseData[key]);
        }
    }

    res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    console.error('Error getting emission summary:', error);
    res.status(500).json({ success: false, message: 'Failed to get emission summary', error: error.message });
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

module.exports = {
  setSocketIO,
  calculateEmissionSummary,
  saveEmissionSummary,
  updateSummariesOnDataChange,
  recalculateAndSaveSummary,
  getEmissionSummary,
  getMultipleSummaries
};