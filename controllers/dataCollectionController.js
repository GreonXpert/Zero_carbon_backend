const DataEntry = require('../models/DataEntry');
const DataCollectionConfig = require('../models/DataCollectionConfig');
const Flowchart = require('../models/Flowchart');
const Client = require('../models/Client');
const User = require('../models/User');
const csvtojson = require('csvtojson');
const moment = require('moment');

const ProcessFlowchart = require('../models/ProcessFlowchart');


const {
  triggerEmissionCalculation,
  validateEmissionPrerequisites
} = require('./Calculation/emissionIntegration');

const {getActiveFlowchart} = require ('../utils/DataCollection/dataCollection');


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
        pd.equitySharePercentage = getValue(['equitySharePercentage', 'equity_share_percentage']);
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
    io.to(`client-${data.clientId}`).emit(eventType, {
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

/**
 * Store one data row as DataEntry and trigger emission calculation
 */
async function saveOneEntry({
  req, clientId, nodeId, scopeIdentifier, scope, node, inputSource, row,
  csvMeta = null
}) {
  // Normalize payload per scope config
  const pd = normalizeDataPayload(row || {}, scope, inputSource === 'CSV' ? 'CSV' : 'MANUAL');

  // Build the DataEntry doc
  const entry = new DataEntry({
    clientId,
    nodeId,
    scopeIdentifier,
    scopeType: scope.scopeType,                 // required by schema
    inputType: 'manual',                        // CSV also stored as manual (schema enum: manual/API/IOT)
    date: row?.date || row?.Date || undefined,  // optional, schema keeps as string if present
    time: row?.time || row?.Time || undefined,  // optional
    timestamp: row?.timestamp ? new Date(row.timestamp) : new Date(), // required
    dataValues: toNumericMap(pd),               // required Map<number>
    sourceDetails: {
      uploadedBy: req.user._id || req.user.id,
      ...(inputSource === 'CSV'
        ? { fileName: csvMeta?.fileName || '', dataSource: 'csv' }
        : { dataSource: 'manual' })
    },
    // Optional: TypeOfNode if present on node
    typeOfNode: node?.details?.TypeOfNode || 'Emission Source',
    // Good defaults for calc/flags — schema will handle the rest
    processingStatus: 'pending',
    emissionCalculationStatus: 'pending',
       emissionFactor: resolveEmissionFactor(row?.emissionFactor, scope?.emissionFactor),

  });

  await entry.save();
 // Run the calculator and capture the result object (status + json)
  const calcResult = await triggerEmissionCalculation(entry);

  // Persisted inside triggerEmissionCalculation:
  //  - entry.calculatedEmissions
  //  - emissionCalculationStatus, emissionCalculatedAt
  //  - summary update attempt

  // Return both to the caller so your response can mirror API/IoT
  return { entry, calcResult };
}




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

    // Locate chart/node/scope
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({ success: false, message: 'Node/scope not found in flowchart or process flowchart' });
    }
    const { node, scope } = located;

    // Permission
    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({ success: false, message: 'Permission denied', reason: perm.reason });
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
      req, clientId, nodeId, scopeIdentifier, scope, node,
      inputSource: 'MANUAL',
      row: rows[i]
    });
    saved.push({
      dataEntryId: entry._id,
      emissionCalculationStatus: entry.emissionCalculationStatus,
      calculatedEmissions: entry.calculatedEmissions || null,
      calculationResponse: calcResult?.data || null
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
return res.status(ok ? 201 : (saved.length ? 207 : 400)).json({
  success: ok,
  message: ok
    ? 'Manual data saved'
    : (saved.length ? 'Manual data partially saved' : 'Manual data failed'),
  savedCount: saved.length,
  failedCount: errors.length,
  results: saved,
  errors
});
  } catch (error) {
    console.error('saveManualData error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

/**
 * POST /api/data-collection/csv/:clientId/:nodeId/:scopeIdentifier
 * Accepts either:
 *  - multipart CSV file at req.file.path  (multer)
 *  - raw CSV text at req.body.csvText
 *  - parsed JSON rows at req.body.rows
 */
const uploadCSVData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    // Locate chart/node/scope
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({ success: false, message: 'Node/scope not found in flowchart or process flowchart' });
    }
    const { node, scope } = located;

    // Permission
    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({ success: false, message: 'Permission denied', reason: perm.reason });
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

    // Parse CSV rows from file, csvText, or rows
    let rows = [];
    let fileName = '';

    if (req.file?.path) {
      fileName = req.file.originalname || req.file.filename || '';
      rows = await csvtojson().fromFile(req.file.path);
    } else if (req.body?.csvText) {
      fileName = req.body.fileName || 'uploaded.csv';
      rows = await csvtojson().fromString(req.body.csvText);
    } else if (Array.isArray(req.body?.rows)) {
      fileName = req.body.fileName || 'rows.json';
      rows = req.body.rows;
    } else {
      return res.status(400).json({
        success: false,
        message: 'CSV data not found. Provide multipart file, csvText, or rows[]'
      });
    }

    const saved = [];
const errors = [];

for (let i = 0; i < rows.length; i++) {
  try {
    const { entry, calcResult } = await saveOneEntry({
      req, clientId, nodeId, scopeIdentifier, scope, node,
      inputSource: 'CSV',
      row: rows[i],
      csvMeta: { fileName }
    });
    saved.push({
      rowNumber: i + 1,
      dataEntryId: entry._id,
      emissionCalculationStatus: entry.emissionCalculationStatus,
      calculatedEmissions: entry.calculatedEmissions || null,
      calculationResponse: calcResult?.data || null
    });
  } catch (err) {
    errors.push({ row: i + 1, error: err.message });
  }
}
  // 🔁 NEW: broadcast data-completion if any rows were saved
    if (saved.length > 0 && global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(clientId);
    }

const ok = errors.length === 0;
return res.status(ok ? 201 : (saved.length ? 207 : 400)).json({
  success: ok,
  message: ok
    ? `CSV processed: ${saved.length} rows saved`
    : `CSV partially processed: ${saved.length} saved, ${errors.length} errors`,
  fileName,
  savedCount: saved.length,
  failedCount: errors.length,
  results: saved,
  errors
});
  } catch (error) {
    console.error('uploadCSVData error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
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
    // This ensures the entry itself has the latest emission data.
    await triggerEmissionCalculation(entry);
    console.log(`Emission calculation re-triggered for entry: ${entry._id}`);

    // 2. Invalidate or update monthly/quarterly summaries for the period.
    // (This is a placeholder for your summary update logic)
    // For example:
    // await SummaryModel.updateSummaryForPeriod(entry.clientId, entry.timestamp);
    console.log(`Summary update triggered for period of entry: ${entry._id}`);


    // 3. Potentially update dashboard analytics or other aggregated views.
    // (This is a placeholder for your analytics update logic)
    // For example:
    // await AnalyticsModel.refreshDashboard(entry.clientId);
    console.log(`Analytics refresh triggered for client: ${entry.clientId}`);

  } catch (error) {
    console.error(`Error in handleDataChange for entry ${entry._id}:`, error);
    // It's important not to throw here, as this is a background process.
    // Log the error for monitoring.
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
          reason: permission.reason || 'User is not client admin, node employee head, assigned to this scope, or the creator of this entry'
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
      const timeMoment = moment(rawTime, 'HH:mm:ss', true);

      if (!dateMoment.isValid() || !timeMoment.isValid()) {
        return res.status(400).json({ message: 'Invalid date/time format' });
      }

      const formattedDate = dateMoment.format('DD:MM:YYYY');
      const formattedTime = timeMoment.format('HH:mm:ss');

      const [day, month, year] = formattedDate.split(':').map(Number);
      const [hour, minute, second] = formattedTime.split(':').map(Number);
      const timestamp = new Date(year, month - 1, day, hour, minute, second);

      entry.date = formattedDate;
      entry.time = formattedTime;
      entry.timestamp = timestamp;
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

    // Recalculate summaries / emissions
    await handleDataChange(entry);

    // Emit real-time update
    emitDataUpdate('manual-data-edited', {
      clientId: entry.clientId,
      nodeId: entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
      dataId: entry._id,
      timestamp: entry.timestamp,
      dataValues: Object.fromEntries(entry.dataValues)
    });

       // 🔁 NEW: broadcast updated completion stats for this client
    if (global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(entry.clientId);
    }

    res.status(200).json({
      message: 'Data entry updated successfully',
      dataId: entry._id
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



// Switch Input Type
const switchInputType = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { inputType: newInputType, connectionDetails } = req.body;
    
    // Check permissions for switching input type - only client_admin allowed
    if (req.user.userType !== 'client_admin' || req.user.clientId !== clientId) {
      return res.status(403).json({ 
        message: 'Permission denied. Only Client Admin can switch input types.' 
      });
    }
    
    if (!newInputType || !['manual', 'API', 'IOT'].includes(newInputType)) {
      return res.status(400).json({ message: 'Invalid input type' });
    }
    
    // Get flowchart
    // Find scope configuration
const activeChart = await getActiveFlowchart(clientId);
if (!activeChart) {
  return res.status(404).json({ message: 'No active flowchart found' });
}
const flowchart = activeChart.chart;
    
    // Find and update scope configuration
    let updated = false;
    for (let i = 0; i < flowchart.nodes.length; i++) {
      if (flowchart.nodes[i].id === nodeId) {
        const scopeIndex = flowchart.nodes[i].details.scopeDetails.findIndex(
          s => s.scopeIdentifier === scopeIdentifier
        );
        
        if (scopeIndex !== -1) {
          const scope = flowchart.nodes[i].details.scopeDetails[scopeIndex];
          const previousType = scope.inputType;
          
          // Update input type
          scope.inputType = newInputType;
          
          // Reset previous connection details
          scope.apiStatus = false;
          scope.apiEndpoint = '';
          scope.iotStatus = false;
          scope.iotDeviceId = '';
          
          // Set new connection details
          if (newInputType === 'API' && connectionDetails?.apiEndpoint) {
            scope.apiEndpoint = connectionDetails.apiEndpoint;
            scope.apiStatus = true;
          } else if (newInputType === 'IOT' && connectionDetails?.deviceId) {
            scope.iotDeviceId = connectionDetails.deviceId;
            scope.iotStatus = true;
          }
          
          flowchart.nodes[i].details.scopeDetails[scopeIndex] = scope;
          updated = true;
          
          // Update or create collection config
          const config = await DataCollectionConfig.findOneAndUpdate(
            { clientId, nodeId, scopeIdentifier },
            {
              inputType: newInputType,
              connectionDetails: newInputType === 'manual' ? {} : connectionDetails,
              lastModifiedBy: req.user._id
            },
            { upsert: true, new: true }
          );
          
          break;
        }
      }
    }
    
    if (!updated) {
      return res.status(404).json({ message: 'Scope not found' });
    }
    
        await flowchart.save();

    // 🔁 Mirror change into Client.workflowTracking.dataInputPoints
    await reflectSwitchInputTypeInClient({
      clientId,
      previousType,
      newType: newInputType,
      nodeId,
      scopeIdentifier,
      connectionDetails: {
        apiEndpoint: flowchart.nodes[i].details.scopeDetails[scopeIndex].apiEndpoint || connectionDetails?.apiEndpoint,
        deviceId:    flowchart.nodes[i].details.scopeDetails[scopeIndex].iotDeviceId || connectionDetails?.deviceId,
        apiStatus:   flowchart.nodes[i].details.scopeDetails[scopeIndex].apiStatus,
        iotStatus:   flowchart.nodes[i].details.scopeDetails[scopeIndex].iotStatus,
        isActive:    true
      },
      userId: req.user?._id
    });
    
    res.status(200).json({
      message: `Input type switched to ${newInputType} successfully`,
      scopeIdentifier,
      newInputType
    });
    
  } catch (error) {
    console.error('Switch input type error:', error);
    res.status(500).json({ 
      message: 'Failed to switch input type', 
      error: error.message 
    });
  }
};

// Get Data Entries with enhanced authorization and strict client isolation
const getDataEntries = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { 
      page = 1, 
      limit = 20, 
      inputType, 
      startDate, 
      endDate, 
      sortBy = 'timestamp', 
      sortOrder = 'desc',
      includeSummaries = 'false'
    } = req.query;
    
    // CRITICAL: Prevent cross-client data access
    const userClientId = req.user.clientId;
    const userId = req.user._id || req.user.id;
    
    // For client-side users, enforce strict client isolation
    if (['client_admin', 'client_employee_head', 'employee', 'auditor'].includes(req.user.userType)) {
      if (userClientId !== clientId) {
        return res.status(403).json({ 
          message: 'Access denied',
          details: 'You cannot access data from another client organization',
          yourClient: userClientId,
          requestedClient: clientId
        });
      }
    }
    
    // Check permissions with full parameters
    const hasPermission = await checkDataPermission(req.user, clientId, 'read', nodeId, scopeIdentifier);
    if (!hasPermission) {
      return res.status(403).json({ 
        message: 'Permission denied',
        details: 'You do not have access to view data entries for this client/node/scope'
      });
    }
    
    // Build base query
    let query = { clientId };
    
    // Include or exclude summaries
    if (includeSummaries === 'false') {
      query.isSummary = { $ne: true };
    }
    
    // Apply role-based filtering
    if (req.user.userType === 'client_employee_head') {
      // Employee heads can only see data from their assigned nodes
      // Find scope configuration
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
              details: 'You can only access data from nodes assigned to you'
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
              data: [],
              pagination: { page: 1, limit: parseInt(limit), total: 0, pages: 0 },
              message: 'No nodes assigned to you'
            });
          }
        }
      }
    } else if (req.user.userType === 'employee') {
      // Employees can only see data from scopes they are assigned to
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
        
        if (nodeId && scopeIdentifier) {
          // Verify they are assigned to the requested scope
          const isAssigned = assignedScopes.some(
            s => s.nodeId === nodeId && s.scopeIdentifier === scopeIdentifier
          );
          if (!isAssigned) {
            return res.status(403).json({ 
              message: 'Access denied',
              details: 'You can only access data from scopes assigned to you'
            });
          }
          query.nodeId = nodeId;
          query.scopeIdentifier = scopeIdentifier;
        } else {
          // Filter to only their assigned scopes
          if (assignedScopes.length > 0) {
            query.$or = assignedScopes.map(s => ({
              nodeId: s.nodeId,
              scopeIdentifier: s.scopeIdentifier
            }));
          } else {
            // No assigned scopes
            return res.status(200).json({
              data: [],
              pagination: { page: 1, limit: parseInt(limit), total: 0, pages: 0 },
              message: 'No scopes assigned to you'
            });
          }
        }
      }
    } else {
      // Client admin and auditors - add nodeId/scope to query if provided
      if (nodeId) query.nodeId = nodeId;
      if (scopeIdentifier) query.scopeIdentifier = scopeIdentifier;
    }
    
    // Add other filters
    if (inputType) query.inputType = inputType;
    
    // Date filtering
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) {
        query.timestamp.$gte = moment(startDate, 'DD:MM:YYYY').startOf('day').toDate();
      }
      if (endDate) {
        query.timestamp.$lte = moment(endDate, 'DD:MM:YYYY').endOf('day').toDate();
      }
    }
    
    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [data, total] = await Promise.all([
      DataEntry.find(query)
        .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('sourceDetails.uploadedBy', 'userName')
        .populate('lastEditedBy', 'userName')
        .lean(),
      DataEntry.countDocuments(query)
    ]);
    
    // Convert Maps to objects for response
    const formattedData = data.map(entry => ({
      ...entry,
      dataValues: entry.dataValues instanceof Map ? Object.fromEntries(entry.dataValues) : entry.dataValues,
      cumulativeValues: entry.cumulativeValues instanceof Map ? Object.fromEntries(entry.cumulativeValues) : entry.cumulativeValues,
      highData: entry.highData instanceof Map ? Object.fromEntries(entry.highData) : entry.highData,
      lowData: entry.lowData instanceof Map ? Object.fromEntries(entry.lowData) : entry.lowData,
      lastEnteredData: entry.lastEnteredData instanceof Map ? Object.fromEntries(entry.lastEnteredData) : entry.lastEnteredData
    }));
    
    res.status(200).json({
      data: formattedData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
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
    console.error('Get data entries error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch data entries', 
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

// Disconnect Source (params-only; DO NOT delete endpoint/deviceId)

const disconnectSource = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    // 🔒 Permission
    const permissionCheck = await checkOperationPermission(
      req.user, clientId, nodeId, scopeIdentifier, 'disconnect'
    );
    if (!permissionCheck.allowed) {
      return res.status(403).json({ message: 'Permission denied', reason: permissionCheck.reason });
    }

    // 🔎 Active flowchart
    const activeChart = await getActiveFlowchart(clientId);
    if (!activeChart || !activeChart.chart) {
      return res.status(404).json({ message: 'No active flowchart found' });
    }
    const flowchart = activeChart.chart;

    // 🧭 Locate node/scope
    const nodeIdx = flowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIdx === -1) return res.status(404).json({ message: 'Node not found' });

    const scopeIdx = flowchart.nodes[nodeIdx].details.scopeDetails
      .findIndex(s => s.scopeIdentifier === scopeIdentifier);
    if (scopeIdx === -1) return res.status(404).json({ message: 'Scope not found' });

    const scope = flowchart.nodes[nodeIdx].details.scopeDetails[scopeIdx];

    // ❗Only flip flags; keep identifiers intact.
    if ((scope.inputType || '').toUpperCase() === 'API') {
      scope.apiStatus = false;           // DO NOT clear scope.apiEndpoint
    } else if ((scope.inputType || '').toUpperCase() === 'IOT') {
      scope.iotStatus = false;           // DO NOT clear scope.iotDeviceId
    } else {
      return res.status(400).json({ message: 'Cannot disconnect manual input type' });
    }

    flowchart.nodes[nodeIdx].details.scopeDetails[scopeIdx] = scope;
    await flowchart.save();

    // Mirror gate OFF in collection config, preserving endpoint/deviceId if known
    await DataCollectionConfig.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier },
      {
        $set: {
          'connectionDetails.isActive': false,
          'connectionDetails.disconnectedAt': new Date(),
          'connectionDetails.disconnectedBy': req.user?._id
        },
        $setOnInsert: {
          // If we create it now, seed from scope (or empty string)
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
    return res.status(200).json({ message: 'Source disconnected successfully', scopeIdentifier });
  } catch (error) {
    console.error('Disconnect source error:', error);
    return res.status(500).json({ message: 'Failed to disconnect source', error: error.message });
  }
};


// Reconnect Source (params-only; flip false->true; never read body)
const reconnectSource = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    // 🔒 Permission
    const permissionCheck = await checkOperationPermission(
      req.user, clientId, nodeId, scopeIdentifier, 'reconnect'
    );
    if (!permissionCheck.allowed) {
      return res.status(403).json({ message: 'Permission denied', reason: permissionCheck.reason });
    }

    // 🔎 Active flowchart
    const activeChart = await getActiveFlowchart(clientId);
    if (!activeChart || !activeChart.chart) {
      return res.status(404).json({ message: 'No active flowchart found' });
    }
    const flowchart = activeChart.chart;

    // 🧭 Locate node/scope
    const nodeIdx = flowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIdx === -1) return res.status(404).json({ message: 'Node not found' });

    const scopeIdx = flowchart.nodes[nodeIdx].details.scopeDetails
      .findIndex(s => s.scopeIdentifier === scopeIdentifier);
    if (scopeIdx === -1) return res.status(404).json({ message: 'Scope not found' });

    const scope = flowchart.nodes[nodeIdx].details.scopeDetails[scopeIdx];
    const inputType = (scope.inputType || '').toUpperCase();

    // Pull any prior config to preserve endpoint/deviceId if needed
    const existingCfg = await DataCollectionConfig.findOne(
      { clientId, nodeId, scopeIdentifier },
      { connectionDetails: 1, inputType: 1 }
    ).lean();

    if (inputType === 'API') {
      // ✅ flip false -> true (no body required)
      scope.apiStatus = true;

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
            // Preserve endpoint: prefer config, else scope, else ''
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


    } else if (inputType === 'IOT') {
      // ✅ flip false -> true (no body required)
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
            // Preserve deviceId: prefer config, else scope, else ''
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
    } else {
      return res.status(200).json({
        message: 'Nothing to reconnect for MANUAL input type; left unchanged',
        scopeIdentifier
      });
    }

    return res.status(200).json({ message: 'Source reconnected successfully', scopeIdentifier });
  } catch (error) {
    console.error('Reconnect source error:', error);
    return res.status(500).json({ message: 'Failed to reconnect source', error: error.message });
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
    
    const summaries = await DataEntry.find(query)
      .sort({ 'summaryPeriod.year': -1, 'summaryPeriod.month': -1 })
      .populate('sourceDetails.uploadedBy', 'userName')
      .lean();
    
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
  getCurrentCumulative
};