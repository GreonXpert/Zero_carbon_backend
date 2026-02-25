const DataEntry = require('../../models/Organization/DataEntry');
const DataCollectionConfig = require('../../models/Organization/DataCollectionConfig');
const Flowchart = require('../../models/Organization/Flowchart');
const Client = require('../../models/CMS/Client');
const User = require('../../models/User');
const csvtojson = require('csvtojson');
const moment = require('moment');
const fs = require('fs');

const ProcessFlowchart = require('../../models/Organization/ProcessFlowchart');
const { createProcessEmissionDataEntry } = require('../../utils/ProcessEmission/createProcessEmissionDataEntry');



const {
  triggerEmissionCalculation,
  validateEmissionPrerequisites
} = require('../Calculation/emissionIntegration');

// Imported here (not at top to avoid circular-dep issues) so that we can
// re-trigger summaries AFTER ProcessEmissionDataEntry records are persisted.
// The first summary run (inside triggerEmissionCalculation) fires before those
// records exist; a second run ensures Strategy A picks them up correctly.
const { updateSummariesOnDataChange } = require('../Calculation/CalculationSummary');

const {getActiveFlowchart} = require ('../../utils/DataCollection/dataCollection');
const {
  getDataEntryAccessContext,
  buildDataEntryMongoConstraint,
  attachDataEntryAccessContext,
} = require('../../utils/Permissions/dataEntryPermission');

const { uploadOrganisationCSVCreate } = require('../../utils/uploads/organisation/csv/create');
const { resolveApiKeyRequestTargets } = require("../../utils/ApiKey/apiKeyNotifications");




/**
 * Normalizes a data payload from any source (API, IOT, Manual, CSV)
 * into a standardized format for emission calculation.
 *
 * @param {object} sourceData The raw data object from the request (e.g., req.body.dataValues or a CSV row).
 * @param {object} scopeConfig The configuration for the specific scope.
 * @param {'API' | 'IOT' | 'MANUAL' | 'CSV'} inputType The source of the data, used to handle type conversions.
 * @returns {object} A standardized data object (pd).
 */
function normalizeDataPayload(sourceData, scopeConfig, inputType) {
    // ✅ If caller sent { dataValues: {...} } (as in your Manual/API/IoT requests),
  //    use it as-is. `saveOneEntry()` will still convert to Map<number> with `toNumericMap`.
  if (
    sourceData &&
    typeof sourceData === 'object' &&
    sourceData.dataValues &&
    typeof sourceData.dataValues === 'object'
  ) {
    return sourceData.dataValues;
  }

  const pd = {};

  /**
   * Helper to safely parse numbers, returning 0 for invalid inputs.
   * This is primarily for CSV data where all values are strings.
   */
  const parseNumber = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    const num = Number(value);
    return isNaN(num) ? 0 : num;
  };

  /**
   * Universal value getter.
   * It finds the first available key from a list of possibilities in the source object.
   * If the inputType is 'CSV', it ensures the value is parsed as a number.
   *
   * @param {string[]} keys An array of possible keys for the value.
   * @param {*} defaultValue The default value to return if no key is found.
   * @returns {*} The found value or the default.
   */
  const getValue = (keys, defaultValue = 0) => {
    for (const key of keys) {
      if (sourceData[key] !== undefined && sourceData[key] !== null) {
        // For CSV, all values are strings and must be parsed.
        // For other types, we trust the type or use the nullish coalescing operator later.
        return inputType === 'CSV' ? parseNumber(sourceData[key]) : sourceData[key];
      }
    }
    return defaultValue;
  };

  // ───────── SCOPE 1 ─────────
  if (scopeConfig.scopeType === 'Scope 1') {
    if (scopeConfig.categoryName.includes('Combustion')) {
      pd.fuelConsumption = getValue(['fuelConsumption', 'fuel_consumed', 'consumption']);
    }
    // SF₆-specific fugitive must come before the generic fugitive check
    else if (scopeConfig.categoryName.includes('Fugitive') && /SF6/i.test(scopeConfig.activity)) {
      pd.nameplateCapacity = getValue(['nameplateCapacity', 'nameplate_capacity']);
      pd.defaultLeakageRate = getValue(['defaultLeakageRate', 'default_leakage_rate']);
      pd.decreaseInventory = getValue(['decreaseInventory', 'decrease_inventory']);
      pd.acquisitions = getValue(['acquisitions']);
      pd.disbursements = getValue(['disbursements']);
      pd.netCapacityIncrease = getValue(['netCapacityIncrease', 'net_capacity_increase']);
    }
    // CH₄-Leaks fugitive
    else if (scopeConfig.categoryName.includes('Fugitive') && /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)) {
      pd.activityData = getValue(['activityData', 'activity_data']);
      pd.numberOfComponents = getValue(['numberOfComponents', 'number_of_components']);
    }
    // Generic fugitive / refrigeration
    else if (scopeConfig.categoryName.includes('Fugitive') || /ref.*?geration/i.test(scopeConfig.activity)) {
      pd.numberOfUnits = getValue(['numberOfUnits', 'unit_count']);
      pd.leakageRate = getValue(['leakageRate', 'leakage']);
      pd.installedCapacity = getValue(['installedCapacity']);
      pd.endYearCapacity = getValue(['endYearCapacity']);
      pd.purchases = getValue(['purchases']);
      pd.disposals = getValue(['disposals']);
    }
    // Process Emission
    else if (scopeConfig.categoryName.includes('Process Emission')) {
      pd.productionOutput = getValue(['productionOutput', 'production_output']); // Tier 1
      pd.rawMaterialInput = getValue(['rawMaterialInput', 'raw_material_input']); // Tier 2
    }
  }

  // ───────── SCOPE 2 ─────────
  else if (scopeConfig.scopeType === 'Scope 2') {
     const categoryFieldMap = {
      'Purchased Electricity': 'consumed_electricity',
      'Purchased Steam': 'consumed_steam',
      'Purchased Heating': 'consumed_heating',
      'Purchased Cooling': 'consumed_cooling'
    };
    const fieldKey = categoryFieldMap[scopeConfig.categoryName] || 'consumed_electricity';
    
    pd[fieldKey] = getValue([
        fieldKey, // e.g., 'consumed_electricity'
        fieldKey.split('_')[1], // e.g., 'electricity'
        `power_${fieldKey.split('_')[1]}`, // e.g., 'power_consumption'
        `${fieldKey.split('_')[1]}_consumed` // e.g., 'electricity_consumed'
    ]);
  }

  // ───────── SCOPE 3 ─────────
  else if (scopeConfig.scopeType === 'Scope 3') {
    switch (scopeConfig.categoryName) {
      case 'Purchased Goods and Services':
        pd.procurementSpend = getValue(['procurementSpend', 'procurement_spend']); // Tier 1
        pd.physicalQuantity = getValue(['physicalQuantity', 'physical_quantity']); // Tier 2
        break;

      case 'Capital Goods':
        pd.procurementSpend = getValue(['procurementSpend', 'procurement_spend', 'capital_spend']); // Tier 1
        pd.assetQuantity = getValue(['assetQuantity', 'asset_quantity']); // Tier 2
        break;

      case 'Fuel and energy':
        pd.fuelConsumed = getValue(['fuelConsumed', 'fuel_consumed']);
        pd.fuelConsumption=getValue(['consumed_fuel','consumedFuel']);
        pd.electricityConsumption = getValue(['electricityConsumption', 'electricity_consumed']);
        pd.tdLossFactor = getValue(['tdLossFactor', 'td_loss_factor']);
        break;

      case 'Upstream Transport and Distribution':{
      const spend = getValue([
        'transportationSpend', 'transportation_spend',
        'transportSpend', 'transport_Spend', 'spendTransport'
      ]);

      // expose under BOTH keys so whatever the calculator expects will be present
      pd.transportationSpend = spend; // canonical name used in formulas
      pd.transportSpend = spend;

      pd.allocation = getValue(['allocation', 'weight']);           // Tier 2
      pd.distance   = getValue(['distance', 'km']);                 // Tier 2
      break;
    }


      case 'Waste Generated in Operation':
        pd.wasteMass = getValue(['wasteMass', 'mass_waste']);
        pd.treatmentType = getValue(['treatmentType'], ''); // Default to empty string
        break;

      case 'Business Travel':
        pd.travelSpend = getValue(['travelSpend', 'travel_spend']); // Tier 1
        pd.numberOfPassengers = getValue(['numberOfPassengers', 'passengers']); // Tier 2
        pd.distanceTravelled = getValue(['distanceTravelled', 'distance']); // Tier 2
        pd.hotelNights = getValue(['hotelNights', 'hotel_nights']); // Both Tiers
        break;

      case 'Employee Commuting':
         if (scopeConfig.calculationModel === 'tier 1') {
            pd.employeeCount = getValue(['employeeCount', 'employee_Count']);
            pd.averageCommuteDistance = getValue(['averageCommuteDistance', 'average_Commuting_Distance']);
            pd.workingDays = getValue(['workingDays', 'working_Days']);
         } else {
             pd.note = 'Tier 2 calculation in progress';
         }
        break;

      // ✅ Inside normalizeDataPayload(...) – in the Scope 3 block for Leased Assets
case 'Upstream Leased Assets':
case 'Downstream Leased Assets': {
  // local helper: prefer numeric, but keep non-numeric strings
  const pick = (obj, keys, def = 0) => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
        const n = Number(obj[k]);
        return Number.isFinite(n) ? n : obj[k];
      }
    }
    return def;
  };

  // ✅ write to pd.* (NOT normalized.*)
  pd.leasedArea        = pick(sourceData, ['leasedArea', 'leased_area']);
  pd.totalArea         = pick(sourceData, ['totalArea', 'total_area']);
  pd.energyConsumption = pick(sourceData, ['energyConsumption', 'energy', 'kWh', 'MWh']);

  // several spellings seen in requests
  pd.BuildingTotalS1_S2 = pick(
    sourceData,
    ['BuildingTotalS1_S2', 'buildingTotalS1S2', 'BuildingTotals1_S2']
  );

  // accept occupancyEF or occupancyFactor; default to 1 so ratio never divides by 0
  pd.occupancyEF = pick(
    sourceData,
    ['occupancyEF', 'occupancyFactor', 'occupancy_factor', 'OccupancyFactor'],
    1
  );
  break;
}


     case 'Downstream Transport and Distribution': {
      const spend = getValue([
        'transportSpend', 'transport_Spend', 'spendTransport',
        'transportationSpend', 'transportation_spend'
      ]);

      // again expose under BOTH keys
      pd.transportSpend        = spend; // canonical for downstream Tier 1
      pd.transportationSpend   = spend;

      pd.allocation = getValue(['allocation', 'transportMass', 'weight']);      // Tier 2
      pd.distance   = getValue(['distance', 'transportDistance', 'km']);        // Tier 2
      break;
    }
      case 'Processing of Sold Products':
        pd.productQuantity = getValue(['productQuantity', 'product_quantity']);
        pd.customerType = getValue(['customerType', 'customer_type'], ''); // Tier 2
        break;

      case 'Use of Sold Products':
        pd.productQuantity = getValue(['productQuantity', 'product_quantity']);
        // Tier 1
        pd.averageLifetimeEnergyConsumption = getValue(['averageLifetimeEnergyConsumption', 'average_lifetime_energy_consumption']);
        // Tier 2
        pd.usePattern = getValue(['usePattern', 'use_pattern'], 1); // Default to 1
        pd.energyEfficiency = getValue(['energyEfficiency', 'energy_efficiency']);
        break;

      case 'End-of-Life Treatment of Sold Products':
        pd.massEol = getValue(['massEol', 'mass_eol']);
        pd.toDisposal = getValue(['toDisposal', 'to_disposal']);
        pd.toLandfill = getValue(['toLandfill', 'to_landfill']);
        pd.toIncineration = getValue(['toIncineration', 'to_incineration']);
        break;

      case 'Franchises':
        // Tier 1
        pd.franchiseCount = getValue(['franchiseCount', 'noOfFranchises']);
        pd.avgEmissionPerFranchise = getValue(['avgEmissionPerFranchise', 'averageEmissionPerFranchise']);
        // Tier 2
        pd.franchiseTotalS1Emission = getValue(['franchiseTotalS1Emission', 'totalS1Emission']);
        pd.franchiseTotalS2Emission = getValue(['franchiseTotalS2Emission', 'totalS2Emission']);
        pd.energyConsumption = getValue(['energyConsumption', 'energy_Consumption']); // Tier 2 Case B
        break;

      case 'Investments':
        // pd.equitySharePercentage = getValue(['equitySharePercentage', 'equity_share_percentage']);
        // Tier 1
        pd.investeeRevenue = getValue(['investeeRevenue', 'investee_revenue']);
        // Tier 2 Case A
        pd.investeeScope1Emission = getValue(['investeeScope1Emission', 'scope1Emission']);
        pd.investeeScope2Emission = getValue(['investeeScope2Emission', 'scope2Emission']);
        // Tier 2 Case B
        pd.energyConsumption = getValue(['energyConsumption', 'energy_consumption']);
        break;
        
      default:
        console.warn(`(normalizeDataPayload) - Unknown Scope 3 category: ${scopeConfig.categoryName}`);
        break;
    }
  }
  
  // Final pass to ensure all numeric values are numbers and not null/undefined
  for (const key in pd) {
      if(typeof pd[key] === 'number') {
          pd[key] = pd[key] ?? 0;
      }
  }

  return pd;
}

// Import socket.io instance (you'll need to export this from your server setup)
let io;

// Function to set socket.io instance
const setSocketIO = (socketIO) => {
  io = socketIO;
};

// Function to emit real-time updates
const emitDataUpdate = (eventType, data) => {
  if (io) {
    // Emit to all connected clients in the same clientId room
    io.to(`client_${data.clientId}`).emit(eventType, {
      timestamp: new Date(),
      type: eventType,
      data: data
    });
  }
};

// ===== Client workflow sync helpers (mirror source state to Client.workflowTracking.dataInputPoints) =====
async function loadClientForPoints(clientId) {
  // Only load the fields we mutate
  const client = await Client.findOne(
    { clientId },
    {
      'workflowTracking.dataInputPoints': 1
    }
  );
  return client;
}

const makePointId = (nodeId, scopeIdentifier) => `${nodeId}::${scopeIdentifier}`;

// Remove any point with same nodeId/scopeIdentifier from all three buckets
function removeFromAllTypes(client, nodeId, scopeIdentifier) {
  if (!client?.workflowTracking?.dataInputPoints) return;

  const dip = client.workflowTracking.dataInputPoints;
  for (const key of ['manual', 'api', 'iot']) {
    const arr = dip[key]?.inputs || [];
    const next = arr.filter(p => !(p.nodeId === nodeId && p.scopeIdentifier === scopeIdentifier));
    dip[key].inputs = next;
    client.updateInputPointCounts(key);
  }
}

// Upsert a point into a specific bucket
function upsertIntoType(client, type, payload) {
  const dip = client.workflowTracking.dataInputPoints;
  const list = dip[type].inputs || [];
  const existingIdx = list.findIndex(
    p => p.nodeId === payload.nodeId && p.scopeIdentifier === payload.scopeIdentifier
  );

  if (type === 'manual') {
    const base = {
      pointId: makePointId(payload.nodeId, payload.scopeIdentifier),
      pointName: payload.scopeIdentifier,
      nodeId: payload.nodeId,
      scopeIdentifier: payload.scopeIdentifier,
      status: 'not_started',
      lastUpdatedBy: payload.userId,
      lastUpdatedAt: new Date()
    };
    if (existingIdx >= 0) list[existingIdx] = { ...list[existingIdx], ...base };
    else list.push(base);
  }

  if (type === 'api') {
    const base = {
      pointId: makePointId(payload.nodeId, payload.scopeIdentifier),
      endpoint: payload.apiEndpoint || '',
      nodeId: payload.nodeId,
      scopeIdentifier: payload.scopeIdentifier,
      status: 'pending',
      connectionStatus: payload.connected ? 'connected' : 'not_connected',
      lastConnectionTest: payload.connected ? new Date() : undefined,
      lastUpdatedBy: payload.userId,
      lastUpdatedAt: new Date()
    };
    if (existingIdx >= 0) {
      list[existingIdx] = {
        ...list[existingIdx],
        ...base,
        endpoint: base.endpoint || list[existingIdx].endpoint
      };
    } else list.push(base);
  }

  if (type === 'iot') {
    const base = {
      pointId: makePointId(payload.nodeId, payload.scopeIdentifier),
      deviceName: payload.deviceName || 'IoT Device',
      deviceId: payload.deviceId || '',
      nodeId: payload.nodeId,
      scopeIdentifier: payload.scopeIdentifier,
      status: 'pending',
      connectionStatus: payload.connected ? 'connected' : 'disconnected',
      lastDataReceived: undefined,
      lastUpdatedBy: payload.userId,
      lastUpdatedAt: new Date()
    };
    if (existingIdx >= 0) {
      list[existingIdx] = {
        ...list[existingIdx],
        ...base,
        deviceId: base.deviceId || list[existingIdx].deviceId
      };
    } else list.push(base);
  }

  dip[type].inputs = list;
  client.updateInputPointCounts(type);
}

// Public helpers the routes will call
async function reflectSwitchInputTypeInClient({
  clientId,
  previousType,     // 'manual' | 'API' | 'IOT'
  newType,          // 'manual' | 'API' | 'IOT'
  nodeId,
  scopeIdentifier,
  connectionDetails,
  userId
}) {
  const client = await loadClientForPoints(clientId);
  if (!client) return;

  // 1) Remove from all lists (so we don't duplicate)
  removeFromAllTypes(client, nodeId, scopeIdentifier);

  // 2) Add to new bucket
  if (newType === 'manual') {
    upsertIntoType(client, 'manual', { nodeId, scopeIdentifier, userId });
  } else if (newType === 'API') {
    upsertIntoType(client, 'api', {
      nodeId,
      scopeIdentifier,
      userId,
      apiEndpoint: connectionDetails?.apiEndpoint || '',
      connected: !!connectionDetails?.isActive || !!connectionDetails?.apiStatus
    });
  } else if (newType === 'IOT') {
    upsertIntoType(client, 'iot', {
      nodeId,
      scopeIdentifier,
      userId,
      deviceId: connectionDetails?.deviceId || '',
      deviceName: connectionDetails?.deviceName || 'IoT Device',
      connected: !!connectionDetails?.isActive || !!connectionDetails?.iotStatus
    });
  }

  await client.save();
}

async function reflectDisconnectInClient({ clientId, nodeId, scopeIdentifier, inputType, userId }) {
  const client = await loadClientForPoints(clientId);
  if (!client) return;

  const dip = client.workflowTracking.dataInputPoints;

  if ((inputType || '').toUpperCase() === 'API') {
    const list = dip.api.inputs || [];
    const idx = list.findIndex(p => p.nodeId === nodeId && p.scopeIdentifier === scopeIdentifier);
    if (idx >= 0) {
      list[idx].connectionStatus = 'not_connected'; // API enum
      list[idx].lastUpdatedBy = userId;
      list[idx].lastUpdatedAt = new Date();
    } else {
      // create a stub record if it didn't exist
      upsertIntoType(client, 'api', {
        nodeId, scopeIdentifier, userId,
        apiEndpoint: '',
        connected: false
      });
    }
    dip.api.inputs = list;
    client.updateInputPointCounts('api');
  }

  if ((inputType || '').toUpperCase() === 'IOT') {
    const list = dip.iot.inputs || [];
    const idx = list.findIndex(p => p.nodeId === nodeId && p.scopeIdentifier === scopeIdentifier);
    if (idx >= 0) {
      list[idx].connectionStatus = 'disconnected'; // IoT enum
      list[idx].lastUpdatedBy = userId;
      list[idx].lastUpdatedAt = new Date();
    } else {
      upsertIntoType(client, 'iot', {
        nodeId, scopeIdentifier, userId,
        deviceId: '',
        deviceName: 'IoT Device',
        connected: false
      });
    }
    dip.iot.inputs = list;
    client.updateInputPointCounts('iot');
  }

  await client.save();
}

async function reflectReconnectInClient({ clientId, nodeId, scopeIdentifier, inputType, userId, endpoint, deviceId }) {
  const client = await loadClientForPoints(clientId);
  if (!client) return;

  if ((inputType || '').toUpperCase() === 'API') {
    upsertIntoType(client, 'api', {
      nodeId, scopeIdentifier, userId,
      apiEndpoint: endpoint || '',
      connected: true
    });
  }
  if ((inputType || '').toUpperCase() === 'IOT') {
    upsertIntoType(client, 'iot', {
      nodeId, scopeIdentifier, userId,
      deviceId: deviceId || '',
      deviceName: 'IoT Device',
      connected: true
    });
  }

  await client.save();
}



// Helper function to convert data to Map if needed
const ensureDataIsMap = (data) => {
  if (data instanceof Map) return data;
  if (typeof data === 'object' && data !== null) {
    return new Map(Object.entries(data));
  }
  throw new Error('Invalid data format: dataValues must be a key-value object');
};

// Enhanced helper function to check permissions with strict client isolation
const checkDataPermission = async (user, clientId, operation = 'read', nodeId = null, scopeIdentifier = null) => {
  const userId = user._id || user.id;
  if (!userId) return false;

  // Super admin has full access to all company data without any restriction
  if (user.userType === 'super_admin') return true;

  // Ensure the client exists
  const client = await Client.findOne({ clientId });
  if (!client) return false;

  // Consultant admin who created the client can access
  if (user.userType === 'consultant_admin') {
    if (client.leadInfo?.createdBy?.toString() === userId.toString()) {
      return true;
    }
    
    // Check if any of their consultants are assigned to this client
    const consultants = await User.find({
      consultantAdminId: userId,
      userType: 'consultant'
    }).select('_id');
    const consultantIds = consultants.map(c => c._id.toString());
    
    if (
      client.leadInfo?.assignedConsultantId &&
      consultantIds.includes(client.leadInfo.assignedConsultantId.toString())
    ) {
      return true;
    }
  }

  // Consultant assigned by consultant admin can access
  if (user.userType === 'consultant') {
    if (client.leadInfo?.assignedConsultantId?.toString() === userId.toString()) {
      return true;
    }
  }

  // Client-side permissions - STRICT CLIENT ISOLATION
  if (
    ['client_admin', 'client_employee_head', 'employee', 'auditor']
      .includes(user.userType)
  ) {
    // CRITICAL: Must be from same client organization - no cross-client access
    if (user.clientId !== clientId) {
      console.log(`Access denied: User from client ${user.clientId} trying to access client ${clientId} data`);
      return false;
    }

    // Client admin has full access to ONLY their own client data
    if (user.userType === 'client_admin') {
      return true;
    }

    // Employee head - restricted to assigned nodes only
    if (user.userType === 'client_employee_head') {
      // For general read without nodeId specified
      if (!nodeId && operation === 'read') {
        return true; // Will be filtered to show only their assigned nodes
      }
      
      // For specific node access
      if (nodeId) {
        const activeChart = await getActiveFlowchart(clientId);
if (!activeChart) {
  return res.status(404).json({ message: 'No active flowchart found' });
}
const flowchart = activeChart.chart;
        if (!flowchart) return false;

        const node = flowchart.nodes.find(n => n.id === nodeId);
        if (!node) return false;

        // Employee head can ONLY access data from their assigned node
        if (node.details.employeeHeadId?.toString() !== userId.toString()) {
          console.log(`Access denied: Employee head ${userId} not assigned to node ${nodeId}`);
          return false;
        }
        
        return true;
      }
    }

    // Employee - restricted to assigned scopes only
    if (user.userType === 'employee') {
      // Employees cannot view general data without specific scope assignment
      if (!nodeId || !scopeIdentifier) {
        // Allow general read for list views, but data will be filtered
        if (operation === 'read') {
          return true;
        }
        return false;
      }
      
      // Check scope assignment
      const activeChart = await getActiveFlowchart(clientId);
if (!activeChart) {
  return res.status(404).json({ message: 'No active flowchart found' });
}
const flowchart = activeChart.chart;
      if (!flowchart) return false;

      const node = flowchart.nodes.find(n => n.id === nodeId);
      if (!node) return false;

      const scope = node.details.scopeDetails.find(s => s.scopeIdentifier === scopeIdentifier);
      if (!scope) return false;

      const assignedEmployees = scope.assignedEmployees || [];
      const isAssigned = assignedEmployees.map(id => id.toString()).includes(userId.toString());
      
      if (!isAssigned) {
        console.log(`Access denied: Employee ${userId} not assigned to scope ${scopeIdentifier}`);
        return false;
      }
      
      return true;
    }

    // Auditors can read data from their client only
    if (user.userType === 'auditor' && operation === 'read') {
      return true;
    }
  }

  return false;
};

/**
 * Return all active charts for a client:
 * - Org Flowchart (isActive: true)
 * - Process Flowchart (not deleted)
 */
async function getChartsForPermission(clientId) {
  const results = [];

  const org = await Flowchart.findOne({ clientId, isActive: true }).lean();
  if (org) results.push({ type: 'flowchart', chart: org });

  const proc = await ProcessFlowchart.findOne({ clientId, isDeleted: false }).lean();
  if (proc) results.push({ type: 'processflowchart', chart: proc });

  return results;
}

/**
 * Build allocation sets from all available charts
 * - employeeHeads: Set of nodeIds this head owns
 * - employeeScopes: Set of "nodeId|scopeIdentifier" the employee is assigned to
 * - reductionScopes: Map reduction scopeId -> { nodeId, scopeIdentifier } from reductionMappings
 */
function buildAllocationMaps(charts, userId) {
  const headNodeIds = new Set();
  const employeeScopeKeys = new Set();
  const reductionScopeMap = new Map();

  for (const { type, chart } of charts) {
    if (!chart?.nodes) continue;

    for (const node of chart.nodes) {
      const details = node?.details || {};

      // Head allocations (node-level)
      if (details.employeeHeadId && details.employeeHeadId.toString() === userId.toString()) {
        headNodeIds.add(node.id);
      }

      // Employee allocations (scope-level)
      const scopes = Array.isArray(details.scopeDetails) ? details.scopeDetails : [];
      for (const s of scopes) {
        const assigned = (s.assignedEmployees || []).map(x => x?.toString());
        if (assigned.includes(userId.toString())) {
          employeeScopeKeys.add(`${node.id}|${s.scopeIdentifier}`);
        }
      }

      // Reduction mappings (if present)
      const mappings = Array.isArray(details.reductionMappings) ? details.reductionMappings : [];
      for (const r of mappings) {
        // r.id is any stable identifier used when inputType === 'reduction'
        if (r?.id && r.nodeId && r.scopeIdentifier) {
          reductionScopeMap.set(r.id, { nodeId: r.nodeId, scopeIdentifier: r.scopeIdentifier });
        }
      }
    }
  }

  return { headNodeIds, employeeScopeKeys, reductionScopeMap };
}

/**
 * Enforce permissions for WRITE-like operations.
 * Supported ops: 'manual_data', 'csv_upload', 'edit_manual', 'disconnect', 'reconnect'
 * Rules:
 *  - super_admin: allowed everywhere
 *  - client_admin (same client): allowed for manual/csv/edit; also allowed for disconnect/reconnect
 *  - client_employee_head: allowed to add/edit only for their allocated node(s)
 *  - employee: allowed to add/edit only for their allocated scope(s)
 *  - For inputType === 'reduction', (nodeId, scopeIdentifier) is resolved via reductionMappings
 *
 * @param {object} user
 * @param {string} clientId
 * @param {string} operation
 * @param {{nodeId?: string, scopeIdentifier?: string, inputType?: string}} ctx
 * @returns {{allowed: boolean, reason?: string}}
 */
// 🔒 Centralized permission gate for Data Collection operations
// Only creator Consultant Admin, assigned Consultant, or Super Admin can connect/reconnect/disconnect.
const checkOperationPermission = async (user, clientId, nodeId, scopeIdentifier, operation) => {
  try {
    const userId = user._id || user.id;

    if (!userId || !user.userType) {
      return { allowed: false, reason: 'Invalid user context' };
    }

    // Super Admin always allowed
    if (user.userType === 'super_admin') {
      return { allowed: true, reason: 'Super admin access' };
    }

    // We need client → createdBy & assignedConsultantId
    const client = await Client.findOne(
      { clientId },
      { 'leadInfo.createdBy': 1, 'leadInfo.assignedConsultantId': 1 }
    ).lean();

    if (!client) {
      return { allowed: false, reason: 'Client not found' };
    }

    const isCreatorConsultantAdmin =
      user.userType === 'consultant_admin' &&
      client.leadInfo?.createdBy &&
      client.leadInfo.createdBy.toString() === userId.toString();

    const isAssignedConsultant =
      user.userType === 'consultant' &&
      client.leadInfo?.assignedConsultantId &&
      client.leadInfo.assignedConsultantId.toString() === userId.toString();

    // 🔧 Ops that wire/unwire external sources
    const connectOps = new Set(['connect', 'reconnect', 'disconnect']);

    if (connectOps.has(operation)) {
      if (isCreatorConsultantAdmin) {
        return { allowed: true, reason: 'Creator consultant admin' };
      }
      if (isAssignedConsultant) {
        return { allowed: true, reason: 'Assigned consultant' };
      }
      // ❌ Nobody else (including client_admin / employee_* / viewer / auditor)
      return {
        allowed: false,
        reason:
          'Only Super Admin, the Consultant Admin who created the client, or the currently assigned Consultant can ' +
          operation
      };
    }

    // Default deny for other operations unless you explicitly allow them here
    return { allowed: false, reason: 'Insufficient permissions for this operation' };
  } catch (err) {
    console.error('checkOperationPermission error:', err);
    return { allowed: false, reason: 'Permission check failed' };
  }
};





// Get data with emissions
exports.getDataByUserNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    if (!clientId || !nodeId) {
      return res.status(400).json({ 
        message: 'Both clientId and nodeId are required in URL.' 
      });
    }

    const entries = await DataEntry
      .find({ clientId, nodeId })
      .sort({ timestamp: -1 }); // newest first

    return res.json({
      success: true,
      data: entries
    });
  } catch (err) {
    console.error('Error fetching DataEntry:', err);
    return res.status(500).json({ 
      success: false,
      message: 'Server error.',
      error: err.message
    });
  }
};


// Save API Data with cumulative tracking
// Save API Data with cumulative tracking
const saveAPIData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { data, date, time, dataValues, emissionFactor } = req.body;

    // Check permissions for API data operations
    // NOTE: Permission check is removed to allow direct data ingestion from API sources.

    // Validate prerequisites
    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation.isValid) {
      return res.status(400).json({
        message: 'Cannot process API data: ' + validation.message
      });
    }

    // Find scope configuration
    const activeChart = await getActiveFlowchart(clientId);
    if (!activeChart) {
      return res.status(404).json({ message: 'No active flowchart found' });
    }

    const flowchart = activeChart.chart;
    let scopeConfig = validation.scopeConfig;

    for (const node of flowchart.nodes) {
      if (node.id === nodeId) {
        const scope = node.details.scopeDetails.find(
          s => s.scopeIdentifier === scopeIdentifier
        );
        if (scope && scope.inputType === 'API') {
          scopeConfig = scope;
          break;
        }
      }
    }

    if (!scopeConfig) {
      return res.status(400).json({ message: 'Invalid API scope configuration' });
    }

    // ---- GATE: refuse API data when inactive ----
    const cfg = await DataCollectionConfig.findOne({ clientId, nodeId, scopeIdentifier }).lean();
    const apiGateActive = (cfg?.connectionDetails?.isActive ?? scopeConfig.apiStatus) === true;
    if (!apiGateActive) {
      return res.status(409).json({
        message: 'API connection is disabled. Data not accepted.',
        accepted: false,
        reason: 'connection_disabled',
        scopeIdentifier
      });
    }
    // ---- END GATE ----

    // Process date/time
    const rawDate = date || moment().format('DD/MM/YYYY');
    const rawTime = time || moment().format('HH:mm:ss');

    let dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
    if (!dateMoment.isValid()) {
      dateMoment = moment(rawDate, 'YYYY-MM-DD', true); // allow alternate format
    }

    const timeMoment = moment(rawTime, 'HH:mm:ss', true);
    if (!dateMoment.isValid() || !timeMoment.isValid()) {
      return res.status(400).json({ message: 'Invalid date/time format' });
    }

    const formattedDate = dateMoment.format('DD:MM:YYYY');
    const formattedTime = timeMoment.format('HH:mm:ss');

    const [day, month, year] = formattedDate.split(':').map(Number);
    const [hour, minute, second] = formattedTime.split(':').map(Number);
    const timestamp = new Date(year, month - 1, day, hour, minute, second);

    // Process API data into dataValues format
    const apiData = dataValues || data; // Check for dataValues first, then data
    const processedData = normalizeDataPayload(apiData, scopeConfig, 'API');

    // Ensure dataValues is a Map
    let dataMap;
    try {
      dataMap = ensureDataIsMap(processedData);
    } catch (error) {
      return res.status(400).json({
        message: 'Invalid format: Please update dataValues to be key-value structured for cumulative tracking.',
        error: error.message
      });
    }

    // Create entry (cumulative values will be calculated in pre-save hook)
    const entry = new DataEntry({
      clientId,
      nodeId,
      scopeIdentifier,
      scopeType: scopeConfig.scopeType,
      inputType: 'API',
      date: formattedDate,
      time: formattedTime,
      timestamp,
      dataValues: dataMap,
      emissionFactor: emissionFactor || scopeConfig.emissionFactor || '',
      sourceDetails: {
        apiEndpoint: scopeConfig.apiEndpoint,
        uploadedBy: req.user?._id, // Set to optional chaining
        dataSource: 'API'
      },
      isEditable: false,
      processingStatus: 'pending'
    });

    await entry.save();

    // Trigger emission calculation
    await triggerEmissionCalculation(entry);

    // Update collection config
    const collectionConfig = await DataCollectionConfig.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier },
      {
        $setOnInsert: {
          scopeType: scopeConfig.scopeType,
          inputType: 'API',
          createdBy: req.user?._id // Set to optional chaining
        }
      },
      { upsert: true, new: true }
    );

    collectionConfig.updateCollectionStatus(entry._id, timestamp);
    await collectionConfig.save();

    // after you save entry and have entry.calculatedEmissions populated:
    const {
      incoming: incomingMap,
      cumulative: cumulativeMap,
      metadata
    } = entry.calculatedEmissions || {};

    // helper to safely turn a Map into a POJO
    function mapToObject(m) {
      return m instanceof Map
        ? Object.fromEntries(m)
        : (m || {});
    }

    // ✅ NEW helper (safe object for response/emit)
    const dataEntryCumulative =
      entry.dataEntryCumulative
        ? {
            incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
            cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
            entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
            lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
          }
        : null;

    // Emit real-time update
    emitDataUpdate('api-data-saved', {
      clientId,
      nodeId,
      scopeIdentifier,
      dataId: entry._id,
      timestamp,
      dataValues: Object.fromEntries(entry.dataValues),
      cumulativeValues: Object.fromEntries(entry.cumulativeValues),
      highData: Object.fromEntries(entry.highData),
      lowData: Object.fromEntries(entry.lowData),
      lastEnteredData: Object.fromEntries(entry.lastEnteredData),

      // ✅ NEW: send dataEntryCumulative
      dataEntryCumulative,

      calculatedEmissions: {
        incoming: mapToObject(incomingMap),
        cumulative: mapToObject(cumulativeMap),
        metadata: metadata || {}
      }
    });

    // 🔁 NEW: push updated data-completion stats for this client
    if (global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(clientId);
    }

    res.status(201).json({
      message: 'API data saved successfully',
      dataId: entry._id,
      cumulativeValues: Object.fromEntries(entry.cumulativeValues),
      highData: Object.fromEntries(entry.highData),
      lowData: Object.fromEntries(entry.lowData),
      lastEnteredData: Object.fromEntries(entry.lastEnteredData),

      // ✅ NEW: return dataEntryCumulative
      dataEntryCumulative,

      calculatedEmissions: {
        incoming: mapToObject(incomingMap),
        cumulative: mapToObject(cumulativeMap),
        metadata: metadata || {}
      }
    });
  } catch (error) {
    console.error('Save API data error:', error);
    res.status(500).json({
      message: 'Failed to save API data',
      error: error.message
    });
  }
};



// Save IoT Data with cumulative tracking
// Save IoT Data with cumulative tracking
const saveIoTData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { data, date, time, dataValues, emissionFactor } = req.body;

    // 1) Permission check
    // NOTE: Permission check is removed to allow direct data ingestion from IoT devices.

    // 2) Validate prerequisites
    const validation = await validateEmissionPrerequisites(
      clientId, nodeId, scopeIdentifier
    );
    if (!validation.isValid) {
      return res.status(400).json({
        message: 'Cannot process IoT data: ' + validation.message
      });
    }
    let scopeConfig = validation.scopeConfig;

    // 3) Locate the exact scopeConfig from the flowchart (to pick up iotDeviceId, etc.)
    const activeChart = await getActiveFlowchart(clientId);
    if (!activeChart) {
      return res.status(404).json({ message: 'No active flowchart found' });
    }
    const flowchart = activeChart.chart;
    for (const node of flowchart.nodes) {
      if (node.id === nodeId) {
        const scope = node.details.scopeDetails.find(
          s => s.scopeIdentifier === scopeIdentifier && s.inputType === 'IOT'
        );
        if (scope) {
          scopeConfig = scope;
          break;
        }
      }
    }
    if (!scopeConfig) {
      return res.status(400).json({ message: 'Invalid IoT scope configuration' });
    }

    // ---- GATE: refuse IoT data when inactive ----
    const cfg = await DataCollectionConfig.findOne({ clientId, nodeId, scopeIdentifier }).lean();
    const iotGateActive = (cfg?.connectionDetails?.isActive ?? scopeConfig.iotStatus) === true;
    if (!iotGateActive) {
      return res.status(409).json({
        message: 'iotStatus connection is disabled. Data not accepted.',
        accepted: false,
        reason: 'connection_disabled',
        scopeIdentifier
      });
    }
    // ---- END GATE ----

    // 4) Normalize incoming IoT payload
    const iotData = dataValues || data;
    const processedData = normalizeDataPayload(iotData, scopeConfig, 'IOT');

    // 5) Handle date/time
    const rawDate = date || moment().format('DD/MM/YYYY');
    const rawTime = time || moment().format('HH:mm:ss');
    const dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
    const timeMoment = moment(rawTime, 'HH:mm:ss', true);
    if (!dateMoment.isValid() || !timeMoment.isValid()) {
      return res.status(400).json({ message: 'Invalid date/time format' });
    }
    const formattedDate = dateMoment.format('DD:MM:YYYY');
    const formattedTime = timeMoment.format('HH:mm:ss');
    const [day, month, year] = formattedDate.split(':').map(Number);
    const [hour, minute, second] = formattedTime.split(':').map(Number);
    const timestamp = new Date(year, month - 1, day, hour, minute, second);

    // 6) Ensure processedData is a Map for cumulative tracking
    let dataMap;
    try {
      dataMap = ensureDataIsMap(processedData);
    } catch (err) {
      return res.status(400).json({
        message: 'Invalid format: Please provide key-value structured IoT data.',
        error: err.message
      });
    }

    // 7) Persist the entry
    const entry = new DataEntry({
      clientId,
      nodeId,
      scopeIdentifier,
      scopeType: scopeConfig.scopeType,
      inputType: 'IOT',
      date: formattedDate,
      time: formattedTime,
      timestamp,
      dataValues: dataMap,
      emissionFactor: emissionFactor || scopeConfig.emissionFactor || '',
      sourceDetails: {
        iotDeviceId: scopeConfig.iotDeviceId,
        uploadedBy: req.user?._id, // optional chaining
        dataSource: 'IOT'
      },
      isEditable: false,
      processingStatus: 'pending'
    });
    await entry.save();

    // 8) Trigger your calculation pipeline
    await triggerEmissionCalculation(entry);

    // 9) Upsert collection config
    const collectionConfig = await DataCollectionConfig.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier },
      {
        $setOnInsert: {
          scopeType: scopeConfig.scopeType,
          inputType: 'IOT',
          createdBy: req.user?._id // optional chaining
        }
      },
      { upsert: true, new: true }
    );
    collectionConfig.updateCollectionStatus(entry._id, timestamp);
    await collectionConfig.save();

    // 10) Prepare calculated emissions for response
    const { incoming: inMap, cumulative: cumMap, metadata } = entry.calculatedEmissions || {};
    const mapToObject = m => (m instanceof Map ? Object.fromEntries(m) : (m || {}));

    // ✅ NEW: attach dataEntryCumulative (already computed by model pre-save hook)
    const dataEntryCumulative =
      entry.dataEntryCumulative
        ? {
            incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
            cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
            entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
            lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
          }
        : null;

    // 11) Emit a real-time update
    emitDataUpdate('iot-data-saved', {
      clientId,
      nodeId,
      scopeIdentifier,
      dataId: entry._id,
      timestamp,
      dataValues: Object.fromEntries(entry.dataValues),
      cumulativeValues: Object.fromEntries(entry.cumulativeValues),
      highData: Object.fromEntries(entry.highData),
      lowData: Object.fromEntries(entry.lowData),
      lastEnteredData: Object.fromEntries(entry.lastEnteredData),

      // ✅ NEW: emit dataEntryCumulative
      dataEntryCumulative,

      calculatedEmissions: {
        incoming: mapToObject(inMap),
        cumulative: mapToObject(cumMap),
        metadata: metadata || {}
      }
    });

    // 🔁 push updated data-completion stats for this client
    if (global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(clientId);
    }

    // 12) Response
    res.status(201).json({
      message: 'IoT data saved successfully',
      dataId: entry._id,
      cumulativeValues: Object.fromEntries(entry.cumulativeValues),
      highData: Object.fromEntries(entry.highData),
      lowData: Object.fromEntries(entry.lowData),
      lastEnteredData: Object.fromEntries(entry.lastEnteredData),

      // ✅ NEW: return dataEntryCumulative
      dataEntryCumulative,

      calculatedEmissions: {
        incoming: mapToObject(inMap),
        cumulative: mapToObject(cumMap),
        metadata: metadata || {}
      }
    });

  } catch (error) {
    console.error('Save IoT data error:', error);
    res.status(500).json({
      message: 'Failed to save IoT data',
      error: error.message
    });
  }
};






// ─────────────────────────────────────────────────────────────────────────────
// SAVE MANUAL DATA + UPLOAD CSV DATA  (with new role rules)
// ─────────────────────────────────────────────────────────────────────────────

// Accept both { a:1, b:2 } and { dataValues:{ a:1, b:2 }, date, time, emissionFactor }
function unwrapDataRow(row = {}) {
  if (row && typeof row === 'object' && row.dataValues && typeof row.dataValues === 'object') {
    const { dataValues, date, Date, time, Time, timestamp, emissionFactor, EF, ef } = row;
    return {
      ...(dataValues || {}),
      // keep common meta fields if provided at top-level
      date: date ?? Date,
      time: time ?? Time,
      timestamp,
      emissionFactor: emissionFactor ?? EF ?? ef
    };
  }
  return row;
}



// Ensures we never store '' in DataEntry.emissionFactor.
// Maps common variants and defaults to 'Custom' if blank.
function resolveEmissionFactor(entryEF, scopeEF) {
  const norm = v => (typeof v === 'string' ? v.trim() : '');

  let v = norm(entryEF) || norm(scopeEF);

  // Canonicalize known values (case-insensitive → enum-safe)
  const map = {
    ipcc: 'IPCC',
    defra: 'DEFRA',
    epa: 'EPA',
    emissionfactorhub: 'EmissionFactorHub', // IMPORTANT: enum-safe casing
    country: 'Country',
    custom: 'Custom'
  };
  if (v) {
    const k = v.toLowerCase();
    if (map[k]) v = map[k];
  }

  // Final guard
  return v || 'Custom';
}


/**
 * Find node & scope from Flowchart or ProcessFlowchart
 */
async function findNodeAndScope(clientId, nodeId, scopeIdentifier) {
  // 1) Try active organizational Flowchart
  let chart = await Flowchart.findOne({ clientId, isActive: true }).lean();
  if (chart && Array.isArray(chart.nodes)) {
    const node = chart.nodes.find(n => n.id === nodeId);
    if (node) {
      const scope = (node.details?.scopeDetails || []).find(s => s.scopeIdentifier === scopeIdentifier);
      if (scope) return { chartType: 'flowchart', chart, node, scope };
    }
  }

  // 2) Fallback: ProcessFlowchart (latest not-deleted)
  const pChart = await ProcessFlowchart.findOne({ clientId, isDeleted: { $ne: true } }).lean();
  if (pChart && Array.isArray(pChart.nodes)) {
    const node = pChart.nodes.find(n => n.id === nodeId);
    if (node) {
      const scope = (node.details?.scopeDetails || []).find(s => s.scopeIdentifier === scopeIdentifier);
      if (scope) return { chartType: 'processflowchart', chart: pChart, node, scope };
    }
  }

  return null;
}

/**
 * New permission gate for Manual / CSV writes (strict client isolation)
 * - super_admin: allowed
 * - consultant_admin: allowed if they created the lead OR any of their consultants is assigned to this client
 * - consultant: allowed if assigned to this client
 * - client_admin: allowed for their own client
 * - client_employee_head: allowed ONLY if assigned to the node (node.details.employeeHeadId)
 * - employee: allowed ONLY if part of scope.assignedEmployees
 * - auditor/viewer: not allowed
 */
async function canWriteManualOrCSV(user, clientId, node, scope) {
  const userId = (user._id || user.id || '').toString();

  // super admin
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin' };
  }

  // All client-side roles must match the same client
  const isSameClient = user.clientId && user.clientId === clientId;

  // Load client to check consultant assignments/relationships
  const client = await Client.findOne({ clientId }).select('leadInfo workflowTracking stage').lean();

  if (!client) return { allowed: false, reason: 'Client not found' };

  // consultant_admin
  if (user.userType === 'consultant_admin') {
    const createdBy = client.leadInfo?.createdBy?.toString();
    if (createdBy && createdBy === userId) {
      return { allowed: true, reason: 'Consultant admin who created client' };
    }
    // check any consultant under this admin is assigned
    const consultants = await User.find({ consultantAdminId: userId, userType: 'consultant', isActive: true })
                                  .select('_id').lean();
    const subIds = new Set(consultants.map(c => c._id.toString()));
    const assigned = client.leadInfo?.assignedConsultantId?.toString();
    if (assigned && subIds.has(assigned)) {
      return { allowed: true, reason: 'Client assigned to consultant under this admin' };
    }
    return { allowed: false, reason: 'Consultant admin not related to this client' };
  }

  // consultant
  if (user.userType === 'consultant') {
    const assigned = client.leadInfo?.assignedConsultantId?.toString();
    if (assigned && assigned === userId) {
      return { allowed: true, reason: 'Assigned consultant' };
    }
    return { allowed: false, reason: 'Consultant not assigned to this client' };
  }

  // client_admin (MUST be same client)
  if (user.userType === 'client_admin') {
    if (isSameClient) return { allowed: true, reason: 'Client admin (same client)' };
    return { allowed: false, reason: 'Client admin from different client' };
  }

  // client_employee_head — only node they head
  if (user.userType === 'client_employee_head') {
    if (!isSameClient) return { allowed: false, reason: 'Employee head from different client' };
    const headId = (node?.details?.employeeHeadId || '').toString();
    if (headId && headId === userId) return { allowed: true, reason: 'Assigned employee head for node' };
    return { allowed: false, reason: 'Employee head not assigned to this node' };
  }

  // employee — only if scope.assignedEmployees includes them
  if (user.userType === 'employee') {
    if (!isSameClient) return { allowed: false, reason: 'Employee from different client' };
    const arr = Array.isArray(scope?.assignedEmployees) ? scope.assignedEmployees.map(x => x.toString()) : [];
    if (arr.includes(userId)) return { allowed: true, reason: 'Employee assigned to this scope' };
    return { allowed: false, reason: 'Employee not assigned to this scope' };
  }

  // viewer / auditor — no write
  return { allowed: false, reason: 'Role not permitted for write' };
}

/**
 * Converts a plain object to a Map of numbers (DataEntry requires numeric values)
 */
const toNumericMap = (obj = {}) => {
  const m = new Map();
  Object.entries(obj).forEach(([k, v]) => {
    const n = Number(v);
    m.set(k, Number.isFinite(n) ? n : 0);
  });
  return m;
};
function getKeyCI(obj, wanted) {
  if (!obj) return undefined;
  const key = Object.keys(obj).find(k => String(k).trim().toLowerCase() === wanted.toLowerCase());
  return key ? obj[key] : undefined;
}

function normalizeDateStr(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (s.includes("-")) return s.replace(/-/g, "/"); // DD-MM-YYYY -> DD/MM/YYYY
  return s;
}

function normalizeTimeStr(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).trim().split(":").map(v => parseInt(v, 10));
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const s = parts[2] ?? 0;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}


const IST_OFFSET_MINUTES = 330; // +05:30

function pad2(n) {
  return String(n).padStart(2, "0");
}

function trimKeys(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of Object.keys(obj)) out[String(k).trim()] = obj[k];
  return out;
}

function normalizeDateInput(dateStr) {
  if (!dateStr) return null;
  let s = String(dateStr).trim();

  // remove hidden CR/LF
  s = s.replace(/\r|\n/g, "");

  // allow DD:MM:YYYY, DD-MM-YYYY, DD.MM.YYYY
  s = s.replace(/[.\-:]/g, "/");

  return s;
}

function normalizeTimeInput(timeStr) {
  if (!timeStr) return null;
  let s = String(timeStr).trim().replace(/\r|\n/g, "");
  s = s.replace(/[.]/g, ":");

  const parts = s.split(":").map((x) => parseInt(x, 10));
  const h = Number.isFinite(parts[0]) ? parts[0] : 0;
  const m = Number.isFinite(parts[1]) ? parts[1] : 0;
  const sec = Number.isFinite(parts[2]) ? parts[2] : 0;

  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

// Build absolute UTC Date from an IST wall-clock date+time
function buildISTTimestamp(dateStr, timeStr) {
  const d = normalizeDateInput(dateStr);
  const t = normalizeTimeInput(timeStr);
  if (!d || !t) return null;

  const parts = d.split("/");
  if (parts.length !== 3) return null;

  let day, month, year;

  // YYYY/MM/DD
  if (parts[0].length === 4) {
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    day = parseInt(parts[2], 10);
  } else {
    // DD/MM/YYYY (your expected format)
    day = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    year = parseInt(parts[2], 10);
  }

  if (!day || !month || !year) return null;

  const [hh, mm, ss] = t.split(":").map((x) => parseInt(x, 10) || 0);

  // interpret given wall-clock as IST, store UTC instant
  const utcMs =
    Date.UTC(year, month - 1, day, hh, mm, ss) - IST_OFFSET_MINUTES * 60 * 1000;

  return new Date(utcMs);
}

function parseRowDateTimeOrNowIST(row = {}) {
  const r = trimKeys(row);

  const rawDate =
    r.date ?? r.Date ?? r.DATE ?? (r.dataValues ? r.dataValues.date : null);
  const rawTime =
    r.time ?? r.Time ?? r.TIME ?? (r.dataValues ? r.dataValues.time : null);

  const rawTs = r.timestamp ?? r.Timestamp ?? r.TIMESTAMP ?? null;

  // 1) If timestamp was provided directly
  if (rawTs) {
    const dt = new Date(rawTs);
    if (!isNaN(dt.getTime())) {
      // still normalize date/time fields to your preferred storage
      const ist = new Date(dt.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
      const dd = pad2(ist.getUTCDate());
      const mm = pad2(ist.getUTCMonth() + 1);
      const yy = ist.getUTCFullYear();
      const hh = pad2(ist.getUTCHours());
      const mi = pad2(ist.getUTCMinutes());
      const ss = pad2(ist.getUTCSeconds());
      return {
        date: `${dd}/${mm}/${yy}`,
        time: `${hh}:${mi}:${ss}`,
        timestamp: dt
      };
    }
  }

  // 2) Build from date + time
  const computed = buildISTTimestamp(rawDate, rawTime);
  if (!computed) {
    // fallback to NOW in IST (only when truly missing/invalid)
    const now = new Date();
    return {
      date: `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`,
      time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
      timestamp: now
    };
  }

  // Keep storage consistent
  const dNorm = normalizeDateInput(rawDate).replace(/[.\-:]/g, "/");
  const tNorm = normalizeTimeInput(rawTime);

  // if date was YYYY/MM/DD convert to DD/MM/YYYY for storage
  const parts = dNorm.split("/");
  let storedDate = dNorm;
  if (parts[0].length === 4) storedDate = `${pad2(parts[2])}/${pad2(parts[1])}/${parts[0]}`;

  return { date: storedDate, time: tNorm, timestamp: computed };
}




/**
 * Store one data row as DataEntry and trigger emission calculation
 */
async function saveOneEntry({
  req, clientId, nodeId, scopeIdentifier, scope, node, inputSource, row,
  csvMeta = null
}) {
  // ✅ IMPORTANT: unwrap first so date/time can be read even if inside { dataValues: {...} }
  const rawRow = unwrapDataRow(row || {});
  const when = parseRowDateTimeOrNowIST(rawRow);

  // Normalize payload per scope config
  const pd = normalizeDataPayload(rawRow || {}, scope, inputSource === 'CSV' ? 'CSV' : 'MANUAL');

  // ✅ Prevent meta keys ever getting stored as emission variables
  delete pd.date;
  delete pd.time;
  delete pd.timestamp;

  const entry = new DataEntry({
    clientId,
    nodeId,
    scopeIdentifier,
    scopeType: scope.scopeType,
    inputType: 'manual', // CSV also stored as manual
    date: when.date,
    time: when.time,
    timestamp: when.timestamp,
    dataValues: toNumericMap(pd),
    sourceDetails: {
      uploadedBy: req.user._id || req.user.id,
      ...(inputSource === 'CSV'
        ? { fileName: csvMeta?.fileName || '', dataSource: 'csv' }
        : { dataSource: 'manual' })
    },
    processingStatus: 'pending',
    emissionCalculationStatus: 'pending',
    emissionFactor: resolveEmissionFactor(rawRow?.emissionFactor, scope?.emissionFactor),
  });

 await entry.save();
    const calcResult = await triggerEmissionCalculation(entry);

    // ── NEW: Propagate emission to ProcessFlowchart nodes ───────────────────
    // Reload the entry from DB so calculatedEmissions is fully populated after
    // triggerEmissionCalculation (which updates the entry in-place via .save()).
    // We use setImmediate to let the response return first, keeping latency low.
    //
    // IMPORTANT: updateSummariesOnDataChange is called a SECOND time here,
    // AFTER createProcessEmissionDataEntry saves the allocated records.
    // The first call (inside triggerEmissionCalculation) runs before those
    // records exist, so ProcessEmissionSummary Strategy A always finds 0 entries
    // and falls back to Strategy B (unallocated values).
    // This second call guarantees Strategy A finds the ProcessEmissionDataEntry
    // records and uses the correct pre-computed allocated CO2e values.
    setImmediate(async () => {
      try {
        const freshEntry = await require('../../models/Organization/DataEntry')
          .findById(entry._id).lean();
        if (freshEntry && freshEntry.calculatedEmissions) {
          await createProcessEmissionDataEntry(freshEntry);
          // ✅ Re-trigger summaries now that ProcessEmissionDataEntry records exist.
          // Strategy A in buildProcessEmissionSummary will now find and use
          // the pre-computed allocated values (e.g. 4.788 instead of 15.96).
          console.log(`📊 [saveOneEntry] Re-triggering summary updates after ProcessEmission propagation for: ${freshEntry._id}`);
          await updateSummariesOnDataChange(freshEntry);
          console.log(`✅ [saveOneEntry] Summary updates completed with allocated process emissions.`);
        }
      } catch (e) {
        console.error('[saveOneEntry] ProcessEmission propagation failed:', e.message);
      }
    });
    // ────────────────────────────────────────────────────────────────────────

    return { entry, calcResult };
  }




/**
 * POST /api/data-collection/manual/:clientId/:nodeId/:scopeIdentifier
 * Body supports:
 *  - { singleEntry: {...} }
 *  - { entries: [ {...}, {...} ] }
 * Compatible with your earlier "entries" multi-payload format.
 */
/**
 * POST /api/data-collection/manual/:clientId/:nodeId/:scopeIdentifier
 * Body supports:
 *  - { singleEntry: {...} }
 *  - { entries: [ {...}, {...} ] }
 * Compatible with your earlier "entries" multi-payload format.
 */
const saveManualData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { entries, singleEntry } = req.body || {};

    // ✅ helper: safe normalize for response (does NOT change model save logic)
    const toDataEntryCumulative = (dec) => {
      if (!dec) return null;
      return {
        incomingTotalValue: Number(dec.incomingTotalValue || 0),
        cumulativeTotalValue: Number(dec.cumulativeTotalValue || 0),
        entryCount: Number(dec.entryCount || 0),
        lastUpdatedAt: dec.lastUpdatedAt || null
      };
    };

    // Locate chart/node/scope
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({
        success: false,
        message: 'Node/scope not found in flowchart or process flowchart'
      });
    }
    const { node, scope } = located;

    // Permission
    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied',
        reason: perm.reason
      });
    }

    // Validate prerequisites before accepting data
    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation?.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Emission prerequisites are not satisfied for this scope',
        issues: validation?.issues || []
      });
    }

    // Normalize inputs into an array of rows
    const rows = Array.isArray(entries)
      ? entries
      : (singleEntry ? [singleEntry] : [req.body]); // backward compatibility for old shape

    const saved = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      try {
        const { entry, calcResult } = await saveOneEntry({
          req,
          clientId,
          nodeId,
          scopeIdentifier,
          scope,
          node,
          inputSource: 'MANUAL',
          row: rows[i]
        });

        saved.push({
          dataEntryId: entry._id,
          emissionCalculationStatus: entry.emissionCalculationStatus,
          calculatedEmissions: entry.calculatedEmissions || null,
          calculationResponse: calcResult?.data || null,

          // ✅ NEW: include dataEntryCumulative for each saved entry
          dataEntryCumulative: toDataEntryCumulative(entry.dataEntryCumulative)
        });
      } catch (err) {
        errors.push({ index: i, error: err.message });
      }
    }

    // 🔁 NEW: only broadcast if we actually saved something
    if (saved.length > 0 && global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(clientId);
    }

    const ok = errors.length === 0;

    // ✅ NEW: also return latest cumulative snapshot (from last saved entry)
    const latestDataEntryCumulative =
      saved.length > 0 ? saved[saved.length - 1].dataEntryCumulative : null;

    return res.status(ok ? 201 : (saved.length ? 207 : 400)).json({
      success: ok,
      message: ok
        ? 'Manual data saved'
        : (saved.length ? 'Manual data partially saved' : 'Manual data failed'),
      savedCount: saved.length,
      failedCount: errors.length,
      results: saved,
      errors,

      // ✅ NEW: top-level latest snapshot (easy for frontend)
      dataEntryCumulative: latestDataEntryCumulative
    });
  } catch (error) {
    console.error('saveManualData error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};



/**
 * POST /api/data-collection/csv/:clientId/:nodeId/:scopeIdentifier
 *
 * ACCEPTS:
 *  - multipart CSV (memory multer → req.file.buffer)
 *  - raw CSV text (req.body.csvText)
 *  - parsed JSON rows (req.body.rows)
 *
 * ✅ Uploads ORIGINAL payload to S3:
 *    clientId/nodeId/scopeIdentifier/{timestamp}_{fileName}
 *
 * ❌ No local disk usage
 * ❌ No temp files
 */
/**
 * POST /api/data-collection/csv/:clientId/:nodeId/:scopeIdentifier
 *
 * ACCEPTS:
 *  - multipart CSV (memory multer → req.file.buffer)
 *  - raw CSV text (req.body.csvText)
 *  - parsed JSON rows (req.body.rows)
 *
 * ✅ Uploads ORIGINAL payload to S3:
 *    clientId/nodeId/scopeIdentifier/{timestamp}_{fileName}
 *
 * ❌ No local disk usage
 * ❌ No temp files
 */
const uploadCSVData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    // ✅ helper: normalize dataEntryCumulative safely for response
    // (model pre-save hook already SAVES it; this just RETURNS it)
    const toDataEntryCumulative = (dec) => {
      if (!dec) return null;
      return {
        incomingTotalValue: Number(dec.incomingTotalValue || 0),
        cumulativeTotalValue: Number(dec.cumulativeTotalValue || 0),
        entryCount: Number(dec.entryCount || 0),
        lastUpdatedAt: dec.lastUpdatedAt || null
      };
    };

    /* -------------------------------------------------- */
    /* 1) Locate node + scope                              */
    /* -------------------------------------------------- */
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({
        success: false,
        message: 'Node/scope not found in flowchart or process flowchart'
      });
    }

    const { node, scope } = located;

    /* -------------------------------------------------- */
    /* 2) Permission                                      */
    /* -------------------------------------------------- */
    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied',
        reason: perm.reason
      });
    }

    /* -------------------------------------------------- */
    /* 3) Emission prerequisite validation                */
    /* -------------------------------------------------- */
    const validation = await validateEmissionPrerequisites(
      clientId,
      nodeId,
      scopeIdentifier
    );

    if (!validation?.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Emission prerequisites are not satisfied for this scope',
        issues: validation?.issues || []
      });
    }

    /* -------------------------------------------------- */
    /* 4) Parse input & prepare ORIGINAL payload           */
    /* -------------------------------------------------- */
    let rows = [];
    let fileName = 'uploaded.csv';
    let rawBuffer = null;
    let rawContentType = 'text/csv';

    /* ---------- CASE A: Multipart CSV (memory) ---------- */
    if (req.file?.buffer) {
      fileName = req.file.originalname || 'uploaded.csv';
      rawBuffer = req.file.buffer;

      rows = await csvtojson().fromString(
        req.file.buffer.toString('utf8')
      );

      /* ---------- CASE B: Raw CSV text ---------- */
    } else if (req.body?.csvText) {
      fileName = req.body.fileName || 'uploaded.csv';
      rawBuffer = Buffer.from(String(req.body.csvText), 'utf8');

      rows = await csvtojson().fromString(req.body.csvText);

      /* ---------- CASE C: JSON rows ---------- */
    } else if (Array.isArray(req.body?.rows)) {
      fileName = req.body.fileName || 'rows.json';
      rawContentType = 'application/json';

      rawBuffer = Buffer.from(
        JSON.stringify(req.body.rows, null, 2),
        'utf8'
      );

      rows = req.body.rows;
    } else {
      return res.status(400).json({
        success: false,
        message: 'CSV data not found. Provide multipart file, csvText, or rows[]'
      });
    }

    /* -------------------------------------------------- */
    /* 5) Upload ORIGINAL payload to S3                    */
    /* -------------------------------------------------- */
    const s3Upload = await uploadOrganisationCSVCreate({
      clientId,
      nodeId,
      scopeIdentifier,
      fileName,
      buffer: rawBuffer,
      contentType: rawContentType
    });

    /* -------------------------------------------------- */
    /* 6) Save rows → DataEntry + calculation              */
    /* -------------------------------------------------- */
    const saved = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      try {
        const { entry, calcResult } = await saveOneEntry({
          req,
          clientId,
          nodeId,
          scopeIdentifier,
          scope,
          node,
          inputSource: 'CSV',
          row: rows[i],
          csvMeta: {
            fileName,
            s3: s3Upload
          }
        });

        saved.push({
          rowNumber: i + 1,
          dataEntryId: entry._id,
          emissionCalculationStatus: entry.emissionCalculationStatus,
          calculatedEmissions: entry.calculatedEmissions || null,
          calculationResponse: calcResult?.data || null,

          // ✅ NEW: include dataEntryCumulative per saved row
          dataEntryCumulative: toDataEntryCumulative(entry.dataEntryCumulative)
        });
      } catch (err) {
        errors.push({
          row: i + 1,
          error: err.message
        });
      }
    }

    /* -------------------------------------------------- */
    /* 7) Broadcast completion                             */
    /* -------------------------------------------------- */
    if (saved.length > 0 && global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(clientId);
    }

    const ok = errors.length === 0;

    // ✅ NEW: latest cumulative snapshot (last saved entry)
    const latestDataEntryCumulative =
      saved.length > 0 ? saved[saved.length - 1].dataEntryCumulative : null;

    return res.status(ok ? 201 : saved.length ? 207 : 400).json({
      success: ok,
      message: ok
        ? `CSV processed: ${saved.length} rows saved`
        : `CSV partially processed: ${saved.length} saved, ${errors.length} errors`,
      fileName,

      /* ✅ S3 info returned */
      s3: {
        bucket: s3Upload.bucket,
        key: s3Upload.key,
        etag: s3Upload.etag
      },

      savedCount: saved.length,
      failedCount: errors.length,
      results: saved,
      errors,

      // ✅ NEW: top-level snapshot for frontend
      dataEntryCumulative: latestDataEntryCumulative
    });

  } catch (error) {
    console.error('uploadCSVData error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};



// // Save Manual Data Entry (with support for multiple entries with different dates)
// const saveManualData = async (req, res) => {
//   try {
//     const { clientId, nodeId, scopeIdentifier } = req.params;
//     const { entries, singleEntry } = req.body; // Support both formats
    
//     // Check permissions for manual data operations
//     const permissionCheck = await checkOperationPermission(
//   req.user,
//   clientId,
//   'manual_data',
//   { nodeId, scopeIdentifier, inputType: 'manual' }
// );

//     if (!permissionCheck.allowed) {
//       return res.status(403).json({ 
//         message: 'Permission denied', 
//         reason: permissionCheck.reason 
//       });
//     }
    
//     // Find scope configuration
//       const activeChart = await getActiveFlowchart(clientId);
//       if (!activeChart) {
//         return res.status(404).json({ message: 'No active flowchart found' });
//       }
//       const flowchart = activeChart.chart;
    
//     // Validate prerequisites
//     const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
//     if (!validation.isValid) {
//       return res.status(400).json({
//         message: 'Cannot process manual data: ' + validation.message
//       });
//     }
    
//     let scopeConfig = validation.scopeConfig;
//     for (const node of flowchart.nodes) {
//       if (node.id === nodeId) {
//         const scope = node.details.scopeDetails.find(
//           s => s.scopeIdentifier === scopeIdentifier
//         );
//         if (scope && scope.inputType === 'manual') {
//           scopeConfig = scope;
//           break;
//         }
//       }
//     }
    
//     if (!scopeConfig) {
//       return res.status(400).json({ message: 'Invalid manual scope configuration' });
//     }
    
//     // Handle both single entry and multiple entries format
//     let dataEntries = [];
    
//     // Check if it's a single entry (backward compatibility)
//     if (singleEntry || (!entries && req.body.dataValues)) {
//       dataEntries = [{
//         date: req.body.date,
//         time: req.body.time,
//         dataValues: req.body.dataValues,
//         emissionFactor: req.body.emissionFactor
//       }];
//     } else if (entries && Array.isArray(entries)) {
//       // Multiple entries format
//       dataEntries = entries;
//     } else {
//       return res.status(400).json({ 
//         message: 'Invalid request format. Expected either entries array or single entry data.' 
//       });
//     }
    
//     // Validate that we have at least one entry
//     if (dataEntries.length === 0) {
//       return res.status(400).json({ message: 'No data entries provided' });
//     }
    
//     // Process and validate each entry
//     const processedEntries = [];
//     const validationErrors = [];
    
//     for (let index = 0; index < dataEntries.length; index++) {
//       const entryData = dataEntries[index];
//       const { date: rawDateInput, time: rawTimeInput, dataValues, emissionFactor } = entryData;

//       // Conditionally require date and time for multiple entries
//       if (dataEntries.length > 1 && (!rawDateInput || !rawTimeInput)) {
//         validationErrors.push({
//           index,
//           error: 'Date and time are required for each entry when adding multiple entries.'
//         });
//         continue;
//       }
      
//       // Validate required fields
//       if (!dataValues || Object.keys(dataValues).length === 0) {
//         validationErrors.push({
//           index,
//           date: rawDateInput,
//           error: 'Data values are required'
//         });
//         continue;
//       }
      
//       // Process date/time, defaulting to current IST if not provided for single entries
//       const nowInIST = moment().utcOffset('+05:30');
//       const rawDate = rawDateInput || nowInIST.format('DD/MM/YYYY');
//       const rawTime = rawTimeInput || nowInIST.format('HH:mm:ss');
      
//       let dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
//       if (!dateMoment.isValid()) {
//         dateMoment = moment(rawDate, 'YYYY-MM-DD', true); // allow alternate format
//       }
//       const timeMoment = moment(rawTime, 'HH:mm:ss', true);
      
//       if (!dateMoment.isValid()) {
//         validationErrors.push({
//           index,
//           date: rawDateInput,
//           error: 'Invalid date format. Use DD/MM/YYYY or YYYY-MM-DD'
//         });
//         continue;
//       }
      
//       if (!timeMoment.isValid()) {
//         validationErrors.push({
//           index,
//           date: rawDateInput,
//           error: 'Invalid time format. Use HH:mm:ss'
//         });
//         continue;
//       }
      
//       const formattedDate = dateMoment.format('DD:MM:YYYY');
//       const formattedTime = timeMoment.format('HH:mm:ss');
      
//       const [day, month, year] = formattedDate.split(':').map(Number);
//       const [hour, minute, second] = formattedTime.split(':').map(Number);
//       const timestamp = new Date(year, month - 1, day, hour, minute, second);
      
//       // Check for duplicate timestamps
//       const isDuplicate = processedEntries.some(entry => 
//         entry.timestamp.getTime() === timestamp.getTime()
//       );
      
//       if (isDuplicate) {
//         validationErrors.push({
//           index,
//           date: rawDateInput,
//           error: 'Duplicate timestamp. Each entry must have a unique date/time combination.'
//         });
//         continue;
//       }
      
//       // Normalize & ensure dataValues is a Map
//       let dataMap;
//       try {
//         const processedData = normalizeDataPayload(dataValues, scopeConfig, 'MANUAL');
//         dataMap = ensureDataIsMap(processedData);
//       } catch (error) {
//         validationErrors.push({
//           index,
//           date: rawDateInput,
//           error: 'Invalid data format: ' + error.message
//         });
//         continue;
//       }
      
//       processedEntries.push({
//         clientId,
//         nodeId,
//         scopeIdentifier,
//         scopeType: scopeConfig.scopeType,
//         inputType: 'manual',
//         date: formattedDate,
//         time: formattedTime,
//         timestamp,
//         dataValues: dataMap,
//         emissionFactor: emissionFactor || scopeConfig.emissionFactor || '',
//         sourceDetails: {
//           uploadedBy: req.user._id,
//           dataSource: 'manual',
//           batchId: `manual_${Date.now()}` // Add batch ID for tracking
//         },
//         isEditable: true,
//         processingStatus: 'pending',
//       });
//     }
    
    
//     // If all entries failed validation, return error
//     if (processedEntries.length === 0 && validationErrors.length > 0) {
//       return res.status(400).json({
//         message: 'All entries failed validation',
//         errors: validationErrors
//       });
//     }
    
//     // Sort by timestamp to ensure proper cumulative calculation
//     processedEntries.sort((a, b) => a.timestamp - b.timestamp);
    
//     // Save entries one by one to ensure proper cumulative calculation
//     const savedEntries = [];
//     const saveErrors = [];
    
//     console.log(`📝 Processing ${processedEntries.length} manual data entries...`);
    
//     for (const entryData of processedEntries) {
//       try {
//         const entry = new DataEntry(entryData);
//         await entry.save(); // Pre-save hook will calculate cumulative values
        
//         console.log(`✅ Entry saved: ${entry.date} ${entry.time}`);
        
//         // Trigger emission calculation for each entry
//         const calcResult = await triggerEmissionCalculation(entry);
        
//         if (calcResult && calcResult.success) {
//           console.log(`🔥 Emissions calculated for entry: ${entry._id}`);
//         }
        
//         savedEntries.push(entry);
//       } catch (error) {
//         console.error(`❌ Error saving entry for ${entryData.date}:`, error);
//         saveErrors.push({
//           date: entryData.date,
//           time: entryData.time,
//           error: error.message
//         });
//       }
//     }
    
//     // Update collection config with latest entry
//     if (savedEntries.length > 0) {
//       const latestEntry = savedEntries[savedEntries.length - 1];
//       const collectionConfig = await DataCollectionConfig.findOneAndUpdate(
//         { clientId, nodeId, scopeIdentifier },
//         {
//           $setOnInsert: {
//             scopeType: scopeConfig.scopeType,
//             inputType: 'manual',
//             collectionFrequency: scopeConfig.collectionFrequency || 'monthly',
//             createdBy: req.user._id
//           }
//         },
//         { upsert: true, new: true }
//       );
      
//       collectionConfig.updateCollectionStatus(latestEntry._id, latestEntry.timestamp);
//       await collectionConfig.save();
//     }
    
//     // Emit real-time update for each saved entry with calculated emissions
//     for (const entry of savedEntries) {
//       const { incoming: inMap, cumulative: cumMap, metadata } = entry.calculatedEmissions || {};
//       const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
      
//       emitDataUpdate('manual-data-saved', {
//         clientId,
//         nodeId,
//         scopeIdentifier,
//         dataId: entry._id,
//         timestamp: entry.timestamp,
//         date: entry.date,
//         dataValues: Object.fromEntries(entry.dataValues),
//         cumulativeValues: Object.fromEntries(entry.cumulativeValues),
//         highData: Object.fromEntries(entry.highData),
//         lowData: Object.fromEntries(entry.lowData),
//         lastEnteredData: Object.fromEntries(entry.lastEnteredData),
//         calculatedEmissions: {
//           incoming: mapToObject(inMap),
//           cumulative: mapToObject(cumMap),
//           metadata: metadata || {}
//         }
//       });
//     }
    
//     // Prepare response
//     const response = {
//       message: `Successfully saved ${savedEntries.length} out of ${dataEntries.length} entries`,
//       summary: {
//         totalSubmitted: dataEntries.length,
//         successfullySaved: savedEntries.length,
//         validationErrors: validationErrors.length,
//         saveErrors: saveErrors.length
//       },
//       savedEntries: savedEntries.map(entry => ({
//         dataId: entry._id,
//         date: entry.date,
//         time: entry.time,
//         timestamp: entry.timestamp,
//         dataValues: Object.fromEntries(entry.dataValues),
//         emissionsSummary: entry.emissionsSummary || null
//       }))
//     };
    
//     // Include latest cumulative values with emissions
//     if (savedEntries.length > 0) {
//       const lastEntry = savedEntries[savedEntries.length - 1];
//       const { incoming: inMap, cumulative: cumMap, metadata } = lastEntry.calculatedEmissions || {};
//       const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
      
//       response.latestCumulative = {
//         date: lastEntry.date,
//         time: lastEntry.time,
//         cumulativeValues: Object.fromEntries(lastEntry.cumulativeValues),
//         highData: Object.fromEntries(lastEntry.highData),
//         lowData: Object.fromEntries(lastEntry.lowData),
//         lastEnteredData: Object.fromEntries(lastEntry.lastEnteredData),
//         calculatedEmissions: {
//           incoming: mapToObject(inMap),
//           cumulative: mapToObject(cumMap),
//           metadata: metadata || {}
//         }
//       };
//     }
    
//     // Add errors to response if any
//     if (validationErrors.length > 0) {
//       response.validationErrors = validationErrors;
//     }
    
//     if (saveErrors.length > 0) {
//       response.saveErrors = saveErrors;
//     }
    
//     // Determine appropriate status code
//     const statusCode = savedEntries.length === dataEntries.length ? 201 : 
//                       savedEntries.length > 0 ? 207 : // Partial success
//                       400; // All failed
    
//     res.status(statusCode).json(response);
    
//   } catch (error) {
//     console.error('Save manual data error:', error);
//     res.status(500).json({ 
//       message: 'Failed to save manual data', 
//       error: error.message 
//     });
//   }
// };



// const uploadCSVData = async (req, res) => {
//   try {
//     const { clientId, nodeId, scopeIdentifier } = req.params;
    
//     // Check permissions for CSV upload operations
//     const permissionCheck = await checkOperationPermission(
//   req.user,
//   clientId,
//   'csv_upload',
//   { nodeId, scopeIdentifier, inputType: 'CSV' }
// );

//     if (!permissionCheck.allowed) {
//       return res.status(403).json({ 
//         message: 'Permission denied', 
//         reason: permissionCheck.reason 
//       });
    
//     }
//         // Add after finding scopeConfig
//     // Validate prerequisites for emission calculation
//     const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
//     if (!validation.isValid) {
//       // Clean up file
//       const fs = require('fs');
//       fs.unlinkSync(req.file.path);
      
//       return res.status(400).json({
//         message: 'Cannot process CSV data: ' + validation.message
//       });
//     }
//     if (!req.file) {
//       return res.status(400).json({ message: 'No CSV file uploaded' });
//     }
    
//     // Find scope configuration
//       const activeChart = await getActiveFlowchart(clientId);
//       if (!activeChart) {
//         return res.status(404).json({ message: 'No active flowchart found' });
//       }
//       const flowchart = activeChart.chart;
    
//     let scopeConfig = null;
//     for (const node of flowchart.nodes) {
//       if (node.id === nodeId) {
//         const scope = node.details.scopeDetails.find(
//           s => s.scopeIdentifier === scopeIdentifier
//         );
//         if (scope && scope.inputType === 'manual') {
//           scopeConfig = scope;
//           break;
//         }
//       }
//     }
    
//     if (!scopeConfig) {
//       return res.status(400).json({ message: 'Invalid manual scope configuration for CSV upload' });
//     }
    
//     // Process CSV file
//     const csvData = await csvtojson().fromFile(req.file.path);
    
//     if (!csvData || csvData.length === 0) {
//       return res.status(400).json({ message: 'CSV file is empty or invalid' });
//     }
    
//     // Validate required columns
//     const requiredColumns = ['date', 'time'];
//     const firstRow = csvData[0];
//     const missingColumns = requiredColumns.filter(col => !(col in firstRow));
    
//     if (missingColumns.length > 0) {
//       return res.status(400).json({ 
//         message: `Missing required columns: ${missingColumns.join(', ')}` 
//       });
//     }
    
//     // Process and prepare entries
//     const processedEntries = [];
//     const errors = [];
    
//     for (const row of csvData) {
//       const rawDate = row.date || moment().format('DD/MM/YYYY');
//       const rawTime = row.time || moment().format('HH:mm:ss');
      
//       let dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
// if (!dateMoment.isValid()) {
//   dateMoment = moment(rawDate, 'YYYY-MM-DD', true); // allow alternate format
// }
//       const timeMoment = moment(rawTime, 'HH:mm:ss', true);
      
//       if (!dateMoment.isValid() || !timeMoment.isValid()) {
//         errors.push({
//           row: csvData.indexOf(row) + 1,
//           error: 'Invalid date/time format'
//         });
//         continue;
//       }
      
//       const formattedDate = dateMoment.format('DD:MM:YYYY');
//       const formattedTime = timeMoment.format('HH:mm:ss');
      
//       const [day, month, year] = formattedDate.split(':').map(Number);
//       const [hour, minute, second] = formattedTime.split(':').map(Number);
//       const timestamp = new Date(year, month - 1, day, hour, minute, second);
      
//       // Extract data values (exclude metadata fields)
//       const dataObj = { ...row };
//       delete dataObj.date;
//       delete dataObj.time;
//       delete dataObj.scopeIdentifier;
//       delete dataObj.clientId;
//       delete dataObj.scopeType;
//       delete dataObj.emissionFactor;
      
//      // Normalize via our CSV helper, then ensure a Map for cumulative tracking
//       // Normalize via our comprehensive CSV helper, then ensure a Map for cumulative tracking
// const processed =normalizeDataPayload(dataObj, scopeConfig, 'CSV');
// let dataMap;
// try {
//   dataMap = ensureDataIsMap(processed);
// } catch (err) {
//   errors.push({
//     row: csvData.indexOf(row) + 1,
//     error: 'Invalid data shape after processing'
//   });
//   continue;
// }
      
//       processedEntries.push({
//         clientId,
//         nodeId,
//         scopeIdentifier,
//         scopeType: scopeConfig.scopeType,
//         inputType: 'manual',
//         date: formattedDate,
//         time: formattedTime,
//         timestamp,
//         dataValues: dataMap,
//         emissionFactor: row.emissionFactor || scopeConfig.emissionFactor || '',
//         sourceDetails: {
//           fileName: req.file.originalname,
//           uploadedBy: req.user._id
//         },
//         isEditable: true,
//         processingStatus: 'processed'
//       });
//     }
    
//     // Sort by timestamp to ensure proper cumulative calculation
//     processedEntries.sort((a, b) => a.timestamp - b.timestamp);
    
//     // Save entries one by one to ensure proper cumulative calculation
//     // Save entries one by one to ensure proper cumulative calculation and trigger emissions
// const savedEntries = [];

// for (const entryData of processedEntries) {
//   try {
//     const entry = new DataEntry(entryData);
//     await entry.save(); // Pre-save hook will calculate cumulative values
    
//     // Trigger emission calculation for each CSV entry
//     await triggerEmissionCalculation(entry);
    
//     savedEntries.push(entry);
//   } catch (error) {
//     errors.push({
//       date: entryData.date,
//       time: entryData.time,
//       error: error.message
//     });
//   }
// }
    
//     // Update collection config
//     if (savedEntries.length > 0) {
//       const latestEntry = savedEntries[savedEntries.length - 1];
//       const collectionConfig = await DataCollectionConfig.findOne({
//         clientId,
//         nodeId,
//         scopeIdentifier
//       });
      
//       if (collectionConfig) {
//         collectionConfig.updateCollectionStatus(latestEntry._id, latestEntry.timestamp);
//         await collectionConfig.save();
//       }
//     }
    
//     // Delete uploaded file
//     const fs = require('fs');
//     fs.unlinkSync(req.file.path);
    
//     // Emit real-time update with detailed entry info
// emitDataUpdate('csv-data-uploaded', {
//   clientId,
//   nodeId,
//   scopeIdentifier,
//   count: savedEntries.length,
//   dataIds: savedEntries.map(e => e._id),
//   entries: savedEntries.map(entry => {
//     const { incoming: inMap, cumulative: cumMap, metadata } = entry.calculatedEmissions || {};
//     const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
    
//     return {
//       dataId: entry._id,
//       timestamp: entry.timestamp,
//       dataValues: Object.fromEntries(entry.dataValues),
//       calculatedEmissions: {
//         incoming: mapToObject(inMap),
//         cumulative: mapToObject(cumMap),
//         metadata: metadata || {}
//       }
//     };
//   })
// });
    
//     const response = {
//   message: 'CSV data uploaded successfully',
//   totalRows: csvData.length,
//   savedCount: savedEntries.length,
//   dataIds: savedEntries.map(e => e._id)
// };

// // Include latest cumulative values with emissions
// if (savedEntries.length > 0) {
//   const lastEntry = savedEntries[savedEntries.length - 1];
//   const { incoming: inMap, cumulative: cumMap, metadata } = lastEntry.calculatedEmissions || {};
//   const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
  
//   response.latestCumulative = {
//     cumulativeValues: Object.fromEntries(lastEntry.cumulativeValues),
//     highData: Object.fromEntries(lastEntry.highData),
//     lowData: Object.fromEntries(lastEntry.lowData),
//     lastEnteredData: Object.fromEntries(lastEntry.lastEnteredData),
//     calculatedEmissions: {
//       incoming: mapToObject(inMap),
//       cumulative: mapToObject(cumMap),
//       metadata: metadata || {}
//     }
//   };
// }
    
//     if (errors.length > 0) {
//       response.errors = errors;
//       response.failedCount = errors.length;
//     }
    
//     res.status(201).json(response);
    
//   } catch (error) {
//     console.error('Upload CSV error:', error);
    
//     // Clean up file on error
//     if (req.file) {
//       const fs = require('fs');
//       try {
//         fs.unlinkSync(req.file.path);
//       } catch (cleanupError) {
//         console.error('Failed to clean up file:', cleanupError);
//       }
//     }
    
//     res.status(500).json({ 
//       message: 'Failed to upload CSV data', 
//       error: error.message 
//     });
//   }
// };

const handleDataChange = async (entry) => {
  if (!entry || !entry._id) {
    console.error('handleDataChange called with an invalid entry object.');
    return;
  }

  console.log(`Handling data change for entry: ${entry._id}`);

  try {
    // 1. Re-trigger emission calculation for the specific entry
    await triggerEmissionCalculation(entry);
    console.log(`Emission calculation re-triggered for entry: ${entry._id}`);

    // 2. Invalidate or update monthly/quarterly summaries for the period.
    console.log(`Summary update triggered for period of entry: ${entry._id}`);

    // 3. Potentially update dashboard analytics or other aggregated views.
    console.log(`Analytics refresh triggered for client: ${entry.clientId}`);

    // ✅ NEW: rebuild cumulative chain (includes dataEntryCumulative)
    await rebuildStreamCumulatives({
      clientId: entry.clientId,
      nodeId: entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
      inputType: entry.inputType
    });
    console.log(
      `Cumulative chain rebuilt for stream: ${entry.clientId}/${entry.nodeId}/${entry.scopeIdentifier}/${entry.inputType}`
    );
  } catch (error) {
    console.error(`Error in handleDataChange for entry ${entry._id}:`, error);
    // Don't throw; background-safe
  }
};



// ✅ Returns true if the user is allowed to modify this manual entry
async function hasManualEditRights(user, entry) {
  // 0) Must be manual entry and editable
  if (entry.inputType !== 'manual' || entry.isEditable === false) return false;

  const userId = (user._id || user.id || '').toString();
  const entryClientId = entry.clientId?.toString?.() || entry.clientId;

  // 1) Same-client client_admin can edit
  if (user.userType === 'client_admin' &&
      (user.clientId?.toString?.() || user.clientId) === entryClientId) {
    return true;
  }

  // 2) Creator of the entry can always edit/delete
  if (entry.createdBy && entry.createdBy.toString?.() === userId) {
    return true;
  }

  // 3) Employee Head of the node or in assignedEmployees[] on the scope
  const ns = await findNodeScopeForEntry(entryClientId, entry.nodeId, entry.scopeIdentifier);
  if (!ns) return false;

  const empHeadId = ns.node?.details?.employeeHeadId?.toString?.();
  if (user.userType === 'client_employee_head' && empHeadId && empHeadId === userId) {
    return true;
  }

  const assigned = Array.isArray(ns.scope?.assignedEmployees)
    ? ns.scope.assignedEmployees.map(x => x?.toString?.())
    : [];

  if (assigned.includes(userId)) {
    // If they’re in assignedEmployees, allow edit/delete.
    return true;
  }

  return false;
}
/**
 * ✅ Rebuild cumulativeValues + high/low + lastEntered + dataEntryCumulative
 * for ALL entries in the same stream (clientId+nodeId+scopeIdentifier+inputType)
 * sorted by timestamp ascending.
 *
 * This is required after EDIT because changing an old row affects all later cumulative rows.
 */
const rebuildStreamCumulatives = async ({ clientId, nodeId, scopeIdentifier, inputType }) => {
  const filter = {
    clientId,
    nodeId,
    scopeIdentifier,
    inputType,
    isSummary: false
  };

  const entries = await DataEntry.find(filter).sort({ timestamp: 1 });

  if (!entries || entries.length === 0) return;

  // running state
  const runningCum = new Map();
  const runningHigh = new Map();
  const runningLow = new Map();

  let runningTotal = 0;
  let runningCount = 0;

  const now = new Date();
  const ops = [];

  for (const e of entries) {
    const cumulativeValues = new Map();
    const highData = new Map();
    const lowData = new Map();
    const lastEnteredData = new Map();

    // incomingTotalValue = sum of numeric values in this row
    let incomingTotalValue = 0;

    for (const [key, rawVal] of (e.dataValues || new Map())) {
      const numValue = Number(rawVal);
      const v = Number.isFinite(numValue) ? numValue : 0;

      incomingTotalValue += v;

      // last entered for this key
      lastEnteredData.set(key, v);

      // cumulative per key
      const prevKeyCum = runningCum.get(key) || 0;
      const nextKeyCum = prevKeyCum + v;
      cumulativeValues.set(key, nextKeyCum);

      // high/low per key
      const prevHigh = runningHigh.has(key) ? runningHigh.get(key) : undefined;
      const prevLow = runningLow.has(key) ? runningLow.get(key) : undefined;

      const nextHigh = prevHigh === undefined ? v : Math.max(prevHigh, v);
      const nextLow = prevLow === undefined ? v : Math.min(prevLow, v);

      highData.set(key, nextHigh);
      lowData.set(key, nextLow);

      // update running state per key
      runningCum.set(key, nextKeyCum);
      runningHigh.set(key, nextHigh);
      runningLow.set(key, nextLow);
    }

    runningTotal += incomingTotalValue;
    runningCount += 1;

    const dataEntryCumulative = {
      incomingTotalValue,
      cumulativeTotalValue: runningTotal,
      entryCount: runningCount,
      lastUpdatedAt: now
    };

    ops.push({
      updateOne: {
        filter: { _id: e._id },
        update: {
          $set: {
            cumulativeValues: Object.fromEntries(cumulativeValues),
            highData: Object.fromEntries(highData),
            lowData: Object.fromEntries(lowData),
            lastEnteredData: Object.fromEntries(lastEnteredData),
            dataEntryCumulative
          }
        }
      }
    });
  }

  if (ops.length) {
    await DataEntry.bulkWrite(ops, { ordered: true });
  }
};


// Edit Manual Data Entry
const editManualData = async (req, res) => {
  try {
    const { dataId } = req.params;
    const { date: rawDateInput, time: rawTimeInput, dataValues, reason } = req.body;

    const entry = await DataEntry.findById(dataId);
    if (!entry) {
      return res.status(404).json({ message: 'Data entry not found' });
    }

    if (!entry.isEditable || entry.inputType !== 'manual') {
      return res.status(403).json({ message: 'This data entry cannot be edited' });
    }

    // 1) Try the existing permission helper
    let permission = await checkOperationPermission(
      req.user,
      entry.clientId,
      entry.nodeId,
      entry.scopeIdentifier,
      'edit_manual'
    );

    // 2) Fallback checks (client admin, employee head, assignedEmployees, creator)
    if (!permission.allowed) {
      const allowedByFallback = await hasManualEditRights(req.user, entry);
      if (!allowedByFallback) {
        return res.status(403).json({
          message: 'Permission denied',
          reason:
            permission.reason ||
            'User is not client admin, node employee head, assigned to this scope, or the creator of this entry'
        });
      }
    }

    // Store previous values for history
    const previousValues = Object.fromEntries(entry.dataValues);

    // Process date/time if provided
    if (rawDateInput || rawTimeInput) {
      const rawDate = rawDateInput || entry.date.replace(/:/g, '/');
      const rawTime = rawTimeInput || entry.time;

      const dateMoment = moment(rawDate, ['DD/MM/YYYY', 'DD-MM-YYYY'], true);
      const timeMoment = moment(rawTime, ['HH:mm:ss', 'HH:mm', 'H:mm', 'H:mm:ss'], true);

      if (!dateMoment.isValid() || !timeMoment.isValid()) {
        return res.status(400).json({ message: 'Invalid date/time format' });
      }

      const formattedDate = dateMoment.format('DD:MM:YYYY');
      const formattedTime = timeMoment.format('HH:mm:ss');

      entry.date = formattedDate;
      entry.time = formattedTime;

      // ✅ Compute IST-based timestamp
      const computed = buildISTTimestamp(formattedDate, formattedTime);
      if (!computed) {
        return res.status(400).json({ message: 'Failed to build timestamp from date/time' });
      }

      entry.timestamp = computed;
    }

    // Update data values if provided
    if (dataValues) {
      const dataMap = ensureDataIsMap(dataValues);
      entry.dataValues = dataMap;
    }

    // Ensure an editor id
    const editorId = req.user._id || req.user.id;
    if (!editorId) {
      return res.status(400).json({ message: 'Could not identify the editor. User ID is missing.' });
    }

    entry.addEditHistory(editorId, reason, previousValues, 'Manual edit');

    await entry.save();

    // ✅ Recalculate summaries / emissions + ALSO rebuild cumulative chain (including dataEntryCumulative)
    await handleDataChange(entry);

    // ✅ Re-fetch updated entry (after rebuildStreamCumulatives finishes)
    const updatedEntry = await DataEntry.findById(entry._id);

    // Emit real-time update (ADD dataEntryCumulative)
    emitDataUpdate('manual-data-edited', {
      clientId: updatedEntry.clientId,
      nodeId: updatedEntry.nodeId,
      scopeIdentifier: updatedEntry.scopeIdentifier,
      dataId: updatedEntry._id,
      timestamp: updatedEntry.timestamp,
      dataValues: Object.fromEntries(updatedEntry.dataValues),

      // ✅ NEW: include updated cumulative snapshot for UI
      dataEntryCumulative: updatedEntry.dataEntryCumulative
        ? {
            incomingTotalValue: Number(updatedEntry.dataEntryCumulative.incomingTotalValue || 0),
            cumulativeTotalValue: Number(updatedEntry.dataEntryCumulative.cumulativeTotalValue || 0),
            entryCount: Number(updatedEntry.dataEntryCumulative.entryCount || 0),
            lastUpdatedAt: updatedEntry.dataEntryCumulative.lastUpdatedAt || null
          }
        : null
    });

    // 🔁 broadcast updated completion stats for this client
    if (global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(updatedEntry.clientId);
    }

    res.status(200).json({
      message: 'Data entry updated successfully',
      dataId: updatedEntry._id,

      // ✅ NEW: return updated dataEntryCumulative
      dataEntryCumulative: updatedEntry.dataEntryCumulative
        ? {
            incomingTotalValue: Number(updatedEntry.dataEntryCumulative.incomingTotalValue || 0),
            cumulativeTotalValue: Number(updatedEntry.dataEntryCumulative.cumulativeTotalValue || 0),
            entryCount: Number(updatedEntry.dataEntryCumulative.entryCount || 0),
            lastUpdatedAt: updatedEntry.dataEntryCumulative.lastUpdatedAt || null
          }
        : null
    });
  } catch (error) {
    console.error('Edit manual data error:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Validation failed',
        errors: error.errors
      });
    }
    res.status(500).json({
      message: 'Failed to edit data entry',
      error: error.message
    });
  }
};

const deleteManualData = async (req, res) => {
  try {
    const { dataId } = req.params;

    const entry = await DataEntry.findById(dataId);
    if (!entry) {
      return res.status(404).json({ message: 'Data entry not found' });
    }

    if (entry.inputType !== 'manual') {
      return res.status(403).json({ message: 'Only manual data entries can be deleted.' });
    }

    // 1) Try existing permission helper (reuse 'edit_manual' right)
    let permission = await checkOperationPermission(
      req.user,
      entry.clientId,
      entry.nodeId,
      entry.scopeIdentifier,
      'edit_manual'
    );

    // 2) Fallback checks
    if (!permission.allowed) {
      const allowedByFallback = await hasManualEditRights(req.user, entry);
      if (!allowedByFallback) {
        return res.status(403).json({
          message: 'Permission denied to delete this entry.',
          reason: permission.reason || 'User is not client admin, node employee head, assigned to this scope, or the creator of this entry'
        });
      }
    }

    // Keep references for re-calculation and emit before delete
    const { clientId, nodeId, scopeIdentifier, timestamp, _id } = entry;

    await entry.deleteOne();

    // Trigger summary recalculation for that period
    await handleDataChange({ clientId, timestamp });

    emitDataUpdate('manual-data-deleted', {
      clientId,
      nodeId,
      scopeIdentifier,
      dataId: _id,
    });

        // 🔁 NEW: broadcast data-completion stats after delete
    if (global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(clientId);
    }


    res.status(200).json({
      message: 'Data entry deleted successfully. Summaries have been updated.'
    });

  } catch (error) {
    console.error('Delete manual data error:', error);
    res.status(500).json({
      message: 'Failed to delete data entry',
      error: error.message
    });
  }
};

const ApiKeyRequest = require('../../models/ApiKeyRequest');
const ApiKey = require('../../models/ApiKey');
const Notification = require('../../models/Notification/Notification');



async function getDataCollectionConnection({ clientId, nodeId, scopeIdentifier, type }) {
  const keyType = type === 'API' ? 'DC_API' : 'DC_IOT';

  const key = await ApiKey.findOne({
    clientId,
    keyType,
    nodeId,
    scopeIdentifier,
    status: 'ACTIVE'
  });

  if (!key) return null;

  const base = `/api/data-collection/clients/${clientId}/nodes/${nodeId}/scopes/${scopeIdentifier}/${key.keyPrefix}`;
  const endpoint = type === 'API' ? `${base}/api-data` : `${base}/iot-data`;

  return {
    endpoint,
    apiKeyId: key._id,
    keyPrefix: key.keyPrefix
  };
}

const switchInputType = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    // ✅ normalize inputType to avoid case issues
    let { inputType } = req.body;
    inputType = (inputType || "").toString().trim();

    if (inputType.toLowerCase() === "manual") inputType = "manual";
    else inputType = inputType.toUpperCase();

    const actorId = req.user?._id || req.user?.id;
    const actorType = req.user?.userType;

    if (!actorId || !actorType) {
      return res.status(401).json({ message: "Authentication missing" });
    }

    if (actorType !== "client_admin" || req.user.clientId !== clientId) {
      return res.status(403).json({ message: "Only Client Admin allowed" });
    }

    if (!["manual", "API", "IOT"].includes(inputType)) {
      return res.status(400).json({ message: "Invalid inputType" });
    }

    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) return res.status(404).json({ message: "Flowchart not found" });

    const node = flowchart.nodes.find((n) => n.id === nodeId);
    const scope = node?.details?.scopeDetails?.find((s) => s.scopeIdentifier === scopeIdentifier);
    if (!scope) return res.status(404).json({ message: "Scope not found" });

    const previousType = scope.inputType;

    /* ---------------- MANUAL ---------------- */
    if (inputType === "manual") {
      scope.inputType = "manual";
      scope.apiEndpoint = "";
      scope.apiStatus = false;
      scope.iotStatus = false;

      flowchart.markModified("nodes");
      await flowchart.save();

      await reflectSwitchInputTypeInClient({
        clientId,
        previousType,
        newType: "manual",
        nodeId,
        scopeIdentifier,
        connectionDetails: {},
        userId: actorId,
      });

      return res.json({ success: true, inputType: "manual" });
    }

    /* ---------------- API / IOT ---------------- */
    const connection = await getDataCollectionConnection({
      clientId,
      nodeId,
      scopeIdentifier,
      type: inputType,
    });

    /* --------- No key → create request (UPSERT) ---------- */
    if (!connection) {
      const keyType = inputType === "API" ? "DC_API" : "DC_IOT";

      // ✅ Prevent duplicate pending requests (upsert)
      const requestDoc = await ApiKeyRequest.findOneAndUpdate(
        { clientId, keyType, nodeId, scopeIdentifier, status: "pending" },
        {
          clientId,
          keyType,
          nodeId,
          scopeIdentifier,
          requestedBy: actorId,
          status: "pending",
          intendedInputType: inputType,
          requestedAt: new Date(),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // ✅ Persist pending request state inside Flowchart/ProcessFlowchart
      scope.apiKeyRequest = {
        ...(scope.apiKeyRequest || {}),
        status: "pending",
        requestedInputType: inputType,
        requestedAt: requestDoc?.requestedAt || new Date(),
        approvedAt: null,
        rejectedAt: null,
        apiKeyId: null,
        requestId: requestDoc?._id || null,
      };

      flowchart.markModified("nodes");
      await flowchart.save();

      const processFlow = await ProcessFlowchart.findOne({ clientId, isActive: true });
      if (processFlow) {
        const pfNode = processFlow.nodes.find((n) => n.id === nodeId);
        const pfScope = pfNode?.details?.scopeDetails?.find((s) => s.scopeIdentifier === scopeIdentifier);
        if (pfScope) {
          pfScope.apiKeyRequest = {
            ...(pfScope.apiKeyRequest || {}),
            status: "pending",
            requestedInputType: inputType,
            requestedAt: requestDoc?.requestedAt || new Date(),
            approvedAt: null,
            rejectedAt: null,
            apiKeyId: null,
            requestId: requestDoc?._id || null,
          };
          processFlow.markModified("nodes");
          await processFlow.save();
        }
      }

      const targetUsers = await resolveApiKeyRequestTargets(clientId);

// Only create notification if we found recipients
if (targetUsers.length > 0) {
  await Notification.create({
    title: "API Key Request",
    message: `Client ${clientId} requested ${keyType} for scope ${scopeIdentifier}`,
    targetUsers,
    targetClients: [clientId],
    priority: "high",

    // required fields
    createdBy: actorId,
    creatorType: actorType,

    systemAction: "api_key_request",
    isSystemNotification: true,
    status: "published",
    publishedAt: new Date(),
  });
}


      return res.status(202).json({
        status: "waiting_for_key",
        message: "API key requested. Consultant must generate it.",
        previousInputType: previousType,
        currentInputType: previousType,
        requestedInputType: inputType,
      });
    }

    const endpoint = connection.endpoint;

    /* --------- Key exists → switch now ---------- */
    scope.inputType = inputType;
    scope.apiEndpoint = endpoint;
    scope.apiStatus = inputType === "API";
    scope.iotStatus = inputType === "IOT";

    // ✅ If a request was pending, mark it approved in Flowchart scope
    if (scope.apiKeyRequest?.status === "pending" || scope.apiKeyRequest?.requestId) {
      scope.apiKeyRequest = {
        ...(scope.apiKeyRequest || {}),
        status: "approved",
        requestedInputType: inputType,
        requestedAt: scope.apiKeyRequest?.requestedAt || new Date(),
        approvedAt: new Date(),
        rejectedAt: null,
        apiKeyId: connection.apiKeyId || scope.apiKeyRequest?.apiKeyId || null,
        requestId: scope.apiKeyRequest?.requestId || null,
      };
    }

    flowchart.markModified("nodes");
    await flowchart.save();

    // ✅ Mirror switch + request status into ProcessFlowchart (if present)
    const processFlow = await ProcessFlowchart.findOne({ clientId, isActive: true });
    if (processFlow) {
      const pfNode = processFlow.nodes.find((n) => n.id === nodeId);
      const pfScope = pfNode?.details?.scopeDetails?.find((s) => s.scopeIdentifier === scopeIdentifier);
      if (pfScope) {
        pfScope.inputType = inputType;
        pfScope.apiEndpoint = endpoint;
        pfScope.apiStatus = inputType === "API";
        pfScope.iotStatus = inputType === "IOT";

        if (pfScope.apiKeyRequest?.status === "pending" || pfScope.apiKeyRequest?.requestId) {
          pfScope.apiKeyRequest = {
            ...(pfScope.apiKeyRequest || {}),
            status: "approved",
            requestedInputType: inputType,
            requestedAt: pfScope.apiKeyRequest?.requestedAt || new Date(),
            approvedAt: new Date(),
            rejectedAt: null,
            apiKeyId: connection.apiKeyId || pfScope.apiKeyRequest?.apiKeyId || null,
            requestId: pfScope.apiKeyRequest?.requestId || null,
          };
        }

        processFlow.markModified("nodes");
        await processFlow.save();
      }
    }

    await reflectSwitchInputTypeInClient({
      clientId,
      previousType,
      newType: inputType,
      nodeId,
      scopeIdentifier,
      connectionDetails: {
        apiEndpoint: endpoint,
        apiStatus: inputType === "API",
        iotStatus: inputType === "IOT",
        isActive: true,
      },
      userId: actorId,
    });

    return res.json({
      success: true,
      inputType,
      apiEndpoint: endpoint,
    });
  } catch (e) {
    console.error("switchInputType error:", e);
    return res.status(500).json({ error: e.message });
  }
};



// 🔧 helper to format JS Date -> 'YYYY-MM-DD' (for period filters)
// 🔧 helper to format JS Date -> 'YYYY-MM-DD' (for period filters)
const formatDateToYMD = (d) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// 🔍 Helper: Build MongoDB filter object for DataEntry list
function buildDataEntryFilters(req) {
  const filters = {};

  // Prefer params (because your routes use params), fallback to query (backward compatible)
  const requestedClientId = req.params?.clientId || req.query?.clientId;
  const requestedNodeId = req.params?.nodeId || req.query?.nodeId;
  const requestedScopeIdentifier = req.params?.scopeIdentifier || req.query?.scopeIdentifier;

  // Normalize user info (your codebase uses both styles elsewhere)
  const userType = req.user?.userType || req.userType;
  const userClientId = req.user?.clientId || req.clientId;

  // 1) Strict client isolation
  const clientScopedTypes = [
    "client_admin",
    "client_employee_head",
    "employee",
    "auditor",
    "viewer",
  ];

  if (clientScopedTypes.includes(userType)) {
    // Client-side users can only see their own client data
    if (requestedClientId && userClientId && requestedClientId !== userClientId) {
      const err = new Error("Access denied: cross-client request");
      err.statusCode = 403;
      throw err;
    }
    filters.clientId = userClientId;
  } else {
    // Super admin / consultant must be explicit (prevents accidental "fetch all")
    if (!requestedClientId) {
      const err = new Error("clientId is required");
      err.statusCode = 400;
      throw err;
    }
    filters.clientId = requestedClientId;
  }

  // 2) Node filtering
  if (requestedNodeId) {
    filters.nodeId = requestedNodeId;
  }

  // 3) Scope filtering
  if (requestedScopeIdentifier) {
    filters.scopeIdentifier = requestedScopeIdentifier;
  }

  // 4) Input type filtering (query only)
  if (req.query.inputType) {
    filters.inputType = req.query.inputType;
  }

  // 5) Date range filtering (query only)
  if (req.query.startDate || req.query.endDate) {
    filters.timestamp = {};
    if (req.query.startDate) filters.timestamp.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filters.timestamp.$lte = new Date(req.query.endDate);
  }

  // 6) Role-based row-level access control
  //    req.dataEntryAccessContext is attached by attachDataEntryAccessContext middleware.
  //    If present, merge the permission constraint so only authorised rows are returned.
  const accessCtx = req.dataEntryAccessContext;
  if (accessCtx && !accessCtx.isFullAccess) {
    const constraint = buildDataEntryMongoConstraint(accessCtx);

    if (constraint && constraint._impossible) {
      // Fail-closed: user has no assignments → match nothing
      filters._id = null;
      return filters;
    }

    if (constraint) {
      if (constraint.nodeId) {
        // employee_head: intersect requested nodeId with allowed set
        if (filters.nodeId) {
          // Caller requested a specific nodeId — verify it's in allowed set
          if (!constraint.nodeId.$in.includes(filters.nodeId)) {
            filters._id = null; // deny access to this specific node
            return filters;
          }
          // nodeId already set correctly, no change needed
        } else {
          // No specific node requested — restrict to allowed nodes
          filters.nodeId = constraint.nodeId;
        }
      }

      if (constraint.scopeIdentifier) {
        // employee: intersect requested scopeIdentifier with allowed set
        if (filters.scopeIdentifier) {
          // Caller requested a specific scope — verify it's in allowed set
          if (!constraint.scopeIdentifier.$in.includes(filters.scopeIdentifier)) {
            filters._id = null; // deny access to this specific scope
            return filters;
          }
          // scopeIdentifier already set correctly, no change needed
        } else {
          // No specific scope requested — restrict to allowed scopes
          filters.scopeIdentifier = constraint.scopeIdentifier;
        }
      }
    }
  }

  return filters;
}



// ⬇️ Helper: Build sort object
const buildDataEntrySort = (req) => {
  let { sortBy = 'timestamp', sortOrder = 'desc' } = req.query;

  // Allowed sort fields (you can add more)
  const allowedSortFields = [
    'timestamp',
    'date',
    'time',
    'inputType',
    'scopeType',
    'nodeType',
    'approvalStatus',
    'validationStatus',
    'processingStatus',

    // ✅ NEW: dataEntryCumulative sort support
    'dataEntryCumulative.incomingTotalValue',
    'dataEntryCumulative.cumulativeTotalValue',
    'dataEntryCumulative.entryCount',
    'dataEntryCumulative.lastUpdatedAt'
  ];

  if (!allowedSortFields.includes(sortBy)) {
    sortBy = 'timestamp';
  }

  const order = sortOrder === 'asc' ? 1 : -1;
  return { [sortBy]: order };
};


// Get Data Entries with enhanced authorization and strict client isolation
const getDataEntries = async (req, res) => {
  try {
    // If the middleware did not run (e.g., legacy caller), build context on-the-fly.
    // This ensures the controller is safe even if the middleware is not on the route.
    if (!req.dataEntryAccessContext) {
      const clientId = req.params?.clientId || req.query?.clientId || req.user?.clientId;
      try {
        req.dataEntryAccessContext = await getDataEntryAccessContext(req.user, clientId);
      } catch (ctxErr) {
        console.error('[getDataEntries] Failed to build access context:', ctxErr.message);
        req.dataEntryAccessContext = { isFullAccess: false, allowedNodeIds: new Set(), allowedScopeIdentifiers: new Set() };
      }
    }

    const filters = buildDataEntryFilters(req);
    const sort = buildDataEntrySort(req);
 
    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const skip  = (page - 1) * limit;
 
    const [entries, total] = await Promise.all([
      DataEntry.find(filters)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      DataEntry.countDocuments(filters)
    ]);
 
    const totalPages = Math.ceil(total / limit);
 
    return res.status(200).json({
      success: true,
      message: 'Data entries fetched successfully',
      data: entries, // ✅ includes dataEntryCumulative because we .lean() the whole doc
      filtersApplied: filters,
      sort,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: total,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    if (error.statusCode === 403) {
      return res.status(403).json({ success: false, message: error.message });
    }
    console.error('Error getting data entries:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get data entries',
      error: error.message
    });
  }
};
 
 


// Get Collection Status with enhanced authorization and strict client isolation
const getCollectionStatus = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { nodeId } = req.query;
    
    // CRITICAL: Prevent cross-client data access
    const userClientId = req.user.clientId;
    const userId = req.user._id || req.user.id;
    
    // For client-side users, enforce strict client isolation
    if (['client_admin', 'client_employee_head', 'employee', 'auditor'].includes(req.user.userType)) {
      if (userClientId !== clientId) {
        return res.status(403).json({ 
          message: 'Access denied',
          details: 'You cannot access collection status from another client organization',
          yourClient: userClientId,
          requestedClient: clientId
        });
      }
    }
    
    // Check permissions with node-level access if nodeId is provided
    const hasPermission = await checkDataPermission(req.user, clientId, 'read', nodeId);
    if (!hasPermission) {
      return res.status(403).json({ 
        message: 'Permission denied',
        details: 'You do not have access to view collection status for this client/node'
      });
    }
    
    // Build query
    let query = { clientId };
    
    // Apply role-based filtering
    if (req.user.userType === 'client_employee_head') {
      // Employee heads can only see collection status for their assigned nodes
     const activeChart = await getActiveFlowchart(clientId);
        if (!activeChart) {
          return res.status(404).json({ message: 'No active flowchart found' });
        }
        const flowchart = activeChart.chart;
      if (flowchart) {
        const assignedNodeIds = flowchart.nodes
          .filter(n => n.details.employeeHeadId?.toString() === userId.toString())
          .map(n => n.id);
        
        if (nodeId) {
          // Verify they are assigned to the requested node
          if (!assignedNodeIds.includes(nodeId)) {
            return res.status(403).json({ 
              message: 'Access denied',
              details: 'You can only view collection status for nodes assigned to you'
            });
          }
          query.nodeId = nodeId;
        } else {
          // Filter to only their assigned nodes
          if (assignedNodeIds.length > 0) {
            query.nodeId = { $in: assignedNodeIds };
          } else {
            // No assigned nodes
            return res.status(200).json({
              configs: [],
              summary: {
                total: 0,
                overdue: 0,
                byInputType: { manual: 0, API: 0, IOT: 0 },
                active: 0
              },
              message: 'No nodes assigned to you'
            });
          }
        }
      }
    } else if (req.user.userType === 'employee') {
      // Employees can only see collection status for scopes they are assigned to
      const activeChart = await getActiveFlowchart(clientId);
if (!activeChart) {
  return res.status(404).json({ message: 'No active flowchart found' });
}
const flowchart = activeChart.chart;
      if (flowchart) {
        const assignedScopes = [];
        
        // Find all scopes assigned to this employee
        flowchart.nodes.forEach(node => {
          node.details.scopeDetails.forEach(scope => {
            const assignedEmployees = scope.assignedEmployees || [];
            if (assignedEmployees.map(id => id.toString()).includes(userId.toString())) {
              assignedScopes.push({
                nodeId: node.id,
                scopeIdentifier: scope.scopeIdentifier
              });
            }
          });
        });
        
        if (assignedScopes.length > 0) {
          const assignedNodeIds = [...new Set(assignedScopes.map(s => s.nodeId))];
          if (nodeId) {
            // Verify they have at least one assigned scope in this node
            if (!assignedNodeIds.includes(nodeId)) {
              return res.status(403).json({ 
                message: 'Access denied',
                details: 'You can only view collection status for nodes where you have assigned scopes'
              });
            }
            query.nodeId = nodeId;
          } else {
            query.nodeId = { $in: assignedNodeIds };
          }
          
          // Store scope info for filtering results
          query._assignedScopes = assignedScopes;
        } else {
          // No assigned scopes
          return res.status(200).json({
            configs: [],
            summary: {
              total: 0,
              overdue: 0,
              byInputType: { manual: 0, API: 0, IOT: 0 },
              active: 0
            },
            message: 'No scopes assigned to you'
          });
        }
      }
    } else {
      // Client admin and auditors - add nodeId to query if provided
      if (nodeId) query.nodeId = nodeId;
    }
    
    // Extract assigned scopes for employee filtering
    const assignedScopes = query._assignedScopes;
    delete query._assignedScopes;
    
    let configs = await DataCollectionConfig.find(query)
      .populate('createdBy', 'userName')
      .populate('lastModifiedBy', 'userName')
      .populate('collectionStatus.lastDataPointId')
      .lean();
    
    // Additional filtering for employees - only show configs for their assigned scopes
    if (req.user.userType === 'employee' && assignedScopes) {
      configs = configs.filter(config => {
        return assignedScopes.some(
          s => s.nodeId === config.nodeId && s.scopeIdentifier === config.scopeIdentifier
        );
      });
    }
    
    // Add overdue status check
    const configsWithStatus = configs.map(config => {
      const isOverdue = config.inputType === 'manual' && 
                      config.collectionStatus?.nextDueDate &&
                      new Date() > new Date(config.collectionStatus.nextDueDate);
      
      return {
        ...config,
        collectionStatus: {
          ...config.collectionStatus,
          isOverdue
        }
      };
    });
    
    res.status(200).json({
      configs: configsWithStatus,
      summary: {
        total: configsWithStatus.length,
        overdue: configsWithStatus.filter(c => c.collectionStatus?.isOverdue).length,
        byInputType: {
          manual: configsWithStatus.filter(c => c.inputType === 'manual').length,
          API: configsWithStatus.filter(c => c.inputType === 'API').length,
          IOT: configsWithStatus.filter(c => c.inputType === 'IOT').length
        },
        active: configsWithStatus.filter(c => c.connectionDetails?.isActive).length
      },
      accessInfo: {
        userType: req.user.userType,
        clientId: req.user.clientId,
        accessLevel: req.user.userType === 'super_admin' ? 'Full Access - All Companies' : 
                    req.user.userType === 'client_admin' ? 'Full Client Access - Own Company Only' :
                    req.user.userType === 'consultant_admin' ? 'Consultant Admin Access' :
                    req.user.userType === 'consultant' ? 'Consultant Access' :
                    req.user.userType === 'client_employee_head' ? 'Employee Head - Assigned Nodes Only' :
                    req.user.userType === 'employee' ? 'Employee - Assigned Scopes Only' :
                    'Limited Access',
        restrictions: req.user.userType === 'client_employee_head' ? 'Only assigned nodes' :
                     req.user.userType === 'employee' ? 'Only assigned scopes' :
                     'None'
      }
    });
    
  } catch (error) {
    console.error('Get collection status error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch collection status', 
      error: error.message 
    });
  }
};

const disconnectSource = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    // 🔒 Permission
    const permissionCheck = await checkOperationPermission(
      req.user, clientId, nodeId, scopeIdentifier, 'disconnect'
    );
    if (!permissionCheck.allowed) {
      return res.status(403).json({
        message: 'Permission denied',
        reason: permissionCheck.reason
      });
    }

    // 🔎 Get Active Flowchart (but NOT usable directly!)
    const activeChart = await getActiveFlowchart(clientId);
    if (!activeChart || !activeChart.chart) {
      return res.status(404).json({ message: 'No active flowchart found' });
    }

    // ✅ Fetch REAL mongoose document (IMPORTANT FIX)
    const flowchart = await Flowchart.findById(activeChart.chart._id);
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // 🧭 Locate node
    const nodeIdx = flowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIdx === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // 🧭 Locate scope
    const scopeIdx = flowchart.nodes[nodeIdx].details.scopeDetails
      .findIndex(s => s.scopeIdentifier === scopeIdentifier);
    if (scopeIdx === -1) {
      return res.status(404).json({ message: 'Scope not found' });
    }

    const scope = flowchart.nodes[nodeIdx].details.scopeDetails[scopeIdx];

    // ❗Only flip flags; keep identifiers intact
    const inputType = (scope.inputType || '').toUpperCase();

    if (inputType === 'API') {
      scope.apiStatus = false;
    } else if (inputType === 'IOT') {
      scope.iotStatus = false;
    } else {
      return res.status(400).json({ message: 'Cannot disconnect manual input type' });
    }

    // Write back modified scope
    flowchart.nodes[nodeIdx].details.scopeDetails[scopeIdx] = scope;

    // 🔥 Save updated flowchart
    await flowchart.save();

    // Mirror gate OFF in DataCollectionConfig
    await DataCollectionConfig.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier },
      {
        $set: {
          'connectionDetails.isActive': false,
          'connectionDetails.disconnectedAt': new Date(),
          'connectionDetails.disconnectedBy': req.user?._id
        },
        $setOnInsert: {
          'connectionDetails.apiEndpoint': scope.apiEndpoint || '',
          'connectionDetails.deviceId': scope.iotDeviceId || ''
        }
      },
      { upsert: true }
    );

    // 🔁 Mirror disconnect to Client.workflowTracking.dataInputPoints
    await reflectDisconnectInClient({
      clientId,
      nodeId,
      scopeIdentifier,
      inputType: scope.inputType,
      userId: req.user?._id
    });

    return res.status(200).json({
      message: 'Source disconnected successfully',
      scopeIdentifier
    });

  } catch (error) {
    console.error('Disconnect source error:', error);
    return res.status(500).json({
      message: 'Failed to disconnect source',
      error: error.message
    });
  }
};


// Reconnect Source (params-only; flip false->true; never read body)
const reconnectSource = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    // 🔒 Permission check
    const permissionCheck = await checkOperationPermission(
      req.user, clientId, nodeId, scopeIdentifier, 'reconnect'
    );
    if (!permissionCheck.allowed) {
      return res.status(403).json({ message: 'Permission denied', reason: permissionCheck.reason });
    }

    // 🔎 Get active flowchart (but this is NOT a mongoose doc)
    const activeChart = await getActiveFlowchart(clientId);
    if (!activeChart || !activeChart.chart) {
      return res.status(404).json({ message: 'No active flowchart found' });
    }

    // ✅ FIX: Fetch the REAL mongoose document
    const flowchart = await Flowchart.findById(activeChart.chart._id);
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // 🧭 Locate node
    const nodeIdx = flowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIdx === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // 🧭 Locate scope
    const scopeIdx = flowchart.nodes[nodeIdx].details.scopeDetails
      .findIndex(s => s.scopeIdentifier === scopeIdentifier);
    if (scopeIdx === -1) {
      return res.status(404).json({ message: 'Scope not found' });
    }

    const scope = flowchart.nodes[nodeIdx].details.scopeDetails[scopeIdx];
    const inputType = (scope.inputType || '').toUpperCase();

    // 🔎 Pull any prior config (preserve endpoint/deviceId)
    const existingCfg = await DataCollectionConfig.findOne(
      { clientId, nodeId, scopeIdentifier },
      { connectionDetails: 1, inputType: 1 }
    ).lean();

    // ============================================================
    // 🔄 API RECONNECT
    // ============================================================
    if (inputType === 'API') {
      scope.apiStatus = true;

      // Save flowchart scope update
      flowchart.nodes[nodeIdx].details.scopeDetails[scopeIdx] = scope;
      await flowchart.save();

      await DataCollectionConfig.findOneAndUpdate(
        { clientId, nodeId, scopeIdentifier },
        {
          $set: {
            inputType: 'API',
            'connectionDetails.isActive': true,
            'connectionDetails.reconnectedAt': new Date(),
            'connectionDetails.reconnectedBy': req.user?._id,
            'connectionDetails.apiEndpoint':
              (existingCfg?.connectionDetails?.apiEndpoint ?? scope.apiEndpoint ?? '')
          }
        },
        { upsert: true }
      );

      await reflectReconnectInClient({
        clientId,
        nodeId,
        scopeIdentifier,
        inputType: 'API',
        userId: req.user?._id,
        endpoint: scope.apiEndpoint || existingCfg?.connectionDetails?.apiEndpoint
      });
    }

    // ============================================================
    // 🔄 IOT RECONNECT
    // ============================================================
    else if (inputType === 'IOT') {
      scope.iotStatus = true;

      flowchart.nodes[nodeIdx].details.scopeDetails[scopeIdx] = scope;
      await flowchart.save();

      await DataCollectionConfig.findOneAndUpdate(
        { clientId, nodeId, scopeIdentifier },
        {
          $set: {
            inputType: 'IOT',
            'connectionDetails.isActive': true,
            'connectionDetails.reconnectedAt': new Date(),
            'connectionDetails.reconnectedBy': req.user?._id,
            'connectionDetails.deviceId':
              (existingCfg?.connectionDetails?.deviceId ?? scope.iotDeviceId ?? '')
          }
        },
        { upsert: true }
      );

      await reflectReconnectInClient({
        clientId,
        nodeId,
        scopeIdentifier,
        inputType: 'IOT',
        userId: req.user?._id,
        deviceId: scope.iotDeviceId || existingCfg?.connectionDetails?.deviceId
      });
    }

    // ============================================================
    // 🚫 MANUAL TYPE DOESN’T REQUIRE RECONNECT
    // ============================================================
    else {
      return res.status(200).json({
        message: 'Nothing to reconnect for MANUAL input type; left unchanged',
        scopeIdentifier
      });
    }

    return res.status(200).json({
      message: 'Source reconnected successfully',
      scopeIdentifier
    });

  } catch (error) {
    console.error('Reconnect source error:', error);
    return res.status(500).json({
      message: 'Failed to reconnect source',
      error: error.message
    });
  }
};






// Create monthly summary manually (admin only)
const createMonthlySummaryManual = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { month, year } = req.body;
    
    // Only super admin and client admin can create summaries
    if (!['super_admin', 'client_admin'].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: 'Permission denied. Only administrators can create monthly summaries.' 
      });
    }
    
    // For client admin, ensure they can only create summaries for their own client
    if (req.user.userType === 'client_admin' && req.user.clientId !== clientId) {
      return res.status(403).json({ 
        message: 'Permission denied. You can only create summaries for your own organization.' 
      });
    }
    
    // Validate month and year
    if (!month || !year || month < 1 || month > 12 || year < 2020 || year > new Date().getFullYear()) {
      return res.status(400).json({ 
        message: 'Invalid month or year. Month must be 1-12, year must be between 2020 and current year.' 
      });
    }
    
    // Check if summary already exists
    const existingSummary = await DataEntry.findOne({
      clientId,
      nodeId,
      scopeIdentifier,
      isSummary: true,
      'summaryPeriod.month': month,
      'summaryPeriod.year': year
    });
    
    if (existingSummary) {
      return res.status(400).json({ 
        message: 'Summary already exists for this period',
        summaryId: existingSummary._id
      });
    }
    
    // Create the summary
    const summary = await DataEntry.createMonthlySummary(
      clientId,
      nodeId,
      scopeIdentifier,
      month,
      year
    );
    
    if (!summary) {
      return res.status(404).json({ 
        message: 'No data found for the specified period' 
      });
    }
    
    // Update collection config
    await DataCollectionConfig.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier },
      {
        $set: {
          lastSummaryCreated: {
            month,
            year,
            createdAt: new Date(),
            summaryId: summary._id,
            createdBy: req.user._id
          }
        }
      }
    );
    
    // Emit real-time update
    emitDataUpdate('monthly-summary-created', {
      clientId,
      nodeId,
      scopeIdentifier,
      summaryId: summary._id,
      period: { month, year }
    });
    
    res.status(201).json({
      message: 'Monthly summary created successfully',
      summaryId: summary._id,
      period: { month, year },
      data: {
        monthlyTotals: Object.fromEntries(summary.dataValues),
        cumulativeValues: Object.fromEntries(summary.cumulativeValues),
        highData: Object.fromEntries(summary.highData),
        lowData: Object.fromEntries(summary.lowData),
        lastEnteredData: Object.fromEntries(summary.lastEnteredData)
      }
    });
    
  } catch (error) {
    console.error('Create monthly summary error:', error);
    res.status(500).json({ 
      message: 'Failed to create monthly summary', 
      error: error.message 
    });
  }
};

// Get monthly summaries
const getMonthlySummaries = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { startMonth, startYear, endMonth, endYear } = req.query;
    
    // Check permissions
    const hasPermission = await checkDataPermission(req.user, clientId, 'read', nodeId, scopeIdentifier);
    if (!hasPermission) {
      return res.status(403).json({ 
        message: 'Permission denied',
        details: 'You do not have access to view summaries for this client/node/scope'
      });
    }
    
    // Build query
    const query = {
      clientId,
      nodeId,
      scopeIdentifier,
      isSummary: true
    };
    
    // Add date range if provided
    if (startMonth && startYear && endMonth && endYear) {
      query.$and = [
        {
          $or: [
            { 'summaryPeriod.year': { $gt: parseInt(startYear) } },
            { 
              'summaryPeriod.year': parseInt(startYear),
              'summaryPeriod.month': { $gte: parseInt(startMonth) }
            }
          ]
        },
        {
          $or: [
            { 'summaryPeriod.year': { $lt: parseInt(endYear) } },
            { 
              'summaryPeriod.year': parseInt(endYear),
              'summaryPeriod.month': { $lte: parseInt(endMonth) }
            }
          ]
        }
      ];
    }
    
    const page = parseInt(req.query.page) || 1;
const limit = Math.min(parseInt(req.query.limit) || 50, 100);
const skip = (page - 1) * limit;

const [summaries, total] = await Promise.all([
  DataEntry.find(query)
    .sort({ 'summaryPeriod.year': -1, 'summaryPeriod.month': -1 })
    .skip(skip)
    .limit(limit)
    .populate('sourceDetails.uploadedBy', 'userName')
    .lean(),
  DataEntry.countDocuments(query)
]);
    
    // Format response
    const formattedSummaries = summaries.map(summary => ({
      _id: summary._id,
      period: summary.summaryPeriod,
      timestamp: summary.timestamp,
      monthlyTotals: summary.dataValues,
      cumulativeValues: summary.cumulativeValues,
      highData: summary.highData,
      lowData: summary.lowData,
      lastEnteredData: summary.lastEnteredData,
      createdAt: summary.createdAt
    }));
    
    res.status(200).json({
      summaries: formattedSummaries,
      count: formattedSummaries.length
    });
    
  } catch (error) {
    console.error('Get monthly summaries error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch monthly summaries', 
      error: error.message 
    });
  }
};

// Get current cumulative values
const getCurrentCumulative = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    
    // Check permissions
    const hasPermission = await checkDataPermission(req.user, clientId, 'read', nodeId, scopeIdentifier);
    if (!hasPermission) {
      return res.status(403).json({ 
        message: 'Permission denied',
        details: 'You do not have access to view data for this client/node/scope'
      });
    }
    
    // Get latest cumulative values
    const latest = await DataEntry.getLatestCumulative(
      clientId,
      nodeId,
      scopeIdentifier,
      'manual'
    );
    
    if (!latest) {
      return res.status(404).json({ 
        message: 'No data found for this scope' 
      });
    }
    
    res.status(200).json({
      clientId,
      nodeId,
      scopeIdentifier,
      cumulativeValues: Object.fromEntries(latest.cumulativeValues || new Map()),
      highData: Object.fromEntries(latest.highData || new Map()),
      lowData: Object.fromEntries(latest.lowData || new Map()),
      lastEnteredData: Object.fromEntries(latest.lastEnteredData || new Map())
    });
    
  } catch (error) {
    console.error('Get current cumulative error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch current cumulative values', 
      error: error.message 
    });
  }
};


// ============================================================================
// FUNCTION 1: UPDATE INPUT TYPE IN REAL-TIME (VIA SOCKET.IO)
// ============================================================================

/**
 * @route   PATCH /api/data-collection/data-entries/:dataId/input-type
 * @desc    Update the inputType of a data entry in real-time and broadcast via Socket.IO
 * @access  Protected (requires authentication)
 * 
 * @param   {string} dataId - The MongoDB _id of the data entry
 * @body    {string} newInputType - The new input type ('manual', 'API', or 'IOT')
 * @body    {string} reason - (Optional) Reason for changing the input type
 * 
 * @returns {object} Updated data entry with new inputType
 * 
 * @example Request Body:
 * {
 *   "newInputType": "manual",
 *   "reason": "Converting from API to manual entry for correction"
 * }
 * 
 * @example Success Response (200):
 * {
 *   "message": "Input type updated successfully",
 *   "dataEntry": {
 *     "_id": "6985f25ac87da39bb65e04ce",
 *     "clientId": "Greon017",
 *     "nodeId": "greon017-node-cdec7a",
 *     "scopeIdentifier": "COK-SC-DG-FY25",
 *     "inputType": "manual",
 *     "previousInputType": "API",
 *     "updatedAt": "2026-02-07T10:30:00.000Z"
 *   },
 *   "broadcastSent": true
 * }
 */
const updateInputTypeRealtime = async (req, res) => {
  try {
    const { dataId } = req.params;
    const { newInputType, reason } = req.body;
    
    // ✅ Validation
    if (!newInputType) {
      return res.status(400).json({ 
        message: 'newInputType is required',
        validValues: ['manual', 'API', 'IOT']
      });
    }
    
    if (!['manual', 'API', 'IOT'].includes(newInputType)) {
      return res.status(400).json({ 
        message: 'Invalid inputType',
        provided: newInputType,
        validValues: ['manual', 'API', 'IOT']
      });
    }
    
    // ✅ Find the data entry
    const dataEntry = await DataEntry.findById(dataId);
    
    if (!dataEntry) {
      return res.status(404).json({ 
        message: 'Data entry not found',
        dataId 
      });
    }
    
    // ✅ Permission check (you should use your existing checkDataPermission function)
    const hasPermission = await checkDataPermission(
      req.user, 
      dataEntry.clientId, 
      'edit', 
      dataEntry.nodeId, 
      dataEntry.scopeIdentifier
    );
    
    if (!hasPermission) {
      return res.status(403).json({ 
        message: 'Permission denied',
        details: 'You do not have permission to modify this data entry'
      });
    }
    
    // ✅ Store previous value for audit trail
    const previousInputType = dataEntry.inputType;
    
    // ✅ Check if already the same
    if (previousInputType === newInputType) {
      return res.status(200).json({ 
        message: 'Input type is already set to this value',
        inputType: newInputType
      });
    }
    
    // ✅ Update the inputType
    dataEntry.inputType = newInputType;
    
    // ✅ Update isEditable based on new inputType
    // Manual entries are editable, API/IOT are not
    dataEntry.isEditable = (newInputType === 'manual');
    
    // ✅ Add to edit history for audit trail
    if (!dataEntry.editHistory) {
      dataEntry.editHistory = [];
    }
    
    dataEntry.editHistory.push({
      editedAt: new Date(),
      editedBy: req.user._id,
      reason: reason || 'Input type changed',
      previousValues: { inputType: previousInputType },
      changeDescription: `Input type changed from ${previousInputType} to ${newInputType}`
    });
    
    dataEntry.lastEditedBy = req.user._id;
    dataEntry.lastEditedAt = new Date();
    
    // ✅ Save the updated entry
    await dataEntry.save();
    
    // ✅ Prepare response data
    const responseData = {
      _id: dataEntry._id,
      clientId: dataEntry.clientId,
      nodeId: dataEntry.nodeId,
      scopeIdentifier: dataEntry.scopeIdentifier,
      inputType: dataEntry.inputType,
      previousInputType,
      isEditable: dataEntry.isEditable,
      updatedAt: dataEntry.updatedAt,
      updatedBy: req.user.userName || req.user.email
    };
    
    // ✅ Emit real-time update via Socket.IO
    emitDataUpdate('inputType-updated', {
      ...responseData,
      timestamp: new Date()
    });
    
    // ✅ Send response
    res.status(200).json({
      message: 'Input type updated successfully',
      dataEntry: responseData,
      broadcastSent: true
    });
    
  } catch (error) {
    console.error('Update input type error:', error);
    res.status(500).json({ 
      message: 'Failed to update input type', 
      error: error.message 
    });
  }
};


// ============================================================================
// FUNCTION 2: GET INPUT TYPE STATISTICS (COUNT BY TYPE)
// ============================================================================

/**
 * @route   GET /api/data-collection/clients/:clientId/input-type-stats
 * @route   GET /api/data-collection/clients/:clientId/nodes/:nodeId/input-type-stats
 * @route   GET /api/data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/input-type-stats
 * @desc    Get count statistics of data entries by inputType (manual, API, IOT)
 * @access  Protected (requires authentication)
 * 
 * @param   {string} clientId - Client identifier
 * @param   {string} nodeId - (Optional) Node identifier for filtering
 * @param   {string} scopeIdentifier - (Optional) Scope identifier for filtering
 * 
 * @query   {string} startDate - (Optional) Filter by start date (ISO format)
 * @query   {string} endDate - (Optional) Filter by end date (ISO format)
 * @query   {boolean} includeSummaries - (Optional) Include summary entries (default: false)
 * 
 * @returns {object} Statistics object with counts per inputType
 * 
 * @example Success Response (200):
 * {
 *   "clientId": "Greon017",
 *   "nodeId": "greon017-node-cdec7a",
 *   "scopeIdentifier": "COK-SC-DG-FY25",
 *   "statistics": {
 *     "manual": {
 *       "count": 150,
 *       "percentage": 45.45
 *     },
 *     "API": {
 *       "count": 120,
 *       "percentage": 36.36
 *     },
 *     "IOT": {
 *       "count": 60,
 *       "percentage": 18.18
 *     },
 *     "total": 330
 *   },
 *   "breakdown": [
 *     { "inputType": "manual", "count": 150 },
 *     { "inputType": "API", "count": 120 },
 *     { "inputType": "IOT", "count": 60 }
 *   ],
 *   "filters": {
 *     "clientId": "Greon017",
 *     "nodeId": "greon017-node-cdec7a",
 *     "scopeIdentifier": "COK-SC-DG-FY25",
 *     "dateRange": {
 *       "start": "2024-01-01",
 *       "end": "2024-12-31"
 *     },
 *     "includeSummaries": false
 *   }
 * }
 */
const getInputTypeStatistics = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { startDate, endDate, includeSummaries } = req.query;
    
    // ✅ Build query based on provided parameters
    const query = { clientId };
    
    // Add nodeId if provided
    if (nodeId) {
      query.nodeId = nodeId;
    }
    
    // Add scopeIdentifier if provided
    if (scopeIdentifier) {
      query.scopeIdentifier = scopeIdentifier;
    }
    
    // Exclude summaries by default (unless explicitly included)
    if (includeSummaries !== 'true') {
      query.isSummary = false;
    }
    
    // Add date range filter if provided
    if (startDate || endDate) {
      query.timestamp = {};
      
      if (startDate) {
        query.timestamp.$gte = new Date(startDate);
      }
      
      if (endDate) {
        query.timestamp.$lte = new Date(endDate);
      }
    }
    
    // ✅ Permission check
    const hasPermission = await checkDataPermission(
      req.user, 
      clientId, 
      'read', 
      nodeId, 
      scopeIdentifier
    );
    
    if (!hasPermission) {
      return res.status(403).json({ 
        message: 'Permission denied',
        details: 'You do not have access to view statistics for this client/node/scope'
      });
    }
    
    // ✅ Aggregate counts by inputType using MongoDB aggregation
    const aggregationPipeline = [
      { $match: query },
      {
        $group: {
          _id: '$inputType',
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          inputType: '$_id',
          count: 1
        }
      },
      { $sort: { count: -1 } }
    ];
    
    const breakdown = await DataEntry.aggregate(aggregationPipeline);
    
    // ✅ Calculate total count
    const totalCount = breakdown.reduce((sum, item) => sum + item.count, 0);
    
    // ✅ Build statistics object with all three types (even if count is 0)
    const statistics = {
      manual: {
        count: 0,
        percentage: 0
      },
      API: {
        count: 0,
        percentage: 0
      },
      IOT: {
        count: 0,
        percentage: 0
      },
      total: totalCount
    };
    
    // ✅ Fill in actual counts and calculate percentages
    breakdown.forEach(item => {
      const inputType = item.inputType;
      if (statistics[inputType] !== undefined) {
        statistics[inputType].count = item.count;
        statistics[inputType].percentage = totalCount > 0 
          ? parseFloat(((item.count / totalCount) * 100).toFixed(2))
          : 0;
      }
    });
    
    // ✅ Build filters object for response transparency
    const filters = {
      clientId,
      ...(nodeId && { nodeId }),
      ...(scopeIdentifier && { scopeIdentifier }),
      ...(startDate || endDate ? {
        dateRange: {
          ...(startDate && { start: startDate }),
          ...(endDate && { end: endDate })
        }
      } : {}),
      includeSummaries: includeSummaries === 'true'
    };
    
    // ✅ Get additional metadata (optional but useful)
    const metadata = {
      latestEntry: null,
      oldestEntry: null
    };
    
    if (totalCount > 0) {
      const [latest, oldest] = await Promise.all([
        DataEntry.findOne(query).sort({ timestamp: -1 }).select('timestamp inputType'),
        DataEntry.findOne(query).sort({ timestamp: 1 }).select('timestamp inputType')
      ]);
      
      metadata.latestEntry = latest ? {
        timestamp: latest.timestamp,
        inputType: latest.inputType
      } : null;
      
      metadata.oldestEntry = oldest ? {
        timestamp: oldest.timestamp,
        inputType: oldest.inputType
      } : null;
    }
    
    // ✅ Send response
    res.status(200).json({
      ...(clientId && { clientId }),
      ...(nodeId && { nodeId }),
      ...(scopeIdentifier && { scopeIdentifier }),
      statistics,
      breakdown,
      filters,
      metadata
    });
    
  } catch (error) {
    console.error('Get input type statistics error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch input type statistics', 
      error: error.message 
    });
  }
};



// ============================================================================
// OPTIMIZED DATA ENTRY CONTROLLER - Only dataValues & dataEntryCumulative
// ============================================================================
// Add this to: controllers/Organization/dataCollectionController.js

/**
 * Get Data Entries with ONLY dataValues and dataEntryCumulative
 * Optimized for real-time updates and reduced payload size
 * 
 * @route GET /api/v1/data/entries/minimal
 * @access Private (requires JWT authentication)
 * @returns {Object} Minimal data entries with only essential fields
 */
const getDataValuesAndCumulative = async (req, res) => {
  try {
    // Build filters manually
    const filters = {};
    
    // Required: clientId
    if (!req.query.clientId) {
      return res.status(400).json({
        success: false,
        message: 'clientId parameter is required'
      });
    }
    filters.clientId = req.query.clientId;
    
    // Optional filters
    if (req.query.nodeId) filters.nodeId = req.query.nodeId;
    if (req.query.scopeIdentifier) filters.scopeIdentifier = req.query.scopeIdentifier;
    if (req.query.inputType) filters.inputType = req.query.inputType;
    
    // Date range
    if (req.query.startDate || req.query.endDate) {
      filters.timestamp = {};
      if (req.query.startDate) filters.timestamp.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filters.timestamp.$lte = new Date(req.query.endDate);
    }

    // Role-based access control — apply the constraint built by middleware.
    // Build it on-the-fly if the middleware was not registered on this route.
    {
      let accessCtx = req.dataEntryAccessContext;
      if (!accessCtx) {
        try {
          accessCtx = await getDataEntryAccessContext(req.user, req.query.clientId);
        } catch (_) {
          accessCtx = { isFullAccess: false, allowedNodeIds: new Set(), allowedScopeIdentifiers: new Set() };
        }
      }

      if (!accessCtx.isFullAccess) {
        const constraint = buildDataEntryMongoConstraint(accessCtx);

        if (constraint && constraint._impossible) {
          // Fail-closed: user has no assignments → return empty immediately
          return res.status(200).json({
            success: true,
            message: 'Minimal data entries fetched successfully',
            data: [],
            filtersApplied: filters,
            sort: { timestamp: -1 },
            pagination: { currentPage: 1, totalPages: 0, totalItems: 0, itemsPerPage: 20, hasNextPage: false, hasPrevPage: false },
            metadata: { fieldsIncluded: ['dataValues', 'dataEntryCumulative'], optimizedPayload: true, estimatedSizeReduction: '~75%' }
          });
        }

        if (constraint) {
          if (constraint.nodeId) {
            if (filters.nodeId) {
              if (!constraint.nodeId.$in.includes(filters.nodeId)) {
                filters._id = null; // deny this specific node
              }
            } else {
              filters.nodeId = constraint.nodeId;
            }
          }
          if (constraint.scopeIdentifier) {
            if (filters.scopeIdentifier) {
              if (!constraint.scopeIdentifier.$in.includes(filters.scopeIdentifier)) {
                filters._id = null; // deny this specific scope
              }
            } else {
              filters.scopeIdentifier = constraint.scopeIdentifier;
            }
          }
        }
      }
    }

    // Build sort
    const sortBy = req.query.sortBy || 'timestamp';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    // Pagination
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) ||20));
    const skip = (page - 1) * limit;

    console.log('🔍 Fetching minimal entries with filters:', filters);

    // Execute query
    const [entries, total] = await Promise.all([
      DataEntry.find(filters)
        .select({
          _id: 1,
          clientId: 1,
          nodeId: 1,
          scopeIdentifier: 1,
          timestamp: 1,
          date: 1,
          time: 1,
          dataValues: 1,
          dataEntryCumulative: 1,
          inputType: 1,
          createdAt: 1,
          updatedAt: 1
        })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      DataEntry.countDocuments(filters)
    ]);

    console.log('✅ Found', entries.length, 'entries (Total:', total, ')');

    // Serialize entries
    const serializedEntries = entries.map(entry => ({
      _id: entry._id,
      clientId: entry.clientId,
      nodeId: entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
      timestamp: entry.timestamp,
      date: entry.date,
      time: entry.time,
      inputType: entry.inputType,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      
      dataValues: entry.dataValues instanceof Map 
        ? Object.fromEntries(entry.dataValues)
        : entry.dataValues,
      
      dataEntryCumulative: entry.dataEntryCumulative ? {
        incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
        cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
        entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
        lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
      } : null
    }));

    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      message: 'Minimal data entries fetched successfully',
      data: serializedEntries,
      filtersApplied: filters,
      sort,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: total,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      metadata: {
        fieldsIncluded: ['dataValues', 'dataEntryCumulative'],
        optimizedPayload: true,
        estimatedSizeReduction: '~75%'
      }
    });
  } catch (error) {
    console.error('❌ Error getting minimal data entries:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get minimal data entries',
      error: error.message
    });
  }
};



// /**
//  * Get Single Data Entry with ONLY dataValues and dataEntryCumulative
//  * Optimized endpoint for fetching a specific entry
//  * 
//  * @route GET /api/v1/data/entries/minimal/:dataId
//  * @access Private (requires JWT authentication)
//  * @returns {Object} Minimal data entry with only essential fields
//  */
// const getSingleDataValueAndCumulative = async (req, res) => {
//   try {
//     const { dataId } = req.params;
//     const { clientId } = req.query;

//     // Build filters with authorization check
//     const filters = { _id: dataId };
    
//     // Apply client isolation based on user role
//     if (req.userType === 'client_admin' || 
//         req.userType === 'client_employee_head' || 
//         req.userType === 'auditor' || 
//         req.userType === 'viewer') {
//       filters.clientId = req.clientId;
//     } else if (clientId) {
//       filters.clientId = clientId;
//     }

//     // ✅ Fetch only required fields
//     const entry = await DataEntry.findOne(filters)
//       .select({
//         _id: 1,
//         clientId: 1,
//         nodeId: 1,
//         scopeIdentifier: 1,
//         timestamp: 1,
//         date: 1,
//         time: 1,
//         dataValues: 1,
//         dataEntryCumulative: 1,
//         inputType: 1,
//         createdAt: 1,
//         updatedAt: 1
//       })
//       .lean();

//     if (!entry) {
//       return res.status(404).json({
//         success: false,
//         message: 'Data entry not found'
//       });
//     }

//     // ✅ Serialize response
//     const serializedEntry = {
//       _id: entry._id,
//       clientId: entry.clientId,
//       nodeId: entry.nodeId,
//       scopeIdentifier: entry.scopeIdentifier,
//       timestamp: entry.timestamp,
//       date: entry.date,
//       time: entry.time,
//       inputType: entry.inputType,
//       createdAt: entry.createdAt,
//       updatedAt: entry.updatedAt,
      
//       dataValues: entry.dataValues instanceof Map 
//         ? Object.fromEntries(entry.dataValues)
//         : entry.dataValues,
      
//       dataEntryCumulative: entry.dataEntryCumulative ? {
//         incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
//         cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
//         entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
//         lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
//       } : null
//     };

//     return res.status(200).json({
//       success: true,
//       message: 'Minimal data entry fetched successfully',
//       data: serializedEntry
//     });
//   } catch (error) {
//     console.error('Error getting single minimal data entry:', error);
//     return res.status(500).json({
//       success: false,
//       message: 'Failed to get minimal data entry',
//       error: error.message
//     });
//   }
// };


/**
 * Stream Data Entries (Server-Sent Events)
 * Real-time streaming of data entries as they're created/updated
 * 
 * @route GET /api/v1/data/entries/stream
 * @access Private (requires JWT authentication)
 * @returns {EventSource} SSE stream of minimal data entries
 */
const streamDataValuesAndCumulative = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.query;

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Build access context for role-based filtering
    let accessCtx = req.dataEntryAccessContext;
    if (!accessCtx) {
      try {
        accessCtx = await getDataEntryAccessContext(req.user, clientId);
      } catch (_) {
        accessCtx = { isFullAccess: false, allowedNodeIds: new Set(), allowedScopeIdentifiers: new Set() };
      }
    }

    // Build the access constraint for the change stream $match stage
    const accessConstraint = buildDataEntryMongoConstraint(accessCtx);

    // If fail-closed (no assignments), send empty initial data and close
    if (accessConstraint && accessConstraint._impossible) {
      res.write(`data: ${JSON.stringify({ type: 'initial', data: [] })}\n\n`);
      res.end();
      return;
    }

    // Build filters for initial data load (reuses buildDataEntryFilters + context)
    const filters = buildDataEntryFilters(req);

    // Send initial data
    const initialEntries = await DataEntry.find(filters)
      .select({
        _id: 1,
        clientId: 1,
        nodeId: 1,
        scopeIdentifier: 1,
        timestamp: 1,
        dataValues: 1,
        dataEntryCumulative: 1
      })
      .sort({ timestamp: -1 })
      .limit(10)
      .lean();

    // Serialize and send initial data
    const serialized = initialEntries.map(entry => ({
      _id: entry._id,
      clientId: entry.clientId,
      nodeId: entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
      timestamp: entry.timestamp,
      dataValues: entry.dataValues instanceof Map 
        ? Object.fromEntries(entry.dataValues)
        : entry.dataValues,
      dataEntryCumulative: entry.dataEntryCumulative ? {
        incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
        cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
        entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
        lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
      } : null
    }));

    res.write(`data: ${JSON.stringify({ type: 'initial', data: serialized })}\n\n`);

    // Build the change stream $match with role-based constraints
    const changeStreamMatch = {
      'fullDocument.clientId': clientId,
      ...(nodeId && { 'fullDocument.nodeId': nodeId }),
      ...(scopeIdentifier && { 'fullDocument.scopeIdentifier': scopeIdentifier }),
      operationType: { $in: ['insert', 'update'] },
      // Apply role-based constraints to the change stream as well
      ...(accessConstraint?.nodeId && {
        'fullDocument.nodeId': { $in: accessConstraint.nodeId.$in }
      }),
      ...(accessConstraint?.scopeIdentifier && {
        'fullDocument.scopeIdentifier': { $in: accessConstraint.scopeIdentifier.$in }
      }),
    };

    // Set up change stream for real-time updates
    const changeStream = DataEntry.watch([
      {
        $match: changeStreamMatch
      }
    ]);

    changeStream.on('change', (change) => {
      const entry = change.fullDocument;
      if (!entry) return;

      const data = {
        _id: entry._id,
        clientId: entry.clientId,
        nodeId: entry.nodeId,
        scopeIdentifier: entry.scopeIdentifier,
        timestamp: entry.timestamp,
        dataValues: entry.dataValues instanceof Map 
          ? Object.fromEntries(entry.dataValues)
          : entry.dataValues,
        dataEntryCumulative: entry.dataEntryCumulative ? {
          incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
          cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
          entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
          lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
        } : null
      };

      res.write(`data: ${JSON.stringify({ type: 'update', data })}\n\n`);
    });

    // Handle client disconnect
    req.on('close', () => {
      changeStream.close();
      res.end();
    });

  } catch (error) {
    console.error('Error in data stream:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
};



module.exports = {
  setSocketIO,
  checkDataPermission,
  checkOperationPermission,
  saveAPIData,
  saveIoTData,
  saveManualData,
  uploadCSVData,
  editManualData,
  deleteManualData,
  switchInputType,
  getDataEntries,
  getCollectionStatus,
  disconnectSource,
  reconnectSource,
  createMonthlySummaryManual,
  getMonthlySummaries,
  getCurrentCumulative,
  updateInputTypeRealtime,
  getInputTypeStatistics,
  getDataValuesAndCumulative,
  // getSingleDataValueAndCumulative,
  streamDataValuesAndCumulative
};