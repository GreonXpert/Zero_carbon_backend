/**
 * ============================================================================
 * READY-TO-COPY: Updated calculateProcessEmissionSummaryPrecise
 * ============================================================================
 * 
 * Replace the existing calculateProcessEmissionSummaryPrecise function in
 * controllers/Calculation/CalculationSummary.js with this version.
 * 
 * ALSO ADD this import at the top of the file:
 * const { getEffectiveAllocationPct, applyAllocation } = require('../../utils/allocation/allocationHelpers');
 * 
 * ============================================================================
 */

/**
 * 🆕 CALCULATE PROCESS EMISSION SUMMARY (PRECISE) - WITH ALLOCATION SUPPORT
 * 
 * This function calculates a filtered emission summary based on ProcessFlowchart.
 * It provides scopeIdentifier-level precision by re-aggregating from DataEntry records.
 * 
 * KEY FEATURES:
 * - Only includes nodes that exist in ProcessFlowchart
 * - Only includes scopeIdentifiers that exist in those nodes
 * - 🆕 SUPPORTS ALLOCATION PERCENTAGES for shared scopeIdentifiers
 * 
 * ALLOCATION RULES:
 * - When scopeIdentifier appears in ONE node → full emissions attributed (100%)
 * - When scopeIdentifier appears in MULTIPLE nodes → emissions split by allocationPct
 * - If allocationPct is missing/undefined → treated as 100 (backward compatible)
 */

/**
 * Get effective allocation percentage from a scopeDetail.
 * Returns 100 if allocationPct is undefined/null (backward compatibility).
 * 
 * @param {Object} scopeDetail - The scopeDetail object from ProcessFlowchart
 * @returns {number} Allocation percentage (0-100)
 */
const getEffectiveAllocationPct = (scopeDetail) => {
  if (scopeDetail && 
      scopeDetail.allocationPct !== undefined && 
      scopeDetail.allocationPct !== null) {
    return Number(scopeDetail.allocationPct);
  }
  return 100; // Default: full allocation (backward compatible)
};


/**
 * Apply allocation percentage to emission values.
 * Multiplies each emission value by (allocationPct / 100).
 * 
 * @param {Object} emissionValues - Object with CO2e, CO2, CH4, N2O, uncertainty
 * @param {number} allocationPct - Allocation percentage (0-100)
 * @returns {Object} New emission values with allocation applied
 */
const applyAllocation = (emissionValues, allocationPct) => {
  const factor = (allocationPct || 100) / 100;
  
  return {
    CO2e: (emissionValues.CO2e || 0) * factor,
    CO2: (emissionValues.CO2 || 0) * factor,
    CH4: (emissionValues.CH4 || 0) * factor,
    N2O: (emissionValues.N2O || 0) * factor,
    uncertainty: (emissionValues.uncertainty || 0) * factor
  };
};

/**
 * Validate allocations for a set of nodes.
 * Checks that shared scopeIdentifiers have allocations summing to 100%.
 * 
 * @param {Array} nodes - Array of ProcessFlowchart nodes
 * @param {Object} options - Validation options
 * @param {boolean} options.includeFromOtherChart - Include scopes imported from other charts
 * @param {boolean} options.includeDeleted - Include deleted scopes
 * @returns {Object} Validation result { isValid, errors, warnings }
 */
const validateAllocations = (nodes, options = {}) => {
  const { includeFromOtherChart = false, includeDeleted = false } = options;
  
  const result = {
    isValid: true,
    errors: [],
    warnings: []
  };
  
  // Build allocation index
  const allocationIndex = buildAllocationIndex({ nodes }, { includeFromOtherChart, includeDeleted });
  
  // Check each scopeIdentifier
  for (const [scopeId, entries] of allocationIndex) {
    if (entries.length <= 1) continue; // Single occurrence - no validation needed
    
    const totalPct = entries.reduce((sum, e) => sum + e.allocationPct, 0);
    
    // Allow small tolerance for floating point errors
    if (Math.abs(totalPct - 100) > 0.01) {
      result.isValid = false;
      result.errors.push({
        scopeIdentifier: scopeId,
        type: 'ALLOCATION_SUM_MISMATCH',
        currentSum: totalPct,
        expectedSum: 100,
        entries: entries.map(e => ({
          nodeId: e.nodeId,
          nodeLabel: e.nodeLabel,
          allocationPct: e.allocationPct
        })),
        message: `Allocation for "${scopeId}" sums to ${totalPct}%, expected 100%`
      });
    }
    
    // Warn if any entry has exactly 100% when shared
    const hasDefault = entries.some(e => e.allocationPct === 100);
    if (hasDefault && entries.length > 1) {
      result.warnings.push({
        scopeIdentifier: scopeId,
        type: 'DEFAULT_ALLOCATION_IN_SHARED',
        message: `Shared scopeIdentifier "${scopeId}" has default 100% allocation - may cause double counting`
      });
    }
  }
  
  return result;
};

/**
 * Build allocation index from flowchart nodes.
 * Creates a Map of scopeIdentifier -> array of node allocations.
 * 
 * @param {Object} flowchart - Object with nodes array
 * @param {Object} options - Options for filtering
 * @returns {Map} Map<scopeIdentifier, Array<{nodeId, nodeLabel, allocationPct, scopeType, categoryName}>>
 */
const buildAllocationIndex = (flowchart, options = {}) => {
  const { includeFromOtherChart = false, includeDeleted = false } = options;
  const index = new Map();
  
  if (!flowchart || !Array.isArray(flowchart.nodes)) {
    return index;
  }
  
  for (const node of flowchart.nodes) {
    if (node.isDeleted && !includeDeleted) continue;
    
    const nodeId = node.id;
    const nodeLabel = node.label || node.details?.nodeType || nodeId;
    const scopeDetails = node.details?.scopeDetails || [];
    
    for (const scope of scopeDetails) {
      // Skip deleted scopes unless included
      if (scope.isDeleted && !includeDeleted) continue;
      
      // Skip imported scopes unless included
      if (scope.fromOtherChart && !includeFromOtherChart) continue;
      
      const sid = scope.scopeIdentifier;
      if (!sid) continue;
      
      if (!index.has(sid)) {
        index.set(sid, []);
      }
      
      index.get(sid).push({
        nodeId,
        nodeLabel,
        allocationPct: getEffectiveAllocationPct(scope),
        scopeType: scope.scopeType,
        categoryName: scope.categoryName
      });
    }
  }
  
  return index;
};

/**
 * Get allocation summary for display/API response.
 * 
 * @param {Map} allocationIndex - Result from buildAllocationIndex
 * @returns {Object} Summary with counts and details
 */
const getAllocationSummary = (allocationIndex) => {
  const summary = {
    totalScopeIdentifiers: allocationIndex.size,
    sharedScopeIdentifiers: 0,
    uniqueScopeIdentifiers: 0,
    details: []
  };
  
  for (const [scopeId, entries] of allocationIndex) {
    const isShared = entries.length > 1;
    
    if (isShared) {
      summary.sharedScopeIdentifiers++;
    } else {
      summary.uniqueScopeIdentifiers++;
    }
    
    const totalAllocation = entries.reduce((sum, e) => sum + e.allocationPct, 0);
    
    summary.details.push({
      scopeIdentifier: scopeId,
      isShared,
      nodeCount: entries.length,
      totalAllocation,
      isValid: !isShared || Math.abs(totalAllocation - 100) <= 0.01,
      nodes: entries.map(e => ({
        nodeId: e.nodeId,
        nodeLabel: e.nodeLabel,
        allocationPct: e.allocationPct
      }))
    });
  }
  
  return summary;
};

/**
 * Format validation error for API response.
 * 
 * @param {Object} validationResult - Result from validateAllocations
 * @returns {Object} Formatted error response
 */
const formatValidationError = (validationResult) => {
  if (validationResult.isValid) {
    return null;
  }
  
  return {
    code: 'ALLOCATION_VALIDATION_FAILED',
    message: 'Allocation percentages are invalid',
    errorCount: validationResult.errors.length,
    warningCount: validationResult.warnings.length,
    errors: validationResult.errors.map(e => ({
      scopeIdentifier: e.scopeIdentifier,
      currentSum: e.currentSum,
      message: e.message,
      nodes: e.entries
    })),
    warnings: validationResult.warnings
  };
};

/**
 * Auto-distribute allocations equally for shared scopeIdentifiers.
 * Useful for migration or initial setup.
 * 
 * @param {Array} nodes - ProcessFlowchart nodes array
 * @param {string} scopeIdentifier - The scopeIdentifier to distribute
 * @returns {Object} Result with updated allocations
 */
const autoDistributeAllocation = (nodes, scopeIdentifier) => {
  const matchingNodes = [];
  
  // Find all nodes with this scopeIdentifier
  for (const node of nodes) {
    if (node.isDeleted) continue;
    
    const scopeDetails = node.details?.scopeDetails || [];
    const scope = scopeDetails.find(s => 
      s.scopeIdentifier === scopeIdentifier && !s.isDeleted && !s.fromOtherChart
    );
    
    if (scope) {
      matchingNodes.push({ node, scope });
    }
  }
  
  if (matchingNodes.length <= 1) {
    return { distributed: false, reason: 'Not a shared scopeIdentifier' };
  }
  
  // Calculate equal distribution
  const equalPct = Math.round((100 / matchingNodes.length) * 100) / 100;
  const remainder = 100 - (equalPct * matchingNodes.length);
  
  // Apply allocations
  matchingNodes.forEach((match, index) => {
    // Last node gets remainder to ensure sum = 100
    match.scope.allocationPct = index === matchingNodes.length - 1
      ? equalPct + remainder
      : equalPct;
  });
  
  return {
    distributed: true,
    nodeCount: matchingNodes.length,
    allocations: matchingNodes.map(m => ({
      nodeId: m.node.id,
      allocationPct: m.scope.allocationPct
    }))
  };

};
const calculateProcessEmissionSummaryPrecise = async (
  clientId,
  periodType,
  year,
  month,
  week,
  day,
  userId = null
) => {
  const startedAt = Date.now();

  try {
    console.log(`📊🔍 Calculating PRECISE process emission summary (with allocation) for client: ${clientId}`);

    // ============================================================
    // STEP 1: LOAD PROCESSFLOWCHART
    // ============================================================
    const processFlowchart = await ProcessFlowchart.findOne({
      clientId,
      isDeleted: false
    }).lean();

    const { from, to } = buildDateRange(periodType, year, month, week, day);

    // Helper to create empty summary
    const createEmptySummary = (errorMessage) => ({
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
      byScopeIdentifier: new Map(),
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
        lastCalculated: new Date(startedAt),
        calculatedBy: userId,
        version: 1,
        isComplete: true,
        hasErrors: !!errorMessage,
        errors: errorMessage ? [errorMessage] : [],
        calculationDuration: Date.now() - startedAt,
        allocationApplied: true,
        sharedScopeIdentifiers: 0,
        allocationWarnings: []
      }
    });

    // Return empty structure if no ProcessFlowchart
    if (!processFlowchart || !Array.isArray(processFlowchart.nodes) || processFlowchart.nodes.length === 0) {
      return createEmptySummary("No ProcessFlowchart found");
    }

    const normalizeScopeIdentifier = (v) => (typeof v === "string" ? v.trim() : "");

    // ============================================================
    // 🆕 STEP 2: BUILD scopeIdentifier → processNode mapping WITH ALLOCATION
    // ============================================================
    const scopeIndex = new Map(); // scopeIdentifier -> array of { processNodeId, nodeMeta, scopeMeta, allocationPct }

    for (const node of processFlowchart.nodes) {
      const processNodeId = node.id || null;

      const nodeMeta = {
        label: node.label || "Unknown Node",
        department: node.details?.department || "Unknown",
        location: node.details?.location || "Unknown"
      };

      const scopeDetails = Array.isArray(node.details?.scopeDetails) ? node.details.scopeDetails : [];
      
      // Filter: only include valid scopes (not deleted)
      const validScopes = scopeDetails.filter(s => 
        normalizeScopeIdentifier(s.scopeIdentifier) && 
        s.isDeleted !== true
      );

      for (const s of validScopes) {
        const sid = normalizeScopeIdentifier(s.scopeIdentifier);
        
        // 🆕 Get allocation percentage (defaults to 100 for backward compatibility)
        const allocationPct = getEffectiveAllocationPct(s);
        
        if (!scopeIndex.has(sid)) scopeIndex.set(sid, []);
        scopeIndex.get(sid).push({
          processNodeId,
          nodeMeta,
          allocationPct,
          scopeMeta: {
            scopeIdentifier: sid,
            scopeType: s.scopeType,
            categoryName: s.categoryName,
            activity: s.activity,
            fromOtherChart: s.fromOtherChart || false
          }
        });
      }
    }

    if (scopeIndex.size === 0) {
      return createEmptySummary("No valid scopes in ProcessFlowchart");
    }

    // ============================================================
    // STEP 3: QUERY DATAENTRY RECORDS
    // ============================================================
    const dataEntries = await DataEntry.find({
      clientId,
      processingStatus: "processed",
      timestamp: { $gte: from, $lte: to }
    }).lean();

    // ============================================================
    // STEP 4: INITIALIZE SUMMARY STRUCTURE
    // ============================================================
    const processEmissionSummary = {
      period: { 
        type: periodType, 
        year, 
        month, 
        week, 
        day, 
        date: periodType === "daily" ? from : null, 
        from, 
        to 
      },
      totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
      byScope: {
        "Scope 1": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        "Scope 2": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        "Scope 3": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
      },
      byCategory: new Map(),
      byActivity: new Map(),
      byNode: new Map(),
      byScopeIdentifier: new Map(), // 🆕 NEW: Detailed breakdown by scopeIdentifier
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
        lastCalculated: new Date(startedAt),
        calculatedBy: userId,
        version: 1,
        isComplete: true,
        hasErrors: false,
        errors: [],
        calculationDuration: 0,
        // 🆕 Allocation metadata
        allocationApplied: true,
        sharedScopeIdentifiers: 0,
        allocationWarnings: []
      }
    };

    // ============================================================
    // 🆕 STEP 5: FILTER by scopeIdentifier AND APPLY ALLOCATION
    // ============================================================
    let includedCount = 0;
    let filteredCount = 0;
    const processedEntryIds = new Set();
    const sharedScopeSet = new Set();

    for (const entry of dataEntries) {
      const sid = normalizeScopeIdentifier(entry.scopeIdentifier);
      if (!sid) { filteredCount++; continue; }

      const matches = scopeIndex.get(sid);
      if (!matches || matches.length === 0) { filteredCount++; continue; }

      // Get raw emission values from entry
      const rawEmissionValues = extractEmissionValues(entry.calculatedEmissions);
      if (rawEmissionValues.CO2e === 0) continue;

      const scopeType = entry.scopeType || matches[0].scopeMeta.scopeType || "Unknown";
      
      // 🆕 ALLOCATION LOGIC
      const isSharedScope = matches.length > 1;
      
      if (isSharedScope && !sharedScopeSet.has(sid)) {
        sharedScopeSet.add(sid);
        processEmissionSummary.metadata.sharedScopeIdentifiers++;
      }

      // Process each node that has this scopeIdentifier
      for (const match of matches) {
        const allocationPct = match.allocationPct;
        
        // 🆕 Apply allocation to emission values
        const emissionValues = applyAllocation(rawEmissionValues, allocationPct);
        
        // Skip if allocated value is negligible
        if (emissionValues.CO2e < 0.0001) continue;

        includedCount++;

        const categoryName = match.scopeMeta.categoryName || "Unknown Category";
        const activity = match.scopeMeta.activity || sid;
        const processNodeId = match.processNodeId || `unknown-process-node::${sid}`;

        // TOTAL (allocated)
        addEmissionValues(processEmissionSummary.totalEmissions, emissionValues);

        // BY SCOPE (allocated)
        if (processEmissionSummary.byScope[scopeType]) {
          addEmissionValues(processEmissionSummary.byScope[scopeType], emissionValues);
          processEmissionSummary.byScope[scopeType].dataPointCount += 1;
        }

        // BY CATEGORY (allocated)
        const cat = ensureMapEntry(processEmissionSummary.byCategory, categoryName, { 
          scopeType, 
          activities: new Map() 
        });
        addEmissionValues(cat, emissionValues);
        const catAct = ensureMapEntry(cat.activities, activity);
        addEmissionValues(catAct, emissionValues);

        // BY ACTIVITY (allocated)
        const act = ensureMapEntry(processEmissionSummary.byActivity, activity, { 
          scopeType, 
          categoryName 
        });
        addEmissionValues(act, emissionValues);

        // 🆕 BY NODE with allocation info
        const nodeBucket = ensureMapEntry(processEmissionSummary.byNode, processNodeId, {
          nodeLabel: match.nodeMeta.label,
          department: match.nodeMeta.department,
          location: match.nodeMeta.location,
          scopeIdentifiers: new Map(), // 🆕 Track scopeIdentifiers and their allocations
          byScope: {
            "Scope 1": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            "Scope 2": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
            "Scope 3": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
          }
        });
        addEmissionValues(nodeBucket, emissionValues);
        
        if (nodeBucket.byScope[scopeType]) {
          addEmissionValues(nodeBucket.byScope[scopeType], emissionValues);
          nodeBucket.byScope[scopeType].dataPointCount += 1;
        }
        
        // 🆕 Track scopeIdentifier details within node
        if (!nodeBucket.scopeIdentifiers.has(sid)) {
          nodeBucket.scopeIdentifiers.set(sid, {
            allocationPct,
            isShared: isSharedScope,
            CO2e: 0,
            dataPointCount: 0
          });
        }
        const nodeScope = nodeBucket.scopeIdentifiers.get(sid);
        nodeScope.CO2e += emissionValues.CO2e;
        nodeScope.dataPointCount += 1;

        // 🆕 BY SCOPE IDENTIFIER (new breakdown)
        const scopeIdBucket = ensureMapEntry(processEmissionSummary.byScopeIdentifier, sid, {
          scopeType,
          categoryName,
          activity,
          isShared: isSharedScope,
          totalCO2e: 0,
          nodes: new Map(),
          dataPointCount: 0
        });
        
        if (!scopeIdBucket.nodes.has(processNodeId)) {
          scopeIdBucket.nodes.set(processNodeId, {
            nodeLabel: match.nodeMeta.label,
            allocationPct,
            CO2e: 0,
            dataPointCount: 0
          });
        }
        const nodeInScope = scopeIdBucket.nodes.get(processNodeId);
        nodeInScope.CO2e += emissionValues.CO2e;
        nodeInScope.dataPointCount += 1;
        
        scopeIdBucket.totalCO2e += emissionValues.CO2e;
        scopeIdBucket.dataPointCount += 1;

        // BY DEPARTMENT (allocated)
        const dept = ensureMapEntry(processEmissionSummary.byDepartment, match.nodeMeta.department);
        addEmissionValues(dept, emissionValues);

        // BY LOCATION (allocated)
        const loc = ensureMapEntry(processEmissionSummary.byLocation, match.nodeMeta.location);
        addEmissionValues(loc, emissionValues);

        // BY INPUT TYPE (allocated)
        if (processEmissionSummary.byInputType[entry.inputType]) {
          processEmissionSummary.byInputType[entry.inputType].CO2e += emissionValues.CO2e;
          processEmissionSummary.byInputType[entry.inputType].dataPointCount += 1;
        }

        // BY EMISSION FACTOR (allocated)
        const eff = ensureMapEntry(
          processEmissionSummary.byEmissionFactor,
          entry.emissionFactor || "Unknown",
          { scopeTypes: { "Scope 1": 0, "Scope 2": 0, "Scope 3": 0 } }
        );
        addEmissionValues(eff, emissionValues);
        eff.scopeTypes[scopeType] += 1;
      }

      // Track entry ID (only once per entry)
      if (!processedEntryIds.has(entry._id.toString())) {
        processEmissionSummary.metadata.dataEntriesIncluded.push(entry._id);
        processedEntryIds.add(entry._id.toString());
      }
    }

    processEmissionSummary.metadata.totalDataPoints = includedCount;
    processEmissionSummary.metadata.calculationDuration = Date.now() - startedAt;

    console.log(`📊 Process summary (with allocation): ${includedCount} allocated entries, ${filteredCount} filtered`);
    console.log(`📊 Shared scopeIdentifiers: ${processEmissionSummary.metadata.sharedScopeIdentifiers}`);

    return processEmissionSummary;

  } catch (err) {
    console.error("❌ Error calculating processEmissionSummary:", err);
    return {
      period: { type: periodType, year, month, week, day, from: null, to: null },
      totalEmissions: { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0 },
      byScope: {
        "Scope 1": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        "Scope 2": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 },
        "Scope 3": { CO2e: 0, CO2: 0, CH4: 0, N2O: 0, uncertainty: 0, dataPointCount: 0 }
      },
      byCategory: new Map(),
      byActivity: new Map(),
      byNode: new Map(),
      byScopeIdentifier: new Map(),
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
        lastCalculated: new Date(startedAt),
        calculatedBy: userId,
        version: 1,
        isComplete: false,
        hasErrors: true,
        errors: [`Error: ${err.message}`],
        calculationDuration: Date.now() - startedAt,
        allocationApplied: false,
        sharedScopeIdentifiers: 0,
        allocationWarnings: []
      }
    };
  }
};

module.exports = { 
  getEffectiveAllocationPct,
  applyAllocation,
  validateAllocations,
  buildAllocationIndex,
  getAllocationSummary,
  formatValidationError,
  autoDistributeAllocation,
  calculateProcessEmissionSummaryPrecise };