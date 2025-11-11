// controllers/Calculation/emissionCalculationController.js

const DataEntry = require('../../models/DataEntry');
const Flowchart = require('../../models/Flowchart');
const ProcessFlowchart = require('../../models/ProcessFlowchart');
const Client = require('../../models/Client'); 
const EmissionSummary = require('../../models/CalculationEmission/EmissionSummary');


// ADD: helper to read latest S1+S2 CO2e for the current node from Calculation Summary
async function getNodeS1S2FromLatestSummary(clientId, nodeId) {
  try {
    if (!clientId || !nodeId) return 0;

    // Get the latest available summary snapshot for this client
    const summary = await EmissionSummary
      .findOne({ clientId })
      .sort({
        'period.to': -1,
        'period.year': -1,
        'period.month': -1,
        'period.week': -1,
        'period.day': -1,
        updatedAt: -1
      })
      .lean();

    if (!summary) return 0;

    // Handle Map vs object safely (summaries may store Maps)
    const byNode =
      summary.byNode instanceof Map
        ? Object.fromEntries(summary.byNode)
        : (summary.byNode || {});

    const nodeRow = byNode[nodeId];
    if (!nodeRow || !nodeRow.byScope) return 0;

    // Keys are exactly 'Scope 1' and 'Scope 2' in byScope
    const s1 = nodeRow.byScope['Scope 1']?.CO2e || 0;
    const s2 = nodeRow.byScope['Scope 2']?.CO2e || 0;

    // Summary stores totals in consistent units; we use them as-is
    return s1 + s2;
  } catch (err) {
    console.error('getNodeS1S2FromLatestSummary error:', err);
    return 0;
  }
}


/**
 * Fetch scopeConfig based on client's assessmentLevel (organization/process/both)
 */
async function getScopeConfigWithAssessmentSource(clientId, nodeId, scopeIdentifier) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) throw new Error('Client not found');

  const al = client?.submissionData?.assessmentLevel;
  const levels = Array.isArray(al) ? al : (al ? [al] : ['organization','process']); // default to both

  // Try process flowchart first when it's allowed, otherwise fallback to main flowchart.
  const tryCharts = [];
  if (levels.includes('process'))   tryCharts.push(ProcessFlowchart);
  if (levels.includes('organization')) tryCharts.push(Flowchart);
  if (tryCharts.length === 0) tryCharts.push(Flowchart);

  let scopeConfig = null;
  let pickedModel = null;

  for (const Model of tryCharts) {
    const chart = await Model.findOne({ clientId, isActive: true }).lean();
    if (!chart) continue;
    const node = chart.nodes.find(n => n.id === nodeId);
    if (!node) continue;

    const scope = node.details.scopeDetails.find(s => s.scopeIdentifier === scopeIdentifier);
    if (scope) { scopeConfig = scope; pickedModel = Model; break; }
  }

  if (!scopeConfig) {
    throw new Error('Scope config not found in available flowcharts for this client');
  }

  return scopeConfig;
}


// Helper to safely extract assetLifetime from scope details (processFlowchart or flowchart)
function getAssetLifetimeFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};

    // accept a few common spellings/keys; first positive number wins
    const candidates = [
      scope?.assetLifetime, scope?.asset_lifetime, scope?.assetLife,
      ai?.assetLifetime,    ai?.asset_lifetime,    ai?.assetLife,
      cv?.assetLifetime,    cv?.asset_lifetime,    cv?.assetLife,
      ai?.lifetime,         cv?.lifetime,          scope?.lifetime
    ];

    for (const v of candidates) {
      if (typeof v === 'number' && isFinite(v) && v > 0) return v;
      if (typeof v === 'string' && v.trim() && !isNaN(Number(v))) {
        const num = Number(v);
        if (isFinite(num) && num > 0) return num;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Read occupancy factor from data entry (preferred) or scope config (fallback).
// Accepts 0–1 or 0–100. Returns a safe [0,1] number; defaults to 1 if invalid.
function getOccupancyFactorFromEntry(dataValues, scopeConfig) {
  // try common field names from data entry
  let occ =
    dataValues?.occupancEF ?? // as you typed
    dataValues?.occupancyEF ??
    dataValues?.occupancyFactor ??
    dataValues?.occupancy ?? null;

  // normalize if provided
  if (typeof occ === 'string' && occ.trim() !== '' && !isNaN(Number(occ))) {
    occ = Number(occ);
  }
  if (typeof occ === 'number' && isFinite(occ)) {
    // support percentages e.g. 85 → 0.85
    if (occ > 1) occ = occ / 100;
    if (occ < 0) occ = 0;
    if (occ > 1) occ = 1;
    return occ;
  }

  // optional fallback from scope config if you store it there
  const cfgOcc =
    scopeConfig?.additionalInfo?.customValue?.occupancyFactor ??
    scopeConfig?.customValue?.occupancyFactor ?? null;

  if (typeof cfgOcc === 'number' && isFinite(cfgOcc)) {
    let v = cfgOcc;
    if (v > 1) v = v / 100;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    return v;
  }

  // safe default so denominator stays valid
  return 1;
}

// Helper: read T&D Loss factor from scope config (process flowchart preferred, else flowchart)
// Looks inside: additionalInfo.customValue.TDLossFactor (and a few common variants)
function getTDLossFactorFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};

    const candidates = [
      scope?.TDLossFactor, scope?.tdLossFactor, scope?.tdloss,
      ai?.TDLossFactor,    ai?.tdLossFactor,    ai?.tdloss,
      cv?.TDLossFactor,    cv?.tdLossFactor,    cv?.tdloss
    ];

    for (const v of candidates) {
      if (typeof v === 'number' && isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() && !isNaN(Number(v))) return Number(v);
    }
    return null;
  } catch {
    return null;
  }
}


// Helper: read defaultRecyclingRate from scope config (prefers process flowchart; falls back to main)
// Accepts fractional (0–1) or percent (0–100). Clamps to [0, 1]. Returns 0 if not found.
function getDefaultRecyclingRateFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};

    const candidates = [
      scope?.defaultRecyclingRate, scope?.recyclingRateDefault, scope?.recyclingRate, scope?.defaultRecycleRate,
      ai?.defaultRecyclingRate,    ai?.recyclingRateDefault,    ai?.recyclingRate,    ai?.defaultRecycleRate,
      cv?.defaultRecyclingRate,    cv?.recyclingRateDefault,    cv?.recyclingRate,    cv?.defaultRecycleRate,
    ];

    for (let v of candidates) {
      if (v == null) continue;
      // normalize strings
      if (typeof v === 'string' && v.trim() && !isNaN(Number(v))) v = Number(v);

      if (typeof v === 'number' && isFinite(v)) {
        // If given as percent > 1, convert to fraction
        let r = (v > 1) ? v / 100 : v;
        // clamp to [0,1]
        if (r < 0) r = 0;
        if (r > 1) r = 1;
        return r;
      }
    }
    return 0; // default (no change vs legacy)
  } catch {
    return 0;
  }
}

function getEquitySharePercentageFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};

    // common keys we’ve seen in configs
    const candidates = [
      scope?.equitySharePercentage, scope?.equityShare, scope?.equity, scope?.sharePercentage,
      ai?.equitySharePercentage,    ai?.equityShare,    ai?.equity,    ai?.sharePercentage,
      cv?.equitySharePercentage,    cv?.equityShare,    cv?.equity,    cv?.sharePercentage
    ];

    for (let v of candidates) {
      if (v == null) continue;
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
      if (typeof v === 'number' && isFinite(v)) {
        // normalize percent → fraction
        if (v > 1) v = v / 100;
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        return v;
      }
    }
    return null;
  } catch {
    return null;
  }
}


function getAverageLifetimeEnergyConsumptionFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};

    const candidates = [
      scope?.averageLifetimeEnergyConsumption, scope?.avgLifetimeEnergyConsumption, scope?.averageLifetimeConsumption, scope?.avgLifetimeConsumption,
      ai?.averageLifetimeEnergyConsumption,    ai?.avgLifetimeEnergyConsumption,    ai?.averageLifetimeConsumption,    ai?.avgLifetimeConsumption,
      cv?.averageLifetimeEnergyConsumption,    cv?.avgLifetimeEnergyConsumption,    cv?.averageLifetimeConsumption,    cv?.avgLifetimeConsumption,
    ];
    for (let v of candidates) {
      if (v == null) continue;
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
      if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
    }
    return null;
  } catch {
    return null;
  }
}


function getUsePatternFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};

    const candidates = [
      scope?.usePattern, ai?.usePattern, cv?.usePattern,
      scope?.usagePattern, ai?.usagePattern, cv?.usagePattern,
      scope?.pattern, ai?.pattern, cv?.pattern,
    ];
    for (let v of candidates) {
      if (v == null) continue;
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
      if (typeof v === 'number' && isFinite(v)) {
        // normalize percent → fraction
        let p = v;
        if (p > 1) p = p / 100;
        if (p < 0) p = 0;
        if (p > 1) p = 1;
        return p;
      }
    }
    return null;
  } catch {
    return null;
  }
}


function getEnergyEfficiencyFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};

    const candidates = [
      scope?.energyEfficiency, ai?.energyEfficiency, cv?.energyEfficiency,
      scope?.efficiency,       ai?.efficiency,       cv?.efficiency,
      scope?.deviceEfficiency, ai?.deviceEfficiency, cv?.deviceEfficiency,
    ];
    for (let v of candidates) {
      if (v == null) continue;
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
      if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
    }
    return null;
  } catch {
    return null;
  }
}



function asFraction01(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const n = Number(v);
    if (isNaN(n)) return null;
    v = n;
  }
  if (!isFinite(v)) return null;
  if (v > 1) v = v / 100;
  if (v < 0) v = 0;
  if (v > 1) v = 1;
  return v;
}


function getEOLDisposalFractionFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};
    const candidates = [
      scope?.toDisposal, ai?.toDisposal, cv?.toDisposal,
      scope?.disposalShare, ai?.disposalShare, cv?.disposalShare,
      scope?.disposalFraction, ai?.disposalFraction, cv?.disposalFraction,
    ];
    for (let v of candidates) {
      const f = asFraction01(v);
      if (f != null) return f;
    }
    return null;
  } catch { return null; }
}

function getEOLLandfillFractionFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};
    const candidates = [
      scope?.toLandfill, ai?.toLandfill, cv?.toLandfill,
      scope?.landfillShare, ai?.landfillShare, cv?.landfillShare,
      scope?.landfillFraction, ai?.landfillFraction, cv?.landfillFraction,
    ];
    for (let v of candidates) {
      const f = asFraction01(v);
      if (f != null) return f;
    }
    return null;
  } catch { return null; }
}

function getEOLIncinerationFractionFromScope(scope) {
  try {
    const ai = scope?.additionalInfo || {};
    const cv = scope?.customValue || ai?.customValue || {};
    const candidates = [
      scope?.toIncineration, ai?.toIncineration, cv?.toIncineration,
      scope?.incinerationShare, ai?.incinerationShare, cv?.incinerationShare,
      scope?.incinerationFraction, ai?.incinerationFraction, cv?.incinerationFraction,
    ];
    for (let v of candidates) {
      const f = asFraction01(v);
      if (f != null) return f;
    }
    return null;
  } catch { return null; }
}

/**
 * Main emission calculation function
 * Calculates emissions based on scope, category, and tier
 */
const calculateEmissions = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier, dataEntryId } = req.body;

    // 1. Fetch the data entry
    const dataEntry = await DataEntry.findById(dataEntryId);
    if (!dataEntry) {
      return res.status(404).json({ 
        success: false, 
        message: 'Data entry not found' 
      });
    }

    // 2. Get scope config based on assessmentLevel logic
    const scopeConfig = await getScopeConfigWithAssessmentSource(clientId, nodeId, scopeIdentifier);
    if (!scopeConfig) {
      return res.status(404).json({ 
        success: false, 
        message: 'Scope configuration not found for this client' 
      });
    }

    // 3. Extract config
    const {
      scopeType,
      categoryName,
      activity,
      calculationModel: tier,
      emissionFactor: emissionFactorSource,
      emissionFactorValues,
      UAD = 0,
      UEF = 0
    } = scopeConfig;

    // 4. Get EF and GWP
    const efValues = extractEmissionFactorValues(scopeConfig);
    const gwpValues = extractGWPValues(scopeConfig);

    // 5. Calculation
    let calculationResult;
    switch (scopeType) {
      case 'Scope 1':
        calculationResult = await calculateScope1Emissions(dataEntry, scopeConfig, efValues, gwpValues, UAD, UEF);
        break;
      case 'Scope 2':
        calculationResult = await calculateScope2Emissions(dataEntry, scopeConfig, efValues, gwpValues, UAD, UEF);
        break;
      case 'Scope 3':
        calculationResult = await calculateScope3Emissions(dataEntry, scopeConfig, efValues, gwpValues, UAD, UEF);
        break;
      default:
        return res.status(400).json({ success: false, message: 'Invalid scope type' });
    }

    // 6. Save results
    if (calculationResult.success) {
      dataEntry.calculatedEmissions = calculationResult.emissions;
      dataEntry.processingStatus = 'processed';
      await dataEntry.save();
    }

    return res.status(200).json(calculationResult);

  } catch (error) {
    console.error('Error in emission calculation:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Error calculating emissions', 
      error: error.message 
    });
  }
};


/**
 * Extract emission factor values based on source
 */
function extractEmissionFactorValues(scopeConfig) {
  const { emissionFactor, emissionFactorValues } = scopeConfig;
  let efValues = { CO2: 0, CH4: 0, N2O: 0, CO2e:0, };

  switch (emissionFactor) {
    case 'DEFRA':
      if (emissionFactorValues?.defraData?.ghgUnits?.length > 0)  {
        emissionFactorValues.defraData.ghgUnits.forEach(({ unit, ghgconversionFactor }) => {
         const u = unit.trim().toUpperCase();
          if (u.endsWith('CO2'))    efValues.CO2  = ghgconversionFactor || 0;
          if (u.endsWith('CH4'))    efValues.CH4  = ghgconversionFactor || 0;
          if (u.endsWith('N2O'))    efValues.N2O  = ghgconversionFactor || 0;
        });
      }
      break;

    case 'IPCC':
      if (emissionFactorValues?.ipccData) {
        // IPCC typically provides single value - need to map based on gas type
        efValues.CO2 = emissionFactorValues.ipccData.value || 0;
      }
      break;

    case 'EPA':
      if (emissionFactorValues?.epaData?.ghgUnitsEPA?.length > 0) {
        emissionFactorValues.epaData.ghgUnitsEPA.forEach(({ unit, ghgconversionFactor }) => {
           const u = unit.trim().toUpperCase();
          if (u.endsWith('CO2'))    efValues.CO2  = ghgconversionFactor || 0;
          if (u.endsWith('CH4')) efValues.CH4 = ghgconversionFactor || 0;
          if (u.endsWith('N2O')) efValues.N2O = ghgconversionFactor|| 0;
        });
      }
      break;

    case 'Custom':
      if (emissionFactorValues?.customEmissionFactor) {
        efValues.CO2 = emissionFactorValues.customEmissionFactor.CO2 || 0;
        efValues.CH4 = emissionFactorValues.customEmissionFactor.CH4 || 0;
        efValues.N2O = emissionFactorValues.customEmissionFactor.N2O || 0;
      }
      break;

    case 'Country':
      if (emissionFactorValues?.countryData?.yearlyValues?.length > 0) {
        // Get the most recent value
        const latestValue = emissionFactorValues.countryData.yearlyValues[
          emissionFactorValues.countryData.yearlyValues.length - 1
        ];
        efValues.CO2 = latestValue?.value || 0;
      }
      break;
    case 'emissionFactorHub':
      if(emissionFactorValues?.emissionFactorHubData){
        efValues.CO2e = emissionFactorValues.emissionFactorHubData.value || 0;

      }
      break;
  }

  return efValues;
}

/**
 * Extract GWP values from flowchart
 */
 function extractGWPValues(scopeConfig) {
   const { emissionFactorValues } = scopeConfig;
  // Start with AR6 defaults
   let gwpValues = { CO2: 0, CH4: 0, N2O: 0 };

  // 1) Override from DEFRA ghgUnits[].gwpValue if present
  if (emissionFactorValues?.defraData?.ghgUnits?.length > 0) {
    emissionFactorValues.defraData.ghgUnits.forEach(({ unit, gwpValue }) => {
      const u = unit.trim().toUpperCase();
      if (u.endsWith('CO2')) gwpValues.CO2 = gwpValue ?? gwpValues.CO2;
      if (u.endsWith('CH4')) gwpValues.CH4 = gwpValue ?? gwpValues.CH4;
      if (u.endsWith('N2O')) gwpValues.N2O = gwpValue ?? gwpValues.N2O;
    });
  }
  // 2) Override from EPA ghgUnitsEpa[].gwpValue if present
  if(emissionFactorValues?.epaData?.ghgUnitsEPA?.length > 0){
    emissionFactorValues.epaData.ghgUnitsEPA.forEach(({unit,gwpValue}) =>{
      const u = unit.trim().toUpperCase();
      if(u.endsWith('CO2')) gwpValues.CO2 = gwpValue ?? gwpValues.CO2;
      if (u.endsWith('CH4')) gwpValues.CH4 = gwpValue ?? gwpValues.CH4;
      if (u.endsWith('N2O')) gwpValues.N2O = gwpValue ?? gwpValues.N2O;
    })
  }

   // 3) Then allow explicit custom overrides (if you still want them)
   if (emissionFactorValues?.customEmissionFactor) {
     gwpValues.CO2 = emissionFactorValues.customEmissionFactor.CO2_gwp || gwpValues.CO2;
     gwpValues.CH4 = emissionFactorValues.customEmissionFactor.CH4_gwp || gwpValues.CH4;
     gwpValues.N2O = emissionFactorValues.customEmissionFactor.N2O_gwp || gwpValues.N2O;
   }

   // 4) For refrigerant‐specific fugitive emissions
   if (emissionFactorValues?.customEmissionFactor?.Gwp_refrigerant) {
     gwpValues.refrigerant = emissionFactorValues.customEmissionFactor.Gwp_refrigerant;
   }

   return gwpValues;
 }

/**
 * Calculate Scope 1 emissions
 */
async function calculateScope1Emissions(dataEntry, scopeConfig, efValues, gwpValues, UAD, UEF) {
  const { categoryName, activity, calculationModel: tier } = scopeConfig;
  const dataValues = dataEntry.dataValues instanceof Map
    ? Object.fromEntries(dataEntry.dataValues)
    : dataEntry.dataValues;
  const cumulativeValues = dataEntry.cumulativeValues instanceof Map
    ? Object.fromEntries(dataEntry.cumulativeValues)
    : dataEntry.cumulativeValues;

  let emissions = { incoming: {}, cumulative: {} };

  // 0️⃣ Tier 3 not yet supported
  if (tier === 'tier 3') {
    return {
      success: true,
      message: 'Calculation for Tier 3 is under development.',
      emissions: { uncertainty: calculateUncertainty(0, UAD, UEF) }
    };
  }

  // 1️⃣ Combustion
  if (
    categoryName.includes('Stationary Combustion') ||
    categoryName.includes('Mobile Combustion')    ||
    categoryName.includes('Combustion')
  ) {
    for (const [key, value] of Object.entries(dataValues)) {
      const incData = value, cumData = cumulativeValues[key] || 0;
      const co2_in  = incData * efValues.CO2;
      const ch4_in  = incData * efValues.CH4;
      const n2o_in  = incData * efValues.N2O;
      const co2e_in = co2_in + (ch4_in * gwpValues.CH4) + (n2o_in * gwpValues.N2O);
      const co2_cum  = cumData * efValues.CO2;
      const ch4_cum  = cumData * efValues.CH4;
      const n2o_cum  = cumData * efValues.N2O;
      const co2e_cum = co2_cum + (ch4_cum * gwpValues.CH4) + (n2o_cum * gwpValues.N2O);

      const uInc = calculateUncertainty(co2e_in, UAD, UEF);
      const uCum = calculateUncertainty(co2e_cum, UAD, UEF);

      emissions.incoming[key] = {
        CO2: co2_in, CH4: ch4_in, N2O: n2o_in,
        CO2e: co2e_in, combinedUncertainty: uInc,
        CO2eWithUncertainty: co2e_in + uInc
      };
      emissions.cumulative[key] = {
        CO2: co2_cum, CH4: ch4_cum, N2O: n2o_cum,
        CO2e: co2e_cum, combinedUncertainty: uCum,
        CO2eWithUncertainty: co2e_cum + uCum
      };
    }
  }

// 2️⃣ 🚨 Refrigeration‐only fugitive must come _before_ Process Emission
  else if (/ref.*?geration/i.test(activity)) {
    const c        = scopeConfig.emissionFactorValues.customEmissionFactor || {};
    const units    = dataValues.numberOfUnits       ?? 0;
    // first try flowchart, then API payload
    const leak     = c.leakageRate                  ?? dataValues.leakageRate  ?? 0;
    const gwpRef   = c.Gwp_refrigerant               ?? 0;
    const cumUnits = cumulativeValues.numberOfUnits ?? 0;

    if (tier === 'tier 1' && units > 0 && leak > 0 && gwpRef > 0) {
      const inc  = units  * leak * gwpRef;
      const cumE = cumUnits * leak * gwpRef;
      const uInc = calculateUncertainty(inc,  UAD, UEF);
      const uCum = calculateUncertainty(cumE, UAD, UEF);

      emissions.incoming['fugitive'] = {
        emission: inc,
        combinedUncertainty: uInc,
        emissionWithUncertainty: inc + uInc
      };
      emissions.cumulative['fugitive'] = {
        emission: cumE,
        combinedUncertainty: uCum,
        emissionWithUncertainty: cumE + uCum
      };
    } else {
      // Tier 2 stock‐change fallback
      const gFug    = c.GWP_fugitiveEmission ?? gwpRef;
      const inst    = dataValues.installedCapacity ?? 0;
      const endYr   = dataValues.endYearCapacity   ?? 0;
      const purch   = dataValues.purchases         ?? 0;
      const disp    = dataValues.disposals         ?? 0;
      const delta   = inst - endYr + purch - disp;
      const cumDelta= (cumulativeValues.installedCapacity ?? 0)
                    - (cumulativeValues.endYearCapacity   ?? 0)
                    + (cumulativeValues.purchases         ?? 0)
                    - (cumulativeValues.disposals         ?? 0);

      const inc2  = delta    * gFug;
      const cumE2= cumDelta * gFug;
      const uInc2= calculateUncertainty(inc2,  UAD, UEF);
      const uCum2= calculateUncertainty(cumE2, UAD, UEF);

      emissions.incoming['fugitive'] = {
        emission: inc2,
        combinedUncertainty: uInc2,
        emissionWithUncertainty: inc2 + uInc2
      };
      emissions.cumulative['fugitive'] = {
        emission: cumE2,
        combinedUncertainty: uCum2,
        emissionWithUncertainty: cumE2 + uCum2
      };
    }

    return {
      success:   true,
      scopeType: 'Scope 1',
      category:  categoryName,
      tier,
      emissions
    };
  }

 
  // 3️⃣ SF₆‐only fugitive
  else if (
    categoryName.includes('Fugitive') &&
    /SF6/i.test(activity)
  ) {
    const c            = scopeConfig.emissionFactorValues.customEmissionFactor || {};
    const gwpSF6       = c.GWP_SF6               ?? 0;
    const nameplateCap = dataValues.nameplateCapacity   ?? 0;
    const leakRate     = dataValues.defaultLeakageRate  ?? c.defaultLeakageRate ?? 0;
    const cumCap       = cumulativeValues.nameplateCapacity ?? 0;
    const cumLeakRate  = cumulativeValues.defaultLeakageRate ?? leakRate;

    if (tier === 'tier 1') {
      const sf6Inc  = nameplateCap * leakRate;
      const sf6Cum  = cumCap      * cumLeakRate;
      const co2eInc = sf6Inc * gwpSF6;
      const co2eCum = sf6Cum * gwpSF6;
      const uInc    = calculateUncertainty(co2eInc, UAD, UEF);
      const uCum    = calculateUncertainty(co2eCum, UAD, UEF);

      emissions.incoming['SF6'] = {
        emission: sf6Inc,
        CO2e: co2eInc,
        combinedUncertainty: uInc,
        emissionWithUncertainty: co2eInc + uInc
      };
      emissions.cumulative['SF6'] = {
        emission: sf6Cum,
        CO2e: co2eCum,
        combinedUncertainty: uCum,
        emissionWithUncertainty: co2eCum + uCum
      };
    } else if (tier === 'tier 2') {
      const decInv = dataValues.decreaseInventory       ?? 0;
      const acq    = dataValues.acquisitions            ?? 0;
      const disb   = dataValues.disbursements           ?? 0;
      const netCap = dataValues.netCapacityIncrease     ?? 0;
      const cumDec = cumulativeValues.decreaseInventory ?? 0;
      const cumAcq = cumulativeValues.acquisitions      ?? 0;
      const cumDisb= cumulativeValues.disbursements     ?? 0;
      const cumNet = cumulativeValues.netCapacityIncrease ?? 0;

      const deltaInc = decInv + acq - disb - netCap;
      const deltaCum = cumDec + cumAcq - cumDisb - cumNet;
      const co2eInc  = deltaInc * gwpSF6;
      const co2eCum  = deltaCum * gwpSF6;
      const uInc     = calculateUncertainty(co2eInc, UAD, UEF);
      const uCum     = calculateUncertainty(co2eCum, UAD, UEF);

      emissions.incoming['SF6'] = {
        emission: deltaInc,
        CO2e: co2eInc,
        combinedUncertainty: uInc,
        emissionWithUncertainty: co2eInc + uInc
      };
      emissions.cumulative['SF6'] = {
        emission: deltaCum,
        CO2e: co2eCum,
        combinedUncertainty: uCum,
        emissionWithUncertainty: co2eCum + uCum
      };
    }

    return {
      success:   true,
      scopeType: 'Scope 1',
      category:  categoryName,
      tier,
      emissions
    };
  }
  // 3️⃣ 🔹 CH₄-Leaks fugitive
 else if (
   categoryName.includes('Fugitive') &&
   /CH4[_\s]?Leaks?/i.test(activity)
 ) {
   const c      = scopeConfig.emissionFactorValues.customEmissionFactor || {};
   // Tier 1
   if (tier === 'tier 1') {
     const dataVal = dataValues.activityData          ?? 0;
     const efLeak  = c.EmissionFactorFugitiveCH4Leak  ?? 0;
     const gwpLeak = c.GWP_CH4_leak                   ?? 0;
     const ch4In   = dataVal * efLeak;
     const co2In   = ch4In   * gwpLeak;
     const uInc    = calculateUncertainty(co2In, UAD, UEF);
     const cumVal = cumulativeValues.activityData      ?? 0;
     const ch4Cum = cumVal * efLeak;
     const co2Cum = ch4Cum * gwpLeak;
     const uCum   = calculateUncertainty(co2Cum, UAD, UEF);

     emissions.incoming['CH4_leaks'] = {
       emission:    ch4In,
       CO2e:   co2In,
       combinedUncertainty: uInc,
       emissionWithUncertainty: co2In + uInc
     };
     emissions.cumulative['CH4_leaks'] = {
       emission:    ch4Cum,
       CO2e:   co2Cum,
       combinedUncertainty: uCum,
       emissionWithUncertainty: co2Cum + uCum
     };
   }
   // Tier 2
   else {
     const comps   = dataValues.numberOfComponents    ?? 0;
     const efComp  = c.EmissionFactorFugitiveCH4Component ?? 0;
     const gwpComp = c.GWP_CH4_Component                 ?? 0;
     const ch4In   = comps * efComp;
     const co2In   = ch4In * gwpComp;
     const uInc    = calculateUncertainty(co2In, UAD, UEF);

     const cumComps= cumulativeValues.numberOfComponents ?? 0;
     const ch4Cum  = cumComps * efComp;
     const co2Cum  = ch4Cum * gwpComp;
     const uCum    = calculateUncertainty(co2Cum, UAD, UEF);

     emissions.incoming['CH4_leaks'] = {
       emission:    ch4In,
       CO2e:   co2In,
       combinedUncertainty: uInc,
       emissionWithUncertainty: co2In + uInc
     };
     emissions.cumulative['CH4_leaks'] = {
       emission:    ch4Cum,
       CO2e:   co2Cum,
       combinedUncertainty: uCum,
       emissionWithUncertainty: co2Cum + uCum
     };
   }

   return {
     success:   true,
     scopeType: 'Scope 1',
     category:  categoryName,
     tier,
     emissions
   };
 }


  // 4️⃣ Process Emission (Custom)
  else if (
    (categoryName.includes('Process Emission') || categoryName.includes('Process Emissions')) &&
    scopeConfig.emissionFactor === 'Custom'
  ) {
    const c          = scopeConfig.emissionFactorValues.customEmissionFactor || {};
    const prodOutput = dataValues.productionOutput        ?? 0;
    const rawInput   = dataValues.rawMaterialInput        ?? 0;
    const cumProd    = cumulativeValues.productionOutput  ?? 0;
    const cumRaw     = cumulativeValues.rawMaterialInput  ?? 0;

    if (tier === 'tier 1' && prodOutput > 0) {
      const iaef = c.industryAverageEmissionFactor || 0;
      const inc  = prodOutput * iaef;
      const cum  = cumProd    * iaef;
      const uInc = calculateUncertainty(inc,  UAD, UEF);
      const uCum = calculateUncertainty(cum, UAD, UEF);

      emissions.incoming['process'] = {
        CO2e: inc,
        combinedUncertainty: uInc,
        emissionWithUncertainty: inc + uInc
      };
      emissions.cumulative['process'] = {
        CO2e: cum,
        combinedUncertainty: uCum,
        emissionWithUncertainty: cum + uCum
      };
    } else if (tier === 'tier 2' && rawInput > 0) {
      const stoich = c.stoichiometicFactor   ?? 0;
      const conv   = c.conversionEfficiency ?? 0;
      const inc    = rawInput * stoich * conv;
      const cum    = cumRaw  * stoich * conv;
      const uInc   = calculateUncertainty(inc, UAD, UEF);
      const uCum   = calculateUncertainty(cum, UAD, UEF);

      emissions.incoming['process'] = {
        CO2e: inc,
        combinedUncertainty: uInc,
        emissionWithUncertainty: inc + uInc
      };
      emissions.cumulative['process'] = {
        CO2e: cum,
        combinedUncertainty: uCum,
        emissionWithUncertainty: cum + uCum
      };
    }
  }

  // 🔚 final catch-all
  return {
    success:   true,
    scopeType: 'Scope 1',
    category:  categoryName,
    tier,
    emissions
  };
}


// Normalize an activity string like "Travel Based", "travelBased", "Energy_Based"
function normActivity(val) {
  return String(val || '')
    .toLowerCase()
    .replace(/\s+/g, '')     // remove spaces
    .replace(/_/g, '');      // remove underscores
}

/**
 * Calculate Scope 2 emissions
 */
 
async function calculateScope2Emissions(
  dataEntry,
  scopeConfig,
  efValues,    // { CO2: <the factor you pulled from flowchart> }
  gwpValues,
  UAD,
  UEF
) {
  const { categoryName, calculationModel: tier } = scopeConfig;
 
  // only handle our four purchased categories here
  const validCategories = [
    'Purchased Electricity',
    'Purchased Steam',
    'Purchased Heating',
    'Purchased Cooling'
  ];
  if (!validCategories.includes(categoryName)) {
    return { success: false, message: `Unsupported Scope 2 category: ${categoryName}` };
  }
 
  // pull in your data
  const dataValues = dataEntry.dataValues instanceof Map
    ? Object.fromEntries(dataEntry.dataValues)
    : dataEntry.dataValues;
  const cumValues = dataEntry.cumulativeValues instanceof Map
    ? Object.fromEntries(dataEntry.cumulativeValues)
    : dataEntry.cumulativeValues;
 
  // pick the single CO2 factor (same for Tier 1 & Tier 2)
  const factor = efValues.CO2;
  if (factor == null) {
    return { success: false, message: 'Emission factor not found for Scope 2' };
  }
 
  // map category → incoming field name
  const fieldMap = {
    'Purchased Electricity': 'consumed_electricity',
    'Purchased Steam':       'consumed_steam',
    'Purchased Heating':     'consumed_heating',
    'Purchased Cooling':     'consumed_cooling'
  };
 
  // pick the right data key, falling back to the first numeric one
  let fieldKey = fieldMap[categoryName];
  if (!fieldKey || dataValues[fieldKey] == null) {
    const numericKeys = Object.keys(dataValues).filter(k => typeof dataValues[k] === 'number');
    fieldKey = numericKeys[0];
  }
  const incomingQty   = Number(dataValues[fieldKey]   ?? 0);
  const cumulativeQty = Number(cumValues[fieldKey]    ?? 0);
 
  // calculate
  const inc = incomingQty  * factor;
  const cum = cumulativeQty * factor;
  const uInc = calculateUncertainty(inc, UAD, UEF);
  const uCum = calculateUncertainty(cum, UAD, UEF);
 
  const emissions = { incoming: {}, cumulative: {} };
  emissions.incoming[fieldKey] = {
    CO2e: inc,
    combinedUncertainty: uInc,
    CO2eWithUncertainty: inc + uInc
  };
  emissions.cumulative[fieldKey] = {
    CO2e: cum,
    combinedUncertainty: uCum,
    CO2eWithUncertainty: cum + uCum
  };
 
  return {
    success:   true,
    scopeType: 'Scope 2',
    category:  categoryName,
    tier,
    emissions
  };
}
 
/**
 * Calculate Scope 3 emissions
 */
async function calculateScope3Emissions(
  dataEntry,
  scopeConfig,
  efValues,
  gwpValues,
  UAD,
  UEF
) {
  const { categoryName, calculationModel: tier, emissionFactor } = scopeConfig;
  const dataValues = dataEntry.dataValues instanceof Map
    ? Object.fromEntries(dataEntry.dataValues)
    : dataEntry.dataValues;
  const cumulativeVals = dataEntry.cumulativeValues instanceof Map
    ? Object.fromEntries(dataEntry.cumulativeValues)
    : dataEntry.cumulativeValues;

    

      // ── define your Fuel & Energy activity enum ──
  const FuelEnergyActivity = Object.freeze({
    WTT:       'WTT '|| 'Well-to-Tank',         // Well-to-Tank
    TD_LOSSES: 'T&D losses'|| 'Transmission & Distribution',  // Transmission & Distribution
  });

  // helper to pull out a single CO2e factor from whichever source
    function getCO2eEF(source = emissionFactor) {
    switch (source) {
      case 'Custom':
        return scopeConfig.emissionFactorValues.customEmissionFactor.CO2e || 0;
      case 'EmissionFactorHub':
        return scopeConfig.emissionFactorValues.emissionFactorHubData.value || 0;
      case 'Country': {
        const yearVals = scopeConfig.emissionFactorValues.countryData.yearlyValues;
        return (yearVals.length && yearVals[yearVals.length - 1].value) || 0;
      }
      case 'DEFRA': {
        const units = scopeConfig.emissionFactorValues.defraData.ghgUnits || [];
        if (!units.length) return 0;
        // try to find a CO2e unit, otherwise fall back to whatever is there
        const u = units.find(g => /CO2E/i.test(g.unit)) || units[0];
        return u.ghgconversionFactor || 0;
      }
      case 'EPA': {
        const units = scopeConfig.emissionFactorValues.epaData.ghgUnitsEPA || [];
        if (!units.length) return 0;
        const u = units.find(g => /CO2E/i.test(g.unit)) || units[0];
        return u.ghgconversionFactor || 0;
      }
      case 'IPCC':
        return scopeConfig.emissionFactorValues.ipccData.value || 0;
      default:
        return 0;
    }
  }
  // for T&D losses we always pull the grid EF from the Country factor
    // primary EF for all standard cases
  const ef = getCO2eEF();;
  const gridEF = getCO2eEF('Country');

  let emissions = { incoming: {}, cumulative: {} };

  switch (categoryName) {
    // ───────── Purchased Goods and Services (1) ─────────
    case 'Purchased Goods and Services':
      if (tier === 'tier 1') {
        const spend    = dataValues.procurementSpend     ?? 0;
        const cumSpend = cumulativeVals.procurementSpend ?? 0;
        const inc      = spend * ef;
        const cum      = cumSpend * ef;
        const uInc     = calculateUncertainty(inc, UAD, UEF);
        const uCum     = calculateUncertainty(cum, UAD, UEF);

        emissions.incoming['purchased_goods_services'] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative['purchased_goods_services'] = {
          CO2e: cum,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cum + uCum
        };
      } else if (tier === 'tier 2') {
        const qty    = dataValues.physicalQuantity     ?? 0;
        const cumQty = cumulativeVals.physicalQuantity ?? 0;
        const inc    = qty * ef;
        const cum    = cumQty * ef;
        const uInc   = calculateUncertainty(inc, UAD, UEF);
        const uCum   = calculateUncertainty(cum, UAD, UEF);

        emissions.incoming['purchased_goods_services'] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative['purchased_goods_services'] = {
          CO2e: cum,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cum + uCum
        };
      }
      break;

    // ───────── Capital Goods (2) ─────────
    case 'Capital Goods':
  if (tier === 'tier 1') {
    // Tier 1: spend-based
    const spend    = dataValues.procurementSpend     ?? 0;
    const cumSpend = cumulativeVals.procurementSpend ?? 0;
    const inc      = spend * ef;
    const cum      = cumSpend * ef;
    const uInc     = calculateUncertainty(inc, UAD, UEF);
    const uCum     = calculateUncertainty(cum, UAD, UEF);

    emissions.incoming['capital_goods'] = {
      CO2e: inc,
      combinedUncertainty: uInc,
      CO2eWithUncertainty: inc + uInc
    };
    emissions.cumulative['capital_goods'] = {
      CO2e: cum,
      combinedUncertainty: uCum,
      CO2eWithUncertainty: cum + uCum
    };
  } else if (tier === 'tier 2') {
 } else if (tier === 'tier 2') {
  // Tier 2: quantity-based with lifetime allocation
  const qty    = dataValues.assetQuantity     ?? 0;
  const cumQty = cumulativeVals.assetQuantity ?? 0;

  // Read assetLifetime from the scope configuration (process flowchart preferred, fallback to flowchart)
  // Expected location: scope.details.scopeDetails[].additionalInfo.customValue.assetLifetime (or shallow)
  const rawLifetime  = getAssetLifetimeFromScope(scopeConfig);
  const assetLifetime = (typeof rawLifetime === 'number' && isFinite(rawLifetime) && rawLifetime > 0)
    ? rawLifetime
    : 1; // safe fallback to avoid divide-by-zero and preserve previous behavior

  const inc  = (qty    * ef) / assetLifetime;
  const cum  = (cumQty * ef) / assetLifetime;

  const uInc = calculateUncertainty(inc, UAD, UEF);
  const uCum = calculateUncertainty(cum, UAD, UEF);

  emissions.incoming['capital_goods'] = {
    CO2e: inc,
    combinedUncertainty: uInc,
    CO2eWithUncertainty: inc + uInc
  };
  emissions.cumulative['capital_goods'] = {
    CO2e: cum,
    combinedUncertainty: uCum,
    CO2eWithUncertainty: cum + uCum
  };
}
  break;

     // ───────── Fuel and energy (3) ─────────
    case 'Fuel and energy': {
  // pull your inputs
  const fc    = dataValues.fuelConsumed           ?? 0;
  const cumFc = cumulativeVals.fuelConsumed       ?? 0;
  const ec    = dataValues.electricityConsumption ?? 0;
  const cumEc = cumulativeVals.electricityConsumption ?? 0;
  const tdCfg = getTDLossFactorFromScope(scopeConfig);
  const td    = (tdCfg !== null) ? tdCfg : (dataValues.tdLossFactor ?? dataValues.TDLossFactor ?? 0);
  const cf    = dataValues.fuelConsumption        ?? 0;
  const cumCf = cumulativeVals.fuelConsumption ?? 0;

  // emission factor for all fuel‐energy buckets
  // you were using `ef` for upstream and WTT, and `gridEF` for T&D.
  // adjust these if you pull them from different efValues properties.
  const WTTEF= ef;
  const upstreamEF = ef;     

  // ─── A) Upstream fuel × EF ──────────────────────────
  {
    const incA = fc    * upstreamEF;
    const cumA = cumFc * upstreamEF;
    const uA   = calculateUncertainty(incA, UAD, UEF);

    emissions.incoming['upstream_fuel'] = {
      CO2e:                 incA,
      combinedUncertainty:  uA,
      CO2eWithUncertainty:  incA + uA
    };
    emissions.cumulative['upstream_fuel'] = {
      CO2e:                 cumA,
      combinedUncertainty:  calculateUncertainty(cumA, UAD, UEF),
      CO2eWithUncertainty:  cumA + calculateUncertainty(cumA, UAD, UEF)
    };
  }

  // ─── B) Well-to-Tank (fuel × EF) ────────────────────
  {
    const incB = cf     * WTTEF;
    const cumB = cumCf * upstreamEF;
    const uB   = calculateUncertainty(incB, UAD, UEF);

    emissions.incoming['WTT'] = {
      CO2e:                 incB,
      combinedUncertainty:  uB,
      CO2eWithUncertainty:  incB + uB
    };
    emissions.cumulative['WTT'] = {
      CO2e:                 cumB,
      combinedUncertainty:  calculateUncertainty(cumB, UAD, UEF),
      CO2eWithUncertainty:  cumB + calculateUncertainty(cumB, UAD, UEF)
    };
  }

  // ─── C) T&D losses (electricity × tdLoss × grid EF) ─
  {
    const incC = ec    * td * gridEF;
    const cumC = cumEc * td * gridEF;
    const uC   = calculateUncertainty(incC, UAD, UEF);

    emissions.incoming['T&D losses'] = {
      CO2e:                 incC,
      combinedUncertainty:  uC,
      CO2eWithUncertainty:  incC + uC
    };
    emissions.cumulative['T&D losses'] = {
      CO2e:                 cumC,
      combinedUncertainty:  calculateUncertainty(cumC, UAD, UEF),
      CO2eWithUncertainty:  cumC + calculateUncertainty(cumC, UAD, UEF)
    };
  }

  break;
    }

    // ───────── Upstream Transport and Distribution (4) ─────────
      case 'Upstream Transport and Distribution': {
        if (tier === 'tier 1') {
          const spend    = dataValues.transportationSpend     ?? 0;
          const cumSpend = cumulativeVals.transportationSpend ?? 0;
          const inc      = spend * ef;
          const cum      = cumSpend * ef;
          const uInc     = calculateUncertainty(inc, UAD, UEF);
          const uCum     = calculateUncertainty(cum, UAD, UEF);

          emissions.incoming['upstream_transport_and_distribution'] = {
            CO2e: inc, combinedUncertainty: uInc, CO2eWithUncertainty: inc + uInc
          };
          emissions.cumulative['upstream_transport_and_distribution'] = {
            CO2e: cum, combinedUncertainty: uCum, CO2eWithUncertainty: cum + uCum
          };
        } else if (tier === 'tier 2') {
          // 🔁 CHANGED: use allocation × distance × EF (fallback from legacy mass)
          const allocation = (dataValues.allocation ?? dataValues.mass ?? 0);
          const distance   = dataValues.distance ?? 0;

          const inc  = allocation * distance * ef;
          const cumA = (cumulativeVals.allocation ?? cumulativeVals.mass ?? 0);
          const cumD = (cumulativeVals.distance   ?? 0);
          const cum  = cumA * cumD * ef;

          const uInc = calculateUncertainty(inc, UAD, UEF);
          const uCum = calculateUncertainty(cum, UAD, UEF);

          emissions.incoming['upstream_transport_and_distribution'] = {
            CO2e: inc, combinedUncertainty: uInc, CO2eWithUncertainty: inc + uInc
          };
          emissions.cumulative['upstream_transport_and_distribution'] = {
            CO2e: cum, combinedUncertainty: uCum, CO2eWithUncertainty: cum + uCum
          };
        }
        break;
      }



      // ───────── Waste Generated in Operation (5) ─────────
    case 'Waste Generated in Operation':
  if (tier === 'tier 1') {
    // Tier 1: wasteMass × EF × (1 − defaultRecyclingRate)
    const mass    = dataValues.wasteMass     ?? 0;
    const cumMass = cumulativeVals.wasteMass ?? 0;

    // Prefer flowchart config → fallback to legacy data-entry value
    // Accepts 0–1 or 0–100 and clamps to [0,1]
    const cfgRate = getDefaultRecyclingRateFromScope(scopeConfig);
    let entryRate = dataValues.defaultRecyclingRate;
    if (typeof entryRate === 'string' && entryRate.trim() && !isNaN(Number(entryRate))) {
      entryRate = Number(entryRate);
    }
    if (typeof entryRate !== 'number' || !isFinite(entryRate)) entryRate = 0;
    // normalize legacy entry percent if needed
    if (entryRate > 1) entryRate = entryRate / 100;
    if (entryRate < 0) entryRate = 0;
    if (entryRate > 1) entryRate = 1;

    const r = (cfgRate ?? 0);           // take config rate (default 0 via helper)
    const effRate = (r !== 0) ? r : entryRate;  // prefer config; else fallback to data entry

    const inc = mass    * ef * (1 - effRate);
    const cum = cumMass * ef * (1 - effRate);

    const uInc = calculateUncertainty(inc, UAD, UEF);
    const uCum = calculateUncertainty(cum, UAD, UEF);

    emissions.incoming['waste_generated_in_operation'] = {
      CO2e: inc,
      combinedUncertainty: uInc,
      CO2eWithUncertainty: inc + uInc
    };
    emissions.cumulative['waste_generated_in_operation'] = {
      CO2e: cum,
      combinedUncertainty: uCum,
      CO2eWithUncertainty: cum + uCum
    };
  }
  else if (tier === 'tier 2') {
    // (unchanged) Tier 2: mass × treatment‐specific EF
    const mass    = dataValues.wasteMass     ?? 0;
    const cumMass = cumulativeVals.wasteMass ?? 0;
    const inc     = mass * ef;
    const cum     = cumMass * ef;
    const uInc    = calculateUncertainty(inc, UAD, UEF);
    const uCum    = calculateUncertainty(cum, UAD, UEF);

    emissions.incoming['waste_generated_in_operation'] = {
      CO2e: inc,
      combinedUncertainty: uInc,
      CO2eWithUncertainty: inc + uInc
    };
    emissions.cumulative['waste_generated_in_operation'] = {
      CO2e: cum,
      combinedUncertainty: uCum,
      CO2eWithUncertainty: cum + uCum
    };
  }
  break;

     
     // ───────── Business Travel ─────────
    // ───────── Business Travel (6) ─────────
   case 'Business Travel': {
  const act = normActivity(scopeConfig.activity);  // 'travelbased' | 'hotelbased' | ''
  if (tier === 'tier 1') {
    // Tier 1
    // travelBased => travelSpend × EF
    // hotelBased  => hotelNights × EF
    const travelSpend   = dataValues.travelSpend   ?? 0;
    const cumTravelSpend= cumulativeVals.travelSpend ?? 0;
    const hotelNights   = dataValues.hotelNights   ?? 0;
    const cumHotelNights= cumulativeVals.hotelNights ?? 0;

    if (act === 'travelbased') {
      const inc  = travelSpend    * ef;
      const cum  = cumTravelSpend * ef;
      const uInc = calculateUncertainty(inc, UAD, UEF);
      const uCum = calculateUncertainty(cum, UAD, UEF);

      emissions.incoming['business_travel'] = {
        CO2e: inc, combinedUncertainty: uInc, CO2eWithUncertainty: inc + uInc
      };
      emissions.cumulative['business_travel'] = {
        CO2e: cum, combinedUncertainty: uCum, CO2eWithUncertainty: cum + uCum
      };
    } else if (act === 'hotelbased') {
      const inc  = hotelNights    * ef;
      const cum  = cumHotelNights * ef;
      const uInc = calculateUncertainty(inc, UAD, UEF);
      const uCum = calculateUncertainty(cum, UAD, UEF);

      emissions.incoming['accommodation'] = {
        CO2e: inc, combinedUncertainty: uInc, CO2eWithUncertainty: inc + uInc
      };
      emissions.cumulative['accommodation'] = {
        CO2e: cum, combinedUncertainty: uCum, CO2eWithUncertainty: cum + uCum
      };
    } else {
      // Fallback: keep your existing dual-line behavior (spend + nights) if activity isn’t set
      const travelInc = travelSpend * ef;
      const hotelInc  = hotelNights * ef;
      const cumTravel = cumTravelSpend * ef;
      const cumHotel  = cumHotelNights * ef;

      emissions.incoming['business_travel'] = {
        CO2e: travelInc,
        combinedUncertainty: calculateUncertainty(travelInc, UAD, UEF),
        CO2eWithUncertainty: travelInc + calculateUncertainty(travelInc, UAD, UEF)
      };
      emissions.incoming['accommodation'] = {
        CO2e: hotelInc,
        combinedUncertainty: calculateUncertainty(hotelInc, UAD, UEF),
        CO2eWithUncertainty: hotelInc + calculateUncertainty(hotelInc, UAD, UEF)
      };
      emissions.cumulative['business_travel'] = {
        CO2e: cumTravel,
        combinedUncertainty: calculateUncertainty(cumTravel, UAD, UEF),
        CO2eWithUncertainty: cumTravel + calculateUncertainty(cumTravel, UAD, UEF)
      };
      emissions.cumulative['accommodation'] = {
        CO2e: cumHotel,
        combinedUncertainty: calculateUncertainty(cumHotel, UAD, UEF),
        CO2eWithUncertainty: cumHotel + calculateUncertainty(cumHotel, UAD, UEF)
      };
    }
  } else if (tier === 'tier 2') {
    // Tier 2
    // travelBased => passengers × distance × EF
    // hotelBased  => hotelNights × EF
    const passengers     = dataValues.numberOfPassengers ?? 0;
    const distance       = dataValues.distanceTravelled  ?? 0;
    const hotelNights    = dataValues.hotelNights        ?? 0;
    const cumPassengers  = cumulativeVals.numberOfPassengers ?? 0;
    const cumDistance    = cumulativeVals.distanceTravelled  ?? 0;
    const cumHotelNights = cumulativeVals.hotelNights        ?? 0;

    if (act === 'travelbased') {
      const inc  = passengers * distance * ef;
      const cum  = (cumPassengers * cumDistance) * ef;
      const uInc = calculateUncertainty(inc, UAD, UEF);
      const uCum = calculateUncertainty(cum, UAD, UEF);

      emissions.incoming['business_travel'] = {
        CO2e: inc, combinedUncertainty: uInc, CO2eWithUncertainty: inc + uInc
      };
      emissions.cumulative['business_travel'] = {
        CO2e: cum, combinedUncertainty: uCum, CO2eWithUncertainty: cum + uCum
      };
    } else if (act === 'hotelbased') {
      const inc  = hotelNights    * ef;
      const cum  = cumHotelNights * ef;
      const uInc = calculateUncertainty(inc, UAD, UEF);
      const uCum = calculateUncertainty(cum, UAD, UEF);

      emissions.incoming['accommodation'] = {
        CO2e: inc, combinedUncertainty: uInc, CO2eWithUncertainty: inc + uInc
      };
      emissions.cumulative['accommodation'] = {
        CO2e: cum, combinedUncertainty: uCum, CO2eWithUncertainty: cum + uCum
      };
    } else {
      // Fallback to your current “two-option” logic if activity isn’t set
      const tripInc = passengers * distance * ef;
      const tripCum = (cumPassengers * cumDistance) * ef;
      emissions.incoming['business_travel'] = {
        CO2e: tripInc,
        combinedUncertainty: calculateUncertainty(tripInc, UAD, UEF),
        CO2eWithUncertainty: tripInc + calculateUncertainty(tripInc, UAD, UEF)
      };
      emissions.cumulative['business_travel'] = {
        CO2e: tripCum,
        combinedUncertainty: calculateUncertainty(tripCum, UAD, UEF),
        CO2eWithUncertainty: tripCum + calculateUncertainty(tripCum, UAD, UEF)
      };

      if (hotelNights > 0 || cumHotelNights > 0) {
        const hotelInc = hotelNights * ef;
        const hotelCum = cumHotelNights * ef;
        emissions.incoming['accommodation'] = {
          CO2e: hotelInc,
          combinedUncertainty: calculateUncertainty(hotelInc, UAD, UEF),
          CO2eWithUncertainty: hotelInc + calculateUncertainty(hotelInc, UAD, UEF)
        };
        emissions.cumulative['accommodation'] = {
          CO2e: hotelCum,
          combinedUncertainty: calculateUncertainty(hotelCum, UAD, UEF),
          CO2eWithUncertainty: hotelCum + calculateUncertainty(hotelCum, UAD, UEF)
        };
      }
    }
  }
  break;
}

     // ───────── Employee Commuting (7) ─────────
      case 'Employee Commuting': {
        if (tier === 'tier 1') {
          // Tier 1: employeeCount × averageCommuteDistance × workingDays × commuteMode EF
          const count       = dataValues.employeeCount             ?? 0;
          const avgDist     = dataValues.averageCommuteDistance    ?? 0;
          const days        = dataValues.workingDays               ?? 0;
          const commuteEF   = ef; // pulled from extractEmissionFactorValues

          const inc = count * avgDist * days * commuteEF;
          const cum = (cumulativeVals.employeeCount          ?? 0)
                    * (cumulativeVals.averageCommuteDistance ?? 0)
                    * (cumulativeVals.workingDays          ?? 0)
                    * commuteEF;

          const uInc = calculateUncertainty(inc, UAD, UEF);
          const uCum = calculateUncertainty(cum, UAD, UEF);

          emissions.incoming['employee_commuting'] = {
            CO2e: inc,
            combinedUncertainty: uInc,
            CO2eWithUncertainty: inc + uInc
          };
          emissions.cumulative['employee_commuting'] = {
            CO2e: cum,
            combinedUncertainty: uCum,
            CO2eWithUncertainty: cum + uCum
          };
        }
        else if (tier === 'tier 2') {
          // Tier 2 design in progress
          emissions.incoming['employee_commuting'] = {
            CO2e: 0,
            note: 'Tier 2 calculation in progress'
          };
          emissions.cumulative['employee_commuting'] = {
            CO2e: 0,
            note: 'Tier 2 calculation in progress'
          };
        }
        break;
        
      }
          // ───────── Upstream Leased Assets (8) (13) Downstream Leased Assets ─────────
   
         
   case 'Upstream Leased Assets':
case 'Downstream Leased Assets': {
  const key = (categoryName === 'Upstream Leased Assets')
    ? 'upstream_leased_assets'
    : 'downstream_leased_assets';

  // helper
  const toNum = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const area         = toNum(dataValues?.leasedArea);
  const cumArea      = toNum(cumulativeVals?.leasedArea);
  const tot          = toNum(dataValues?.totalArea);
  const cumTot       = toNum(cumulativeVals?.totalArea);

  // accept both 'occupancyEF' and 'occupancyFactor' (and coerce)
  const occ          = toNum(
    (dataValues?.occupancyEF ?? dataValues?.occupancyFactor ?? dataValues?.occupancy_factor ?? 1)
  ) || 1; // never 0 / falsy to avoid divide-by-zero

  // allow several key styles for BuildingTotalS1_S2 and coerce
  const buildingTotal = toNum(
    dataValues?.BuildingTotalS1_S2 ??
    dataValues?.buildingTotalS1S2 ??
    dataValues?.BuildingTotals1_S2 ?? 0
  );

  if (tier === 'tier 1') {
    // area × EF
    const inc  = area * ef;           // ef should already be resolved by your getCO2eEF()
    const cum  = cumArea * ef;
    const uInc = calculateUncertainty(inc, UAD, UEF);
    const uCum = calculateUncertainty(cum, UAD, UEF);

    emissions.incoming[key] = {
      CO2e: inc,
      combinedUncertainty: uInc,
      CO2eWithUncertainty: inc + uInc
    };
    emissions.cumulative[key] = {
      CO2e: cum,
      combinedUncertainty: uCum,
      CO2eWithUncertainty: cum + uCum
    };
  } else if (tier === 'tier 2') {
  const act = normActivity(scopeConfig.activity); // 'energybased' | 'areabased' | ''
  const doCaseA = act === 'energybased';
  const doCaseB = act === 'areabased';

  // Case A: energy × EF
  if (doCaseA) {
    const ec    = toNum(dataValues?.energyConsumption);
    const cumEc = toNum(cumulativeVals?.energyConsumption);

    const incA  = ec    * ef;
    const cumA  = cumEc * ef;
    const uA    = calculateUncertainty(incA, UAD, UEF);
    const uCumA = calculateUncertainty(cumA, UAD, UEF);

    emissions.incoming[key] = { CO2e: incA, combinedUncertainty: uA, CO2eWithUncertainty: incA + uA };
    emissions.cumulative[key] = { CO2e: cumA, combinedUncertainty: uCumA, CO2eWithUncertainty: cumA + uCumA };
  }
  // Case B: area-ratio × BuildingTotalS1_S2
  else if (doCaseB) {
    const ratio    = (tot > 0 && occ > 0) ? (area / (tot * occ)) : 0;
    const cumRatio = (cumTot > 0 && occ > 0) ? (cumArea / (cumTot * occ)) : 0;

    const incB  = ratio    * buildingTotal;
    const cumB  = cumRatio * buildingTotal;

    const uB    = calculateUncertainty(incB, UAD, UEF);
    const uCumB = calculateUncertainty(cumB, UAD, UEF);

    emissions.incoming[key]  = { CO2e: incB, combinedUncertainty: uB, CO2eWithUncertainty: incB + uB };
    emissions.cumulative[key]= { CO2e: cumB, combinedUncertainty: uCumB, CO2eWithUncertainty: cumB + uCumB };
  }
  // Fallback to your old heuristic (A if energyConsumption present, else B) when activity isn’t set
  else if (toNum(dataValues?.energyConsumption) > 0) {
    const ec    = toNum(dataValues?.energyConsumption);
    const cumEc = toNum(cumulativeVals?.energyConsumption);

    const incA  = ec    * ef;
    const cumA  = cumEc * ef;
    const uA    = calculateUncertainty(incA, UAD, UEF);
    const uCumA = calculateUncertainty(cumA, UAD, UEF);

    emissions.incoming[key] = { CO2e: incA, combinedUncertainty: uA, CO2eWithUncertainty: incA + uA };
    emissions.cumulative[key] = { CO2e: cumA, combinedUncertainty: uCumA, CO2eWithUncertainty: cumA + uCumA };
  } else {
    const ratio    = (tot > 0 && occ > 0) ? (area / (tot * occ)) : 0;
    const cumRatio = (cumTot > 0 && occ > 0) ? (cumArea / (cumTot * occ)) : 0;

    const incB  = ratio    * buildingTotal;
    const cumB  = cumRatio * buildingTotal;

    const uB    = calculateUncertainty(incB, UAD, UEF);
    const uCumB = calculateUncertainty(cumB, UAD, UEF);

    emissions.incoming[key]  = { CO2e: incB, combinedUncertainty: uB, CO2eWithUncertainty: incB + uB };
    emissions.cumulative[key]= { CO2e: cumB, combinedUncertainty: uCumB, CO2eWithUncertainty: cumB + uCumB };
  }
}
  break;
}

   // ───────── Downstream Transport and Distribution (9) ─────────
      case 'Downstream Transport and Distribution': {
        if (tier === 'tier 1') {
          // Transport Spend × EF
          const spend    = dataValues.transportSpend     ?? 0;
          const cumSpend = cumulativeVals.transportSpend ?? 0;
          const inc      = spend * ef;
          const cum      = cumSpend * ef;

          const uInc = calculateUncertainty(inc, UAD, UEF);
          const uCum = calculateUncertainty(cum, UAD, UEF);

          emissions.incoming['downstream_transport_and_distribution'] = {
            CO2e: inc, combinedUncertainty: uInc, CO2eWithUncertainty: inc + uInc
          };
          emissions.cumulative['downstream_transport_and_distribution'] = {
            CO2e: cum, combinedUncertainty: uCum, CO2eWithUncertainty: cum + uCum
          };
        } else if (tier === 'tier 2') {
          // 🔁 CHANGED: use allocation × distance × EF (fallback from legacy mass)
          const allocation = (dataValues.allocation ?? dataValues.mass ?? 0);
          const distance   = dataValues.distance ?? 0;

          const inc   = allocation * distance * ef;
          const cumA  = (cumulativeVals.allocation ?? cumulativeVals.mass ?? 0);
          const cumD  = (cumulativeVals.distance   ?? 0);
          const cum   = cumA * cumD * ef;

          const uInc  = calculateUncertainty(inc, UAD, UEF);
          const uCum  = calculateUncertainty(cum, UAD, UEF);

          emissions.incoming['downstream_transport_and_distribution'] = {
            CO2e: inc, combinedUncertainty: uInc, CO2eWithUncertainty: inc + uInc
          };
          emissions.cumulative['downstream_transport_and_distribution'] = {
            CO2e: cum, combinedUncertainty: uCum, CO2eWithUncertainty: cum + uCum
          };
        }
        break;
      }

        // ───────── Processing of Sold Products (10) ─────────
    case 'Processing of Sold Products': {
      const qty    = dataValues.productQuantity     ?? 0;
      const cumQty = cumulativeVals.productQuantity ?? 0;

      if (tier === 'tier 1') {
        // Tier 1: productQuantity × averageProcessingEF
        const inc  = qty * ef;
        const cum  = cumQty * ef;
        const uInc = calculateUncertainty(inc, UAD, UEF);
        const uCum = calculateUncertainty(cum, UAD, UEF);

        emissions.incoming['processing_of_sold_products'] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative['processing_of_sold_products'] = {
          CO2e: cum,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cum + uCum
        };
      }
      else if (tier === 'tier 2') {
        // Tier 2: productQuantity × customerTypeSpecificEF
        // (ef already pulled for the correct customerType by extractEmissionFactorValues)
        const inc  = qty * ef;
        const cum  = cumQty * ef;
        const uInc = calculateUncertainty(inc, UAD, UEF);
        const uCum = calculateUncertainty(cum, UAD, UEF);

        emissions.incoming['processing_of_sold_products'] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative['processing_of_sold_products'] = {
          CO2e: cum,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cum + uCum
        };
      }
      break;
    }
   // ───────── Use of Sold Products (11) ─────────
case 'Use of Sold Products': {
  const qty    = dataValues.productQuantity     ?? 0;
  const cumQty = cumulativeVals.productQuantity ?? 0;

  if (tier === 'tier 1') {
    // Tier 1: productQuantity × avgLifetimeEnergyConsumption × use-phase EF
    const cfgAvgLife = getAverageLifetimeEnergyConsumptionFromScope(scopeConfig);
    // prefer scope-level constant; else fall back to payload
    const avgLifeIn  = (cfgAvgLife !== null)
      ? cfgAvgLife
      : (dataValues.averageLifetimeEnergyConsumption ?? 0);
    const avgLifeCum = (cfgAvgLife !== null)
      ? cfgAvgLife
      : (cumulativeVals.averageLifetimeEnergyConsumption ?? 0);

    const inc  = qty    * avgLifeIn  * ef;
    const cum  = cumQty * avgLifeCum * ef;

    const uInc = calculateUncertainty(inc, UAD, UEF);
    const uCum = calculateUncertainty(cum, UAD, UEF);

    emissions.incoming['use_of_sold_products'] = {
      CO2e: inc,
      combinedUncertainty: uInc,
      CO2eWithUncertainty: inc + uInc
    };
    emissions.cumulative['use_of_sold_products'] = {
      CO2e: cum,
      combinedUncertainty: uCum,
      CO2eWithUncertainty: cum + uCum
    };
  }
  else if (tier === 'tier 2') {
    // Tier 2: productQuantity × usePattern × energyEfficiency × grid EF
    const cfgPattern = getUsePatternFromScope(scopeConfig);
    const cfgEff     = getEnergyEfficiencyFromScope(scopeConfig);

    // prefer scope-level constants; else fall back to payload (and to cumulative for cum path)
    const patternIn   = (cfgPattern !== null) ? cfgPattern : (dataValues.usePattern       ?? 0);
    const effIn       = (cfgEff     !== null) ? cfgEff     : (dataValues.energyEfficiency ?? 0);
    const patternCum  = (cfgPattern !== null) ? cfgPattern : (cumulativeVals.usePattern       ?? 0);
    const effCum      = (cfgEff     !== null) ? cfgEff     : (cumulativeVals.energyEfficiency ?? 0);

    const inc2  = qty    * patternIn  * effIn  * gridEF;
    const cum2  = cumQty * patternCum * effCum * gridEF;

    const uInc2 = calculateUncertainty(inc2, UAD, UEF);
    const uCum2 = calculateUncertainty(cum2, UAD, UEF);

    emissions.incoming['use_of_sold_products'] = {
      CO2e: inc2,
      combinedUncertainty: uInc2,
      CO2eWithUncertainty: inc2 + uInc2
    };
    emissions.cumulative['use_of_sold_products'] = {
      CO2e: cum2,
      combinedUncertainty: uCum2,
      CO2eWithUncertainty: cum2 + uCum2
    };
  }
  break;
}

//─────────End-of-Life Treatment of Sold Products (12) ─────────
case 'End-of-Life Treatment of Sold Products': {
  if (tier === 'tier 1') {
    const mass  = dataValues.massEol        ?? 0;

    // Prefer scope-level fractions, else fall back to payload values (and cumulative for cum path)
    const dCfg = getEOLDisposalFractionFromScope(scopeConfig);
    const lCfg = getEOLLandfillFractionFromScope(scopeConfig);
    const iCfg = getEOLIncinerationFractionFromScope(scopeConfig);

    const dIn   = (dCfg != null) ? dCfg : (asFraction01(dataValues.toDisposal)     ?? 0);
    const lIn   = (lCfg != null) ? lCfg : (asFraction01(dataValues.toLandfill)     ?? 0);
    const iIn   = (iCfg != null) ? iCfg : (asFraction01(dataValues.toIncineration) ?? 0);

    const dCum  = (dCfg != null) ? dCfg : (asFraction01(cumulativeVals.toDisposal)     ?? 0);
    const lCum  = (lCfg != null) ? lCfg : (asFraction01(cumulativeVals.toLandfill)     ?? 0);
    const iCum  = (iCfg != null) ? iCfg : (asFraction01(cumulativeVals.toIncineration) ?? 0);

    // pull three EF values in order [disposal, landfill, incineration]
    let efDisp = ef, efLand = ef, efInc = ef;
    const hub   = scopeConfig?.emissionFactorValues?.emissionFactorHubData;
    if (Array.isArray(hub)) {
      efDisp = hub[0]?.value ?? ef;
      efLand = hub[1]?.value ?? ef;
      efInc  = hub[2]?.value ?? ef;
    }

    // 1️⃣ Disposal
    const incDisp = mass * dIn * efDisp;
    const cumDisp = (cumulativeVals.massEol ?? 0) * dCum * efDisp;
    const uDisp   = calculateUncertainty(incDisp, UAD, UEF);

    emissions.incoming['eol_disposal'] = {
      CO2e: incDisp,
      combinedUncertainty: uDisp,
      CO2eWithUncertainty: incDisp + uDisp
    };
    emissions.cumulative['eol_disposal'] = {
      CO2e: cumDisp,
      combinedUncertainty: calculateUncertainty(cumDisp, UAD, UEF),
      CO2eWithUncertainty: cumDisp + calculateUncertainty(cumDisp, UAD, UEF)
    };

    // 2️⃣ Landfill
    const incLand = mass * lIn * efLand;
    const cumLand = (cumulativeVals.massEol ?? 0) * lCum * efLand;
    const uLand   = calculateUncertainty(incLand, UAD, UEF);

    emissions.incoming['eol_landfill'] = {
      CO2e: incLand,
      combinedUncertainty: uLand,
      CO2eWithUncertainty: incLand + uLand
    };
    emissions.cumulative['eol_landfill'] = {
      CO2e: cumLand,
      combinedUncertainty: calculateUncertainty(cumLand, UAD, UEF),
      CO2eWithUncertainty: cumLand + calculateUncertainty(cumLand, UAD, UEF)
    };

    // 3️⃣ Incineration
    const incInc = mass * iIn * efInc;
    const cumInc = (cumulativeVals.massEol ?? 0) * iCum * efInc;
    const uInc2  = calculateUncertainty(incInc, UAD, UEF);

    emissions.incoming['eol_incineration'] = {
      CO2e: incInc,
      combinedUncertainty: uInc2,
      CO2eWithUncertainty: incInc + uInc2
    };
    emissions.cumulative['eol_incineration'] = {
      CO2e: cumInc,
      combinedUncertainty: calculateUncertainty(cumInc, UAD, UEF),
      CO2eWithUncertainty: cumInc + calculateUncertainty(cumInc, UAD, UEF)
    };
  }
  break;
}


     // ───────── Franchises (14) ─────────
    case 'Franchises': {
      // pull your single EF
      const efFactor = ef; 
      const data     = dataValues;
      const cum      = cumulativeVals;
      const key      = 'franchises';

      if (tier === 'tier 1') {
        // Tier 1: count × avg‐EF
        const count = data.franchiseCount            ?? 0;
        const avgEF = data.avgEmissionPerFranchise  || efFactor;
        const inc   = count * avgEF;
        const cumV  = (cum.franchiseCount ?? 0) * avgEF;
        const uInc  = calculateUncertainty(inc, UAD, UEF);
        const uCum  = calculateUncertainty(cumV, UAD, UEF);

        emissions.incoming[key] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative[key] = {
          CO2e: cumV,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cumV + uCum
        };
      } else if (tier === 'tier 2') {
  // Case A: Emission Based (S1+S2)
  // Case B: Energy Based (energy × EF)
  const act = normActivity(scopeConfig.activity); // 'emissionbased' | 'energybased' | ''

  if (act === 'emissionbased') {
    const s1   = data.franchiseTotalS1Emission ?? 0;
    const s2   = data.franchiseTotalS2Emission ?? 0;
    const incA = s1 + s2;
    const cumA = (cum.franchiseTotalS1Emission ?? 0) + (cum.franchiseTotalS2Emission ?? 0);

    const uA    = calculateUncertainty(incA, UAD, UEF);
    const uCumA = calculateUncertainty(cumA, UAD, UEF);

    emissions.incoming[key]  = { CO2e: incA, combinedUncertainty: uA, CO2eWithUncertainty: incA + uA };
    emissions.cumulative[key]= { CO2e: cumA, combinedUncertainty: uCumA, CO2eWithUncertainty: cumA + uCumA };
  }
  else if (act === 'energybased') {
    const ec   = data.energyConsumption ?? 0;
    const incB = ec * efFactor;
    const cumB = (cum.energyConsumption ?? 0) * efFactor;

    const uB    = calculateUncertainty(incB, UAD, UEF);
    const uCumB = calculateUncertainty(cumB, UAD, UEF);

    emissions.incoming[key]  = { CO2e: incB, combinedUncertainty: uB, CO2eWithUncertainty: incB + uB };
    emissions.cumulative[key]= { CO2e: cumB, combinedUncertainty: uCumB, CO2eWithUncertainty: cumB + uCumB };
  }
  else {
    // Fallback to your previous A-then-B logic if activity isn’t set
    const s1 = data.franchiseTotalS1Emission ?? 0;
    const s2 = data.franchiseTotalS2Emission ?? 0;
    if (s1 > 0 || s2 > 0) {
      const incA = s1 + s2;
      const cumA = (cum.franchiseTotalS1Emission ?? 0) + (cum.franchiseTotalS2Emission ?? 0);
      emissions.incoming[key]  = { CO2e: incA, combinedUncertainty: calculateUncertainty(incA, UAD, UEF), CO2eWithUncertainty: incA + calculateUncertainty(incA, UAD, UEF) };
      emissions.cumulative[key]= { CO2e: cumA, combinedUncertainty: calculateUncertainty(cumA, UAD, UEF), CO2eWithUncertainty: cumA + calculateUncertainty(cumA, UAD, UEF) };
    } else {
      const ec   = data.energyConsumption ?? 0;
      const incB = ec * efFactor;
      const cumB = (cum.energyConsumption ?? 0) * efFactor;
      emissions.incoming[key]  = { CO2e: incB, combinedUncertainty: calculateUncertainty(incB, UAD, UEF), CO2eWithUncertainty: incB + calculateUncertainty(incB, UAD, UEF) };
      emissions.cumulative[key]= { CO2e: cumB, combinedUncertainty: calculateUncertainty(cumB, UAD, UEF), CO2eWithUncertainty: cumB + calculateUncertainty(cumB, UAD, UEF) };
    }
  }
}
      break;
    }
   // ───────── Investments (15) ─────────
case 'Investments': {
  // Pull equity share from scope (preferred), else fall back to payload
  const eqCfg = getEquitySharePercentageFromScope(scopeConfig);

  if (tier === 'tier 1') {
    // Tier 1: revenue × EF × equity%
   const rev = dataValues.investeeRevenue ?? 0;

const payloadShareRaw =
  dataValues.equitySharePercentage ?? dataValues.equityShare ?? dataValues.equity ?? null;

const share = (eqCfg !== null)
  ? eqCfg                              // already normalized in getEquityShare...()
  : (asFraction01(payloadShareRaw) ?? 1);  // default to 100% if not provided

const inc = rev * ef * share;

// cumulative:
const cumRev = cumulativeVals.investeeRevenue ?? 0;
const cumPayloadShareRaw =
  cumulativeVals.equitySharePercentage ?? cumulativeVals.equityShare ?? cumulativeVals.equity ?? null;

const cumShr = (eqCfg !== null)
  ? eqCfg
  : (asFraction01(cumPayloadShareRaw) ?? 1);

const cum = cumRev * ef * cumShr;

    const uInc = calculateUncertainty(inc, UAD, UEF);
    const uCum = calculateUncertainty(cum, UAD, UEF);

    emissions.incoming['investments'] = {
      CO2e: inc,
      combinedUncertainty: uInc,
      CO2eWithUncertainty: inc + uInc
    };
    emissions.cumulative['investments'] = {
      CO2e: cum,
      combinedUncertainty: uCum,
      CO2eWithUncertainty: cum + uCum
    };
  } else if (tier === 'tier 2') {
    // Case A: (Scope1 + Scope2) × equity%
    // Case B: energyConsumption × EF
    const act = normActivity(scopeConfig.activity); // 'investmentbased' | 'energybased' | ''

    if (act === 'investmentbased') {
     // Tier-2 investmentbased
const s1 = dataValues.investeeScope1Emission ?? 0;
const s2 = dataValues.investeeScope2Emission ?? 0;

const payloadShareRaw =
  dataValues.equitySharePercentage ?? dataValues.equityShare ?? dataValues.equity ?? null;

const share = (eqCfg !== null)
  ? eqCfg
  : (asFraction01(payloadShareRaw) ?? 1);

const incA = (s1 + s2) * share;

const cumS1 = cumulativeVals.investeeScope1Emission ?? 0;
const cumS2 = cumulativeVals.investeeScope2Emission ?? 0;

const cumPayloadShareRaw =
  cumulativeVals.equitySharePercentage ?? cumulativeVals.equityShare ?? cumulativeVals.equity ?? null;

const cumShr = (eqCfg !== null)
  ? eqCfg
  : (asFraction01(cumPayloadShareRaw) ?? 1);

const cumA = (cumS1 + cumS2) * cumShr;


      const uA    = calculateUncertainty(incA, UAD, UEF);
      const uCumA = calculateUncertainty(cumA, UAD, UEF);

      emissions.incoming['investments']  = { CO2e: incA, combinedUncertainty: uA,    CO2eWithUncertainty: incA + uA };
      emissions.cumulative['investments'] = { CO2e: cumA, combinedUncertainty: uCumA, CO2eWithUncertainty: cumA + uCumA };
    }
    else if (act === 'energybased') {
      const ec    = dataValues.energyConsumption ?? 0;
      const cumEc = cumulativeVals.energyConsumption ?? 0;

      const incB  = ec * ef;
      const cumB  = cumEc * ef;

      const uB    = calculateUncertainty(incB, UAD, UEF);
      const uCumB = calculateUncertainty(cumB, UAD, UEF);

      emissions.incoming['investments']   = { CO2e: incB, combinedUncertainty: uB,    CO2eWithUncertainty: incB + uB };
      emissions.cumulative['investments'] = { CO2e: cumB, combinedUncertainty: uCumB, CO2eWithUncertainty: cumB + uCumB };
    }
    else {
      // Fallback to your old A-then-B heuristic when activity isn’t set
      const s1    = dataValues.investeeScope1Emission ?? 0;
      const s2    = dataValues.investeeScope2Emission ?? 0;
      const share = (eqCfg !== null)
        ? eqCfg
        : (dataValues.equitySharePercentage ?? dataValues.equityShare ?? dataValues.equity ?? 0);

      if (s1 > 0 || s2 > 0) {
        const incA   = (s1 + s2) * share;
        const cumS1  = cumulativeVals.investeeScope1Emission ?? 0;
        const cumS2  = cumulativeVals.investeeScope2Emission ?? 0;
        const cumShr = (eqCfg !== null)
          ? eqCfg
          : (cumulativeVals.equitySharePercentage ?? cumulativeVals.equityShare ?? cumulativeVals.equity ?? 0);
        const cumA   = (cumS1 + cumS2) * cumShr;

        emissions.incoming['investments']   = {
          CO2e: incA,
          combinedUncertainty: calculateUncertainty(incA, UAD, UEF),
          CO2eWithUncertainty: incA + calculateUncertainty(incA, UAD, UEF)
        };
        emissions.cumulative['investments'] = {
          CO2e: cumA,
          combinedUncertainty: calculateUncertainty(cumA, UAD, UEF),
          CO2eWithUncertainty: cumA + calculateUncertainty(cumA, UAD, UEF)
        };
      } else if ((dataValues.energyConsumption ?? 0) > 0) {
        const ec    = dataValues.energyConsumption;
        const cumEc = cumulativeVals.energyConsumption ?? 0;
        const incB  = ec * ef;
        const cumB  = cumEc * ef;

        emissions.incoming['investments']   = {
          CO2e: incB,
          combinedUncertainty: calculateUncertainty(incB, UAD, UEF),
          CO2eWithUncertainty: incB + calculateUncertainty(incB, UAD, UEF)
        };
        emissions.cumulative['investments'] = {
          CO2e: cumB,
          combinedUncertainty: calculateUncertainty(cumB, UAD, UEF),
          CO2eWithUncertainty: cumB + calculateUncertainty(cumB, UAD, UEF)
        };
      }
    }
  }

  break;
}


    // ───────── default / other Scope 3 categories ─────────
    default:
      // you can add more categories here…
      break;
  }

  return {
    success:   true,
    scopeType: 'Scope 3',
    category:  categoryName,
    tier,
    emissions
  };
}

/**
 * Calculate combined uncertainty
 */
function calculateUncertainty(baseValue, UAD, UEF) {
  // Combined Uncertainty = √(UAD² + UEF²)
  const combinedUncertaintyPercent = Math.sqrt(Math.pow(UAD, 2) + Math.pow(UEF, 2));
  return baseValue * (combinedUncertaintyPercent / 100);
}

/**
 * Batch calculation for multiple data entries
 */
const calculateBatchEmissions = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier, dataEntryIds } = req.body;
    
    const results = [];
    
    for (const dataEntryId of dataEntryIds) {
      try {
        // Create individual request for each entry
        const singleReq = {
          body: { clientId, nodeId, scopeIdentifier, dataEntryId }
        };
        
        // Mock response to capture result
        const singleRes = {
          status: () => ({ json: (data) => data }),
          json: (data) => data
        };
        
        const result = await calculateEmissions(singleReq, singleRes);
        results.push({ dataEntryId, result });
        
      } catch (error) {
        results.push({ 
          dataEntryId, 
          error: error.message 
        });
      }
    }
    
    return res.status(200).json({
      success: true,
      results: results
    });
    
  } catch (error) {
    console.error('Error in batch emission calculation:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Error in batch calculation', 
      error: error.message 
    });
  }
};

/**
 * Save calculated emissions to DataEntry
 */
const saveCalculatedEmissions = async (dataEntryId, emissions) => {
  try {
    const dataEntry = await DataEntry.findById(dataEntryId);
    if (!dataEntry) {
      throw new Error('Data entry not found');
    }

    // Add calculated emissions to the entry
    dataEntry.calculatedEmissions = emissions;
    dataEntry.processingStatus = 'processed';
    dataEntry.lastCalculated = new Date();

    await dataEntry.save();
    return { success: true };
    
  } catch (error) {
    console.error('Error saving emissions:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Get emission summary for a client
 */
const getEmissionSummary = async (req, res) => {
  try {
    const { clientId, startDate, endDate } = req.query;
    
    const query = { 
      clientId,
      processingStatus: 'processed',
      timestamp: {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      }
    };
    
    const entries = await DataEntry.find(query)
      .select('scopeType nodeId scopeIdentifier calculatedEmissions timestamp');
    
    // Aggregate emissions by scope
    const summary = {
      'Scope 1': { total: 0, byCategory: {} },
      'Scope 2': { total: 0, byCategory: {} },
      'Scope 3': { total: 0, byCategory: {} },
      totalEmissions: 0
    };
    
    entries.forEach(entry => {
      if (entry.calculatedEmissions?.emissions?.incoming) {
        Object.values(entry.calculatedEmissions.emissions.incoming).forEach(emission => {
          const co2e = emission.CO2e || emission.emission || 0;
          summary[entry.scopeType].total += co2e;
          summary.totalEmissions += co2e;
        });
      }
    });
    
    return res.status(200).json({
      success: true,
      summary: summary,
      period: { startDate, endDate }
    });
    
  } catch (error) {
    console.error('Error getting emission summary:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Error getting emission summary', 
      error: error.message 
    });
  }
};

module.exports = {
  calculateEmissions,
  calculateBatchEmissions,
  saveCalculatedEmissions,
  getEmissionSummary
};