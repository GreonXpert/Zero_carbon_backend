const DataEntry = require('../models/DataEntry');
const DataCollectionConfig = require('../models/DataCollectionConfig');
const Flowchart = require('../models/Flowchart');
const Client = require('../models/Client');
const User = require('../models/User');
const csvtojson = require('csvtojson');
const moment = require('moment');

const {
  triggerEmissionCalculation,
  validateEmissionPrerequisites
} = require('./Calculation/emissionIntegration');




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
        const flowchart = await Flowchart.findOne({ clientId, isActive: true });
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
      const flowchart = await Flowchart.findOne({ clientId, isActive: true });
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

// Enhanced permission check for specific operations
const checkOperationPermission = async (user, clientId, nodeId, scopeIdentifier, operation) => {
  const userId = user._id || user.id;
  if (!userId) return { allowed: false, reason: 'Invalid user' };

  // Super admin always allowed
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  const client = await Client.findOne({ clientId });
  if (!client) {
    return { allowed: false, reason: 'Client not found' };
  }

  // Consultant permissions for API/IoT operations
  if (['api_data', 'iot_data', 'disconnect', 'reconnect'].includes(operation)) {
    if (user.userType === 'consultant_admin') {
      if (client.leadInfo?.createdBy?.toString() === userId.toString()) {
        return { allowed: true, reason: 'Consultant admin who created client' };
      }
      
      const consultants = await User.find({
        consultantAdminId: userId,
        userType: 'consultant'
      }).select('_id');
      const consultantIds = consultants.map(c => c._id.toString());
      if (
        client.leadInfo?.assignedConsultantId &&
        consultantIds.includes(client.leadInfo.assignedConsultantId.toString())
      ) {
        return { allowed: true, reason: 'Consultant admin of assigned consultant' };
      }
    }

    if (user.userType === 'consultant') {
      if (client.leadInfo?.assignedConsultantId?.toString() === userId.toString()) {
        return { allowed: true, reason: 'Assigned consultant' };
      }
    }
  }

  // Client user permissions
  if (user.clientId !== clientId) {
    return { allowed: false, reason: 'Different client organization' };
  }

  // Client admin permissions
  if (user.userType === 'client_admin') {
    if (operation === 'switch_input') {
      return { allowed: true, reason: 'Client admin can switch input types' };
    }
    if (['api_data', 'iot_data', 'disconnect', 'reconnect'].includes(operation)) {
      return { allowed: true, reason: 'Client admin access' };
    }
    if (['manual_data', 'edit_manual', 'csv_upload'].includes(operation)) {
      return { allowed: true, reason: 'Client admin access' };
    }
  }

  // Get node information for role-based checks
  const flowchart = await Flowchart.findOne({ clientId, isActive: true });
  if (!flowchart) {
    return { allowed: false, reason: 'Flowchart not found' };
  }

  const node = flowchart.nodes.find(n => n.id === nodeId);
  if (!node) {
    return { allowed: false, reason: 'Node not found' };
  }

  // Employee head permissions
  if (user.userType === 'client_employee_head') {
    const isAssignedToNode = node.details.employeeHeadId?.toString() === userId.toString();
    
    if (!isAssignedToNode) {
      return { allowed: false, reason: 'Not assigned to this node' };
    }

    if (['api_data', 'iot_data', 'disconnect', 'reconnect', 'manual_data', 'edit_manual', 'csv_upload'].includes(operation)) {
      return { allowed: true, reason: 'Employee head of assigned node' };
    }
  }

  // Employee permissions for manual operations only
  if (user.userType === 'employee' && ['manual_data', 'edit_manual', 'csv_upload'].includes(operation)) {
    if (scopeIdentifier) {
      const scope = node.details.scopeDetails.find(s => s.scopeIdentifier === scopeIdentifier);
      if (!scope) {
        return { allowed: false, reason: 'Scope not found' };
      }
      
      const assignedEmployees = scope.assignedEmployees || [];
      const isAssignedToScope = assignedEmployees.map(id => id.toString()).includes(userId.toString());
      
      if (isAssignedToScope) {
        return { allowed: true, reason: 'Assigned employee to scope' };
      }
    }
  }

  return { allowed: false, reason: 'Insufficient permissions for this operation' };
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

// Helper function to process API data based on scope configuration
function processAPIData(apiData, scopeConfig) {
const pd = {};
if (scopeConfig.scopeType === 'Scope 1') {
if (scopeConfig.categoryName.includes('Combustion')) {
pd.fuelConsumption = apiData.fuel_consumed || apiData.consumption || 0;
}
// ← NEW: SF₆‐specific must come before the generic fugitive check
else if (
scopeConfig.categoryName.includes('Fugitive') &&
/SF6/i.test(scopeConfig.activity)
) {
pd.nameplateCapacity = apiData.nameplateCapacity ?? 0;
pd.defaultLeakageRate = apiData.defaultLeakageRate ?? 0;
pd.decreaseInventory = apiData.decreaseInventory ?? 0;
pd.acquisitions = apiData.acquisitions ?? 0;
pd.disbursements = apiData.disbursements ?? 0;
pd.netCapacityIncrease= apiData.netCapacityIncrease ?? 0;
}
   else if (
    scopeConfig.categoryName.includes('Fugitive') &&
    /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)
  ) {
    // accept camelCase or snake_case inputs
    pd.activityData       =
         apiData.activityData
      ?? apiData.activity_data
      ?? 0;
    pd.numberOfComponents =
         apiData.numberOfComponents
      ?? apiData.number_of_components
      ?? 0;
  }
else if (
scopeConfig.categoryName.includes('Fugitive') ||
/ref.*?geration/i.test(scopeConfig.activity)
) {
pd.numberOfUnits = apiData.unit_count || 0;
pd.leakageRate = apiData.leakage ?? 0;
pd.installedCapacity= apiData.installedCapacity || 0;
pd.endYearCapacity = apiData.endYearCapacity || 0;
pd.purchases = apiData.purchases || 0;
pd.disposals = apiData.disposals || 0;
}
  
// Process Emission–type
else if (scopeConfig.categoryName.includes('Process Emission')) {
// Tier 1 process
pd.productionOutput = apiData.productionOutput
?? apiData.production_output
?? 0;
// Tier 2 process
pd.rawMaterialInput = apiData.rawMaterialInput
?? apiData.raw_material_input
?? 0;
}
}
else if (scopeConfig.scopeType === 'Scope 2') {
pd.consumed_electricity = apiData.electricity
|| apiData.power_consumption
|| 0;
}
 // ───────── Scope 3 ───────── 
else if (scopeConfig.scopeType === 'Scope 3') {
  switch (scopeConfig.categoryName) {

    // Purchased Goods and Services
    case 'Purchased Goods and Services':
      if (scopeConfig.calculationModel === 'tier 1') {
        // spend‐based
        pd.procurementSpend   = apiData.procurementSpend   ?? 0;
      } else if (scopeConfig.calculationModel === 'tier 2') {
        // quantity‐based
        pd.physicalQuantity   = apiData.physicalQuantity   ?? 0;
      }
      break;
    // Capital Goods
    case 'Capital Goods':
      if (scopeConfig.calculationModel === 'tier 1') {
        // spend‐based
        pd.procurementSpend   = apiData.procurementSpend   ?? 0;
      } else if (scopeConfig.calculationModel === 'tier 2') {
        // quantity‐based
        pd.assetQuantity      = apiData.assetQuantity      ?? 0;
      }
      break;
    case 'Fuel and energy':
  // Always pull these three fields from the incoming API data
  pd.fuelConsumed = apiData.fuelConsumed
                 ?? apiData.fuel_consumed
                 ?? 0;
  pd.electricityConsumption = apiData.electricityConsumption
                            ?? apiData.electricity_consumed
                            ?? 0;
  pd.tdLossFactor = apiData.tdLossFactor
                  ?? apiData.td_loss_factor
                  ?? 0;
  break;

    case 'Upstream Transport and Distribution':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.transportationSpend = apiData.transportationSpend 
                                 ?? apiData.transportation_spend 
                                 ?? 0;
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.mass     = apiData.mass     ?? 0;
          pd.distance = apiData.distance ?? 0;
        }
  break;
    case 'Waste Generated in Operation':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.wasteMass = apiData.wasteMass
                       ?? apiData.mass_waste
                       ?? 0;
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.wasteMass = apiData.wasteMass ?? 0;
          // if you collect a separate “treatment” mass or type,
           pd.treatmentType = apiData.treatmentType
        }
    break;
    case 'Business Travel':
      if (scopeConfig.calculationModel === 'tier 1') {
        pd.travelSpend      = apiData.travelSpend      ?? apiData.travel_spend    ?? 0;
        pd.hotelNights      = apiData.hotelNights      ?? apiData.hotel_nights    ?? 0;
      } else if (scopeConfig.calculationModel === 'tier 2') {
        pd.numberOfPassengers  = apiData.numberOfPassengers ?? apiData.passengers ?? 0;
        pd.distanceTravelled   = apiData.distanceTravelled  ?? apiData.distance   ?? 0;
        pd.hotelNights         = apiData.hotelNights        ?? apiData.hotel_nights ?? 0;
      }
      break;
    case 'Employee Commuting':
      if(scopeConfig.calculationModel === 'tier 1'){
        pd.employeeCount = apiData.employeeCount ?? apiData.employee_Count ?? 0;
        pd.averageCommuteDistance = apiData.averageCommuteDistance ?? apiData.average_Commuting_Distance ?? 0;
        pd.workingDays = apiData.workingDays ?? apiData.working_Days ?? 0;
      
      }else if (scopeConfig.calculationModel === 'tier 2'){
         pd.note = 'Tier 2 calculation in progress';
        
      }
    case 'Upstream Leased Assets':
    case 'Downstream Leased Assets':
    if (scopeConfig.calculationModel === 'tier 1') {
      pd.leasedArea = apiData.leasedArea
                   ?? apiData.leased_Area
                   ?? 0;
    }
    else if (scopeConfig.calculationModel === 'tier 2') {
      pd.leasedArea        = apiData.leasedArea
                           ?? apiData.leased_Area
                           ?? 0;
      pd.totalArea         = apiData.totalArea
                           ?? apiData.total_Area
                           ?? 0;
      // energyConsumption for Case A
      pd.energyConsumption = apiData.energyConsumption
                           ?? apiData.energy_Consumption
                           ?? 0;
      // Building total S1+S2 now comes from the payload
      pd.BuildingTotalS1_S2 = apiData.BuildingTotalS1_S2
                           ?? apiData.buildingTotalS1S2
                           ?? 0;
    }
    break;
    case 'Downstream Transport and Distribution':
    if (scopeConfig.calculationModel === 'tier 1') {
      // Tier 1: spend‐based
      pd.transportSpend = apiData.transportSpend
                       ?? apiData.transport_Spend
                       ?? apiData.spendTransport
                       ?? 0;
    }
    else if (scopeConfig.calculationModel === 'tier 2') {
      // Tier 2: mass‐km based
      pd.mass     = apiData.mass     ?? apiData.transportMass   ?? 0;
      pd.distance = apiData.distance ?? apiData.transportDistance ?? 0;
    }
    break;
      // ───────── Processing of Sold Products ─────────
    case 'Processing of Sold Products':
    if (scopeConfig.calculationModel === 'tier 1') {
      // Tier 1: Quantity‐based
      pd.productQuantity = apiData.productQuantity
                        ?? apiData.product_quantity
                        ?? 0;
    }
    else if (scopeConfig.calculationModel === 'tier 2') {
      // Tier 2: same quantity + customerType for EF lookup
      pd.productQuantity = apiData.productQuantity
                        ?? apiData.product_quantity
                        ?? 0;
      pd.customerType    = apiData.customerType
                        ?? apiData.customer_type
                        ?? '';
    }
    break;
    case 'End-of-Life Treatment of Sold Products':
  if (scopeConfig.calculationModel === 'tier 1') {
    pd.massEol           = apiData.massEol           ?? apiData.mass_eol           ?? 0;
    pd.toDisposal        = apiData.toDisposal        ?? apiData.to_disposal        ?? 0;
    pd.toLandfill        = apiData.toLandfill        ?? apiData.to_landfill        ?? 0;
    pd.toIncineration    = apiData.toIncineration    ?? apiData.to_incineration    ?? 0;
  }
  break;

    // ───────── Use of Sold Products ─────────
    case 'Use of Sold Products':
    if (scopeConfig.calculationModel === 'tier 1') {
      // Tier 1: productQuantity × avgLifetimeEnergyConsumption × usePhase EF
      pd.productQuantity                   = apiData.productQuantity
                                           ?? apiData.product_quantity
                                           ?? 0;
      pd.averageLifetimeEnergyConsumption  = apiData.averageLifetimeEnergyConsumption
                                           ?? apiData.average_lifetime_energy_consumption
                                           ?? 0;
    } else if (scopeConfig.calculationModel === 'tier 2') {
      // Tier 2: productQuantity × usePattern × energyEfficiency × grid EF
      pd.productQuantity    = apiData.productQuantity
                            ?? apiData.product_quantity
                            ?? 0;
      pd.usePattern         = apiData.usePattern
                            ?? apiData.use_pattern
                            ?? 1;      // default 0 if missing
      pd.energyEfficiency   = apiData.energyEfficiency
                            ?? apiData.energy_efficiency
                            ?? 0;
    }
    break;
    case 'Franchises':
      if (scopeConfig.calculationModel === 'tier 1') {
        pd.franchiseCount            = apiData.franchiseCount
                                     ?? apiData.noOfFranchises
                                     ?? 0;
        pd.avgEmissionPerFranchise  = apiData.avgEmissionPerFranchise
                                     ?? apiData.averageEmissionPerFranchise
                                     ?? 0;
      } else if (scopeConfig.calculationModel === 'tier 2') {
        // Case A inputs
        pd.franchiseTotalS1Emission = apiData.franchiseTotalS1Emission
                                     ?? apiData.totalS1Emission
                                     ?? 0;
        pd.franchiseTotalS2Emission = apiData.franchiseTotalS2Emission
                                     ?? apiData.totalS2Emission
                                     ?? 0;
        // Case B input
        pd.energyConsumption        = apiData.energyConsumption
                                     ?? apiData.energy_Consumption
                                     ?? 0;
      }
      break;
    case 'Investments':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.investeeRevenue         = apiData.investeeRevenue         ?? apiData.investee_revenue         ?? 0;
          pd.equitySharePercentage   = apiData.equitySharePercentage   ?? apiData.equity_share_percentage   ?? 0;
        }
        else if (scopeConfig.calculationModel === 'tier 2') {
          // Case A inputs
          pd.investeeScope1Emission  = apiData.investeeScope1Emission  ?? apiData.scope1Emission          ?? 0;
          pd.investeeScope2Emission  = apiData.investeeScope2Emission  ?? apiData.scope2Emission          ?? 0;
          pd.equitySharePercentage   = apiData.equitySharePercentage   ?? apiData.equity_share_percentage ?? 0;
          // Case B input
          pd.energyConsumption       = apiData.energyConsumption       ?? apiData.energy_consumption     ?? 0;
        }
        break;
    // TODO: add other Scope 3 categories here
    // case 'Fuel- and energy-related activities': …
    // case 'Transportation and distribution': …
  }
}

 

return pd;
}
// Save API Data with cumulative tracking
const saveAPIData = async (req, res) => {
try {
const { clientId, nodeId, scopeIdentifier } = req.params;
const { data, date, time, dataValues, emissionFactor } = req.body;
// Check permissions for API data operations
const permissionCheck = await checkOperationPermission(req.user, clientId, nodeId, scopeIdentifier, 'api_data');
if (!permissionCheck.allowed) {
return res.status(403).json({
message: 'Permission denied',
reason: permissionCheck.reason
});
}
// Validate prerequisites
const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
if (!validation.isValid) {
return res.status(400).json({
message: 'Cannot process API data: ' + validation.message
});
}
// Find scope configuration
const flowchart = await Flowchart.findOne({ clientId, isActive: true });
if (!flowchart) {
return res.status(404).json({ message: 'Flowchart not found' });
}
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
const processedData = processAPIData(dataValues, scopeConfig);
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
uploadedBy: req.user._id,
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
createdBy: req.user._id
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



// ─────────────────────────────────────────────────────────────
// 1) Helper to normalize IoT payloads into the same shape as API
// ─────────────────────────────────────────────────────────────
/**
 * Helper function to process IoT data based on scope configuration
 */

function processIoTData(iotData, scopeConfig) {
  const pd = {};

  // ───────── Scope 1 ─────────
  if (scopeConfig.scopeType === 'Scope 1') {
    // Combustion
    if (scopeConfig.categoryName.includes('Combustion')) {
      pd.fuelConsumption = iotData.fuel_consumed || iotData.consumption || 0;
    }
    // SF₆‐specific fugitive
    else if (
      scopeConfig.categoryName.includes('Fugitive') &&
      /SF6/i.test(scopeConfig.activity)
    ) {
      pd.nameplateCapacity   = iotData.nameplateCapacity     ?? 0;
      pd.defaultLeakageRate  = iotData.defaultLeakageRate    ?? 0;
      pd.decreaseInventory   = iotData.decreaseInventory     ?? 0;
      pd.acquisitions        = iotData.acquisitions          ?? 0;
      pd.disbursements       = iotData.disbursements         ?? 0;
      pd.netCapacityIncrease = iotData.netCapacityIncrease   ?? 0;
    }
    // CH₄‐Leaks fugitive
    else if (
    scopeConfig.categoryName.includes('Fugitive') &&
    /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)
  ) {
    // accept camelCase or snake_case inputs
    pd.activityData       =
         iotData.activityData
      ?? iotData.activity_data
      ?? 0;
    pd.numberOfComponents =
         iotData.numberOfComponents
      ?? iotData.number_of_components
      ?? 0;
  }
    // Generic fugitive / refrigeration
    else if (
      scopeConfig.categoryName.includes('Fugitive') ||
      /ref.*?geration/i.test(scopeConfig.activity)
    ) {
      pd.numberOfUnits     = iotData.unit_count         || 0;
      pd.leakageRate       = iotData.leakage            ?? 0;
      pd.installedCapacity = iotData.installedCapacity || 0;
      pd.endYearCapacity   = iotData.endYearCapacity    || 0;
      pd.purchases         = iotData.purchases          || 0;
      pd.disposals         = iotData.disposals          || 0;
    }
    // Process Emission
    else if (scopeConfig.categoryName.includes('Process Emission')) {
      // Tier 1
      pd.productionOutput = iotData.productionOutput
                          ?? iotData.production_output
                          ?? 0;
      // Tier 2
      pd.rawMaterialInput = iotData.rawMaterialInput
                          ?? iotData.raw_material_input
                          ?? 0;
    }
  }

  // ───────── Scope 2 ─────────
  else if (scopeConfig.scopeType === 'Scope 2') {
    pd.consumed_electricity = iotData.electricity
                           || iotData.power_consumption
                           || 0;
  }

  // ───────── Scope 3 ─────────
  else if (scopeConfig.scopeType === 'Scope 3') {
    switch (scopeConfig.categoryName) {
      // Purchased Goods and Services
      case 'Purchased Goods and Services':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.procurementSpend = iotData.procurementSpend ?? 0;
        } else {
          pd.physicalQuantity = iotData.physicalQuantity ?? 0;
        }
        break;

      // Capital Goods
      case 'Capital Goods':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.procurementSpend = iotData.procurementSpend ?? 0;
        } else {
          pd.assetQuantity = iotData.assetQuantity ?? 0;
        }
        break;

      // Fuel and energy
      case 'Fuel and energy':
        pd.fuelConsumed           = iotData.fuelConsumed
                                  ?? iotData.fuel_consumed
                                  ?? 0;
        pd.electricityConsumption = iotData.electricityConsumption
                                  ?? iotData.electricity_consumed
                                  ?? 0;
        pd.tdLossFactor           = iotData.tdLossFactor
                                  ?? iotData.td_loss_factor
                                  ?? 0;
        break;

      // Upstream Transport and Distribution
      case 'Upstream Transport and Distribution':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.transportationSpend = iotData.transportationSpend
                                 ?? iotData.transportation_spend
                                 ?? 0;
        } else {
          pd.mass     = iotData.mass     ?? 0;
          pd.distance = iotData.distance ?? 0;
        }
        break;

      // Waste Generated in Operation
      case 'Waste Generated in Operation':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.wasteMass = iotData.wasteMass
                       ?? iotData.mass_waste
                       ?? 0;
        } else {
          pd.wasteMass    = iotData.wasteMass ?? 0;
          pd.treatmentType= iotData.treatmentType;
        }
        break;

      // Business Travel
      case 'Business Travel':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.travelSpend = iotData.travelSpend    ?? iotData.travel_spend ?? 0;
          pd.hotelNights = iotData.hotelNights    ?? iotData.hotel_nights ?? 0;
        } else {
          pd.numberOfPassengers = iotData.numberOfPassengers ?? iotData.passengers ?? 0;
          pd.distanceTravelled  = iotData.distanceTravelled  ?? iotData.distance   ?? 0;
          pd.hotelNights        = iotData.hotelNights        ?? iotData.hotel_nights ?? 0;
        }
        break;

      // Employee Commuting
      case 'Employee Commuting':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.employeeCount          = iotData.employeeCount           ?? iotData.employee_Count           ?? 0;
          pd.averageCommuteDistance = iotData.averageCommuteDistance  ?? iotData.average_Commuting_Distance ?? 0;
          pd.workingDays            = iotData.workingDays             ?? iotData.working_Days             ?? 0;
        } else {
          pd.note = 'Tier 2 calculation in progress';
        }
        break;

      // Upstream & Downstream Leased Assets
      case 'Upstream Leased Assets':
      case 'Downstream Leased Assets':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.leasedArea = iotData.leasedArea ?? iotData.leased_Area ?? 0;
        } else {
          pd.leasedArea        = iotData.leasedArea        ?? iotData.leased_Area        ?? 0;
          pd.totalArea         = iotData.totalArea         ?? iotData.total_Area         ?? 0;
          pd.energyConsumption = iotData.energyConsumption ?? iotData.energy_Consumption ?? 0;
          pd.BuildingTotalS1_S2= iotData.BuildingTotalS1_S2   ?? iotData.buildingTotalS1S2   ?? 0;
        }
        break;

      // Downstream Transport and Distribution
      case 'Downstream Transport and Distribution':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.transportSpend = iotData.transportSpend
                            ?? iotData.transport_Spend
                            ?? iotData.spendTransport
                            ?? 0;
        } else {
          pd.mass     = iotData.mass     ?? iotData.transportMass   ?? 0;
          pd.distance = iotData.distance ?? iotData.transportDistance ?? 0;
        }
        break;

      // Processing of Sold Products
      case 'Processing of Sold Products':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.productQuantity = iotData.productQuantity ?? iotData.product_quantity ?? 0;
        } else {
          pd.productQuantity = iotData.productQuantity ?? iotData.product_quantity ?? 0;
          pd.customerType    = iotData.customerType    ?? iotData.customer_type    ?? '';
        }
        break;

      // End-of-Life Treatment of Sold Products
      case 'End-of-Life Treatment of Sold Products':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.massEol        = iotData.massEol        ?? iotData.mass_eol        ?? 0;
          pd.toDisposal     = iotData.toDisposal     ?? iotData.to_disposal     ?? 0;
          pd.toLandfill     = iotData.toLandfill     ?? iotData.to_landfill     ?? 0;
          pd.toIncineration = iotData.toIncineration ?? iotData.to_incineration ?? 0;
        }
        break;

      // Use of Sold Products
      case 'Use of Sold Products':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.productQuantity                  = iotData.productQuantity                   ?? iotData.product_quantity                   ?? 0;
          pd.averageLifetimeEnergyConsumption = iotData.averageLifetimeEnergyConsumption  ?? iotData.average_lifetime_energy_consumption ?? 0;
        } else {
          pd.productQuantity  = iotData.productQuantity  ?? iotData.product_quantity ?? 0;
          pd.usePattern       = iotData.usePattern       ?? iotData.use_pattern    ?? 1;
          pd.energyEfficiency = iotData.energyEfficiency ?? iotData.energy_efficiency ?? 0;
        }
        break;

      // Franchises
      case 'Franchises':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.franchiseCount           = iotData.franchiseCount           ?? iotData.noOfFranchises              ?? 0;
          pd.avgEmissionPerFranchise  = iotData.avgEmissionPerFranchise  ?? iotData.averageEmissionPerFranchise ?? 0;
        } else {
          pd.franchiseTotalS1Emission = iotData.franchiseTotalS1Emission ?? iotData.totalS1Emission ?? 0;
          pd.franchiseTotalS2Emission = iotData.franchiseTotalS2Emission ?? iotData.totalS2Emission ?? 0;
          pd.energyConsumption        = iotData.energyConsumption        ?? iotData.energy_Consumption ?? 0;
        }
        break;

      // Investments
      case 'Investments':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.investeeRevenue       = iotData.investeeRevenue       ?? iotData.investee_revenue       ?? 0;
          pd.equitySharePercentage = iotData.equitySharePercentage ?? iotData.equity_share_percentage ?? 0;
        } else {
          pd.investeeScope1Emission  = iotData.investeeScope1Emission  ?? iotData.scope1Emission          ?? 0;
          pd.investeeScope2Emission  = iotData.investeeScope2Emission  ?? iotData.scope2Emission          ?? 0;
          pd.equitySharePercentage    = iotData.equitySharePercentage ?? iotData.equity_share_percentage ?? 0;
          pd.energyConsumption        = iotData.energyConsumption     ?? iotData.energy_consumption      ?? 0;
        }
        break;

      // …add any other Scope 3 categories here…
    }
  }

  return pd;
}



// Helper functions for date/time formatting
function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}:${month}:${year}`;
}

function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}
// Save IoT Data with cumulative tracking
const saveIoTData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { data, date, time, dataValues, emissionFactor } = req.body;

    // 1) Permission check
    const permissionCheck = await checkOperationPermission(
      req.user, clientId, nodeId, scopeIdentifier, 'iot_data'
    );
    if (!permissionCheck.allowed) {
      return res.status(403).json({
        message: 'Permission denied',
        reason: permissionCheck.reason
      });
    }

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
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }
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

    // 4) Normalize incoming IoT payload
    const iotData = dataValues || data;
    const processedData = processIoTData(iotData, scopeConfig);

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
        uploadedBy:   req.user._id,
        dataSource:   'IOT'
      },
      isEditable:      false,
      processingStatus:'pending'
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
          createdBy: req.user._id
        }
      },
      { upsert: true, new: true }
    );
    collectionConfig.updateCollectionStatus(entry._id, timestamp);
    await collectionConfig.save();

    // 10) Prepare calculated emissions for response
    const { incoming: inMap, cumulative: cumMap, metadata } = entry.calculatedEmissions || {};
    const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});

    // 11) Emit a real-time update
    emitDataUpdate('iot-data-saved', {
      clientId,
      nodeId,
      scopeIdentifier,
      dataId: entry._id,
      timestamp,
      dataValues:       Object.fromEntries(entry.dataValues),
      cumulativeValues: Object.fromEntries(entry.cumulativeValues),
      highData:         Object.fromEntries(entry.highData),
      lowData:          Object.fromEntries(entry.lowData),
      lastEnteredData:  Object.fromEntries(entry.lastEnteredData),
      calculatedEmissions: {
        incoming:   mapToObject(inMap),
        cumulative: mapToObject(cumMap),
        metadata:   metadata || {}
      }
    });

    // 12) Return the same shape as your API endpoint
    res.status(201).json({
      message: 'IoT data saved successfully',
      dataId: entry._id,
      cumulativeValues: Object.fromEntries(entry.cumulativeValues),
      highData:         Object.fromEntries(entry.highData),
      lowData:          Object.fromEntries(entry.lowData),
      lastEnteredData:  Object.fromEntries(entry.lastEnteredData),
      calculatedEmissions: {
        incoming:   mapToObject(inMap),
        cumulative: mapToObject(cumMap),
        metadata:   metadata || {}
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

/**
 * Normalize a manual‐entry payload into the same shape your 
 * emission‐calculation logic expects.
 */
function processManualData(rawValues, scopeConfig) {
  const pd = {};

  if (scopeConfig.scopeType === 'Scope 1') {
    if (scopeConfig.categoryName.includes('Combustion')) {
      pd.fuelConsumption = rawValues.fuel_consumed || rawValues.consumption || rawValues.fuelConsumption || 0;
    } 
    // SF₆‐specific fugitive (must come before generic fugitive)
    else if (scopeConfig.categoryName.includes('Fugitive') && /SF6/i.test(scopeConfig.activity)) {
      pd.nameplateCapacity   = rawValues.nameplateCapacity   ?? 0;
      pd.defaultLeakageRate  = rawValues.defaultLeakageRate  ?? 0;
      pd.decreaseInventory   = rawValues.decreaseInventory   ?? 0;
      pd.acquisitions        = rawValues.acquisitions        ?? 0;
      pd.disbursements       = rawValues.disbursements       ?? 0;
      pd.netCapacityIncrease = rawValues.netCapacityIncrease ?? 0;
    } 
    // CH₄-Leaks fugitive
    else if (scopeConfig.categoryName.includes('Fugitive') && /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)) {
      pd.activityData       = rawValues.activityData       ?? rawValues.activity_data       ?? 0;
      pd.numberOfComponents = rawValues.numberOfComponents ?? rawValues.number_of_components ?? 0;
    } 
    // Generic fugitive / refrigeration
    else if (
      scopeConfig.categoryName.includes('Fugitive') ||
      /ref.*?geration/i.test(scopeConfig.activity)
    ) {
      pd.numberOfUnits     = rawValues.unit_count         || 0;
      pd.leakageRate       = rawValues.leakage            ?? 0;
      pd.installedCapacity = rawValues.installedCapacity || 0;
      pd.endYearCapacity   = rawValues.endYearCapacity    || 0;
      pd.purchases         = rawValues.purchases          || 0;
      pd.disposals         = rawValues.disposals          || 0;
    }
    // // Generic fugitive (non-refrigeration)
    // else if (scopeConfig.categoryName.includes('Fugitive')) {
    //   pd.numberOfUnits = rawValues.numberOfUnits || rawValues.unit_count || 0;
    //   pd.leakageRate = rawValues.leakageRate || rawValues.leakage ?? 0;
    //   pd.installedCapacity = rawValues.installedCapacity || 0;
    //   pd.endYearCapacity = rawValues.endYearCapacity || 0;
    //   pd.purchases = rawValues.purchases || 0;
    //   pd.disposals = rawValues.disposals || 0;
    // } 
    // Process Emission (must come AFTER all fugitive checks)
    else if (scopeConfig.categoryName.includes('Process Emission')) {
      pd.productionOutput = rawValues.productionOutput   ?? rawValues.production_output   ?? 0;
      pd.rawMaterialInput = rawValues.rawMaterialInput   ?? rawValues.raw_material_input ?? 0;
    }
  } 
  else if (scopeConfig.scopeType === 'Scope 2') {
    // Map category to field name
    const categoryFieldMap = {
      'Purchased Electricity': 'consumed_electricity',
      'Purchased Steam': 'consumed_steam',
      'Purchased Heating': 'consumed_heating',
      'Purchased Cooling': 'consumed_cooling'
    };
    
    const fieldKey = categoryFieldMap[scopeConfig.categoryName] || 'consumed_electricity';
    
    if (fieldKey === 'consumed_electricity') {
      pd.consumed_electricity = rawValues.electricity || rawValues.power_consumption || rawValues.consumed_electricity || 0;
    } else if (fieldKey === 'consumed_steam') {
      pd.consumed_steam = rawValues.steam || rawValues.consumed_steam || 0;
    } else if (fieldKey === 'consumed_heating') {
      pd.consumed_heating = rawValues.heating || rawValues.consumed_heating || 0;
    } else if (fieldKey === 'consumed_cooling') {
      pd.consumed_cooling = rawValues.cooling || rawValues.consumed_cooling || 0;
    }
  } 
  else if (scopeConfig.scopeType === 'Scope 3') {
    switch (scopeConfig.categoryName) {
      case 'Purchased Goods and Services':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.procurementSpend = rawValues.procurementSpend ?? rawValues.procurement_spend ?? 0;
        } else {
          pd.physicalQuantity = rawValues.physicalQuantity ?? rawValues.physical_quantity ?? 0;
        }
        break;
        
      case 'Capital Goods':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.procurementSpend = rawValues.procurementSpend ?? rawValues.procurement_spend ?? 0;
        } else {
          pd.assetQuantity = rawValues.assetQuantity ?? rawValues.asset_quantity ?? 0;
        }
        break;
        
      case 'Fuel and energy':
        pd.fuelConsumed = rawValues.fuelConsumed ?? rawValues.fuel_consumed ?? 0;
        pd.electricityConsumption = rawValues.electricityConsumption ?? rawValues.electricity_consumed ?? 0;
        pd.tdLossFactor = rawValues.tdLossFactor ?? rawValues.td_loss_factor ?? 0;
        break;
        
      case 'Upstream Transport and Distribution':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.transportationSpend = rawValues.transportationSpend ?? rawValues.transportation_spend ?? 0;
        } else {
          pd.mass = rawValues.mass ?? 0;
          pd.distance = rawValues.distance ?? 0;
        }
        break;
        
      case 'Waste Generated in Operation':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.wasteMass = rawValues.wasteMass ?? rawValues.mass_waste ?? 0;
        } else {
          pd.wasteMass = rawValues.wasteMass ?? 0;
          pd.treatmentType = rawValues.treatmentType;
        }
        break;
        
      case 'Business Travel':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.travelSpend = rawValues.travelSpend ?? rawValues.travel_spend ?? 0;
          pd.hotelNights = rawValues.hotelNights ?? rawValues.hotel_nights ?? 0;
        } else {
          pd.numberOfPassengers = rawValues.numberOfPassengers ?? rawValues.passengers ?? 0;
          pd.distanceTravelled = rawValues.distanceTravelled ?? rawValues.distance ?? 0;
          pd.hotelNights = rawValues.hotelNights ?? rawValues.hotel_nights ?? 0;
        }
        break;
        
      case 'Employee Commuting':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.employeeCount = rawValues.employeeCount ?? rawValues.employee_Count ?? 0;
          pd.averageCommuteDistance = rawValues.averageCommuteDistance ?? rawValues.average_Commuting_Distance ?? 0;
          pd.workingDays = rawValues.workingDays ?? rawValues.working_Days ?? 0;
        } else {
          pd.note = 'Tier 2 calculation in progress';
        }
        break;
        
      case 'Upstream Leased Assets':
      case 'Downstream Leased Assets':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.leasedArea = rawValues.leasedArea ?? rawValues.leased_Area ?? 0;
        } else {
          pd.leasedArea = rawValues.leasedArea ?? rawValues.leased_Area ?? 0;
          pd.totalArea = rawValues.totalArea ?? rawValues.total_Area ?? 0;
          pd.energyConsumption = rawValues.energyConsumption ?? rawValues.energy_Consumption ?? 0;
          pd.BuildingTotalS1_S2 = rawValues.BuildingTotalS1_S2 ?? rawValues.buildingTotalS1S2 ?? 0;
        }
        break;
        
      case 'Downstream Transport and Distribution':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.transportSpend = rawValues.transportSpend ?? rawValues.transport_Spend ?? rawValues.spendTransport ?? 0;
        } else {
          pd.mass = rawValues.mass ?? rawValues.transportMass ?? 0;
          pd.distance = rawValues.distance ?? rawValues.transportDistance ?? 0;
        }
        break;
        
      case 'Processing of Sold Products':
        pd.productQuantity = rawValues.productQuantity ?? rawValues.product_quantity ?? 0;
        if (scopeConfig.calculationModel === 'tier 2') {
          pd.customerType = rawValues.customerType ?? rawValues.customer_type ?? '';
        }
        break;
        
      case 'End-of-Life Treatment of Sold Products':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.massEol = rawValues.massEol ?? rawValues.mass_eol ?? 0;
          pd.toDisposal = rawValues.toDisposal ?? rawValues.to_disposal ?? 0;
          pd.toLandfill = rawValues.toLandfill ?? rawValues.to_landfill ?? 0;
          pd.toIncineration = rawValues.toIncineration ?? rawValues.to_incineration ?? 0;
        }
        break;
        
      case 'Use of Sold Products':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.productQuantity = rawValues.productQuantity ?? rawValues.product_quantity ?? 0;
          pd.averageLifetimeEnergyConsumption = rawValues.averageLifetimeEnergyConsumption ?? rawValues.average_lifetime_energy_consumption ?? 0;
        } else {
          pd.productQuantity = rawValues.productQuantity ?? rawValues.product_quantity ?? 0;
          pd.usePattern = rawValues.usePattern ?? rawValues.use_pattern ?? 1;
          pd.energyEfficiency = rawValues.energyEfficiency ?? rawValues.energy_efficiency ?? 0;
        }
        break;
        
      case 'Franchises':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.franchiseCount = rawValues.franchiseCount ?? rawValues.noOfFranchises ?? 0;
          pd.avgEmissionPerFranchise = rawValues.avgEmissionPerFranchise ?? rawValues.averageEmissionPerFranchise ?? 0;
        } else {
          pd.franchiseTotalS1Emission = rawValues.franchiseTotalS1Emission ?? rawValues.totalS1Emission ?? 0;
          pd.franchiseTotalS2Emission = rawValues.franchiseTotalS2Emission ?? rawValues.totalS2Emission ?? 0;
          pd.energyConsumption = rawValues.energyConsumption ?? rawValues.energy_Consumption ?? 0;
        }
        break;
        
      case 'Investments':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.investeeRevenue = rawValues.investeeRevenue ?? rawValues.investee_revenue ?? 0;
          pd.equitySharePercentage = rawValues.equitySharePercentage ?? rawValues.equity_share_percentage ?? 0;
        } else {
          pd.investeeScope1Emission = rawValues.investeeScope1Emission ?? rawValues.scope1Emission ?? 0;
          pd.investeeScope2Emission = rawValues.investeeScope2Emission ?? rawValues.scope2Emission ?? 0;
          pd.equitySharePercentage = rawValues.equitySharePercentage ?? rawValues.equity_share_percentage ?? 0;
          pd.energyConsumption = rawValues.energyConsumption ?? rawValues.energy_consumption ?? 0;
        }
        break;
        
      default:
        break;
    }
  }
  
  return pd;
}

// Save Manual Data Entry (with support for multiple entries with different dates)
const saveManualData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { entries, singleEntry } = req.body; // Support both formats
    
    // Check permissions for manual data operations
    const permissionCheck = await checkOperationPermission(req.user, clientId, nodeId, scopeIdentifier, 'manual_data');
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: permissionCheck.reason 
      });
    }
    
    // Find scope configuration
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }
    
    // Validate prerequisites
    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation.isValid) {
      return res.status(400).json({
        message: 'Cannot process manual data: ' + validation.message
      });
    }
    
    let scopeConfig = validation.scopeConfig;
    for (const node of flowchart.nodes) {
      if (node.id === nodeId) {
        const scope = node.details.scopeDetails.find(
          s => s.scopeIdentifier === scopeIdentifier
        );
        if (scope && scope.inputType === 'manual') {
          scopeConfig = scope;
          break;
        }
      }
    }
    
    if (!scopeConfig) {
      return res.status(400).json({ message: 'Invalid manual scope configuration' });
    }
    
    // Handle both single entry and multiple entries format
    let dataEntries = [];
    
    // Check if it's a single entry (backward compatibility)
    if (singleEntry || (!entries && req.body.dataValues)) {
      dataEntries = [{
        date: req.body.date,
        time: req.body.time,
        dataValues: req.body.dataValues,
        emissionFactor: req.body.emissionFactor
      }];
    } else if (entries && Array.isArray(entries)) {
      // Multiple entries format
      dataEntries = entries;
    } else {
      return res.status(400).json({ 
        message: 'Invalid request format. Expected either entries array or single entry data.' 
      });
    }
    
    // Validate that we have at least one entry
    if (dataEntries.length === 0) {
      return res.status(400).json({ message: 'No data entries provided' });
    }
    
    // Process and validate each entry
    const processedEntries = [];
    const validationErrors = [];
    
    for (let index = 0; index < dataEntries.length; index++) {
      const entryData = dataEntries[index];
      const { date: rawDateInput, time: rawTimeInput, dataValues, emissionFactor } = entryData;

      // Conditionally require date and time for multiple entries
      if (dataEntries.length > 1 && (!rawDateInput || !rawTimeInput)) {
        validationErrors.push({
          index,
          error: 'Date and time are required for each entry when adding multiple entries.'
        });
        continue;
      }
      
      // Validate required fields
      if (!dataValues || Object.keys(dataValues).length === 0) {
        validationErrors.push({
          index,
          date: rawDateInput,
          error: 'Data values are required'
        });
        continue;
      }
      
      // Process date/time, defaulting to current IST if not provided for single entries
      const nowInIST = moment().utcOffset('+05:30');
      const rawDate = rawDateInput || nowInIST.format('DD/MM/YYYY');
      const rawTime = rawTimeInput || nowInIST.format('HH:mm:ss');
      
      let dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
      if (!dateMoment.isValid()) {
        dateMoment = moment(rawDate, 'YYYY-MM-DD', true); // allow alternate format
      }
      const timeMoment = moment(rawTime, 'HH:mm:ss', true);
      
      if (!dateMoment.isValid()) {
        validationErrors.push({
          index,
          date: rawDateInput,
          error: 'Invalid date format. Use DD/MM/YYYY or YYYY-MM-DD'
        });
        continue;
      }
      
      if (!timeMoment.isValid()) {
        validationErrors.push({
          index,
          date: rawDateInput,
          error: 'Invalid time format. Use HH:mm:ss'
        });
        continue;
      }
      
      const formattedDate = dateMoment.format('DD:MM:YYYY');
      const formattedTime = timeMoment.format('HH:mm:ss');
      
      const [day, month, year] = formattedDate.split(':').map(Number);
      const [hour, minute, second] = formattedTime.split(':').map(Number);
      const timestamp = new Date(year, month - 1, day, hour, minute, second);
      
      // Check for duplicate timestamps
      const isDuplicate = processedEntries.some(entry => 
        entry.timestamp.getTime() === timestamp.getTime()
      );
      
      if (isDuplicate) {
        validationErrors.push({
          index,
          date: rawDateInput,
          error: 'Duplicate timestamp. Each entry must have a unique date/time combination.'
        });
        continue;
      }
      
      // Normalize & ensure dataValues is a Map
      let dataMap;
      try {
        const processedData = processManualData(dataValues, scopeConfig);
        dataMap = ensureDataIsMap(processedData);
      } catch (error) {
        validationErrors.push({
          index,
          date: rawDateInput,
          error: 'Invalid data format: ' + error.message
        });
        continue;
      }
      
      processedEntries.push({
        clientId,
        nodeId,
        scopeIdentifier,
        scopeType: scopeConfig.scopeType,
        inputType: 'manual',
        date: formattedDate,
        time: formattedTime,
        timestamp,
        dataValues: dataMap,
        emissionFactor: emissionFactor || scopeConfig.emissionFactor || '',
        sourceDetails: {
          uploadedBy: req.user._id,
          dataSource: 'manual',
          batchId: `manual_${Date.now()}` // Add batch ID for tracking
        },
        isEditable: true,
        processingStatus: 'pending',
      });
    }
    
    
    // If all entries failed validation, return error
    if (processedEntries.length === 0 && validationErrors.length > 0) {
      return res.status(400).json({
        message: 'All entries failed validation',
        errors: validationErrors
      });
    }
    
    // Sort by timestamp to ensure proper cumulative calculation
    processedEntries.sort((a, b) => a.timestamp - b.timestamp);
    
    // Save entries one by one to ensure proper cumulative calculation
    const savedEntries = [];
    const saveErrors = [];
    
    console.log(`📝 Processing ${processedEntries.length} manual data entries...`);
    
    for (const entryData of processedEntries) {
      try {
        const entry = new DataEntry(entryData);
        await entry.save(); // Pre-save hook will calculate cumulative values
        
        console.log(`✅ Entry saved: ${entry.date} ${entry.time}`);
        
        // Trigger emission calculation for each entry
        const calcResult = await triggerEmissionCalculation(entry);
        
        if (calcResult && calcResult.success) {
          console.log(`🔥 Emissions calculated for entry: ${entry._id}`);
        }
        
        savedEntries.push(entry);
      } catch (error) {
        console.error(`❌ Error saving entry for ${entryData.date}:`, error);
        saveErrors.push({
          date: entryData.date,
          time: entryData.time,
          error: error.message
        });
      }
    }
    
    // Update collection config with latest entry
    if (savedEntries.length > 0) {
      const latestEntry = savedEntries[savedEntries.length - 1];
      const collectionConfig = await DataCollectionConfig.findOneAndUpdate(
        { clientId, nodeId, scopeIdentifier },
        {
          $setOnInsert: {
            scopeType: scopeConfig.scopeType,
            inputType: 'manual',
            collectionFrequency: scopeConfig.collectionFrequency || 'monthly',
            createdBy: req.user._id
          }
        },
        { upsert: true, new: true }
      );
      
      collectionConfig.updateCollectionStatus(latestEntry._id, latestEntry.timestamp);
      await collectionConfig.save();
    }
    
    // Emit real-time update for each saved entry with calculated emissions
    for (const entry of savedEntries) {
      const { incoming: inMap, cumulative: cumMap, metadata } = entry.calculatedEmissions || {};
      const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
      
      emitDataUpdate('manual-data-saved', {
        clientId,
        nodeId,
        scopeIdentifier,
        dataId: entry._id,
        timestamp: entry.timestamp,
        date: entry.date,
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
    }
    
    // Prepare response
    const response = {
      message: `Successfully saved ${savedEntries.length} out of ${dataEntries.length} entries`,
      summary: {
        totalSubmitted: dataEntries.length,
        successfullySaved: savedEntries.length,
        validationErrors: validationErrors.length,
        saveErrors: saveErrors.length
      },
      savedEntries: savedEntries.map(entry => ({
        dataId: entry._id,
        date: entry.date,
        time: entry.time,
        timestamp: entry.timestamp,
        dataValues: Object.fromEntries(entry.dataValues),
        emissionsSummary: entry.emissionsSummary || null
      }))
    };
    
    // Include latest cumulative values with emissions
    if (savedEntries.length > 0) {
      const lastEntry = savedEntries[savedEntries.length - 1];
      const { incoming: inMap, cumulative: cumMap, metadata } = lastEntry.calculatedEmissions || {};
      const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
      
      response.latestCumulative = {
        date: lastEntry.date,
        time: lastEntry.time,
        cumulativeValues: Object.fromEntries(lastEntry.cumulativeValues),
        highData: Object.fromEntries(lastEntry.highData),
        lowData: Object.fromEntries(lastEntry.lowData),
        lastEnteredData: Object.fromEntries(lastEntry.lastEnteredData),
        calculatedEmissions: {
          incoming: mapToObject(inMap),
          cumulative: mapToObject(cumMap),
          metadata: metadata || {}
        }
      };
    }
    
    // Add errors to response if any
    if (validationErrors.length > 0) {
      response.validationErrors = validationErrors;
    }
    
    if (saveErrors.length > 0) {
      response.saveErrors = saveErrors;
    }
    
    // Determine appropriate status code
    const statusCode = savedEntries.length === dataEntries.length ? 201 : 
                      savedEntries.length > 0 ? 207 : // Partial success
                      400; // All failed
    
    res.status(statusCode).json(response);
    
  } catch (error) {
    console.error('Save manual data error:', error);
    res.status(500).json({ 
      message: 'Failed to save manual data', 
      error: error.message 
    });
  }
};


/**
 * Normalize a CSV row into the same shape your emission‐calculation logic expects.
 */
function processCSVData(rawValues, scopeConfig) {
  const pd = {};

  // Helper function to parse numbers from CSV strings
  const parseNumber = (value) => {
    const num = Number(value);
    return isNaN(num) ? 0 : num;
  };

  // ───────── Scope 1 ─────────
  if (scopeConfig.scopeType === 'Scope 1') {
    // Combustion (Stationary/Mobile)
    if (scopeConfig.categoryName.includes('Combustion')) {
      pd.fuelConsumption = parseNumber(
        rawValues.fuel_consumed ||
        rawValues.consumption ||
        rawValues.fuelConsumption ||
        rawValues.fuel_consumption
      );
    }
    // SF₆-specific fugitive (must come before generic fugitive)
    else if (
      scopeConfig.categoryName.includes('Fugitive') &&
      /SF6/i.test(scopeConfig.activity)
    ) {
      pd.nameplateCapacity   = parseNumber(rawValues.nameplateCapacity || rawValues.nameplate_capacity);
      pd.defaultLeakageRate  = parseNumber(rawValues.defaultLeakageRate || rawValues.default_leakage_rate);
      pd.decreaseInventory   = parseNumber(rawValues.decreaseInventory || rawValues.decrease_inventory);
      pd.acquisitions        = parseNumber(rawValues.acquisitions);
      pd.disbursements       = parseNumber(rawValues.disbursements);
      pd.netCapacityIncrease = parseNumber(rawValues.netCapacityIncrease || rawValues.net_capacity_increase);
    }
    // CH₄-Leaks fugitive
    else if (
      scopeConfig.categoryName.includes('Fugitive') &&
      /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)
    ) {
      pd.activityData       = parseNumber(
        rawValues.activityData ||
        rawValues.activity_data
      );
      pd.numberOfComponents = parseNumber(
        rawValues.numberOfComponents ||
        rawValues.number_of_components
      );
    }
    // Generic fugitive / refrigeration
    else if (
      scopeConfig.categoryName.includes('Fugitive') ||
      /ref.*?geration/i.test(scopeConfig.activity)
    ) {
      pd.numberOfUnits     = parseNumber(rawValues.numberOfUnits || rawValues.number_of_units || rawValues.unit_count);
      pd.leakageRate       = parseNumber(rawValues.leakageRate || rawValues.leakage_rate || rawValues.leakage) 
                          || scopeConfig.emissionFactorValues?.customEmissionFactor?.leakageRate 
                          || 0;
      pd.installedCapacity = parseNumber(rawValues.installedCapacity || rawValues.installed_capacity);
      pd.endYearCapacity   = parseNumber(rawValues.endYearCapacity || rawValues.end_year_capacity);
      pd.purchases         = parseNumber(rawValues.purchases);
      pd.disposals         = parseNumber(rawValues.disposals);
    }
    // Process Emission
    else if (scopeConfig.categoryName.includes('Process Emission') || scopeConfig.categoryName.includes('Process Emissions')) {
      // Tier 1
      pd.productionOutput = parseNumber(
        rawValues.productionOutput ||
        rawValues.production_output
      );
      // Tier 2
      pd.rawMaterialInput = parseNumber(
        rawValues.rawMaterialInput ||
        rawValues.raw_material_input
      );
    }
  }

  // ───────── Scope 2 ─────────
  else if (scopeConfig.scopeType === 'Scope 2') {
    const categoryFieldMap = {
      'Purchased Electricity': 'consumed_electricity',
      'Purchased Steam': 'consumed_steam',
      'Purchased Heating': 'consumed_heating',
      'Purchased Cooling': 'consumed_cooling'
    };

    const fieldKey = categoryFieldMap[scopeConfig.categoryName];
    
    if (fieldKey === 'consumed_electricity') {
      pd.consumed_electricity = parseNumber(
        rawValues.consumed_electricity ||
        rawValues.electricity ||
        rawValues.power_consumption ||
        rawValues.electricity_consumed
      );
    } else if (fieldKey === 'consumed_steam') {
      pd.consumed_steam = parseNumber(
        rawValues.consumed_steam ||
        rawValues.steam ||
        rawValues.steam_consumed
      );
    } else if (fieldKey === 'consumed_heating') {
      pd.consumed_heating = parseNumber(
        rawValues.consumed_heating ||
        rawValues.heating ||
        rawValues.heating_consumed
      );
    } else if (fieldKey === 'consumed_cooling') {
      pd.consumed_cooling = parseNumber(
        rawValues.consumed_cooling ||
        rawValues.cooling ||
        rawValues.cooling_consumed
      );
    }
  }

  // ───────── Scope 3 ─────────
  else if (scopeConfig.scopeType === 'Scope 3') {
    switch (scopeConfig.categoryName) {
      // (1) Purchased Goods and Services
      case 'Purchased Goods and Services':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.procurementSpend = parseNumber(
            rawValues.procurementSpend ||
            rawValues.procurement_spend
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.physicalQuantity = parseNumber(
            rawValues.physicalQuantity ||
            rawValues.physical_quantity
          );
        }
        break;

      // (2) Capital Goods
      case 'Capital Goods':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.procurementSpend = parseNumber(
            rawValues.procurementSpend ||
            rawValues.procurement_spend ||
            rawValues.capital_spend
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.assetQuantity = parseNumber(
            rawValues.assetQuantity ||
            rawValues.asset_quantity
          );
        }
        break;

      // (3) Fuel and Energy
      case 'Fuel and energy':
        pd.fuelConsumed = parseNumber(
          rawValues.fuelConsumed ||
          rawValues.fuel_consumed
        );
        pd.electricityConsumption = parseNumber(
          rawValues.electricityConsumption ||
          rawValues.electricity_consumption ||
          rawValues.electricity_consumed
        );
        pd.tdLossFactor = parseNumber(
          rawValues.tdLossFactor ||
          rawValues.td_loss_factor ||
          rawValues.td_losses
        );
        break;

      // (4) Upstream Transport and Distribution
      case 'Upstream Transport and Distribution':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.transportationSpend = parseNumber(
            rawValues.transportationSpend ||
            rawValues.transportation_spend ||
            rawValues.transport_spend
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.mass = parseNumber(rawValues.mass || rawValues.weight);
          pd.distance = parseNumber(rawValues.distance || rawValues.km);
        }
        break;

      // (5) Waste Generated in Operation
      case 'Waste Generated in Operation':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.wasteMass = parseNumber(
            rawValues.wasteMass ||
            rawValues.waste_mass ||
            rawValues.mass_waste
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.wasteMass = parseNumber(
            rawValues.wasteMass ||
            rawValues.waste_mass
          );
          pd.treatmentType = rawValues.treatmentType || rawValues.treatment_type || '';
        }
        break;

      // (6) Business Travel
      case 'Business Travel':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.travelSpend = parseNumber(
            rawValues.travelSpend ||
            rawValues.travel_spend
          );
          pd.hotelNights = parseNumber(
            rawValues.hotelNights ||
            rawValues.hotel_nights
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.numberOfPassengers = parseNumber(
            rawValues.numberOfPassengers ||
            rawValues.number_of_passengers ||
            rawValues.passengers
          );
          pd.distanceTravelled = parseNumber(
            rawValues.distanceTravelled ||
            rawValues.distance_travelled ||
            rawValues.distance
          );
          pd.hotelNights = parseNumber(
            rawValues.hotelNights ||
            rawValues.hotel_nights
          );
        }
        break;

      // (7) Employee Commuting
      case 'Employee Commuting':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.employeeCount = parseNumber(
            rawValues.employeeCount ||
            rawValues.employee_count ||
            rawValues.employee_Count
          );
          pd.averageCommuteDistance = parseNumber(
            rawValues.averageCommuteDistance ||
            rawValues.average_commute_distance ||
            rawValues.average_Commuting_Distance
          );
          pd.workingDays = parseNumber(
            rawValues.workingDays ||
            rawValues.working_days ||
            rawValues.working_Days
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.note = 'Tier 2 calculation in progress';
        }
        break;

      // (8) Upstream Leased Assets
      case 'Upstream Leased Assets':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.leasedArea = parseNumber(
            rawValues.leasedArea ||
            rawValues.leased_area ||
            rawValues.leased_Area
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.leasedArea = parseNumber(
            rawValues.leasedArea ||
            rawValues.leased_area ||
            rawValues.leased_Area
          );
          pd.totalArea = parseNumber(
            rawValues.totalArea ||
            rawValues.total_area ||
            rawValues.total_Area
          );
          pd.energyConsumption = parseNumber(
            rawValues.energyConsumption ||
            rawValues.energy_consumption ||
            rawValues.energy_Consumption
          );
          pd.BuildingTotalS1_S2 = parseNumber(
            rawValues.BuildingTotalS1_S2 ||
            rawValues.buildingTotalS1S2 ||
            rawValues.building_total_s1_s2
          );
        }
        break;

      // (9) Downstream Transport and Distribution
      case 'Downstream Transport and Distribution':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.transportSpend = parseNumber(
            rawValues.transportSpend ||
            rawValues.transport_spend ||
            rawValues.transport_Spend ||
            rawValues.spendTransport
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.mass = parseNumber(
            rawValues.mass ||
            rawValues.transportMass ||
            rawValues.transport_mass
          );
          pd.distance = parseNumber(
            rawValues.distance ||
            rawValues.transportDistance ||
            rawValues.transport_distance
          );
        }
        break;

      // (10) Processing of Sold Products
      case 'Processing of Sold Products':
        pd.productQuantity = parseNumber(
          rawValues.productQuantity ||
          rawValues.product_quantity
        );
        if (scopeConfig.calculationModel === 'tier 2') {
          pd.customerType = rawValues.customerType || rawValues.customer_type || '';
        }
        break;

      // (11) Use of Sold Products
      case 'Use of Sold Products':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.productQuantity = parseNumber(
            rawValues.productQuantity ||
            rawValues.product_quantity
          );
          pd.averageLifetimeEnergyConsumption = parseNumber(
            rawValues.averageLifetimeEnergyConsumption ||
            rawValues.average_lifetime_energy_consumption
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.productQuantity = parseNumber(
            rawValues.productQuantity ||
            rawValues.product_quantity
          );
          pd.usePattern = parseNumber(
            rawValues.usePattern ||
            rawValues.use_pattern
          ) || 1;
          pd.energyEfficiency = parseNumber(
            rawValues.energyEfficiency ||
            rawValues.energy_efficiency
          );
        }
        break;

      // (12) End-of-Life Treatment of Sold Products
      case 'End-of-Life Treatment of Sold Products':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.massEol = parseNumber(
            rawValues.massEol ||
            rawValues.mass_eol
          );
          pd.toDisposal = parseNumber(
            rawValues.toDisposal ||
            rawValues.to_disposal
          );
          pd.toLandfill = parseNumber(
            rawValues.toLandfill ||
            rawValues.to_landfill
          );
          pd.toIncineration = parseNumber(
            rawValues.toIncineration ||
            rawValues.to_incineration
          );
        }
        break;

      // (13) Downstream Leased Assets
      case 'Downstream Leased Assets':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.leasedArea = parseNumber(
            rawValues.leasedArea ||
            rawValues.leased_area ||
            rawValues.leased_Area
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.leasedArea = parseNumber(
            rawValues.leasedArea ||
            rawValues.leased_area ||
            rawValues.leased_Area
          );
          pd.totalArea = parseNumber(
            rawValues.totalArea ||
            rawValues.total_area ||
            rawValues.total_Area
          );
          pd.energyConsumption = parseNumber(
            rawValues.energyConsumption ||
            rawValues.energy_consumption ||
            rawValues.energy_Consumption
          );
          pd.BuildingTotalS1_S2 = parseNumber(
            rawValues.BuildingTotalS1_S2 ||
            rawValues.buildingTotalS1S2 ||
            rawValues.building_total_s1_s2
          );
        }
        break;

      // (14) Franchises
      case 'Franchises':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.franchiseCount = parseNumber(
            rawValues.franchiseCount ||
            rawValues.franchise_count ||
            rawValues.noOfFranchises
          );
          pd.avgEmissionPerFranchise = parseNumber(
            rawValues.avgEmissionPerFranchise ||
            rawValues.avg_emission_per_franchise ||
            rawValues.averageEmissionPerFranchise
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.franchiseTotalS1Emission = parseNumber(
            rawValues.franchiseTotalS1Emission ||
            rawValues.franchise_total_s1_emission ||
            rawValues.totalS1Emission
          );
          pd.franchiseTotalS2Emission = parseNumber(
            rawValues.franchiseTotalS2Emission ||
            rawValues.franchise_total_s2_emission ||
            rawValues.totalS2Emission
          );
          pd.energyConsumption = parseNumber(
            rawValues.energyConsumption ||
            rawValues.energy_consumption ||
            rawValues.energy_Consumption
          );
        }
        break;

      // (15) Investments
      case 'Investments':
        if (scopeConfig.calculationModel === 'tier 1') {
          pd.investeeRevenue = parseNumber(
            rawValues.investeeRevenue ||
            rawValues.investee_revenue
          );
          pd.equitySharePercentage = parseNumber(
            rawValues.equitySharePercentage ||
            rawValues.equity_share_percentage
          );
        } else if (scopeConfig.calculationModel === 'tier 2') {
          pd.investeeScope1Emission = parseNumber(
            rawValues.investeeScope1Emission ||
            rawValues.investee_scope1_emission ||
            rawValues.scope1Emission
          );
          pd.investeeScope2Emission = parseNumber(
            rawValues.investeeScope2Emission ||
            rawValues.investee_scope2_emission ||
            rawValues.scope2Emission
          );
          pd.equitySharePercentage = parseNumber(
            rawValues.equitySharePercentage ||
            rawValues.equity_share_percentage
          );
          pd.energyConsumption = parseNumber(
            rawValues.energyConsumption ||
            rawValues.energy_consumption
          );
        }
        break;

      default:
        console.warn(`Unknown Scope 3 category: ${scopeConfig.categoryName}`);
        break;
    }
  }

  return pd;
}

// Upload CSV Data (now with cumulative tracking)
const uploadCSVData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    
    // Check permissions for CSV upload operations
    const permissionCheck = await checkOperationPermission(req.user, clientId, nodeId, scopeIdentifier, 'csv_upload');
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: permissionCheck.reason 
      });
    
    }
        // Add after finding scopeConfig
    // Validate prerequisites for emission calculation
    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation.isValid) {
      // Clean up file
      const fs = require('fs');
      fs.unlinkSync(req.file.path);
      
      return res.status(400).json({
        message: 'Cannot process CSV data: ' + validation.message
      });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No CSV file uploaded' });
    }
    
    // Find scope configuration
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }
    
    let scopeConfig = null;
    for (const node of flowchart.nodes) {
      if (node.id === nodeId) {
        const scope = node.details.scopeDetails.find(
          s => s.scopeIdentifier === scopeIdentifier
        );
        if (scope && scope.inputType === 'manual') {
          scopeConfig = scope;
          break;
        }
      }
    }
    
    if (!scopeConfig) {
      return res.status(400).json({ message: 'Invalid manual scope configuration for CSV upload' });
    }
    
    // Process CSV file
    const csvData = await csvtojson().fromFile(req.file.path);
    
    if (!csvData || csvData.length === 0) {
      return res.status(400).json({ message: 'CSV file is empty or invalid' });
    }
    
    // Validate required columns
    const requiredColumns = ['date', 'time'];
    const firstRow = csvData[0];
    const missingColumns = requiredColumns.filter(col => !(col in firstRow));
    
    if (missingColumns.length > 0) {
      return res.status(400).json({ 
        message: `Missing required columns: ${missingColumns.join(', ')}` 
      });
    }
    
    // Process and prepare entries
    const processedEntries = [];
    const errors = [];
    
    for (const row of csvData) {
      const rawDate = row.date || moment().format('DD/MM/YYYY');
      const rawTime = row.time || moment().format('HH:mm:ss');
      
      let dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
if (!dateMoment.isValid()) {
  dateMoment = moment(rawDate, 'YYYY-MM-DD', true); // allow alternate format
}
      const timeMoment = moment(rawTime, 'HH:mm:ss', true);
      
      if (!dateMoment.isValid() || !timeMoment.isValid()) {
        errors.push({
          row: csvData.indexOf(row) + 1,
          error: 'Invalid date/time format'
        });
        continue;
      }
      
      const formattedDate = dateMoment.format('DD:MM:YYYY');
      const formattedTime = timeMoment.format('HH:mm:ss');
      
      const [day, month, year] = formattedDate.split(':').map(Number);
      const [hour, minute, second] = formattedTime.split(':').map(Number);
      const timestamp = new Date(year, month - 1, day, hour, minute, second);
      
      // Extract data values (exclude metadata fields)
      const dataObj = { ...row };
      delete dataObj.date;
      delete dataObj.time;
      delete dataObj.scopeIdentifier;
      delete dataObj.clientId;
      delete dataObj.scopeType;
      delete dataObj.emissionFactor;
      
     // Normalize via our CSV helper, then ensure a Map for cumulative tracking
      // Normalize via our comprehensive CSV helper, then ensure a Map for cumulative tracking
const processed = processCSVData(dataObj, scopeConfig);
let dataMap;
try {
  dataMap = ensureDataIsMap(processed);
} catch (err) {
  errors.push({
    row: csvData.indexOf(row) + 1,
    error: 'Invalid data shape after processing'
  });
  continue;
}
      
      processedEntries.push({
        clientId,
        nodeId,
        scopeIdentifier,
        scopeType: scopeConfig.scopeType,
        inputType: 'manual',
        date: formattedDate,
        time: formattedTime,
        timestamp,
        dataValues: dataMap,
        emissionFactor: row.emissionFactor || scopeConfig.emissionFactor || '',
        sourceDetails: {
          fileName: req.file.originalname,
          uploadedBy: req.user._id
        },
        isEditable: true,
        processingStatus: 'processed'
      });
    }
    
    // Sort by timestamp to ensure proper cumulative calculation
    processedEntries.sort((a, b) => a.timestamp - b.timestamp);
    
    // Save entries one by one to ensure proper cumulative calculation
    // Save entries one by one to ensure proper cumulative calculation and trigger emissions
const savedEntries = [];

for (const entryData of processedEntries) {
  try {
    const entry = new DataEntry(entryData);
    await entry.save(); // Pre-save hook will calculate cumulative values
    
    // Trigger emission calculation for each CSV entry
    await triggerEmissionCalculation(entry);
    
    savedEntries.push(entry);
  } catch (error) {
    errors.push({
      date: entryData.date,
      time: entryData.time,
      error: error.message
    });
  }
}
    
    // Update collection config
    if (savedEntries.length > 0) {
      const latestEntry = savedEntries[savedEntries.length - 1];
      const collectionConfig = await DataCollectionConfig.findOne({
        clientId,
        nodeId,
        scopeIdentifier
      });
      
      if (collectionConfig) {
        collectionConfig.updateCollectionStatus(latestEntry._id, latestEntry.timestamp);
        await collectionConfig.save();
      }
    }
    
    // Delete uploaded file
    const fs = require('fs');
    fs.unlinkSync(req.file.path);
    
    // Emit real-time update with detailed entry info
emitDataUpdate('csv-data-uploaded', {
  clientId,
  nodeId,
  scopeIdentifier,
  count: savedEntries.length,
  dataIds: savedEntries.map(e => e._id),
  entries: savedEntries.map(entry => {
    const { incoming: inMap, cumulative: cumMap, metadata } = entry.calculatedEmissions || {};
    const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
    
    return {
      dataId: entry._id,
      timestamp: entry.timestamp,
      dataValues: Object.fromEntries(entry.dataValues),
      calculatedEmissions: {
        incoming: mapToObject(inMap),
        cumulative: mapToObject(cumMap),
        metadata: metadata || {}
      }
    };
  })
});
    
    const response = {
  message: 'CSV data uploaded successfully',
  totalRows: csvData.length,
  savedCount: savedEntries.length,
  dataIds: savedEntries.map(e => e._id)
};

// Include latest cumulative values with emissions
if (savedEntries.length > 0) {
  const lastEntry = savedEntries[savedEntries.length - 1];
  const { incoming: inMap, cumulative: cumMap, metadata } = lastEntry.calculatedEmissions || {};
  const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
  
  response.latestCumulative = {
    cumulativeValues: Object.fromEntries(lastEntry.cumulativeValues),
    highData: Object.fromEntries(lastEntry.highData),
    lowData: Object.fromEntries(lastEntry.lowData),
    lastEnteredData: Object.fromEntries(lastEntry.lastEnteredData),
    calculatedEmissions: {
      incoming: mapToObject(inMap),
      cumulative: mapToObject(cumMap),
      metadata: metadata || {}
    }
  };
}
    
    if (errors.length > 0) {
      response.errors = errors;
      response.failedCount = errors.length;
    }
    
    res.status(201).json(response);
    
  } catch (error) {
    console.error('Upload CSV error:', error);
    
    // Clean up file on error
    if (req.file) {
      const fs = require('fs');
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Failed to clean up file:', cleanupError);
      }
    }
    
    res.status(500).json({ 
      message: 'Failed to upload CSV data', 
      error: error.message 
    });
  }
};

// Edit Manual Data Entry
const editManualData = async (req, res) => {
  try {
    const { dataId } = req.params;
    const { date: rawDateInput, time: rawTimeInput, dataValues, reason } = req.body;
    
    // Find the data entry
    const entry = await DataEntry.findById(dataId);
    if (!entry) {
      return res.status(404).json({ message: 'Data entry not found' });
    }
    
    // Check if entry is editable
    if (!entry.isEditable || entry.inputType !== 'manual') {
      return res.status(403).json({ message: 'This data entry cannot be edited' });
    }
    
    // Check permissions for editing manual data
    const permissionCheck = await checkOperationPermission(
      req.user, 
      entry.clientId, 
      entry.nodeId, 
      entry.scopeIdentifier, 
      'edit_manual'
    );
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: permissionCheck.reason 
      });
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
    
    // Add edit history
    entry.addEditHistory(req.user._id, reason, previousValues, 'Manual edit');
    
    await entry.save();

    // After saving, re-trigger emission calculation and summary updates
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
    
    res.status(200).json({
      message: 'Data entry updated successfully',
      dataId: entry._id
    });
    
  } catch (error) {
    console.error('Edit manual data error:', error);
    res.status(500).json({ 
      message: 'Failed to edit data entry', 
      error: error.message 
    });
  }
};

const deleteManualData = async (req, res) => {
  try {
    const { dataId } = req.params;

    // Find the data entry to be deleted
    const entry = await DataEntry.findById(dataId);
    if (!entry) {
      return res.status(404).json({ message: 'Data entry not found' });
    }

    // Check if entry is deletable
    if (entry.inputType !== 'manual') {
      return res.status(403).json({ message: 'Only manual data entries can be deleted.' });
    }

    // Check user permissions (re-using 'edit_manual' for deletion rights)
    const permissionCheck = await checkOperationPermission(
      req.user,
      entry.clientId,
      entry.nodeId,
      entry.scopeIdentifier,
      'edit_manual' 
    );
    if (!permissionCheck.allowed) {
      return res.status(403).json({
        message: 'Permission denied to delete this entry.',
        reason: permissionCheck.reason
      });
    }

    // Store details for summary recalculation before deleting
    const { clientId, timestamp } = entry;

    // Delete the entry
    await entry.deleteOne();

    // Trigger summary recalculation for the affected period
    await handleDataChange({ clientId, timestamp });

    // Emit real-time update
    emitDataUpdate('manual-data-deleted', {
      clientId: entry.clientId,
      nodeId: entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
      dataId: entry._id,
    });

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
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }
    
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
      const flowchart = await Flowchart.findOne({ clientId, isActive: true });
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
      const flowchart = await Flowchart.findOne({ clientId, isActive: true });
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
      const flowchart = await Flowchart.findOne({ clientId, isActive: true });
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
      const flowchart = await Flowchart.findOne({ clientId, isActive: true });
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

// Disconnect Source
const disconnectSource = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    
    // Check permissions for disconnect operations
    const permissionCheck = await checkOperationPermission(req.user, clientId, nodeId, scopeIdentifier, 'disconnect');
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: permissionCheck.reason 
      });
    }
    
    // Find and update scope configuration
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }
    
    let updated = false;
    for (let i = 0; i < flowchart.nodes.length; i++) {
      if (flowchart.nodes[i].id === nodeId) {
        const scopeIndex = flowchart.nodes[i].details.scopeDetails.findIndex(
          s => s.scopeIdentifier === scopeIdentifier
        );
        
        if (scopeIndex !== -1) {
          const scope = flowchart.nodes[i].details.scopeDetails[scopeIndex];
          
          // Disconnect based on current type
          if (scope.inputType === 'API') {
            scope.apiStatus = false;
            scope.apiEndpoint = '';
          } else if (scope.inputType === 'IOT') {
            scope.iotStatus = false;
            scope.iotDeviceId = '';
          } else {
            return res.status(400).json({ message: 'Cannot disconnect manual input type' });
          }
          
          flowchart.nodes[i].details.scopeDetails[scopeIndex] = scope;
          updated = true;
          break;
        }
      }
    }
    
    if (!updated) {
      return res.status(404).json({ message: 'Scope not found' });
    }
    
    await flowchart.save();
    
    // Update collection config
    await DataCollectionConfig.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier },
      {
        'connectionDetails.isActive': false,
        'connectionDetails.disconnectedAt': new Date(),
        'connectionDetails.disconnectedBy': req.user._id
      }
    );
    
    res.status(200).json({
      message: 'Source disconnected successfully',
      scopeIdentifier
    });
    
  } catch (error) {
    console.error('Disconnect source error:', error);
    res.status(500).json({ 
      message: 'Failed to disconnect source', 
      error: error.message 
    });
  }
};

// Reconnect Source
const reconnectSource = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { connectionDetails } = req.body;
    
    // Check permissions for reconnect operations
    const permissionCheck = await checkOperationPermission(req.user, clientId, nodeId, scopeIdentifier, 'reconnect');
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: permissionCheck.reason 
      });
    }
    
    // Find and update scope configuration
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }
    
    let updated = false;
    for (let i = 0; i < flowchart.nodes.length; i++) {
      if (flowchart.nodes[i].id === nodeId) {
        const scopeIndex = flowchart.nodes[i].details.scopeDetails.findIndex(
          s => s.scopeIdentifier === scopeIdentifier
        );
        
        if (scopeIndex !== -1) {
          const scope = flowchart.nodes[i].details.scopeDetails[scopeIndex];
          
          // Reconnect based on current type
          if (scope.inputType === 'API') {
            if (!connectionDetails?.apiEndpoint) {
              return res.status(400).json({ message: 'API endpoint required for reconnection' });
            }
            scope.apiStatus = true;
            scope.apiEndpoint = connectionDetails.apiEndpoint;
          } else if (scope.inputType === 'IOT') {
            if (!connectionDetails?.deviceId) {
              return res.status(400).json({ message: 'Device ID required for reconnection' });
            }
            scope.iotStatus = true;
            scope.iotDeviceId = connectionDetails.deviceId;
          } else {
            return res.status(400).json({ message: 'Cannot reconnect manual input type' });
          }
          
          flowchart.nodes[i].details.scopeDetails[scopeIndex] = scope;
          updated = true;
          break;
        }
      }
    }
    
    if (!updated) {
      return res.status(404).json({ message: 'Scope not found' });
    }
    
    await flowchart.save();
    
    // Update collection config
    await DataCollectionConfig.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier },
      {
        connectionDetails,
        'connectionDetails.isActive': true,
        'connectionDetails.reconnectedAt': new Date(),
        'connectionDetails.reconnectedBy': req.user._id
      }
    );
    
    res.status(200).json({
      message: 'Source reconnected successfully',
      scopeIdentifier
    });
    
  } catch (error) {
    console.error('Reconnect source error:', error);
    res.status(500).json({ 
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