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
    // ── Uncertainty fields ────────────────────────────────────────────────
    // UAD = Activity Data Uncertainty %  (e.g. 5 means ±5%)
    // UEF = Emission Factor Uncertainty % (e.g. 3 means ±3%)
    // conservativeMode = per-scopeIdentifier boolean.
    //   false (default): report E ± ΔE range
    //   true:            report only conservative upper estimate E + ΔE
    // Used by formatUncertaintyResult() on the CUMULATIVE emission only —
    // never applied per-row.
    UAD: Number(scope.UAD) || 0,
    UEF: Number(scope.UEF) || 0,
    conservativeMode: scope.conservativeMode === true ? true : false,
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
    reductionCalculationMode: scope.reductionCalculationMode || 'advanced',
    allocationPct: typeof scope.allocationPct === 'number' ? scope.allocationPct : 100,
  
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
  const rawCEF =
    scope.emissionFactorValues?.customEmissionFactor ||
    scope.customEmissionFactor ||
    {};

  normalizedScope.customEmissionFactor = {
    // Main gas values
    CO2: numOrNull(rawCEF.CO2),
    CH4: numOrNull(rawCEF.CH4),
    N2O: numOrNull(rawCEF.N2O),
    CO2e: numOrNull(rawCEF.CO2e),
    unit: rawCEF.unit || '',

    // Per-gas comments
    CO2_comment: rawCEF.CO2_comment || '',
    CH4_comment: rawCEF.CH4_comment || '',
    N2O_comment: rawCEF.N2O_comment || '',
    CO2e_comment: rawCEF.CO2e_comment || '',
    unit_comment: rawCEF.unit_comment || '',

    // Per-gas conversion factors
    CO2_conversionFactor: numOrNull(rawCEF.CO2_conversionFactor),
    CO2_conversionFactor_comment: rawCEF.CO2_conversionFactor_comment || '',

    CH4_conversionFactor: numOrNull(rawCEF.CH4_conversionFactor),
    CH4_conversionFactor_comment: rawCEF.CH4_conversionFactor_comment || '',

    N2O_conversionFactor: numOrNull(rawCEF.N2O_conversionFactor),
    N2O_conversionFactor_comment: rawCEF.N2O_conversionFactor_comment || '',

    CO2e_conversionFactor: numOrNull(rawCEF.CO2e_conversionFactor),
    CO2e_conversionFactor_comment: rawCEF.CO2e_conversionFactor_comment || '',

    // Common conversion factor
    conversionFactor: numOrNull(rawCEF.conversionFactor),
    conversionFactor_comment: rawCEF.conversionFactor_comment || '',

    // Process-level fields
    industryAverageEmissionFactor: numOrNull(rawCEF.industryAverageEmissionFactor),
    stoichiometicFactor: numOrNull(rawCEF.stoichiometicFactor),
    conversionEfficiency: numOrNull(rawCEF.conversionEfficiency),

    industryAverageEmissionFactor_comment:
      rawCEF.industryAverageEmissionFactor_comment || '',
    stoichiometicFactor_comment:
      rawCEF.stoichiometicFactor_comment || '',
    conversionEfficiency_comment:
      rawCEF.conversionEfficiency_comment || '',

    // Fugitive-emission fields
    chargeType: rawCEF.chargeType || '',
    leakageRate: numOrNull(rawCEF.leakageRate),
    Gwp_refrigerant: numOrNull(
      rawCEF.Gwp_refrigerent ?? rawCEF.Gwp_refrigerant
    ),
    GWP_fugitiveEmission: numOrNull(rawCEF.GWP_fugitiveEmission),
    GWP_SF6: numOrNull(rawCEF.GWP_SF6),
    EmissionFactorFugitiveCH4Leak: numOrNull(rawCEF.EmissionFactorFugitiveCH4Leak),
    GWP_CH4_leak: numOrNull(rawCEF.GWP_CH4_leak),
    EmissionFactorFugitiveCH4Component: numOrNull(
      rawCEF.EmissionFactorFugitiveCH4Component
    ),
    GWP_CH4_Component: numOrNull(rawCEF.GWP_CH4_Component),

    chargeType_comment: rawCEF.chargeType_comment || '',
    leakageRate_comment: rawCEF.leakageRate_comment || '',
    Gwp_refrigerant_comment: rawCEF.Gwp_refrigerant_comment || '',
    GWP_fugitiveEmission_comment: rawCEF.GWP_fugitiveEmission_comment || '',
    GWP_SF6_comment: rawCEF.GWP_SF6_comment || '',
    EmissionFactorFugitiveCH4Leak_comment:
      rawCEF.EmissionFactorFugitiveCH4Leak_comment || '',
    GWP_CH4_leak_comment: rawCEF.GWP_CH4_leak_comment || '',
    EmissionFactorFugitiveCH4Component_comment:
      rawCEF.EmissionFactorFugitiveCH4Component_comment || '',
    GWP_CH4_Component_comment: rawCEF.GWP_CH4_Component_comment || '',

    // GWP override fields
    CO2_gwp: numOrNull(rawCEF.CO2_gwp),
    CH4_gwp: numOrNull(rawCEF.CH4_gwp),
    N2O_gwp: numOrNull(rawCEF.N2O_gwp),
    CO2e_gwp: numOrNull(rawCEF.CO2e_gwp),

    CO2_gwp_comment: rawCEF.CO2_gwp_comment || '',
    CH4_gwp_comment: rawCEF.CH4_gwp_comment || '',
    N2O_gwp_comment: rawCEF.N2O_gwp_comment || '',
    CO2e_gwp_comment: rawCEF.CO2e_gwp_comment || '',
  };
} else {
  normalizedScope.customEmissionFactor = {
    // Main gas values
    CO2: null,
    CH4: null,
    N2O: null,
    CO2e: null,
    unit: '',

    // Per-gas comments
    CO2_comment: '',
    CH4_comment: '',
    N2O_comment: '',
    CO2e_comment: '',
    unit_comment: '',

    // Per-gas conversion factors
    CO2_conversionFactor: null,
    CO2_conversionFactor_comment: '',
    CH4_conversionFactor: null,
    CH4_conversionFactor_comment: '',
    N2O_conversionFactor: null,
    N2O_conversionFactor_comment: '',
    CO2e_conversionFactor: null,
    CO2e_conversionFactor_comment: '',

    // Common conversion factor
    conversionFactor: null,
    conversionFactor_comment: '',

    // Process-level fields
    industryAverageEmissionFactor: null,
    stoichiometicFactor: null,
    conversionEfficiency: null,
    industryAverageEmissionFactor_comment: '',
    stoichiometicFactor_comment: '',
    conversionEfficiency_comment: '',

    // Fugitive-emission fields
    chargeType: '',
    leakageRate: null,
    Gwp_refrigerant: null,
    GWP_fugitiveEmission: null,
    GWP_SF6: null,
    EmissionFactorFugitiveCH4Leak: null,
    GWP_CH4_leak: null,
    EmissionFactorFugitiveCH4Component: null,
    GWP_CH4_Component: null,

    chargeType_comment: '',
    leakageRate_comment: '',
    Gwp_refrigerant_comment: '',
    GWP_fugitiveEmission_comment: '',
    GWP_SF6_comment: '',
    EmissionFactorFugitiveCH4Leak_comment: '',
    GWP_CH4_leak_comment: '',
    EmissionFactorFugitiveCH4Component_comment: '',
    GWP_CH4_Component_comment: '',

    // GWP override fields
    CO2_gwp: null,
    CH4_gwp: null,
    N2O_gwp: null,
    CO2e_gwp: null,

    CO2_gwp_comment: '',
    CH4_gwp_comment: '',
    N2O_gwp_comment: '',
    CO2e_gwp_comment: '',
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

      uom: defraSource.uom || '',
      conversionFactor:         defraSource.conversionFactor         ?? null,
      conversionFactor_comment: defraSource.conversionFactor_comment || '',
      ghgUnits: Array.isArray(defraSource.ghgUnits)
        ? defraSource.ghgUnits.map(gu => ({
            unit:                     gu.unit,
            ghgconversionFactor:      gu.ghgconversionFactor,
            ghgconversionFactor_comment: gu.ghgconversionFactor_comment || '',
            conversionFactor:         gu.conversionFactor         ?? null,
            conversionFactor_comment: gu.conversionFactor_comment || '',
            gwpValue:                 gu.gwpValue        ?? 0,
            gwpSearchField:           gu.gwpSearchField  ?? null,
            gwpLastUpdated:           gu.gwpLastUpdated  ?? null
          }))
        : (defraSource.ghgUnit && defraSource.ghgConversionFactor != null)
          ? [{ unit: defraSource.ghgUnit, ghgconversionFactor: defraSource.ghgConversionFactor, ghgconversionFactor_comment: '', conversionFactor: null, conversionFactor_comment: '', gwpValue: 0, gwpSearchField: null, gwpLastUpdated: null }]
          : [],
      gwpValue:       defraSource.gwpValue       || 0,
      gwpSearchField: defraSource.gwpSearchField || null,
      gwpLastUpdated: defraSource.gwpLastUpdated || null
    };
  } else if (scope.emissionFactor === 'IPCC') {
    const ipccSource = scope.emissionFactorValues?.ipccData || scope;
    normalizedScope.emissionFactorValues.ipccData = {

      fuelDensityLiter:         ipccSource.fuelDensityLiter         || null,
      fuelDensityM3:            ipccSource.fuelDensityM3            || null,
      unit:                     ipccSource.unit || ipccSource.Unit  || '',
      conversionFactor:         ipccSource.conversionFactor         ?? null,
      conversionFactor_comment: ipccSource.conversionFactor_comment || '',
      ghgUnits: Array.isArray(ipccSource.ghgUnits)
        ? ipccSource.ghgUnits.map(gu => ({
            unit:                        gu.unit,
            ghgconversionFactor:         gu.ghgconversionFactor,
            ghgconversionFactor_comment: gu.ghgconversionFactor_comment || '',
            conversionFactor:            gu.conversionFactor         ?? null,
            conversionFactor_comment:    gu.conversionFactor_comment || '',
            gwpValue:                    gu.gwpValue        ?? 0,
            gwpSearchField:              gu.gwpSearchField  ?? null,
            gwpLastUpdated:              gu.gwpLastUpdated  ?? null
          }))
        : (ipccSource.ghgUnit && ipccSource.ghgConversionFactor != null)
          ? [{ unit: ipccSource.ghgUnit, ghgconversionFactor: ipccSource.ghgConversionFactor, ghgconversionFactor_comment: '', conversionFactor: null, conversionFactor_comment: '', gwpValue: 0, gwpSearchField: null, gwpLastUpdated: null }]
          : [],
      gwpValue:       ipccSource.gwpValue       || 0,
      gwpSearchField: ipccSource.gwpSearchField || null,
      gwpLastUpdated: ipccSource.gwpLastUpdated || null
    };
  } else if (scope.emissionFactor === 'EPA') {
    const epaSource = scope.emissionFactorValues?.epaData || scope;
    normalizedScope.emissionFactorValues.epaData = {

      uomEPA:                   epaSource.uomEPA || '',
      conversionFactor:         epaSource.conversionFactor         ?? null,
      conversionFactor_comment: epaSource.conversionFactor_comment || '',
      ghgUnitsEPA: Array.isArray(epaSource.ghgUnitsEPA)
        ? epaSource.ghgUnitsEPA.map(gu => ({
            unit:                        gu.unit,
            ghgconversionFactor:         gu.ghgconversionFactor,
            ghgconversionFactor_comment: gu.ghgconversionFactor_comment || '',
            conversionFactor:            gu.conversionFactor         ?? null,
            conversionFactor_comment:    gu.conversionFactor_comment || '',
            gwpValue:                    gu.gwpValue        ?? 0,
            gwpSearchField:              gu.gwpSearchField  ?? null,
            gwpLastUpdated:              gu.gwpLastUpdated  ?? null
          }))
        : (epaSource.ghgUnitEPA && epaSource.ghgConversionFactorEPA != null)
          ? [{ unit: epaSource.ghgUnitEPA, ghgconversionFactor: epaSource.ghgConversionFactorEPA, ghgconversionFactor_comment: '', conversionFactor: null, conversionFactor_comment: '', gwpValue: 0, gwpSearchField: null, gwpLastUpdated: null }]
          : [],
      gwpValue:       epaSource.gwpValue       || 0,
      gwpSearchField: epaSource.gwpSearchField || null,
      gwpLastUpdated: epaSource.gwpLastUpdated || null
    };
  } else if (scope.emissionFactor === 'Country') {
    const countrySource = scope.emissionFactorValues?.countryData || scope;
    normalizedScope.emissionFactorValues.countryData = {
      C:             countrySource.C || countrySource.country || '',
      regionGrid:    countrySource.regionGrid       || '',
      emissionFactor:countrySource.emissionFactor   || '',
      reference:     countrySource.reference        || '',
      unit:                     countrySource.unit             || '',
      conversionFactor:         countrySource.conversionFactor         ?? null,
      conversionFactor_comment: countrySource.conversionFactor_comment || '',
      yearlyValues:  Array.isArray(countrySource.yearlyValues)
        ? countrySource.yearlyValues.map(yv => ({
            from:                     yv.from,
            to:                       yv.to,
            periodLabel:              yv.periodLabel,
            value:                    yv.value,
            conversionFactor:         yv.conversionFactor         ?? null,
            conversionFactor_comment: yv.conversionFactor_comment || ''
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
      convertionFactor:         hubSource.conversionFactor         ?? null,
      conversionFactor_comment: hubSource.conversionFactor_comment || '',
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