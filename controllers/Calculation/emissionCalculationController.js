// controllers/Calculation/emissionCalculationController.js

const DataEntry = require('../../models/DataEntry');
const Flowchart = require('../../models/Flowchart');
const ProcessFlowchart = require('../../models/ProcessFlowchart');
const Client = require('../../models/Client'); 

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
    // Tier 2: quantity-based
    const qty    = dataValues.assetQuantity     ?? 0;
    const cumQty = cumulativeVals.assetQuantity ?? 0;
    const inc    = qty * ef;
    const cum    = cumQty * ef;
    const uInc   = calculateUncertainty(inc, UAD, UEF);
    const uCum   = calculateUncertainty(cum, UAD, UEF);

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
  const td    = dataValues.tdLossFactor           ?? 0;
  const cf    = dataValues.fuelConsumption        ?? 0;
  const cumCf = dataValues.fuelConsumption        ?? 0;

  // emission factor for all fuel‐energy buckets
  // you were using `ef` for upstream and WTT, and `gridEF` for T&D.
  // adjust these if you pull them from different efValues properties.
  const WTTEF= ef;
  const upstreamEF = ef;     
  const gridEF     = ef;     

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
    case 'Upstream Transport and Distribution':
      if (tier === 'tier 1') {
        const spend    = dataValues.transportationSpend     ?? 0;
        const cumSpend = cumulativeVals.transportationSpend ?? 0;
        const inc      = spend * ef;
        const cum      = cumSpend * ef;
        const uInc     = calculateUncertainty(inc, UAD, UEF);
        const uCum     = calculateUncertainty(cum, UAD, UEF);

        emissions.incoming['upstream_transport_and_distribution'] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative['upstream_transport_and_distribution'] = {
          CO2e: cum,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cum + uCum
        };
      }
      else if (tier === 'tier 2') {
        const mass     = dataValues.mass     ?? 0;
        const distance = dataValues.distance ?? 0;
        const inc      = mass * distance * ef;
        // for cumulative, multiply cumulative mass & distance if you track them separately
        const cum      = (cumulativeVals.mass ?? 0) * (cumulativeVals.distance ?? 0) * ef;
        const uInc     = calculateUncertainty(inc, UAD, UEF);
        const uCum     = calculateUncertainty(cum, UAD, UEF);

        emissions.incoming['upstream_transport_and_distribution'] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative['upstream_transport_and_distribution'] = {
          CO2e: cum,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cum + uCum
        };
      }
      break;

      // ───────── Waste Generated in Operation (5) ─────────
    case 'Waste Generated in Operation':
      if (tier === 'tier 1') {
        // Tier 1: waste mass × waste‐type EF
        const mass    = dataValues.wasteMass          ?? 0;
        const cumMass = cumulativeVals.wasteMass      ?? 0;
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
      else if (tier === 'tier 2') {
        // Tier 2: mass of each waste type × treatment‐specific EF
        const mass    = dataValues.wasteMass            ?? 0;
        const cumMass = cumulativeVals.wasteMass        ?? 0;
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
    case 'Business Travel':
      if (tier === 'tier 1') {
        // Tier 1: Travel spend × travel EF  +  Hotel nights × hotel‐night EF
        const travelSpend   = dataValues.travelSpend   ?? 0;
        const hotelNights   = dataValues.hotelNights   ?? 0;
        // both EFs come from whatever source is in scopeConfig.emissionFactor
        const travelInc     = travelSpend * ef;
        const hotelInc      = hotelNights * ef;
        const cumTravel     = (cumulativeVals.travelSpend   ?? 0) * ef;
        const cumHotel      = (cumulativeVals.hotelNights   ?? 0) * ef;

        const uTravelInc    = calculateUncertainty(travelInc, UAD, UEF);
        const uHotelInc     = calculateUncertainty(hotelInc,  UAD, UEF);
        const uTravelCum    = calculateUncertainty(cumTravel,  UAD, UEF);
        const uHotelCum     = calculateUncertainty(cumHotel,   UAD, UEF);

        // break it out into two line‐items
        emissions.incoming['business_travel'] = {
          CO2e: travelInc,
          combinedUncertainty: uTravelInc,
          CO2eWithUncertainty: travelInc + uTravelInc
        };
        emissions.incoming['accommodation'] = {
          CO2e: hotelInc,
          combinedUncertainty: uHotelInc,
          CO2eWithUncertainty: hotelInc + uHotelInc
        };
        emissions.cumulative['business_travel'] = {
          CO2e: cumTravel,
          combinedUncertainty: uTravelCum,
          CO2eWithUncertainty: cumTravel + uTravelCum
        };
        emissions.cumulative['accommodation'] = {
          CO2e: cumHotel,
          combinedUncertainty: uHotelCum,
          CO2eWithUncertainty: cumHotel + uHotelCum
        };
      }
      else if (tier === 'tier 2') {
        // Tier 2 has two “or” cases:
        // 1) passenger-km, 2) hotel-nights
        const passengers    = dataValues.numberOfPassengers ?? 0;
        const distance      = dataValues.distanceTravelled ?? 0;
        const hotelNights   = dataValues.hotelNights       ?? 0;

        // CASE A: passenger-km
        const tripInc       = passengers * distance * ef;
        const cumTrip       = (cumulativeVals.numberOfPassengers ?? 0)
                            * (cumulativeVals.distanceTravelled ?? 0)
                            * ef;
        const uTripInc      = calculateUncertainty(tripInc, UAD, UEF);
        const uTripCum      = calculateUncertainty(cumTrip, UAD, UEF);

        emissions.incoming['business_travel'] = {
          CO2e: tripInc,
          combinedUncertainty: uTripInc,
          CO2eWithUncertainty: tripInc + uTripInc
        };
        emissions.cumulative['business_travel'] = {
          CO2e: cumTrip,
          combinedUncertainty: uTripCum,
          CO2eWithUncertainty: cumTrip + uTripCum
        };

        // CASE B: hotel nights (country lookup via your Country EF)
        if (hotelNights > 0) {
          const hotelInc    = hotelNights * ef;
          const cumHotel    = (cumulativeVals.hotelNights ?? 0) * ef;
          const uHotelInc   = calculateUncertainty(hotelInc, UAD, UEF);
          const uHotelCum   = calculateUncertainty(cumHotel, UAD, UEF);

          emissions.incoming['accommodation'] = {
            CO2e: hotelInc,
            combinedUncertainty: uHotelInc,
            CO2eWithUncertainty: hotelInc + uHotelInc
          };
          emissions.cumulative['accommodation'] = {
            CO2e: cumHotel,
            combinedUncertainty: uHotelCum,
            CO2eWithUncertainty: cumHotel + uHotelCum
          };
        }
      }
      break;
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
      // pick the right JSON key
      const key = categoryName === 'Upstream Leased Assets'
        ? 'upstream_leased_assets'
        : 'downstream_leased_assets';

      const area    = dataValues.leasedArea       ?? 0;
      const cumArea = cumulativeVals.leasedArea   ?? 0;
      const tot     = dataValues.totalArea        ?? 0;
      const cumTot  = cumulativeVals.totalArea    ?? 0;
      const occupancyEF = ef; // your occupancy‐factor EF
      const buildingTotal = dataValues.BuildingTotalS1_S2 ?? 0;

      // Tier 1
      if (tier === 'tier 1') {
        const inc  = area * ef;
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
      }
      // Tier 2
      else if (tier === 'tier 2') {
        // Case A: energy × EF
        if ((dataValues.energyConsumption ?? 0) > 0) {
          const ec    = dataValues.energyConsumption      ?? 0;
          const cumEc = cumulativeVals.energyConsumption  ?? 0;
          const incA  = ec  * ef;
          const cumA  = cumEc * ef;
          const uA    = calculateUncertainty(incA, UAD, UEF);
          const uCumA = calculateUncertainty(cumA, UAD, UEF);

          emissions.incoming[key] = {
            CO2e: incA,
            combinedUncertainty: uA,
            CO2eWithUncertainty: incA + uA
          };
          emissions.cumulative[key] = {
            CO2e: cumA,
            combinedUncertainty: uCumA,
            CO2eWithUncertainty: cumA + uCumA
          };
        }
        // Case B: ratio‐method
        else {
          const ratio = (tot > 0 && occupancyEF > 0)
            ? (area / (tot * occupancyEF))
            : 0;
          const incB    = ratio * buildingTotal;
          const cumRatio= (cumTot > 0 && occupancyEF > 0)
            ? (cumArea / (cumTot * occupancyEF))
            : 0;
          const cumB    = cumRatio * buildingTotal;
          const uB      = calculateUncertainty(incB, UAD, UEF);
          const uCumB   = calculateUncertainty(cumB, UAD, UEF);

          emissions.incoming[key] = {
            CO2e: incB,
            combinedUncertainty: uB,
            CO2eWithUncertainty: incB + uB
          };
          emissions.cumulative[key] = {
            CO2e: cumB,
            combinedUncertainty: uCumB,
            CO2eWithUncertainty: cumB + uCumB
          };
        }
      }
      break;
    }

    // ───────── Downstream Transport & Distribution (9) ─────────
    case 'Downstream Transport and Distribution': {
      if (tier === 'tier 1') {
        // Transport Spend × EF
        const spend = dataValues.transportSpend ?? 0;
        const cumSpend = cumulativeVals.transportSpend ?? 0;
        const inc = spend * ef;
        const cum = cumSpend * ef;
        const uInc = calculateUncertainty(inc, UAD, UEF);
        const uCum = calculateUncertainty(cum, UAD, UEF);

        emissions.incoming['downstream_transport_and_distribution'] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative['downstream_transport_and_distribution'] = {
          CO2e: cum,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cum + uCum
        };
      }
      else if (tier === 'tier 2') {
        // Mass × Distance × EF
        const mass     = dataValues.mass     ?? 0;
        const distance = dataValues.distance ?? 0;
        const cumMass  = cumulativeVals.mass     ?? 0;
        const cumDist  = cumulativeVals.distance ?? 0;
        const inc = mass * distance * ef;
        const cum = cumMass * cumDist * ef;
        const uInc = calculateUncertainty(inc, UAD, UEF);
        const uCum = calculateUncertainty(cum, UAD, UEF);

        emissions.incoming['downstream_transport_and_distribution'] = {
          CO2e: inc,
          combinedUncertainty: uInc,
          CO2eWithUncertainty: inc + uInc
        };
        emissions.cumulative['downstream_transport_and_distribution'] = {
          CO2e: cum,
          combinedUncertainty: uCum,
          CO2eWithUncertainty: cum + uCum
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
        // Tier 1: productQuantity × avgLifetimeEnergyConsumption × usePhase EF
        const avgLife = dataValues.averageLifetimeEnergyConsumption ?? 0;
        const inc     = qty * avgLife * ef;
        const cum     = cumQty
                      * (cumulativeVals.averageLifetimeEnergyConsumption ?? 0)
                      * ef;
        const uInc    = calculateUncertainty(inc, UAD, UEF);
        const uCum    = calculateUncertainty(cum, UAD, UEF);

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
        const pattern   = dataValues.usePattern       ?? 0;
        const efficiency= dataValues.energyEfficiency ?? 0;
        const cumPattern   = cumulativeVals.usePattern       ?? 0;
        const cumEfficiency= cumulativeVals.energyEfficiency ?? 0;

        const inc2  = qty * pattern * efficiency * gridEF;
        const cum2  = cumQty * cumPattern * cumEfficiency * gridEF;
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
    const d     = dataValues.toDisposal     ?? 0;
    const l     = dataValues.toLandfill     ?? 0;
    const i     = dataValues.toIncineration ?? 0;

    // pull three EF values in order [disposal, landfill, incineration]
    let efDisp = ef, efLand = ef, efInc = ef;
    const hub   = scopeConfig.emissionFactorValues.emissionFactorHubData;
    if (Array.isArray(hub)) {
      efDisp = hub[0]?.value ?? ef;
      efLand = hub[1]?.value ?? ef;
      efInc  = hub[2]?.value ?? ef;
    }

    // 1️⃣ Disposal
    const incDisp = mass * d * efDisp;
    const cumDisp = (cumulativeVals.massEol ?? 0)
                  * (cumulativeVals.toDisposal ?? 0)
                  * efDisp;
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
    const incLand = mass * l * efLand;
    const cumLand = (cumulativeVals.massEol ?? 0)
                  * (cumulativeVals.toLandfill ?? 0)
                  * efLand;
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
    const incInc = mass * i * efInc;
    const cumInc = (cumulativeVals.massEol ?? 0)
                 * (cumulativeVals.toIncineration ?? 0)
                 * efInc;
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
      }
      else if (tier === 'tier 2') {
        // Case A: S1 + S2
        const s1 = data.franchiseTotalS1Emission ?? 0;
        const s2 = data.franchiseTotalS2Emission ?? 0;
        if (s1 > 0 || s2 > 0) {
          const incA  = s1 + s2;
          const cumA  = (cum.franchiseTotalS1Emission ?? 0)
                      + (cum.franchiseTotalS2Emission ?? 0);
          const uA    = calculateUncertainty(incA, UAD, UEF);
          const uCumA = calculateUncertainty(cumA, UAD, UEF);

          emissions.incoming[key] = {
            CO2e: incA,
            combinedUncertainty: uA,
            CO2eWithUncertainty: incA + uA
          };
          emissions.cumulative[key] = {
            CO2e: cumA,
            combinedUncertainty: uCumA,
            CO2eWithUncertainty: cumA + uCumA
          };
        }
        // Case B: energy × EF
        else {
          const ec    = data.energyConsumption ?? 0;
          const incB  = ec * efFactor;
          const cumB  = (cum.energyConsumption ?? 0) * efFactor;
          const uB    = calculateUncertainty(incB, UAD, UEF);
          const uCumB = calculateUncertainty(cumB, UAD, UEF);

          emissions.incoming[key] = {
            CO2e: incB,
            combinedUncertainty: uB,
            CO2eWithUncertainty: incB + uB
          };
          emissions.cumulative[key] = {
            CO2e: cumB,
            combinedUncertainty: uCumB,
            CO2eWithUncertainty: cumB + uCumB
          };
        }
      }
      break;
    }
     // ───────── Investments (15) ─────────
    case 'Investments': {
      if (tier === 'tier 1') {
        // Tier 1: revenue × EF × equity%
        const rev    = dataValues.investeeRevenue       ?? 0;
        const share  = dataValues.equitySharePercentage ?? 0;
        const inc    = rev * ef * share;
        const cumRev = cumulativeVals.investeeRevenue       ?? 0;
        const cumShr = cumulativeVals.equitySharePercentage ?? 0;
        const cum    = cumRev * ef * cumShr;

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
      }
      else if (tier === 'tier 2') {
        // Case A: (Scope1 + Scope2) × equity%
        const s1    = dataValues.investeeScope1Emission ?? 0;
        const s2    = dataValues.investeeScope2Emission ?? 0;
        const share = dataValues.equitySharePercentage  ?? 0;
        if (s1 > 0 || s2 > 0) {
          const incA   = (s1 + s2) * share;
          const cumS1  = cumulativeVals.investeeScope1Emission ?? 0;
          const cumS2  = cumulativeVals.investeeScope2Emission ?? 0;
          const cumShr = cumulativeVals.equitySharePercentage  ?? 0;
          const cumA   = (cumS1 + cumS2) * cumShr;

          const uA    = calculateUncertainty(incA, UAD, UEF);
          const uCumA = calculateUncertainty(cumA, UAD, UEF);

          emissions.incoming['investments'] = {
            CO2e: incA,
            combinedUncertainty: uA,
            CO2eWithUncertainty: incA + uA
          };
          emissions.cumulative['investments'] = {
            CO2e: cumA,
            combinedUncertainty: uCumA,
            CO2eWithUncertainty: cumA + uCumA
          };
        }
        // Case B: energyConsumption × EF
        else if ((dataValues.energyConsumption ?? 0) > 0) {
          const ec    = dataValues.energyConsumption;
          const cumEc = cumulativeVals.energyConsumption ?? 0;
          const incB  = ec * ef;
          const cumB  = cumEc * ef;

          const uB    = calculateUncertainty(incB, UAD, UEF);
          const uCumB = calculateUncertainty(cumB, UAD, UEF);

          emissions.incoming['investments'] = {
            CO2e: incB,
            combinedUncertainty: uB,
            CO2eWithUncertainty: incB + uB
          };
          emissions.cumulative['investments'] = {
            CO2e: cumB,
            combinedUncertainty: uCumB,
            CO2eWithUncertainty: cumB + uCumB
          };
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