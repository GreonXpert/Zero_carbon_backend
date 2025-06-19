const DataEntry = require('../models/DataEntry');
const DataCollectionConfig = require('../models/DataCollectionConfig');
const Flowchart = require('../models/Flowchart');
const Client = require('../models/Client');
const User = require('../models/User');
const csvtojson = require('csvtojson');
const moment = require('moment');

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
    
    // Ensure dataValues is a Map
    let dataMap;
    try {
      dataMap = ensureDataIsMap(dataValues || data);
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
        uploadedBy: req.user._id
      },
      isEditable: false,
      processingStatus: 'processed'
    });
    
    await entry.save();
    
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
      lastEnteredData: Object.fromEntries(entry.lastEnteredData)
    });
    
    res.status(201).json({
      message: 'API data saved successfully',
      dataId: entry._id,
      cumulativeValues: Object.fromEntries(entry.cumulativeValues),
      highData: Object.fromEntries(entry.highData),
      lowData: Object.fromEntries(entry.lowData),
      lastEnteredData: Object.fromEntries(entry.lastEnteredData)
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
    
    // Check permissions for IoT data operations
    const permissionCheck = await checkOperationPermission(req.user, clientId, nodeId, scopeIdentifier, 'iot_data');
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
    
    let scopeConfig = null;
    for (const node of flowchart.nodes) {
      if (node.id === nodeId) {
        const scope = node.details.scopeDetails.find(
          s => s.scopeIdentifier === scopeIdentifier
        );
        if (scope && scope.inputType === 'IOT') {
          scopeConfig = scope;
          break;
        }
      }
    }
    
    if (!scopeConfig) {
      return res.status(400).json({ message: 'Invalid IoT scope configuration' });
    }
    
    // Process date/time
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
    
    // Ensure dataValues is a Map
    let dataMap;
    try {
      dataMap = ensureDataIsMap(dataValues || data);
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
      inputType: 'IOT',
      date: formattedDate,
      time: formattedTime,
      timestamp,
      dataValues: dataMap,
      emissionFactor: emissionFactor || scopeConfig.emissionFactor || '',
      sourceDetails: {
        iotDeviceId: scopeConfig.iotDeviceId,
        uploadedBy: req.user._id
      },
      isEditable: false,
      processingStatus: 'processed'
    });
    
    await entry.save();
    
    // Update collection config
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
    
    // Emit real-time update
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
      lastEnteredData: Object.fromEntries(entry.lastEnteredData)
    });
    
    res.status(201).json({
      message: 'IoT data saved successfully',
      dataId: entry._id,
      cumulativeValues: Object.fromEntries(entry.cumulativeValues),
      highData: Object.fromEntries(entry.highData),
      lowData: Object.fromEntries(entry.lowData),
      lastEnteredData: Object.fromEntries(entry.lastEnteredData)
    });
    
  } catch (error) {
    console.error('Save IoT data error:', error);
    res.status(500).json({ 
      message: 'Failed to save IoT data', 
      error: error.message 
    });
  }
};

// Save Manual Data Entry (now with cumulative tracking and bulk support)
const saveManualData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { entries } = req.body; // Support for multiple entries
    
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
      return res.status(400).json({ message: 'Invalid manual scope configuration' });
    }
    
    // Handle single entry (backward compatibility) or multiple entries
    const dataEntries = entries || [req.body];
    
    // Sort entries by timestamp to ensure proper cumulative calculation
    const processedEntries = [];
    
    for (const entryData of dataEntries) {
      const { date: rawDateInput, time: rawTimeInput, dataValues, emissionFactor } = entryData;
      
      // Process date/time
      const rawDate = rawDateInput || moment().format('DD/MM/YYYY');
      const rawTime = rawTimeInput || moment().format('HH:mm:ss');
      
      const dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
      const timeMoment = moment(rawTime, 'HH:mm:ss', true);
      
      if (!dateMoment.isValid() || !timeMoment.isValid()) {
        continue; // Skip invalid entries
      }
      
      const formattedDate = dateMoment.format('DD:MM:YYYY');
      const formattedTime = timeMoment.format('HH:mm:ss');
      
      const [day, month, year] = formattedDate.split(':').map(Number);
      const [hour, minute, second] = formattedTime.split(':').map(Number);
      const timestamp = new Date(year, month - 1, day, hour, minute, second);
      
      // Ensure dataValues is a Map
      let dataMap;
      try {
        dataMap = ensureDataIsMap(dataValues);
      } catch (error) {
        continue; // Skip entries with invalid data format
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
          uploadedBy: req.user._id
        },
        isEditable: true,
        processingStatus: 'processed'
      });
    }
    
    // Sort by timestamp
    processedEntries.sort((a, b) => a.timestamp - b.timestamp);
    
    // Save entries one by one to ensure proper cumulative calculation
    const savedEntries = [];
    const errors = [];
    
    for (const entryData of processedEntries) {
      try {
        const entry = new DataEntry(entryData);
        await entry.save(); // Pre-save hook will calculate cumulative values
        savedEntries.push(entry);
      } catch (error) {
        errors.push({
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
    
    // Emit real-time update for each saved entry
    for (const entry of savedEntries) {
      emitDataUpdate('manual-data-saved', {
        clientId,
        nodeId,
        scopeIdentifier,
        dataId: entry._id,
        timestamp: entry.timestamp,
        dataValues: Object.fromEntries(entry.dataValues),
        cumulativeValues: Object.fromEntries(entry.cumulativeValues),
        highData: Object.fromEntries(entry.highData),
        lowData: Object.fromEntries(entry.lowData),
        lastEnteredData: Object.fromEntries(entry.lastEnteredData)
      });
    }
    
    const response = {
      message: `Manual data saved successfully`,
      savedCount: savedEntries.length,
      dataIds: savedEntries.map(e => e._id)
    };
    
    // Include latest cumulative values
    if (savedEntries.length > 0) {
      const lastEntry = savedEntries[savedEntries.length - 1];
      response.latestCumulative = {
        cumulativeValues: Object.fromEntries(lastEntry.cumulativeValues),
        highData: Object.fromEntries(lastEntry.highData),
        lowData: Object.fromEntries(lastEntry.lowData),
        lastEnteredData: Object.fromEntries(lastEntry.lastEnteredData)
      };
    }
    
    if (errors.length > 0) {
      response.errors = errors;
    }
    
    res.status(201).json(response);
    
  } catch (error) {
    console.error('Save manual data error:', error);
    res.status(500).json({ 
      message: 'Failed to save manual data', 
      error: error.message 
    });
  }
};




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
      
      const dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
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
      
      // Convert to Map and validate numeric values
      const dataMap = new Map();
      let hasValidData = false;
      
      for (const [key, value] of Object.entries(dataObj)) {
        const numValue = Number(value);
        if (!isNaN(numValue)) {
          dataMap.set(key, numValue);
          hasValidData = true;
        }
      }
      
      if (!hasValidData) {
        errors.push({
          row: csvData.indexOf(row) + 1,
          error: 'No valid numeric data found'
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
    const savedEntries = [];
    
    for (const entryData of processedEntries) {
      try {
        const entry = new DataEntry(entryData);
        await entry.save(); // Pre-save hook will calculate cumulative values
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
    
    // Emit real-time update
    emitDataUpdate('csv-data-uploaded', {
      clientId,
      nodeId,
      scopeIdentifier,
      count: savedEntries.length,
      dataIds: savedEntries.map(e => e._id)
    });
    
    const response = {
      message: 'CSV data uploaded successfully',
      totalRows: csvData.length,
      savedCount: savedEntries.length,
      dataIds: savedEntries.map(e => e._id)
    };
    
    // Include latest cumulative values
    if (savedEntries.length > 0) {
      const lastEntry = savedEntries[savedEntries.length - 1];
      response.latestCumulative = {
        cumulativeValues: Object.fromEntries(lastEntry.cumulativeValues),
        highData: Object.fromEntries(lastEntry.highData),
        lowData: Object.fromEntries(lastEntry.lowData),
        lastEnteredData: Object.fromEntries(lastEntry.lastEnteredData)
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
  switchInputType,
  getDataEntries,
  getCollectionStatus,
  disconnectSource,
  reconnectSource,
  createMonthlySummaryManual,
  getMonthlySummaries,
  getCurrentCumulative
};