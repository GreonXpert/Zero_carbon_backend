const Flowchart = require('../models/Flowchart');
const Client = require('../models/Client');
const User = require('../models/User');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification   = require('../models/Notification');

// Add this import at the top of flowchartController.js:
const { autoUpdateFlowchartStatus } = require('./clientController');


// ============================================================================
// PERMISSION HELPERS
// ============================================================================

// Check if user can create/edit flowchart for a client
const canManageFlowchart = async (user, clientId, flowchart = null) => {
  // Super admin can manage all
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  // Get client details
  const client = await Client.findOne({ clientId });
  if (!client) {
    return { allowed: false, reason: 'Client not found' };
  }

  // Consultant Admin: Can manage if they created the lead
  if (user.userType === 'consultant_admin') {
    const createdBy = client.leadInfo?.createdBy;
    if (createdBy && user._id && createdBy.toString() === user._id.toString()) {
      return { allowed: true, reason: 'Consultant admin who created lead' };
    }

    // Also check if any consultant under them is assigned
    const consultantsUnderAdmin = await User.find({
      consultantAdminId: user.id,
      userType: 'consultant'
    }).select('_id');
    const consultantIds = consultantsUnderAdmin.map(c => c._id.toString());
    const assignedConsultantId = client.leadInfo?.assignedConsultantId;
    if (assignedConsultantId && consultantIds.includes(assignedConsultantId.toString())) {
      return { allowed: true, reason: 'Client assigned to consultant under this admin' };
    }
    return { allowed: false, reason: 'Not authorized for this client' };
  }

  // Consultant: Can manage if they are assigned to this client
  if (user.userType === 'consultant') {
    const assignedConsultantId = client.leadInfo?.assignedConsultantId;
    if (assignedConsultantId && user.id && assignedConsultantId.toString() === user.id.toString()) {
      return { allowed: true, reason: 'Assigned consultant' };
    }
    return { allowed: false, reason: 'Not assigned to this client' };
  }

  return { allowed: false, reason: 'Insufficient permissions' };
};


// Check if user can view flowchart
const canViewFlowchart = async (user, clientId) => {
  // Super admin can view all
  if (user.userType === 'super_admin') {
    return { allowed: true, fullAccess: true };
  }

  // Check if user can manage (creators can always view)
  const manageCheck = await canManageFlowchart(user, clientId);
  if (manageCheck.allowed) {
    return { allowed: true, fullAccess: true };
  }

  // Client admin can view their own flowchart
  if (user.userType === 'client_admin' && user.clientId === clientId) {
    return { allowed: true, fullAccess: true };
  }

  // Employee head can view with department/location restrictions
  if (user.userType === 'client_employee_head' && user.clientId === clientId) {
    return { 
      allowed: true, 
      fullAccess: false,
      restrictions: {
        department: user.department,
        location: user.location
      }
    };
  }

  // Employees, auditors, viewers can view if they belong to the client
  if (['employee', 'auditor', 'viewer'].includes(user.userType) && user.clientId === clientId) {
    return { allowed: true, fullAccess: false };
  }

  return { allowed: false };
};

// Enhanced validation for scope details (excerpt from flowchartController.js)
const validateScopeDetails = (scopeDetails, nodeId) => {
  if (!Array.isArray(scopeDetails)) {
    throw new Error("scopeDetails must be an array");
  }

  // Check for unique identifiers within this node
  const identifiers = new Set();
  const scopeTypeCounts = {
    'Scope 1': 0,
    'Scope 2': 0,
    'Scope 3': 0
  };
  
  scopeDetails.forEach((scope, index) => {
    // Check required common fields
    if (!scope.scopeIdentifier || scope.scopeIdentifier.trim() === '') {
      throw new Error(`Scope at index ${index} must have a scopeIdentifier (unique name)`);
    }
    
    if (identifiers.has(scope.scopeIdentifier)) {
      throw new Error(`Duplicate scopeIdentifier "${scope.scopeIdentifier}" in node ${nodeId}`);
    }
    identifiers.add(scope.scopeIdentifier);

    if (!scope.scopeType) {
      throw new Error(`Scope "${scope.scopeIdentifier}" must have a scopeType`);
    }

    if (!['Scope 1', 'Scope 2', 'Scope 3'].includes(scope.scopeType)) {
      throw new Error(`Invalid scopeType "${scope.scopeType}" for scope "${scope.scopeIdentifier}"`);
    }

    if (!scope.inputType) {
      throw new Error(`Scope "${scope.scopeIdentifier}" must have an inputType (manual/IOT/API)`);
    }

    if (!['manual', 'IOT', 'API'].includes(scope.inputType)) {
      throw new Error(`Invalid inputType "${scope.inputType}" for scope "${scope.scopeIdentifier}". Must be manual, IOT, or API`);
    }

    // Count scope types
    scopeTypeCounts[scope.scopeType]++;

    // Validate based on scope type
    switch (scope.scopeType) {
      case "Scope 1":
        if (!scope.emissionFactor || !scope.categoryName || !scope.activity || !scope.fuel || !scope.units) {
          throw new Error(`Scope 1 "${scope.scopeIdentifier}" requires: emissionFactor, categoryName, activity, fuel, units`);
        }
        
        // Updated validation to include Custom and other emission factors
        if (!['IPCC', 'DEFRA', 'EPA', 'EmissionFactorHub', 'Custom'].includes(scope.emissionFactor)) {
          throw new Error(`Scope 1 "${scope.scopeIdentifier}" emissionFactor must be one of: IPCC, DEFRA, EPA, EmissionFactorHub, or Custom`);
        }

        // Validate custom emission factor if selected
        if (scope.emissionFactor === 'Custom') {
          if (!scope.customEmissionFactor) {
            throw new Error(`Scope 1 "${scope.scopeIdentifier}" with Custom emission factor must have customEmissionFactor object`);
          }
          
          const { CO2, CH4, N2O, CO2e } = scope.customEmissionFactor;
          
          // At least one emission factor must be provided
          if (CO2 === null && CH4 === null && N2O === null && CO2e === null) {
            throw new Error(`Scope 1 "${scope.scopeIdentifier}" with Custom emission factor must have at least one of CO2, CH4, N2O, or CO2e values`);
          }
          
          // Validate that provided values are numbers
          if (CO2 !== null && (typeof CO2 !== 'number' || CO2 < 0)) {
            throw new Error(`Scope 1 "${scope.scopeIdentifier}" CO2 emission factor must be a non-negative number`);
          }
          if (CH4 !== null && (typeof CH4 !== 'number' || CH4 < 0)) {
            throw new Error(`Scope 1 "${scope.scopeIdentifier}" CH4 emission factor must be a non-negative number`);
          }
          if (N2O !== null && (typeof N2O !== 'number' || N2O < 0)) {
            throw new Error(`Scope 1 "${scope.scopeIdentifier}" N2O emission factor must be a non-negative number`);
          }
          if (CO2e !== null && (typeof CO2e !== 'number' || CO2e < 0)) {
            throw new Error(`Scope 1 "${scope.scopeIdentifier}" CO2e emission factor must be a non-negative number`);
          }
        }

        // Validate API endpoint if API input type
        if (scope.inputType === 'API' && !scope.apiEndpoint) {
          throw new Error(`Scope 1 "${scope.scopeIdentifier}" with API input type must have apiEndpoint`);
        }

        // Validate IOT device ID if IOT input type
        if (scope.inputType === 'IOT' && !scope.iotDeviceId) {
          throw new Error(`Scope 1 "${scope.scopeIdentifier}" with IOT input type must have iotDeviceId`);
        }
        break;

      case "Scope 2":
        if (!scope.country || !scope.regionGrid) {
          throw new Error(`Scope 2 "${scope.scopeIdentifier}" requires: country, regionGrid`);
        }
        
        if (scope.electricityUnit && !['kWh', 'MWh', 'GWh'].includes(scope.electricityUnit)) {
          throw new Error(`Invalid electricity unit "${scope.electricityUnit}" for scope "${scope.scopeIdentifier}"`);
        }

        // Validate API/IOT fields if applicable
        if (scope.inputType === 'API' && !scope.apiEndpoint) {
          throw new Error(`Scope 2 "${scope.scopeIdentifier}" with API input type must have apiEndpoint`);
        }

        if (scope.inputType === 'IOT' && !scope.iotDeviceId) {
          throw new Error(`Scope 2 "${scope.scopeIdentifier}" with IOT input type must have iotDeviceId`);
        }
        break;

      case "Scope 3":
        if (!scope.scope3Category || !scope.activityDescription || !scope.itemName || !scope.scope3Unit) {
          throw new Error(`Scope 3 "${scope.scopeIdentifier}" requires: scope3Category, activityDescription, itemName, scope3Unit`);
        }

        // Validate API fields if applicable (Scope 3 typically doesn't use IOT)
        if (scope.inputType === 'API' && !scope.apiEndpoint) {
          throw new Error(`Scope 3 "${scope.scopeIdentifier}" with API input type must have apiEndpoint`);
        }
        break;

      default:
        throw new Error(`Invalid scopeType: ${scope.scopeType}`);
    }
  });

  return {
    isValid: true,
    counts: scopeTypeCounts,
    totalScopes: scopeDetails.length
  };
};





// ============================================================================
// MAIN CONTROLLERS
// ============================================================================

// Create or Update Flowchart
// Create or Update Flowchart
const saveFlowchart = async (req, res) => {
  try {
    const { clientId, flowchartData } = req.body;

    // 0) Check if user is authenticated and has required fields
    if (!req.user || (!req.user._id && !req.user.id)) {
      return res.status(401).json({
        message: 'Authentication required - user information missing'
      });
    }

    // Ensure we have a consistent userId
    const userId = req.user._id || req.user.id;
    
    // 1) Basic request validation
    if (!clientId || !flowchartData || !Array.isArray(flowchartData.nodes)) {
      return res.status(400).json({
        message: 'Missing required fields: clientId or flowchartData.nodes'
      });
    }
   
    // Auto-update client workflow status when consultant starts creating process flowchart
    if (['consultant', 'consultant_admin'].includes(req.user.userType)) {
      await autoUpdateFlowchartStatus(clientId, userId);
    }

    // 2) Verify the client actually exists
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    // 3) Role check
    if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
      return res.status(403).json({
        message: 'Only Super Admin, Consultant Admin, and Consultants can manage flowcharts'
      });
    }

    // 4) Permission check
    const perm = await canManageFlowchart(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({
        message: 'Permission denied',
        reason: perm.reason
      });
    }

    // 5) Normalize & validate nodes
    const normalizedNodes = flowchartData.nodes.map(node => {
      const d = node.details || {};
      
      if (Array.isArray(d.scopeDetails) && d.scopeDetails.length) {
        validateScopeDetails(d.scopeDetails, node.id);
        d.scopeDetails = d.scopeDetails.map(scope => {
          // First create the normalized scope object with all existing fields
          const normalizedScope = {
            scopeIdentifier:      scope.scopeIdentifier.trim(),
            scopeType:            scope.scopeType,
            inputType:            scope.inputType          || 'manual',
            apiStatus:            scope.apiStatus          || false,
            apiEndpoint:          scope.apiEndpoint        || '',
            iotStatus:            scope.iotStatus          || false,
            iotDeviceId:          scope.iotDeviceId        || '',
            emissionFactor:       scope.emissionFactor     || '',
            categoryName:         scope.categoryName       || '',
            activity:             scope.activity           || '',
            fuel:                 scope.fuel               || '',
            units:                scope.units              || '',
            country:              scope.country            || '',
            regionGrid:           scope.regionGrid         || '',
            electricityUnit:      scope.electricityUnit    || '',
            scope3Category:       scope.scope3Category     || '',
            activityDescription:  scope.activityDescription|| '',
            itemName:             scope.itemName           || '',
            scope3Unit:           scope.scope3Unit         || '',
            description:          scope.description        || '',
            source:               scope.source             || '',
            reference:            scope.reference          || '',
            collectionFrequency:  scope.collectionFrequency|| 'monthly',
            calculationModel:     scope.calculationModel  || 'tier 1',
            additionalInfo:       scope.additionalInfo     || {},
            assignedEmployees:    scope.assignedEmployees  || [],
            UAD:                  scope.UAD                || 0,
            UEF:                  scope.UEF                || 0
          };
          
          // Handle custom emission factor if emission factor is 'Custom'
          if (scope.emissionFactor === 'Custom') {
            normalizedScope.customEmissionFactor = {
              CO2:  scope.customEmissionFactor?.CO2  ?? null,
              CH4:  scope.customEmissionFactor?.CH4  ?? null,
              N2O:  scope.customEmissionFactor?.N2O  ?? null,
              CO2e: scope.customEmissionFactor?.CO2e ?? null,
              unit: scope.customEmissionFactor?.unit || '',
              // Process Emission Factor 
              industryAverageEmissionFactor:scope.customEmissionFactor?.industryAverageEmissionFactor || null,
              stoichiometicFactor: scope.customEmissionFactor?.stoichiometicFactor || null,
              conversionEfficiency: scope.customEmissionFactor?.conversionEfficiency || null,

              // fugitive emission Factor Values 
              chargeType: scope.customEmissionFactor?.chargeType || '',
              leakageRate: scope.customEmissionFactor?.leakageRate || null,
              Gwp_refrigerant: scope.customEmissionFactor?.Gwp_refrigerant || null,
              GWP_fugitiveEmission: scope.customEmissionFactor?.GWP_fugitiveEmission || null,

              CO2_gwp: scope.customEmissionFactor?.CO2_gwp ?? 0,
              CH4_gwp: scope.customEmissionFactor?.CH4_gwp ?? 0,
              N2O_gwp: scope.customEmissionFactor?.N2O_gwp ?? 0,
            };
          } else {
            // Initialize empty custom emission factor for non-custom cases
            normalizedScope.customEmissionFactor = {
              CO2: null,
              CH4: null,
              N2O: null,
              CO2e: null,
              unit: ''
            };
          }
          
          // ───── UPDATED: Dynamic emissionFactorValues based on emissionFactor choice ─────
          const validSources = ['DEFRA','IPCC','EPA','EmissionFactorHub','Custom','Country'];
          
          // Initialize empty emissionFactorValues structure
          normalizedScope.emissionFactorValues = {
            defraData: {},
            ipccData: {},
            epaData: {},
            countryData: {},
            customEmissionFactor: normalizedScope.customEmissionFactor,
            dataSource: validSources.includes(scope.emissionFactor) ? scope.emissionFactor : undefined,
            lastUpdated: new Date()
          };

          // Populate only the relevant data based on emissionFactor choice
          if (scope.emissionFactor === 'DEFRA') {
            // Check if data comes from emissionFactorValues or direct fields
            const defraSource = scope.emissionFactorValues?.defraData || scope;
            normalizedScope.emissionFactorValues.defraData = {
              scope:   defraSource.scope    || '',
              level1:  defraSource.level1   || '',
              level2:  defraSource.level2   || '',
              level3:  defraSource.level3   || '',
              level4:  defraSource.level4   || '',
              columnText: defraSource.columnText || '',
              uom:     defraSource.uom      || '',
              ghgUnits: Array.isArray(defraSource.ghgUnits) 
                ? defraSource.ghgUnits
                : (defraSource.ghgUnit && defraSource.ghgConversionFactor != null)
                  ? [{ unit: defraSource.ghgUnit, ghgconversionFactor: defraSource.ghgConversionFactor }]
                  : [],
              gwpValue: defraSource.gwpValue || 0,
              gwpSearchField: defraSource.gwpSearchField || null,
              gwpLastUpdated: defraSource.gwpLastUpdated || null
            };
          } else if (scope.emissionFactor === 'IPCC') {
            // Check if data comes from emissionFactorValues or direct fields
            const ipccSource = scope.emissionFactorValues?.ipccData || scope;
            normalizedScope.emissionFactorValues.ipccData = {
              level1:         ipccSource.level1           || '',
              level2:         ipccSource.level2           || '',
              level3:         ipccSource.level3           || '',
              cpool:          ipccSource.cpool || ipccSource.Cpool || '',
              typeOfParameter:ipccSource.typeOfParameter || ipccSource.TypeOfParameter || '',
              unit:           ipccSource.unit || ipccSource.Unit || '',
              value:          ipccSource.value ?? ipccSource.Value ?? null,
              description:    ipccSource.description || ipccSource.Description || '',
              gwpValue: ipccSource.gwpValue || 0,
              gwpSearchField:ipccSource.gwpSearchField || null,
              gwpLastUpdated: ipccSource.gwpLastUpdated || null
            };
          } else if (scope.emissionFactor === 'EPA') {
            // Check if data comes from emissionFactorValues or direct fields
            const epaSource = scope.emissionFactorValues?.epaData || scope;
            normalizedScope.emissionFactorValues.epaData = {
              scopeEPA:       epaSource.scopeEPA        || '',
              level1EPA:      epaSource.level1EPA       || '',
              level2EPA:      epaSource.level2EPA       || '',
              level3EPA:      epaSource.level3EPA       || '',
              level4EPA:      epaSource.level4EPA       || '',
              columnTextEPA:  epaSource.columnTextEPA   || '',
              uomEPA:         epaSource.uomEPA          || '',
              ghgUnitsEPA: Array.isArray(epaSource.ghgUnitsEPA)
                ? epaSource.ghgUnitsEPA
                : (epaSource.ghgUnitEPA && epaSource.ghgConversionFactorEPA != null)
                  ? [{ unit: epaSource.ghgUnitEPA, ghgconversionFactor: epaSource.ghgConversionFactorEPA }]
                  : [],
              gwpValue:epaSource.gwpValue || 0,
              gwpSearchField: epaSource.gwpSearchField || null,
              gwpLastUpdated:epaSource.gwpLastUpdated || null
            };
          } else if (scope.emissionFactor === 'Country') {
            // Check if data comes from emissionFactorValues or direct fields
            const countrySource = scope.emissionFactorValues?.countryData || scope;
            normalizedScope.emissionFactorValues.countryData = {
              C:             countrySource.C || countrySource.country || '',
              regionGrid:    countrySource.regionGrid       || '',
              emissionFactor:countrySource.emissionFactor   || '',
              reference:     countrySource.reference        || '',
              unit:          countrySource.unit             || '',
              yearlyValues:  Array.isArray(countrySource.yearlyValues)
                ? countrySource.yearlyValues.map(yv => ({
                    from:        yv.from,
                    to:          yv.to,
                    periodLabel: yv.periodLabel,
                    value:       yv.value
                  }))
                : []
            };
          }else if (scope.emissionFactor === 'EmissionFactorHub') {
            const hubSource = scope.emissionFactorValues?.emissionFactorHubData || scope;
            normalizedScope.emissionFactorValues.emissionFactorHubData = {
              factorId:    hubSource.factorId    || '',
              factorName:  hubSource.factorName  || '',
              category:    hubSource.category    || '',
              subcategory: hubSource.subcategory || '',
              unit:        hubSource.unit        || '',
              value:       hubSource.value       || 0,
              source:      hubSource.source      || '',
              reference:   hubSource.reference   || '',
              // Initialize GWP fields
              gwpValue: 0,
              gwpSearchField: null,
              gwpLastUpdated: null
            };
          }

          // Handle custom emission factor with GWP fields
          if (scope.emissionFactor === 'Custom') {
            normalizedScope.emissionFactorValues.customEmissionFactor = {
              ...normalizedScope.customEmissionFactor,
              // Initialize custom GWP fields
              CO2_gwp: 0,
              CH4_gwp: 0,
              N2O_gwp: 0,
              gwpLastUpdated: null
            };
          }
          // If emissionFactor is Custom, customEmissionFactor is already handled above
          // If emissionFactor is EmissionFactorHub or other, keep empty structures
          
          // ───────────────────────────────────────────────
          return normalizedScope;
        });
      }

      return {
        id:         node.id,
        label:      node.label,
        position:   node.position,
        parentNode: node.parentNode || null,
        details: {
          nodeType:          d.nodeType          || '',
          department:        d.department        || '',
          location:          d.location          || '',
          employeeHeadId:    d.employeeHeadId    || null,  // Don't forget this field if it exists
          scopeDetails:      d.scopeDetails      || [],
          additionalDetails: d.additionalDetails || {}
        }
      };
    });

    // 6) Normalize edges & auto-generate missing IDs
    let normalizedEdges = [];
    if (flowchartData.edges && Array.isArray(flowchartData.edges) && flowchartData.edges.length > 0) {
      normalizedEdges = flowchartData.edges
        .map(e => ({
          id:     e.id     || uuidv4(),
          source: e.source,
          target: e.target
        }))
        .filter(edge => edge.source && edge.target);
    }

    // 7) Create vs. Update
    let flowchart = await Flowchart.findOne({ clientId });
    let isNew = false;

    if (flowchart) {
      // **UPDATE** existing flowchart
      flowchart.nodes          = normalizedNodes;
      flowchart.edges          = normalizedEdges;
      flowchart.lastModifiedBy = userId;
      flowchart.version       += 1;
      await flowchart.save();
    } else {
      // **CREATE** new flowchart
      isNew = true;
      flowchart = new Flowchart({
        clientId,
        createdBy:      userId,
        creatorType:    req.user.userType,
        lastModifiedBy: userId,
        nodes:          normalizedNodes,
        edges:          normalizedEdges
      });
      await flowchart.save();
    }
    
    // Auto‐start flowchart status
    if (['consultant','consultant_admin'].includes(req.user.userType)) {
      await Client.findOneAndUpdate(
        { clientId },
        { 
          $set: {
            'workflowTracking.flowchartStatus': 'on_going',
            'workflowTracking.flowchartStartedAt': new Date()
          }
        }
      );
    }

    // 8) Send notifications to all client_admins of this client
    try {
      const clientAdmins = await User.find({
        userType: 'client_admin',
        clientId
      });
      
      for (const admin of clientAdmins) {
        await Notification.create({
          title:           isNew
                             ? `Flowchart Created for ${clientId}`
                             : `Flowchart Updated for ${clientId}`,
          message:         isNew
                             ? `A new flowchart was created for client ${clientId} by ${req.user.userName}.`
                             : `The flowchart for client ${clientId} was updated by ${req.user.userName}.`,
          priority:        isNew ? 'medium' : 'medium',
          createdBy:       userId, // Using consistent userId
          creatorType:     req.user.userType,
          targetUsers:     [admin._id || admin.id], // Handle both _id and id
          targetClients:   [clientId],
          status:          'published',
          publishedAt:     new Date(),
          isSystemNotification: true,
          systemAction:    isNew ? 'flowchart_created' : 'flowchart_updated',
          relatedEntity:   { type: 'flowchart', id: flowchart._id }
        });
      }
    } catch (notificationError) {
      console.error('❌ Error creating notifications:', notificationError);
      // Don't fail the entire operation if notifications fail
      // Just log the error and continue
    }

    // 9) Respond
    if (isNew) {
      return res.status(201).json({
        message:     'Flowchart created successfully',
        flowchartId: flowchart._id
      });
    } else {
      return res.status(200).json({
        message:     'Flowchart updated successfully',
        version:     flowchart.version,
        flowchartId: flowchart._id
      });
    }

  } catch (error) {
    console.error('❌ Error saving flowchart:', error);

    // Handle Mongo duplicate-key
    if (error.code === 11000) {
      return res.status(400).json({
        message: 'Duplicate key error - check for duplicate identifiers',
        error:   error.message,
        details:'This might be caused by duplicate edge IDs or scope identifiers'
      });
    }

    return res.status(500).json({
      message: 'Failed to save flowchart',
      error:   error.message
    });
  }
};

// Get single Flowchart with proper permissions
const getFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    // Check view permissions
    const permissionCheck = await canViewFlowchart(req.user, clientId);
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'You do not have permission to view this flowchart' 
      });
    }

    // Find flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true })
      .populate('createdBy', 'userName email userType')
      .populate('lastModifiedBy', 'userName email');

    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // Filter nodes based on permissions
    let filteredNodes = flowchart.nodes;
    
    // Employee heads see only their department/location nodes
    if (req.user.userType === 'client_employee_head' && !permissionCheck.fullAccess) {
      filteredNodes = flowchart.nodes.filter(node => {
        return node.details.department === req.user.department ||
               node.details.location === req.user.location;
      });
    }

    // Employees see limited scope details
    if (req.user.userType === 'employee' && !permissionCheck.fullAccess) {
      filteredNodes = flowchart.nodes.map(node => ({
        ...node.toObject(),
        details: {
          ...node.details,
          scopeDetails: node.details.scopeDetails.map(scope => ({
            scopeIdentifier: scope.scopeIdentifier,
            scopeType: scope.scopeType,
            dataCollectionType: scope.dataCollectionType
            // Hide sensitive emission details
          }))
        }
      }));
    }

    // Format response
    const response = {
      clientId: flowchart.clientId,
      createdBy: flowchart.createdBy,
      creatorType: flowchart.creatorType,
      lastModifiedBy: flowchart.lastModifiedBy,
      version: flowchart.version,
      createdAt: flowchart.createdAt,
      updatedAt: flowchart.updatedAt,
      nodes: filteredNodes.map(n => ({
        id: n.id,
        data: { 
          label: n.label, 
          details: n.details 
        },
        position: n.position,
        ...(n.parentNode ? { parentNode: n.parentNode } : {})
      })),
      edges: flowchart.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target
      })),
      permissions: {
        canEdit: permissionCheck.fullAccess && ['super_admin', 'consultant_admin', 'consultant'].includes(req.user.userType),
        canDelete: permissionCheck.fullAccess && ['super_admin', 'consultant_admin', 'consultant'].includes(req.user.userType)
      }
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching flowchart:', error);
    res.status(500).json({ 
      message: 'Failed to fetch flowchart', 
      error: error.message 
    });
  }
};

// Get All Flowcharts based on user hierarchy
const getAllFlowcharts = async (req, res) => {
  try {
    let query = { isActive: true };
    const { page = 1, limit = 10, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    // Build query based on user type
    switch (req.user.userType) {
      case 'super_admin':
        // Super admin sees all flowcharts
        // No additional query filters needed
        break;

      case 'consultant_admin':
        // Get all consultants under this admin
        const consultantsUnderAdmin = await User.find({
          consultantAdminId: req.user.id,
          userType: 'consultant'
        }).select('_id');
        
        const consultantIds = consultantsUnderAdmin.map(c => c._id);
        
        // Get all clients created by this consultant admin or assigned to their consultants
        const clients = await Client.find({
          $or: [
            { 'leadInfo.createdBy': req.user.id },
            { 'leadInfo.assignedConsultantId': { $in: consultantIds } }
          ]
        }).select('clientId');
        
        const clientIds = clients.map(c => c.clientId);
        
        // Filter flowcharts by these client IDs
        query.clientId = { $in: clientIds };
        break;

      case 'consultant':
        // Get clients assigned to this consultant
        const assignedClients = await Client.find({
          'leadInfo.assignedConsultantId': req.user.id
        }).select('clientId');
        
        const assignedClientIds = assignedClients.map(c => c.clientId);
        
        // Filter flowcharts by assigned client IDs
        query.clientId = { $in: assignedClientIds };
        break;

      case 'client_admin':
        // Client admin can only see their own client's flowchart
        query.clientId = req.user.clientId;
        break;

      default:
        // Other user types shouldn't access this endpoint
        return res.status(403).json({ 
          message: 'You do not have permission to view flowcharts' 
        });
    }

    // Add search functionality
    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      query.$or = [
        { clientId: searchRegex },
        { 'nodes.label': searchRegex }
      ];
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    // Get total count
    const total = await Flowchart.countDocuments(query);

    // Fetch flowcharts with pagination
    const flowcharts = await Flowchart.find(query)
      .populate('createdBy', 'userName email userType')
      .populate('lastModifiedBy', 'userName email')
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get client details for each flowchart
    const clientIds = [...new Set(flowcharts.map(f => f.clientId))];
    const clients = await Client.find({ 
      clientId: { $in: clientIds } 
    }).select('clientId leadInfo.companyName stage status');

    // Create client map for quick lookup
    const clientMap = {};
    clients.forEach(client => {
      clientMap[client.clientId] = {
        companyName: client.leadInfo.companyName,
        stage: client.stage,
        status: client.status
      };
    });

    // Format response with client details
    const formattedFlowcharts = flowcharts.map(flowchart => ({
      _id: flowchart._id,
      clientId: flowchart.clientId,
      clientDetails: clientMap[flowchart.clientId] || {},
      createdBy: flowchart.createdBy,
      creatorType: flowchart.creatorType,
      lastModifiedBy: flowchart.lastModifiedBy,
      version: flowchart.version,
      nodeCount: flowchart.nodes.length,
      edgeCount: flowchart.edges.length,
      scopeSummary: {
        'Scope 1': flowchart.nodes.reduce((count, node) => 
          count + node.details.scopeDetails.filter(s => s.scopeType === 'Scope 1').length, 0),
        'Scope 2': flowchart.nodes.reduce((count, node) => 
          count + node.details.scopeDetails.filter(s => s.scopeType === 'Scope 2').length, 0),
        'Scope 3': flowchart.nodes.reduce((count, node) => 
          count + node.details.scopeDetails.filter(s => s.scopeType === 'Scope 3').length, 0)
      },
      createdAt: flowchart.createdAt,
      updatedAt: flowchart.updatedAt
    }));

    // Response
    res.status(200).json({
      success: true,
      message: 'Flowcharts fetched successfully',
      data: {
        flowcharts: formattedFlowcharts,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
          hasNextPage: page < Math.ceil(total / parseInt(limit)),
          hasPrevPage: page > 1
        }
      }
    });

  } catch (error) {
    console.error('Error fetching all flowcharts:', error);
    res.status(500).json({ 
      message: 'Failed to fetch flowcharts', 
      error: error.message 
    });
  }
};

// Delete Flowchart (soft delete)
// Delete Flowchart (soft delete)
const deleteFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Only super_admin, consultant_admin, consultant
    if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: 'Only Super Admin, Consultant Admin, and Consultants can delete flowcharts' 
      });
    }

    // Permission check
    const perm = await canManageFlowchart(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: perm.reason 
      });
    }

    // Find the active flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // Soft delete
    flowchart.isActive       = false;
    flowchart.lastModifiedBy = req.user._id;
    await flowchart.save();

    // Notify all client_admins for this client
    const clientAdmins = await User.find({ 
      userType: 'client_admin', 
      clientId 
    });
    for (const admin of clientAdmins) {
      await Notification.create({
        title:           `Flowchart Deleted: ${clientId}`,
        message:         `The flowchart for client ${clientId} was deleted by ${req.user.userName}.`,
        priority:        'high',
        createdBy:       req.user._id,
        creatorType:     req.user.userType,
        targetUsers:     [admin._id],
        targetClients:   [clientId],
        status:          'published',
        publishedAt:     new Date(),
        isSystemNotification: true,
        systemAction:    'flowchart_deleted',
        relatedEntity:   { type: 'flowchart', id: flowchart._id }
      });
    }

    console.log(`✅ Flowchart soft-deleted for ${clientId} by ${req.user.userName}`);
    return res.status(200).json({ message: 'Flowchart deleted successfully' });
  } catch (error) {
    console.error('Error deleting flowchart:', error);
    return res.status(500).json({ 
      message: 'Failed to delete flowchart', 
      error: error.message 
    });
  }
};
// Delete specific node in flowchart
const deleteFlowchartNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;

    // Permission check
    const perm = await canManageFlowchart(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: perm.reason 
      });
    }

    // Find active flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // Locate node
    const nodeIndex = flowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // Remove node and any edges tied to it
    flowchart.nodes.splice(nodeIndex, 1);
    flowchart.edges = flowchart.edges.filter(
      e => e.source !== nodeId && e.target !== nodeId
    );

    flowchart.lastModifiedBy = req.user.id;
    flowchart.version += 1;
    await flowchart.save();

    res.status(200).json({ message: 'Node deleted successfully' });
  } catch (error) {
    console.error('Error deleting node:', error);
    res.status(500).json({ 
      message: 'Failed to delete node', 
      error: error.message 
    });
  }
};

// Restore Flowchart
// Restore soft-deleted flowchart, with conflict check
const restoreFlowchart = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Only super_admin, consultant_admin, consultant
    if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: 'Only Super Admin, Consultant Admin, and Consultants can restore flowcharts' 
      });
    }

    // Permission check
    const perm = await canManageFlowchart(req.user, clientId);
    if (!perm.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: perm.reason 
      });
    }

    // Conflict: if there's already an active flowchart for this client
    const existingActive = await Flowchart.findOne({ clientId, isActive: true });
    if (existingActive) {
      return res.status(409).json({
        message: 'Conflict: an active flowchart already exists for this client'
      });
    }

    // Find the soft-deleted flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: false });
    if (!flowchart) {
      return res.status(404).json({ message: 'No deleted flowchart to restore' });
    }

    // Restore
    flowchart.isActive       = true;
    flowchart.lastModifiedBy = req.user.id;
    flowchart.version       += 1;
    await flowchart.save();

    res.status(200).json({ 
      message: 'Flowchart restored successfully' 
    });

  } catch (error) {
    console.error('Error restoring flowchart:', error);
    res.status(500).json({ 
      message: 'Failed to restore flowchart', 
      error: error.message 
    });
  }
};


// Get Flowchart Summary (for dashboards) - Supports both consolidated and single client
const getFlowchartSummary = async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Check if this is a request for consolidated summary
    // This handles both /summary route and cases where clientId might be undefined
    if (!clientId || clientId === 'summary') {
      return getConsolidatedSummary(req, res);
    }
    
    // Otherwise, return single client summary
    return getSingleClientSummary(req, res, clientId);
    
  } catch (error) {
    console.error('Error getting flowchart summary:', error);
    res.status(500).json({ 
      message: 'Failed to get summary', 
      error: error.message 
    });
  }
};

// Helper function for single client summary
const getSingleClientSummary = async (req, res, clientId) => {
  const permissionCheck = await canViewFlowchart(req.user, clientId);
  if (!permissionCheck.allowed) {
    return res.status(403).json({ 
      message: 'Permission denied' 
    });
  }

  const flowchart = await Flowchart.findOne({ clientId, isActive: true });
  if (!flowchart) {
    return res.status(404).json({ message: 'Flowchart not found' });
  }

  // Get client details
  const client = await Client.findOne({ clientId })
    .populate('leadInfo.createdBy', 'userName userType')
    .populate('leadInfo.assignedConsultantId', 'userName');

  // Calculate summary
  const summary = {
    clientId: flowchart.clientId,
    clientName: client?.leadInfo?.companyName || 'Unknown',
    totalNodes: flowchart.nodes.length,
    totalEdges: flowchart.edges.length,
    nodesByDepartment: {},
    nodesByLocation: {},
    scopesSummary: {
      'Scope 1': 0,
      'Scope 2': 0,
      'Scope 3': 0
    },
    dataCollectionMethods: {
      manual: 0,
      IOT: 0,
      API: 0
    },
    emissionFactors: {
      IPCC: 0,
      DEFRA: 0,
      EPA: 0,
      EmissionFactorHub: 0,
      Custom: 0
    },
    createdAt: flowchart.createdAt,
    updatedAt: flowchart.updatedAt,
    version: flowchart.version
  };

  // Add creator info for super admin
  if (req.user.userType === 'super_admin') {
    summary.createdBy = {
      userName: client?.leadInfo?.createdBy?.userName,
      userType: client?.leadInfo?.createdBy?.userType
    };
    summary.assignedConsultant = client?.leadInfo?.assignedConsultantId?.userName;
  }

  // Apply restrictions for employee heads
  let nodesToAnalyze = flowchart.nodes;
  if (req.user.userType === 'client_employee_head' && !permissionCheck.fullAccess) {
    nodesToAnalyze = flowchart.nodes.filter(node => {
      return node.details.department === req.user.department ||
             node.details.location === req.user.location;
    });
  }

  nodesToAnalyze.forEach(node => {
    // Count by department
    if (node.details.department) {
      summary.nodesByDepartment[node.details.department] = 
        (summary.nodesByDepartment[node.details.department] || 0) + 1;
    }

    // Count by location
    if (node.details.location) {
      summary.nodesByLocation[node.details.location] = 
        (summary.nodesByLocation[node.details.location] || 0) + 1;
    }

    // Count scopes and collection methods
    node.details.scopeDetails.forEach(scope => {
      summary.scopesSummary[scope.scopeType]++;
      summary.dataCollectionMethods[scope.inputType]++; // Fixed: was scope.dataCollectionType
      
      // Count emission factors for Scope 1
      if (scope.scopeType === 'Scope 1' && scope.emissionFactor) {
        summary.emissionFactors[scope.emissionFactor]++;
      }
    });
  });

  res.status(200).json({
    success: true,
    data: summary
  });
};

// Helper function for consolidated summary
const getConsolidatedSummary = async (req, res) => {
  let query = { isActive: true };
  let clientQuery = {};

  // Build query based on user type
  switch (req.user.userType) {
    case 'super_admin':
      // Super admin sees all flowcharts
      break;

    case 'consultant_admin':
      // Get all consultants under this admin
      const consultantsUnderAdmin = await User.find({
        consultantAdminId: req.user._id,
        userType: 'consultant'
      }).select('_id');
      
      const consultantIds = consultantsUnderAdmin.map(c => c._id);
      
      // Get all clients created by this consultant admin or assigned to their consultants
      clientQuery = {
        $or: [
          { 'leadInfo.createdBy': req.user._id },
          { 'leadInfo.assignedConsultantId': { $in: consultantIds } }
        ]
      };
      break;

    case 'consultant':
      // Get clients assigned to this consultant
      clientQuery = {
        'leadInfo.assignedConsultantId': req.user._id
      };
      break;

    default:
      return res.status(403).json({ 
        message: 'You do not have permission to view consolidated summary' 
      });
  }

  // Get eligible clients
  const clients = await Client.find(clientQuery)
    .populate('leadInfo.createdBy', 'userName userType')
    .populate('leadInfo.assignedConsultantId', 'userName');
  
  const clientIds = clients.map(c => c.clientId);
  
  // Update query for flowcharts
  if (req.user.userType !== 'super_admin') {
    query.clientId = { $in: clientIds };
  }

  // Fetch all accessible flowcharts
  const flowcharts = await Flowchart.find(query)
    .populate('createdBy', 'userName userType')
    .populate('lastModifiedBy', 'userName');

  // Create client map for quick lookup
  const clientMap = {};
  clients.forEach(client => {
    clientMap[client.clientId] = client;
  });

  // Initialize consolidated summary
  const consolidatedSummary = {
    totalFlowcharts: flowcharts.length,
    flowchartsByClient: []
  };

  // Process each flowchart
  flowcharts.forEach(flowchart => {
    const client = clientMap[flowchart.clientId];
    
    // Create client-specific summary with all details
    const clientSummary = {
      clientId: flowchart.clientId,
      clientName: client?.leadInfo?.companyName || 'Unknown',
      totalNodes: flowchart.nodes.length,
      totalEdges: flowchart.edges.length,
      nodesByDepartment: {},
      nodesByLocation: {},
      scopesSummary: {
        'Scope 1': 0,
        'Scope 2': 0,
        'Scope 3': 0
      },
      dataCollectionMethods: {
        manual: 0,
        IOT: 0,
        API: 0
      },
      emissionFactors: {
        IPCC: 0,
        DEFRA: 0,
        EPA: 0,
        EmissionFactorHub: 0,
        Custom: 0
      },
      createdAt: flowchart.createdAt,
      updatedAt: flowchart.updatedAt,
      version: flowchart.version
    };

    // Add creator info for super admin
    if (req.user.userType === 'super_admin') {
      clientSummary.createdBy = {
        userName: client?.leadInfo?.createdBy?.userName,
        userType: client?.leadInfo?.createdBy?.userType
      };
      clientSummary.assignedConsultant = client?.leadInfo?.assignedConsultantId?.userName;
    }

    // Process nodes for this specific flowchart
    flowchart.nodes.forEach(node => {
      // Count by department
      if (node.details.department) {
        clientSummary.nodesByDepartment[node.details.department] = 
          (clientSummary.nodesByDepartment[node.details.department] || 0) + 1;
      }

      // Count by location
      if (node.details.location) {
        clientSummary.nodesByLocation[node.details.location] = 
          (clientSummary.nodesByLocation[node.details.location] || 0) + 1;
      }

      // Count scopes and collection methods
      node.details.scopeDetails.forEach(scope => {
        clientSummary.scopesSummary[scope.scopeType]++;
        clientSummary.dataCollectionMethods[scope.inputType]++;
        
        // Count emission factors for Scope 1
        if (scope.scopeType === 'Scope 1' && scope.emissionFactor) {
          clientSummary.emissionFactors[scope.emissionFactor]++;
        }
      });
    });

    consolidatedSummary.flowchartsByClient.push(clientSummary);
  });

  // Optionally add overall statistics
  if (flowcharts.length > 0) {
    // Calculate overall totals
    let overallTotals = {
      totalNodes: 0,
      totalEdges: 0,
      totalScopes: {
        'Scope 1': 0,
        'Scope 2': 0,
        'Scope 3': 0
      }
    };

    consolidatedSummary.flowchartsByClient.forEach(client => {
      overallTotals.totalNodes += client.totalNodes;
      overallTotals.totalEdges += client.totalEdges;
      overallTotals.totalScopes['Scope 1'] += client.scopesSummary['Scope 1'];
      overallTotals.totalScopes['Scope 2'] += client.scopesSummary['Scope 2'];
      overallTotals.totalScopes['Scope 3'] += client.scopesSummary['Scope 3'];
    });

    consolidatedSummary.overallStatistics = {
      averageNodesPerFlowchart: Math.round(overallTotals.totalNodes / flowcharts.length),
      averageEdgesPerFlowchart: Math.round(overallTotals.totalEdges / flowcharts.length),
      totalScopes: overallTotals.totalScopes
    };
  }

  res.status(200).json({
    success: true,
    data: consolidatedSummary
  });
};





// In the updateFlowchartNode function, ensure custom emission factors are handled
// This is a modification to the existing updateFlowchartNode function

const updateFlowchartNode = async (req, res) => {
  try {
    const { clientId, nodeId } = req.params;
    const { nodeData } = req.body;

    // Check if user is authenticated and has required fields
    if (!req.user || (!req.user._id && !req.user.id)) {
      return res.status(401).json({
        message: 'Authentication required - user information missing'
      });
    }

    // Ensure we have a consistent userId
    const userId = req.user._id || req.user.id;

    // Check permissions
    const permissionCheck = await canManageFlowchart(req.user, clientId);
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied',
        reason: permissionCheck.reason 
      });
    }

    // Find flowchart
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // Find node index
    const nodeIndex = flowchart.nodes.findIndex(n => n.id === nodeId);
    if (nodeIndex === -1) {
      return res.status(404).json({ message: 'Node not found' });
    }

    // Validate and normalize scope details if updating
    if (nodeData.details?.scopeDetails) {
      try {
        validateScopeDetails(nodeData.details.scopeDetails, nodeId);
        
        // Normalize the scope details with dynamic emission factor support
        nodeData.details.scopeDetails = nodeData.details.scopeDetails.map(scope => {
          const normalizedScope = {
            scopeIdentifier:      scope.scopeIdentifier.trim(),
            scopeType:            scope.scopeType,
            inputType:            scope.inputType          || 'manual',
            apiStatus:            scope.apiStatus          || false,
            apiEndpoint:          scope.apiEndpoint        || '',
            iotStatus:            scope.iotStatus          || false,
            iotDeviceId:          scope.iotDeviceId        || '',
            emissionFactor:       scope.emissionFactor     || '',
            categoryName:         scope.categoryName       || '',
            activity:             scope.activity           || '',
            fuel:                 scope.fuel               || '',
            units:                scope.units              || '',
            country:              scope.country            || '',
            regionGrid:           scope.regionGrid         || '',
            electricityUnit:      scope.electricityUnit    || '',
            scope3Category:       scope.scope3Category     || '',
            activityDescription:  scope.activityDescription|| '',
            itemName:             scope.itemName           || '',
            scope3Unit:           scope.scope3Unit         || '',
            description:          scope.description        || '',
            source:               scope.source             || '',
            reference:            scope.reference          || '',
            collectionFrequency:  scope.collectionFrequency|| 'monthly',
            calculationModel:     scope.calculationModel  || 'tier 1',
            additionalInfo:       scope.additionalInfo     || {},
            assignedEmployees:    scope.assignedEmployees  || [],
            UAD:                  scope.UAD                || 0,
            UEF:                  scope.UEF                || 0
          };
          
          // Handle custom emission factor
          if (scope.emissionFactor === 'Custom') {
            normalizedScope.customEmissionFactor = {
              CO2:  scope.customEmissionFactor?.CO2  ?? null,
              CH4:  scope.customEmissionFactor?.CH4  ?? null,
              N2O:  scope.customEmissionFactor?.N2O  ?? null,
              CO2e: scope.customEmissionFactor?.CO2e ?? null,
              unit: scope.customEmissionFactor?.unit || '',
               // Process Emission Factor 
              industryAverageEmissionFactor:scope.customEmissionFactor?.industryAverageEmissionFactor || null,
              stoichiometicFactor: scope.customEmissionFactor?.stoichiometicFactor || null,
              conversionEfficiency: scope.customEmissionFactor?.conversionEfficiency || null,

              // fugitive emission Factor Values 
              chargeType: scope.customEmissionFactor?.chargeType || '',
              leakageRate: scope.customEmissionFactor?.leakageRate || null,
              Gwp_refrigerant: scope.customEmissionFactor?.Gwp_refrigerant || null,
              GWP_fugitiveEmission: scope.customEmissionFactor?.GWP_fugitiveEmission || null,
              // GWP value
              CO2_gwp: scope.customEmissionFactor?.CO2_gwp ?? 0,
              CH4_gwp: scope.customEmissionFactor?.CH4_gwp ?? 0,
              N2O_gwp: scope.customEmissionFactor?.N2O_gwp ?? 0,

              
            };
          } else {
            normalizedScope.customEmissionFactor = {
              CO2: null,
              CH4: null,
              N2O: null,
              CO2e: null,
              unit: ''
            };
          }
          
          // ───── UPDATED: Dynamic emissionFactorValues based on emissionFactor choice ─────
          const validSources = ['DEFRA','IPCC','EPA','EmissionFactorHub','Custom','Country'];
          
          // Initialize empty emissionFactorValues structure (this clears old data)
          normalizedScope.emissionFactorValues = {
            defraData: {},
            ipccData: {},
            epaData: {},
            countryData: {},
            customEmissionFactor: normalizedScope.customEmissionFactor,
            dataSource: validSources.includes(scope.emissionFactor) ? scope.emissionFactor : undefined,
            lastUpdated: new Date()
          };

          // Populate only the relevant data based on emissionFactor choice
          if (scope.emissionFactor === 'DEFRA') {
            // Check if data comes from emissionFactorValues or direct fields
            const defraSource = scope.emissionFactorValues?.defraData || scope;
            normalizedScope.emissionFactorValues.defraData = {
              scope:   defraSource.scope    || '',
              level1:  defraSource.level1   || '',
              level2:  defraSource.level2   || '',
              level3:  defraSource.level3   || '',
              level4:  defraSource.level4   || '',
              columnText: defraSource.columnText || '',
              uom:     defraSource.uom      || '',
              ghgUnits: Array.isArray(defraSource.ghgUnits) 
                ? defraSource.ghgUnits
                : (defraSource.ghgUnit && defraSource.ghgConversionFactor != null)
                  ? [{ unit: defraSource.ghgUnit, ghgconversionFactor: defraSource.ghgConversionFactor }]
                  : [],
              gwpValue: defraSource.gwpValue || 0,
              gwpSearchField: defraSource.gwpSearchField || null,
              gwpLastUpdated: defraSource.gwpLastUpdated || null
            };
          } else if (scope.emissionFactor === 'IPCC') {
            // Check if data comes from emissionFactorValues or direct fields
            const ipccSource = scope.emissionFactorValues?.ipccData || scope;
            normalizedScope.emissionFactorValues.ipccData = {
              level1:         ipccSource.level1           || '',
              level2:         ipccSource.level2           || '',
              level3:         ipccSource.level3           || '',
              cpool:          ipccSource.cpool || ipccSource.Cpool || '',
              typeOfParameter:ipccSource.typeOfParameter || ipccSource.TypeOfParameter || '',
              unit:           ipccSource.unit || ipccSource.Unit || '',
              value:          ipccSource.value ?? ipccSource.Value ?? null,
              description:    ipccSource.description || ipccSource.Description || '',
              gwpValue: ipccSource.gwpValue || 0,
              gwpSearchField:ipccSource.gwpSearchField || null,
              gwpLastUpdated: ipccSource.gwpLastUpdated || null
            };
          } else if (scope.emissionFactor === 'EPA') {
            // Check if data comes from emissionFactorValues or direct fields
            const epaSource = scope.emissionFactorValues?.epaData || scope;
            normalizedScope.emissionFactorValues.epaData = {
              scopeEPA:       epaSource.scopeEPA        || '',
              level1EPA:      epaSource.level1EPA       || '',
              level2EPA:      epaSource.level2EPA       || '',
              level3EPA:      epaSource.level3EPA       || '',
              level4EPA:      epaSource.level4EPA       || '',
              columnTextEPA:  epaSource.columnTextEPA   || '',
              uomEPA:         epaSource.uomEPA          || '',
              ghgUnitsEPA: Array.isArray(epaSource.ghgUnitsEPA)
                ? epaSource.ghgUnitsEPA
                : (epaSource.ghgUnitEPA && epaSource.ghgConversionFactorEPA != null)
                  ? [{ unit: epaSource.ghgUnitEPA, ghgconversionFactor: epaSource.ghgConversionFactorEPA }]
                  : [],
               gwpValue:epaSource.gwpValue || 0,
              gwpSearchField: epaSource.gwpSearchField || null,
              gwpLastUpdated:epaSource.gwpLastUpdated || null
            };
          } else if (scope.emissionFactor === 'Country') {
            // Check if data comes from emissionFactorValues or direct fields
            const countrySource = scope.emissionFactorValues?.countryData || scope;
            normalizedScope.emissionFactorValues.countryData = {
              C:             countrySource.C || countrySource.country || '',
              regionGrid:    countrySource.regionGrid       || '',
              emissionFactor:countrySource.emissionFactor   || '',
              reference:     countrySource.reference        || '',
              unit:          countrySource.unit             || '',
              yearlyValues:  Array.isArray(countrySource.yearlyValues)
                ? countrySource.yearlyValues.map(yv => ({
                    from:        yv.from,
                    to:          yv.to,
                    periodLabel: yv.periodLabel,
                    value:       yv.value
                  }))
                : []
            };
          }
          // If emissionFactor is Custom, customEmissionFactor is already handled above
          // If emissionFactor is EmissionFactorHub or other, keep empty structures
          
          // ───────────────────────────────────────────────
          
          return normalizedScope;
        });
      } catch (error) {
        return res.status(400).json({
          message: `Node validation failed: ${error.message}`
        });
      }
    }

    // Update node
    flowchart.nodes[nodeIndex] = {
      ...flowchart.nodes[nodeIndex].toObject(),
      ...nodeData,
      id: nodeId // Ensure ID doesn't change
    };

    flowchart.lastModifiedBy = userId;
    flowchart.version += 1;
    await flowchart.save();

    res.status(200).json({ 
      message: 'Node updated successfully',
      node: flowchart.nodes[nodeIndex]
    });
  } catch (error) {
    console.error('Error updating node:', error);
    res.status(500).json({ 
      message: 'Failed to update node', 
      error: error.message 
    });
  }
};

module.exports = {
  saveFlowchart,
  getFlowchart,
  getAllFlowcharts,
  deleteFlowchart,
  deleteFlowchartNode,
  restoreFlowchart,
  getFlowchartSummary,
  getConsolidatedSummary,
  updateFlowchartNode,
};