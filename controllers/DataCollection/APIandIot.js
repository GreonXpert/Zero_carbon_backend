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
