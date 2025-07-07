// Create a new file: utils/emissionFactorHelpers.js

const DefraData = require('../models/EmissionFactor/DefraData');
const IPCCData = require('../models/EmissionFactor/IPCCData');
const EPAData = require('../models/EmissionFactor/EPAData');

/**
 * Fetch DEFRA emission factor data
 * @param {Object} params - Selection parameters
 * @returns {Object} Processed DEFRA data with sorted units
 */
const fetchDEFRAEmissionFactor = async (params) => {
  try {
    const { scope, level1, level2, level3, level4, columnText, uom } = params;
    
    // Find all matching DEFRA records with different ghgUnits
    const defraRecords = await DefraData.find({
      scope,
      level1,
      level2: level2 || '',
      level3: level3 || '',
      level4: level4 || '',
      columnText: columnText || '',
      uom
    });
    
    if (!defraRecords || defraRecords.length === 0) {
      throw new Error('No DEFRA data found for the selected parameters');
    }
    
    // Extract and sort all unique ghgUnits
    const ghgUnitsMap = new Map();
    defraRecords.forEach(record => {
      if (!ghgUnitsMap.has(record.ghgUnit)) {
        ghgUnitsMap.set(record.ghgUnit, {
          unit: record.ghgUnit,
          conversionFactor: record.ghgConversionFactor
        });
      }
    });
    
    // Sort ghgUnits alphabetically
    const sortedGhgUnits = Array.from(ghgUnitsMap.values())
      .sort((a, b) => a.unit.localeCompare(b.unit));
    
    // Get the primary conversion factor (first record or specific selection)
    const primaryRecord = defraRecords[0];
    
    return {
      defraData: {
        scope,
        level1,
        level2: level2 || '',
        level3: level3 || '',
        level4: level4 || '',
        columnText: columnText || '',
        uom,
        ghgUnits: sortedGhgUnits,
        selectedGhgUnit: primaryRecord.ghgUnit,
        ghgConversionFactor: primaryRecord.ghgConversionFactor
      },
      dataSource: 'DEFRA'
    };
  } catch (error) {
    throw new Error(`DEFRA fetch error: ${error.message}`);
  }
};

/**
 * Fetch IPCC emission factor data
 * @param {Object} params - Selection parameters
 * @returns {Object} Processed IPCC data
 */
const fetchIPCCEmissionFactor = async (params) => {
  try {
    const { level1, level2, level3, cpool, typeOfParameter, unit } = params;
    
    // Find the matching IPCC record
    const ipccRecord = await IPCCData.findOne({
      level1: level1 || '',
      level2: level2 || '',
      level3: level3 || '',
      Cpool: cpool || '',
      TypeOfParameter: typeOfParameter || '',
      Unit: unit || ''
    });
    
    if (!ipccRecord) {
      throw new Error('No IPCC data found for the selected parameters');
    }
    
    // Sort by hierarchy: Level 1 -> Level 2 -> Level 3 -> Cpool -> TypeOfParameter -> Unit -> Value
    return {
      ipccData: {
        level1: ipccRecord.level1,
        level2: ipccRecord.level2,
        level3: ipccRecord.level3,
        cpool: ipccRecord.Cpool,
        typeOfParameter: ipccRecord.TypeOfParameter,
        unit: ipccRecord.Unit,
        value: ipccRecord.Value,
        description: ipccRecord.Description || ''
      },
      dataSource: 'IPCC'
    };
  } catch (error) {
    throw new Error(`IPCC fetch error: ${error.message}`);
  }
};

/**
 * Fetch EPA emission factor data
 * @param {Object} params - Selection parameters
 * @returns {Object} Processed EPA data with sorted units
 */
const fetchEPAEmissionFactor = async (params) => {
  try {
    const { scopeEPA, level1EPA, level2EPA, level3EPA, level4EPA, columnTextEPA, uomEPA } = params;
    
    // Find all matching EPA records with different ghgUnitsEPA
    const epaRecords = await EPAData.find({
      scopeEPA,
      level1EPA,
      level2EPA: level2EPA || '',
      level3EPA: level3EPA || '',
      level4EPA: level4EPA || '',
      columnTextEPA: columnTextEPA || '',
      uomEPA
    });
    
    if (!epaRecords || epaRecords.length === 0) {
      throw new Error('No EPA data found for the selected parameters');
    }
    
    // Extract and sort all unique ghgUnitsEPA
    const ghgUnitsMap = new Map();
    epaRecords.forEach(record => {
      if (!ghgUnitsMap.has(record.ghgUnitEPA)) {
        ghgUnitsMap.set(record.ghgUnitEPA, {
          unit: record.ghgUnitEPA,
          conversionFactor: record.ghgConversionFactorEPA
        });
      }
    });
    
    // Sort ghgUnitsEPA alphabetically
    const sortedGhgUnitsEPA = Array.from(ghgUnitsMap.values())
      .sort((a, b) => a.unit.localeCompare(b.unit));
    
    // Get the primary conversion factor
    const primaryRecord = epaRecords[0];
    
    return {
      epaData: {
        scopeEPA,
        level1EPA,
        level2EPA: level2EPA || '',
        level3EPA: level3EPA || '',
        level4EPA: level4EPA || '',
        columnTextEPA: columnTextEPA || '',
        uomEPA,
        ghgUnitsEPA: sortedGhgUnitsEPA,
        selectedGhgUnitEPA: primaryRecord.ghgUnitEPA,
        ghgConversionFactorEPA: primaryRecord.ghgConversionFactorEPA
      },
      dataSource: 'EPA'
    };
  } catch (error) {
    throw new Error(`EPA fetch error: ${error.message}`);
  }
};

/**
 * Main function to fetch emission factor based on selected database
 * @param {String} database - Selected database ('DEFRA', 'IPCC', 'EPA')
 * @param {Object} params - Selection parameters specific to the database
 * @returns {Object} Emission factor values
 */
const fetchEmissionFactorValues = async (database, params) => {
  switch (database) {
    case 'DEFRA':
      return await fetchDEFRAEmissionFactor(params);
    case 'IPCC':
      return await fetchIPCCEmissionFactor(params);
    case 'EPA':
      return await fetchEPAEmissionFactor(params);
    default:
      throw new Error(`Unsupported emission factor database: ${database}`);
  }
};

module.exports = {
  fetchEmissionFactorValues,
  fetchDEFRAEmissionFactor,
  fetchIPCCEmissionFactor,
  fetchEPAEmissionFactor
};