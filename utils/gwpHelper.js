const GWP  =require('../models/GWP');

// Enhanced helper function with better matching and fallback options
exports.getLatestGWPValue=async (chemicalUnit)=> {
  try {
    if (!chemicalUnit) return 0;

    // Clean and normalize the unit/chemical name for better matching
    const normalizedUnit = chemicalUnit.toString().trim().toLowerCase();

    // Try exact match first
    let gwpData = await GWP.findOne({
      $or: [ 
        { chemicalFormula: { $regex: new RegExp(`^${normalizedUnit}$`, 'i') } },
        { chemicalName: { $regex: new RegExp(`^${normalizedUnit}$`, 'i') } }
      ]
    });

    // If no exact match, try partial matching for compound names
    if (!gwpData) {
      // For cases like "Natural gas" -> search for "CH4" or "Methane"
      const chemicalMappings = {
        'natural gas': ['CH4', 'Methane'],
        'coal': ['CO2', 'Carbon dioxide'],
        'diesel': ['CO2', 'Carbon dioxide'],
        'gasoline': ['CO2', 'Carbon dioxide'],
        'petrol': ['CO2', 'Carbon dioxide'],
        'lng': ['CH4', 'Methane'],
        'lpg': ['C3H8', 'Propane', 'C4H10', 'Butane'],
        'butane': ['C4H10', 'Butane'],
        'propane': ['C3H8', 'Propane'],
        'methane': ['CH4', 'Methane'],
        'carbon dioxide': ['CO2'],
        'nitrous oxide': ['N2O'],
        'refrigerant': ['HFC', 'R-134a', 'R-410A']
      };

      const mappedChemicals = chemicalMappings[normalizedUnit];
      if (mappedChemicals) {
        for (const chemical of mappedChemicals) {
          gwpData = await GWP.findOne({
            $or: [
              { chemicalFormula: { $regex: new RegExp(`^${chemical}$`, 'i') } },
              { chemicalName: { $regex: new RegExp(`^${chemical}$`, 'i') } }
            ]
          });
          if (gwpData) break;
        }
      }
    }

    // If still no match, try fuzzy search
    if (!gwpData) {
      gwpData = await GWP.findOne({
        $or: [
          { chemicalFormula: { $regex: new RegExp(normalizedUnit, 'i') } },
          { chemicalName: { $regex: new RegExp(normalizedUnit, 'i') } }
        ]
      });
    }

    if (!gwpData) {
      console.log(`No GWP data found for: ${chemicalUnit}`);
      return 0;
    }

    // Get the latest AR assessment (AR6 is currently latest, AR7 will be next)
    const assessments = gwpData.assessments;
    if (!assessments || assessments.size === 0) {
      return 0;
    }

    // Priority order: AR7 > AR6 > AR5 > AR4 (for future-proofing)
    const priorityOrder = ['AR7', 'AR6', 'AR5', 'AR4'];

    for (const ar of priorityOrder) {
      if (assessments.has(ar)) {
        console.log(`Found GWP value for ${chemicalUnit} in ${ar}: ${assessments.get(ar)}`);
        return assessments.get(ar);
      }
    }

    // If no AR assessments found, return the first available GWP value
    const firstValue = assessments.values().next().value;
    return firstValue || 0;
  } catch (error) {
    console.error('Error fetching GWP value:', error);
    return 0;
  }
}

// Enhanced function to add GWP values to emission factor data
// Updated to use level2 for IPCC and level3EPA for EPA
exports.enhanceDataWithGWP= async (data, source) => {
  try {
    const enhancedData = await Promise.all(data.map(async (item) => {
      const itemObj = item.toObject ? item.toObject() : item;
      let gwpValue = 0;
      let gwpSearchField = null; // Track which field was used for GWP search
      
      try {
        switch (source) {
          case 'EPA':
            // For EPA, use level3EPA to get GWP value (primary)
            if (itemObj.level3EPA) {
              gwpValue = await getLatestGWPValue(itemObj.level3EPA);
              gwpSearchField = 'level3EPA';
            }
            // Fallback to ghgUnitEPA if level3EPA doesn't yield results
            if (gwpValue === 0 && itemObj.ghgUnitEPA) {
              gwpValue = await getLatestGWPValue(itemObj.ghgUnitEPA);
              gwpSearchField = 'ghgUnitEPA';
            }
            // Additional fallback to level2EPA
            if (gwpValue === 0 && itemObj.level2EPA) {
              gwpValue = await getLatestGWPValue(itemObj.level2EPA);
              gwpSearchField = 'level2EPA';
            }
            break;
            
          case 'DEFRA':
            // For DEFRA, use ghgUnit to get GWP value
            if (itemObj.ghgUnit) {
              gwpValue = await getLatestGWPValue(itemObj.ghgUnit);
              gwpSearchField = 'ghgUnit';
            }
            break;
            
          case 'IPCC':
            // For IPCC, use level2 to get GWP value (primary)
            if (itemObj.level2) {
              gwpValue = await getLatestGWPValue(itemObj.level2);
              gwpSearchField = 'level2';
            }
            // Fallback to Unit if level2 doesn't yield results
            if (gwpValue === 0 && itemObj.Unit) {
              gwpValue = await getLatestGWPValue(itemObj.Unit);
              gwpSearchField = 'Unit';
            }
            // Additional fallback to level3
            if (gwpValue === 0 && itemObj.level3) {
              gwpValue = await getLatestGWPValue(itemObj.level3);
              gwpSearchField = 'level3';
            }
            break;
            
          case 'Country':
            // For Country, no GWP values needed - skip GWP processing
            gwpValue = 0;
            gwpSearchField = null;
            break;
            
          default:
            gwpValue = 0;
        }
      } catch (error) {
        console.error(`Error getting GWP for item ${itemObj._id}:`, error);
        gwpValue = 0;
      }
      
      // Add GWP value and metadata to the item
      return {
        ...itemObj,
        gwpValue: gwpValue,
        gwpSearchField: gwpSearchField, // Track which field was used for matching
        gwpLastUpdated: new Date().toISOString()
      };
    }));
    
    return enhancedData;
  } catch (error) {
    console.error('Error enhancing data with GWP:', error);
    return data;
  }
}

// Helper function to enhance GHG units array with GWP values for DEFRA
 exports.enhanceDefraGhgUnits= async(ghgUnits) =>{
  if (!Array.isArray(ghgUnits) || ghgUnits.length === 0) {
    return [];
  }

  return await Promise.all(ghgUnits.map(async (ghgUnit) => {
    try {
      const gwpValue = await getLatestGWPValue(ghgUnit.unit);
      return {
        unit: ghgUnit.unit,
        ghgconversionFactor: ghgUnit.ghgconversionFactor,
        gwpValue: gwpValue,
        gwpSearchField: ghgUnit.unit ? 'unit' : null,
        gwpLastUpdated: new Date()
      };
    } catch (error) {
      console.error(`Error enhancing GHG unit ${ghgUnit.unit}:`, error);
      return {
        ...ghgUnit,
        gwpValue: 0,
        gwpSearchField: null,
        gwpLastUpdated: new Date()
      };
    }
  }));
}

// Helper function to enhance GHG units array with GWP values for EPA
 exports.enhanceEpaGhgUnits=async(ghgUnitsEPA) =>{
  if (!Array.isArray(ghgUnitsEPA) || ghgUnitsEPA.length === 0) {
    return [];
  }

  return await Promise.all(ghgUnitsEPA.map(async (ghgUnit) => {
    try {
      const gwpValue = await getLatestGWPValue(ghgUnit.unit);
      return {
        unit: ghgUnit.unit,
        ghgconversionFactor: ghgUnit.ghgconversionFactor,
        gwpValue: gwpValue,
        gwpSearchField: ghgUnit.unit ? 'unit' : null,
        gwpLastUpdated: new Date()
      };
    } catch (error) {
      console.error(`Error enhancing EPA GHG unit ${ghgUnit.unit}:`, error);
      return {
        ...ghgUnit,
        gwpValue: 0,
        gwpSearchField: null,
        gwpLastUpdated: new Date()
      };
    }
  }));
}

// Helper function to get GWP values for Custom emission factors
exports.getCustomGWPValues = async(customEmissionFactor, customGwpData = null) => {
  try {
    const gwpValues = {
      CO2_gwp: 0,
      CH4_gwp: 0,
      N2O_gwp: 0,
      gwpLastUpdated: new Date()
    };

    // If custom GWP data is provided in request, use it
    if (customGwpData) {
      if (customGwpData.CO2_chemical || customGwpData.co2Chemical) {
        const co2Chemical = customGwpData.CO2_chemical || customGwpData.co2Chemical;
        gwpValues.CO2_gwp = await getLatestGWPValue(co2Chemical);
      }
      
      if (customGwpData.CH4_chemical || customGwpData.ch4Chemical) {
        const ch4Chemical = customGwpData.CH4_chemical || customGwpData.ch4Chemical;
        gwpValues.CH4_gwp = await getLatestGWPValue(ch4Chemical);
      }
      
      if (customGwpData.N2O_chemical || customGwpData.n2oChemical) {
        const n2oChemical = customGwpData.N2O_chemical || customGwpData.n2oChemical;
        gwpValues.N2O_gwp = await getLatestGWPValue(n2oChemical);
      }
    } else {
      // Default behavior - use standard chemical names
      if (customEmissionFactor.CO2 !== null && customEmissionFactor.CO2 !== undefined) {
        gwpValues.CO2_gwp = await getLatestGWPValue('CO2') || 1; // CO2 GWP is always 1
      }

      if (customEmissionFactor.CH4 !== null && customEmissionFactor.CH4 !== undefined) {
        gwpValues.CH4_gwp = await getLatestGWPValue('CH4');
      }

      if (customEmissionFactor.N2O !== null && customEmissionFactor.N2O !== undefined) {
        gwpValues.N2O_gwp = await getLatestGWPValue('N2O');
      }
    }

    return gwpValues;
  } catch (error) {
    console.error('Error getting custom GWP values:', error);
    return {
      CO2_gwp: 0,
      CH4_gwp: 0,
      N2O_gwp: 0,
      gwpLastUpdated: new Date()
    };
  }
}

// Helper function to get GWP values for EmissionFactorHub
exports.getEmissionFactorHubGWP= async(emissionFactorHubData, hubGwpData = null) =>{
  try {
    let gwpValue = 0;
    let gwpSearchField = null;

    // If specific GWP data is provided in request, use it
    if (hubGwpData && hubGwpData.chemicalName) {
      gwpValue = await getLatestGWPValue(hubGwpData.chemicalName);
      gwpSearchField = 'chemicalName';
    } else if (hubGwpData && hubGwpData.searchTerm) {
      gwpValue = await getLatestGWPValue(hubGwpData.searchTerm);
      gwpSearchField = 'searchTerm';
    } else {
      // Default behavior - try to get GWP from different fields in EmissionFactorHub data
      const searchFields = [
        { value: emissionFactorHubData.factorName, field: 'factorName' },
        { value: emissionFactorHubData.category, field: 'category' },
        { value: emissionFactorHubData.subcategory, field: 'subcategory' },
        { value: emissionFactorHubData.unit, field: 'unit' }
      ];

      for (const fieldData of searchFields) {
        if (fieldData.value && gwpValue === 0) {
          const tempGWP = await getLatestGWPValue(fieldData.value);
          if (tempGWP > 0) {
            gwpValue = tempGWP;
            gwpSearchField = fieldData.field;
            break;
          }
        }
      }
    }

    return {
      gwpValue,
      gwpSearchField,
      gwpLastUpdated: new Date()
    };
  } catch (error) {
    console.error('Error getting EmissionFactorHub GWP:', error);
    return {
      gwpValue: 0,
      gwpSearchField: null,
      gwpLastUpdated: new Date()
    };
  }
}

// Main function to enhance scope with GWP values (updated for new model structure)
exports.enhanceScopeWithGWP =async (scope, gwpData = null) => {
  try {
    const emissionFactor = scope.emissionFactor;
    
    if (!emissionFactor || emissionFactor === '' || emissionFactor === 'Country') {
      return scope; // No GWP processing needed
    }

    switch (emissionFactor) {
      case 'DEFRA':
        if (scope.emissionFactorValues?.defraData?.ghgUnits) {
          scope.emissionFactorValues.defraData.ghgUnits = await enhanceDefraGhgUnits(
            scope.emissionFactorValues.defraData.ghgUnits
          );
        }
        break;

      case 'IPCC':
        if (scope.emissionFactorValues?.ipccData) {
          const ipccData = scope.emissionFactorValues.ipccData;
          let gwpValue = 0;
          let gwpSearchField = null;

          // Use level2 for GWP matching (as per your requirement)
          if (ipccData.level2) {
            gwpValue = await getLatestGWPValue(ipccData.level2);
            gwpSearchField = 'level2';
          }
          // Fallback to unit
          if (gwpValue === 0 && ipccData.unit) {
            gwpValue = await getLatestGWPValue(ipccData.unit);
            gwpSearchField = 'unit';
          }

          scope.emissionFactorValues.ipccData.gwpValue = gwpValue;
          scope.emissionFactorValues.ipccData.gwpSearchField = gwpSearchField;
          scope.emissionFactorValues.ipccData.gwpLastUpdated = new Date();
        }
        break;

      case 'EPA':
        if (scope.emissionFactorValues?.epaData?.ghgUnitsEPA) {
          scope.emissionFactorValues.epaData.ghgUnitsEPA = await enhanceEpaGhgUnits(
            scope.emissionFactorValues.epaData.ghgUnitsEPA
          );
        }
        break;

      case 'Custom':
        if (scope.emissionFactorValues?.customEmissionFactor) {
          const customGWP = await getCustomGWPValues(
            scope.emissionFactorValues.customEmissionFactor,
            gwpData?.customGwpData || null
          );
          
          scope.emissionFactorValues.customEmissionFactor.CO2_gwp = customGWP.CO2_gwp;
          scope.emissionFactorValues.customEmissionFactor.CH4_gwp = customGWP.CH4_gwp;
          scope.emissionFactorValues.customEmissionFactor.N2O_gwp = customGWP.N2O_gwp;
          scope.emissionFactorValues.customEmissionFactor.gwpLastUpdated = customGWP.gwpLastUpdated;
        }
        break;

      case 'EmissionFactorHub':
        if (scope.emissionFactorValues?.emissionFactorHubData) {
          const hubGWP = await getEmissionFactorHubGWP(
            scope.emissionFactorValues.emissionFactorHubData,
            gwpData?.hubGwpData || null
          );
          
          scope.emissionFactorValues.emissionFactorHubData.gwpValue = hubGWP.gwpValue;
          scope.emissionFactorValues.emissionFactorHubData.gwpSearchField = hubGWP.gwpSearchField;
          scope.emissionFactorValues.emissionFactorHubData.gwpLastUpdated = hubGWP.gwpLastUpdated;
        }
        break;

      default:
        console.log(`No GWP processing for emission factor: ${emissionFactor}`);
    }

    return scope;
  } catch (error) {
    console.error('Error enhancing scope with GWP:', error);
    return scope;
  }
}

// Helper function to process GWP data from request body
exports.extractGwpDataFromRequest=async(requestData) => {
  const gwpData = {};
  
  // Extract custom GWP data
  if (requestData.customGwpData) {
    gwpData.customGwpData = requestData.customGwpData;
  }
  
  // Extract emission factor hub GWP data
  if (requestData.hubGwpData) {
    gwpData.hubGwpData = requestData.hubGwpData;
  }
  
  // Extract from nested structure if present
  if (requestData.gwpData) {
    Object.assign(gwpData, requestData.gwpData);
  }
  
  return Object.keys(gwpData).length > 0 ? gwpData : null;
}