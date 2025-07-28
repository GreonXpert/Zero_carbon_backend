// utils/chart/chartHelpers.js

const { v4: uuidv4 } = require('uuid');

/**
 * Validate scope details for a node
 */
const validateScopeDetails = (scopeDetails, nodeId) => {
  if (!Array.isArray(scopeDetails)) {
    throw new Error(`scopeDetails must be an array for node ${nodeId}`);
  }
  
  scopeDetails.forEach((scope, index) => {
    if (!scope.scopeIdentifier || typeof scope.scopeIdentifier !== 'string') {
      throw new Error(`Missing or invalid scopeIdentifier at index ${index} for node ${nodeId}`);
    }
    if (!scope.scopeType) {
      throw new Error(`Missing scopeType at index ${index} for node ${nodeId}`);
    }
  });
};

/**
 * Normalize a single scope detail object
 */
const normalizeScopeDetail = (scope) => {
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
    itemName:             scope.itemName           || '',
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
    const rawCEF = scope.emissionFactorValues?.customEmissionFactor 
                 || scope.customEmissionFactor 
                 || {};
    normalizedScope.customEmissionFactor = {
      CO2:  rawCEF.CO2  ?? null,
      CH4:  rawCEF.CH4  ?? null,
      N2O:  rawCEF.N2O  ?? null,
      CO2e: rawCEF.CO2e ?? null,
      unit: rawCEF.unit || '',

      // Process-level fields
      industryAverageEmissionFactor: rawCEF.industryAverageEmissionFactor || null,
      stoichiometicFactor:           rawCEF.stoichiometicFactor || null,
      conversionEfficiency:          rawCEF.conversionEfficiency || null,

      // Fugitive-emission fields
      chargeType:     rawCEF.chargeType    || '',
      leakageRate:    rawCEF.leakageRate   ?? null,
      Gwp_refrigerant: rawCEF.Gwp_refrigerent ?? rawCEF.Gwp_refrigerant ?? null,

      GWP_fugitiveEmission: rawCEF.GWP_fugitiveEmission ?? null,
      GWP_SF6:rawCEF.GWP_SF6 ?? null,
      EmissionFactorFugitiveCH4Leak: rawCEF.EmissionFactorFugitiveCH4Leak ?? null,
      GWP_CH4_leak:rawCEF.GWP_CH4_leak ?? null,
      EmissionFactorFugitiveCH4Component:rawCEF.EmissionFactorFugitiveCH4Component ?? null,
      GWP_CH4_Component:rawCEF.GWP_CH4_Component ?? null,

      // GWP override fields
      CO2_gwp: rawCEF.CO2_gwp ?? null,
      CH4_gwp: rawCEF.CH4_gwp ?? null,
      N2O_gwp: rawCEF.N2O_gwp ?? null
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

  // Initialize emissionFactorValues structure
  const validSources = ['DEFRA','IPCC','EPA','EmissionFactorHub','Custom','Country'];
  normalizedScope.emissionFactorValues = {
    defraData: {},
    ipccData: {},
    epaData: {},
    countryData: {},
    customEmissionFactor: normalizedScope.customEmissionFactor,
    dataSource: validSources.includes(scope.emissionFactor) ? scope.emissionFactor : undefined,
    lastUpdated: new Date()
  };

  // Populate emission factor data based on source
  if (scope.emissionFactor === 'DEFRA') {
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
  } else if (scope.emissionFactor === 'EmissionFactorHub') {
    const hubSource = scope.emissionFactorValues?.emissionFactorHubData || scope;
    normalizedScope.emissionFactorValues.emissionFactorHubData = {
      scope:    hubSource.scope    || '',
      category:  hubSource.category  || '',
      activity:    hubSource.activity    || '',
      itemName: hubSource.itemName || '',
      unit:        hubSource.unit        || '',
      value:       hubSource.value       || 0,
      source:      hubSource.source      || '',
      reference:   hubSource.reference   || '',
      gwpValue: 0,
      gwpSearchField: null,
      gwpLastUpdated: null
    };
  }

  return normalizedScope;
};

/**
 * Normalize nodes based on assessmentLevel
 * @param {Array} nodes - Array of nodes
 * @param {String} assessmentLevel - 'both', 'process', or 'organization'
 * @param {String} chartType - 'flowchart' or 'processFlowchart'
 */
const normalizeNodes = (nodes, assessmentLevel, chartType) => {
  return nodes.map(node => {
    const d = node.details || {};
    
    // For processFlowchart with assessmentLevel 'both', only return basic details
    if (chartType === 'processFlowchart' && assessmentLevel === 'both') {
      return {
        id:         node.id,
        label:      node.label,
        position:   node.position,
        parentNode: node.parentNode || null,
        details: {
          nodeType:          d.nodeType          || '',
          department:        d.department        || '',
          location:          d.location          || '',
          employeeHeadId:    d.employeeHeadId    || null,
          scopeDetails:      [], // Empty scopeDetails for basic view
          additionalDetails: d.additionalDetails || {}
        }
      };
    }
    
    // For all other cases, process scopeDetails if present
    if (Array.isArray(d.scopeDetails) && d.scopeDetails.length) {
      validateScopeDetails(d.scopeDetails, node.id);
      d.scopeDetails = d.scopeDetails.map(scope => normalizeScopeDetail(scope));
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
        employeeHeadId:    d.employeeHeadId    || null,
        scopeDetails:      d.scopeDetails      || [],
        additionalDetails: d.additionalDetails || {}
      }
    };
  });
};

/**
 * Normalize edges with auto-generated IDs
 */
const normalizeEdges = (edges) => {
  if (!edges || !Array.isArray(edges) || edges.length === 0) {
    return [];
  }
  
  return edges
    .map(e => ({
      id:     e.id     || uuidv4(),
      source: e.source,
      target: e.target
    }))
    .filter(edge => edge.source && edge.target);
};

/**
 * Create notifications for flowchart/processFlowchart updates
 */
const createChartNotifications = async (User, Notification, {
  clientId,
  userId,
  userType,
  userName,
  isNew,
  chartType,
  chartId
}) => {
  try {
    const clientAdmins = await User.find({
      userType: 'client_admin',
      clientId
    });
    
    const chartName = chartType === 'processFlowchart' ? 'Process Flowchart' : 'Flowchart';
    
    for (const admin of clientAdmins) {
      await Notification.create({
        title:           isNew
                          ? `${chartName} Created for ${clientId}`
                          : `${chartName} Updated for ${clientId}`,
        message:         isNew
                          ? `A new ${chartName.toLowerCase()} was created for client ${clientId} by ${userName}.`
                          : `The ${chartName.toLowerCase()} for client ${clientId} was updated by ${userName}.`,
        priority:        'medium',
        createdBy:       userId,
        creatorType:     userType,
        targetUsers:     [admin._id || admin.id],
        targetClients:   [clientId],
        status:          'published',
        publishedAt:     new Date(),
        isSystemNotification: true,
        systemAction:    isNew ? `${chartType}_created` : `${chartType}_updated`,
        relatedEntity:   { type: chartType, id: chartId }
      });
    }
  } catch (notificationError) {
    console.error(`❌ Error creating ${chartType} notifications:`, notificationError);
    // Don't fail the entire operation if notifications fail
  }
};

/**
 * Check if chart is available based on assessmentLevel
 */
const isChartAvailable = (assessmentLevel, chartType) => {
  const availability = {
    flowchart: {
      both: true,
      organization: true,
      process: false
    },
    processFlowchart: {
      both: true,
      process: true,
      organization: false
    }
  };
  
  return availability[chartType]?.[assessmentLevel] ?? false;
};

/**
 * Get error message for unavailable chart
 */
const getChartUnavailableMessage = (assessmentLevel, chartType) => {
  const chartName = chartType === 'processFlowchart' ? 'Process flowchart' : 'Flowchart';
  const availableFor = chartType === 'processFlowchart' 
    ? ['both', 'process'] 
    : ['both', 'organization'];
    
  return {
    message: `${chartName} is not available for assessment level: ${assessmentLevel}`,
    availableFor
  };
};

module.exports = {
  validateScopeDetails,
  normalizeScopeDetail,
  normalizeNodes,
  normalizeEdges,
  createChartNotifications,
  isChartAvailable,
  getChartUnavailableMessage
};