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

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};



/**
 * Normalize a single scope detail object
 */
const normalizeScopeDetail = (scope) => {
  const normalizedScope = {
    //scopeUid: scope.scopeUid || scope.uid || scope._id || uuidv4(),
    scopeIdentifier:      scope.scopeIdentifier.trim(),
    scopeType:            scope.scopeType,
    projectActivityType:  scope.projectActivityType || 'null',
    inputType:            scope.inputType          || 'manual',
    
    apiStatus:            scope.apiStatus          || false,
    fromOtherChart:       scope.fromOtherChart     || false,
    apiEndpoint:          scope.apiEndpoint        || '',
    iotStatus:            scope.iotStatus          || false,
    iotDeviceId:          scope.iotDeviceId        || '',
    apiKeyRequest: {
    status: scope?.apiKeyRequest?.status || 'none', // 'none' | 'pending' | 'approved' | 'rejected'
    requestedInputType: scope?.apiKeyRequest?.requestedInputType ?? null, // 'API' | 'IOT' | null
    requestedAt: scope?.apiKeyRequest?.requestedAt ?? null,
    approvedAt: scope?.apiKeyRequest?.approvedAt ?? null,
    rejectedAt: scope?.apiKeyRequest?.rejectedAt ?? null,
    apiKeyId: scope?.apiKeyRequest?.apiKeyId ?? null,
    requestId: scope?.apiKeyRequest?.requestId ?? null
    },
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
    UEF:                  scope.UEF                || 0,
    reductionSetup: scope.reductionSetup || {
      initialBE: 0,
      initialPE: 0,
      initialLE: 0,
      initialBufferPercentage: 0,
      initialBufferEmissions: 0,
      initialNetReduction: 0,
      unitReductionFactor: 0,
      setupCompletedAt: null,
      setupCompletedBy: null,
      isSetupCompleted: false,
      setupCalculationDetails: {
        setupAPDValues: new Map(),
        setupABDValues: new Map(),
        setupALDValues: new Map(),
        setupEmissionFactor: 0,
        setupNotes: ''
      }
    },
    reductionCalculationMode: scope.reductionCalculationMode || 'advanced'
  
  };
  // ── Custom values (optional, with alias support) ─────────────────────────────
  const rawCV = scope.customValues || scope.customValue || {};
  normalizedScope.customValues = {
    assetLifetime:        numOrNull(
                            rawCV.assetLifetime ??
                            rawCV.AssetLifeTime ??
                            rawCV.AssestLifeTime ??     // common typo accepted
                            rawCV.assetLifeTime
                          ),
    TDLossFactor:         numOrNull(
                            rawCV.TDLossFactor ??
                            rawCV['T&DLossFactor'] ??   // if frontend sends T&DLossFactor
                            rawCV.TAndDLossFactor
                          ),
    defaultRecyclingRate: numOrNull(
                            rawCV.defaultRecyclingRate ??
                            rawCV.defaultRecylingRate ?? // common typo accepted
                            rawCV.defaultRecycleRate
                          )
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
      N2O_gwp: rawCEF.N2O_gwp ?? null,
      CO2e_gwp: rawCEF.CO2e_gwp ?? null,

      CO2_comment: rawCEF.CO2_comment || '',
      CH4_comment: rawCEF.CH4_comment || '',
      N2O_comment: rawCEF.N2O_comment || '',
      CO2e_comment: rawCEF.CO2e_comment || '',
      unit_comment: rawCEF.unit_comment || '',
      industryAverageEmissionFactor_comment: rawCEF.industryAverageEmissionFactor_comment || '',
      stoichiometicFactor_comment: rawCEF.stoichiometicFactor_comment || '',
      conversionEfficiency_comment: rawCEF.conversionEfficiency_comment || '',
      chargeType_comment: rawCEF.chargeType_comment || '',
      leakageRate_comment: rawCEF.leakageRate_comment || '',
      Gwp_refrigerant_comment: rawCEF.Gwp_refrigerant_comment || '',
      GWP_fugitiveEmission_comment: rawCEF.GWP_fugitiveEmission_comment || '',
      GWP_SF6_comment: rawCEF.GWP_SF6_comment || '',
      EmissionFactorFugitiveCH4Leak_comment: rawCEF.EmissionFactorFugitiveCH4Leak_comment || '',
      GWP_CH4_leak_comment: rawCEF.GWP_CH4_leak_comment || '',
      EmissionFactorFugitiveCH4Component_comment: rawCEF.EmissionFactorFugitiveCH4Component_comment || '',
      GWP_CH4_Component_comment: rawCEF.GWP_CH4_Component_comment || '',
      CO2_gwp_comment: rawCEF.CO2_gwp_comment || '',
      CH4_gwp_comment: rawCEF.CH4_gwp_comment || '',
      N2O_gwp_comment: rawCEF.N2O_gwp_comment || '',
      CO2e_gwp_comment: rawCEF.CO2e_gwp_comment || ''

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
     
      fuelDensityLiter: ipccSource.fuelDensityLiter || null,
    fuelDensityM3: ipccSource.fuelDensityM3 || null,
      unit:           ipccSource.unit || ipccSource.Unit || '',
      ghgUnits: Array.isArray(ipccSource.ghgUnits) 
        ? ipccSource.ghgUnits
        : (ipccSource.ghgUnit && ipccSource.ghgConversionFactor != null)
          ? [{ unit: ipccSource.ghgUnit, ghgconversionFactor: ipccSource.ghgConversionFactor }]
          : [],
      gwpValue: ipccSource.gwpValue || 0,
      gwpSearchField: ipccSource.gwpSearchField || null,
      gwpLastUpdated: ipccSource.gwpLastUpdated || null
    };
  } else if (scope.emissionFactor === 'EPA') {
    const epaSource = scope.emissionFactorValues?.epaData || scope;
    normalizedScope.emissionFactorValues.epaData = {
   
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
  const cleanObject = (obj) => {
    return Object.fromEntries(
      Object.entries(obj).filter(([_, v]) =>
        v !== undefined && v !== null && v !== '' &&
        !(Array.isArray(v) && v.length === 0) &&
        !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
      )
    );
  };

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
          TypeOfNode:        d.TypeOfNode        || 'Emission Source',
          department:        d.department        || '',
          location:          d.location          || '',
          longitude:         d.longitude         || null,
          latitude:          d.latitude          || null,
          employeeHeadId:    d.employeeHeadId    || null,
          scopeDetails: Array.isArray(d.scopeDetails)
            ? d.scopeDetails.map(scope => cleanObject({
                scopeIdentifier: scope.scopeIdentifier,
                scopeType: scope.scopeType,
                categoryName: scope.categoryName,
                activity: scope.activity,

               
              }))
            : [],// Empty scopeDetails for basic view
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
        TypeOfNode:        d.TypeOfNode        || 'Emission Source',
        department:        d.department        || '',
        location:          d.location          || '',
        longitude:         d.longitude         || null,
        latitude:          d.latitude          || null,
        employeeHeadId:    d.employeeHeadId    || null,
        scopeDetails:      d.scopeDetails      || [],
        additionalDetails: d.additionalDetails || {},
        fromOtherChart:    d.fromOtherChart    || false,
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
      target: e.target,
      sourcePosition: e.sourcePosition,
      targetPosition:e.targetPosition
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
// Ensures that for each known CEF key, a sibling "<key>_comment" string exists
const ensureCEFComments = (cef = {}) => {
  if (!cef || typeof cef !== 'object') return cef;

  const keysNeedingComment = [
    'CO2','CH4','N2O','CO2e','unit',
    'industryAverageEmissionFactor','stoichiometicFactor','conversionEfficiency',
    'chargeType','leakageRate','Gwp_refrigerant','GWP_fugitiveEmission','GWP_SF6',
    'EmissionFactorFugitiveCH4Leak','GWP_CH4_leak','EmissionFactorFugitiveCH4Component','GWP_CH4_Component',
    'CO2_gwp','CH4_gwp','N2O_gwp','CO2e_gwp'
  ];

  const out = { ...cef };
  for (const k of keysNeedingComment) {
    const ck = `${k}_comment`;
    if (out[k] !== undefined && out[ck] === undefined) out[ck] = '';
  }
  return out;
};

// Walk nodes -> scopes and apply ensureCEFComments to customEmissionFactor
const addCEFCommentsToNodes = (nodes = []) =>
  nodes.map(node => {
    const details = node?.details || {};
    const scopes = Array.isArray(details.scopeDetails) ? details.scopeDetails : [];
    const scoped = scopes.map(s => {
      const efv = s?.emissionFactorValues || {};
      if (efv.customEmissionFactor) {
        efv.customEmissionFactor = ensureCEFComments(efv.customEmissionFactor);
      }
      // keep mirror top-level if you use it
      if (s.customEmissionFactor) {
        s.customEmissionFactor = ensureCEFComments(s.customEmissionFactor);
      }
      return { ...s, emissionFactorValues: efv };
    });
    return { ...node, details: { ...details, scopeDetails: scoped } };
  });

module.exports = {
  validateScopeDetails,
  normalizeScopeDetail,
  normalizeNodes,
  normalizeEdges,
  createChartNotifications,
  isChartAvailable,
  getChartUnavailableMessage,
  addCEFCommentsToNodes,
  ensureCEFComments,
  numOrNull
};