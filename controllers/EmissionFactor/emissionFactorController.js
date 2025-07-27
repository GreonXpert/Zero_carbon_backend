const EPAData = require('../../models/EmissionFactor/EPAData');
const IPCCData = require('../../models/EmissionFactor/IPCCData');
const DefraData = require('../../models/EmissionFactor/DefraData');
// Make sure you create & export your CountryEmissionFactor model at models/EmissionFactor/CountryEmissionFactor.js
const CountryEF = require('../../models/EmissionFactor/contryEmissionFactorModel');
const GWP  =require('../../models/GWP');

// Enhanced helper function with better matching and fallback options
async function getLatestGWPValue(chemicalUnit) {
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
async function enhanceDataWithGWP(data, source) {
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
          
          case 'emissionFactorHub':
          // Use 'itemName' or 'unit' as the best guess
          if (itemObj.itemName) {
            gwpValue = await getLatestGWPValue(itemObj.itemName);
            gwpSearchField = 'itemName';
          }

          if (gwpValue === 0 && itemObj.unit) {
            gwpValue = await getLatestGWPValue(itemObj.unit);
            gwpSearchField = 'unit';
          }

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

exports.getEmissionFactors = async (req, res) => {
  try {
    const {
      source,                  // EPA, IPCC, DEFRA, Country
      page = 1,
      limit = 50,
      sortBy = 'createdAt',    // field to sort by
      order = 'desc',          // asc or desc
      includeGWP = 'true',     // New parameter to control GWP inclusion
      ...filters               // all other query params used for filtering
    } = req.query;

    const pgNum = Math.max(parseInt(page, 10), 1);
    const limNum = Math.max(parseInt(limit, 10), 1);
    const skip = (pgNum - 1) * limNum;
    const sortOrder = order === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };
    const shouldIncludeGWP = includeGWP === 'true';

    let Model;
    let query = {};
    let useAggregate = false;
    let pipeline = [];

    switch (source) {
      case 'EPA':
        Model = EPAData;
        // Scope & levels filters
        if (filters.scopeEPA)    query.scopeEPA    = filters.scopeEPA;
        if (filters.level1EPA)   query.level1EPA   = new RegExp(filters.level1EPA, 'i');
        if (filters.level2EPA)   query.level2EPA   = new RegExp(filters.level2EPA, 'i');
        if (filters.level3EPA)   query.level3EPA   = new RegExp(filters.level3EPA, 'i');
        if (filters.level4EPA)   query.level4EPA   = new RegExp(filters.level4EPA, 'i');
        if (filters.columnTextEPA) query.columnTextEPA = new RegExp(filters.columnTextEPA, 'i');
        if (filters.uomEPA)      query.uomEPA      = new RegExp(filters.uomEPA, 'i');
        if (filters.ghgUnitEPA)  query.ghgUnitEPA  = filters.ghgUnitEPA;
        break;

      case 'IPCC':
        Model = IPCCData;
        if (filters.level1)  query.level1    = new RegExp(filters.level1, 'i');
        if (filters.level2)  query.level2    = new RegExp(filters.level2, 'i');
        if (filters.level3)  query.level3    = new RegExp(filters.level3, 'i');
        if (filters.Cpool)   query.Cpool     = new RegExp(filters.Cpool, 'i');
        if (filters.TypeOfParameter) query.TypeOfParameter = new RegExp(filters.TypeOfParameter, 'i');
        if (filters.Unit)    query.Unit      = new RegExp(filters.Unit, 'i');
        break;

      case 'DEFRA':
        Model = DefraData;
        if (filters.scope)    query.scope    = filters.scope;
        if (filters.level1)   query.level1   = new RegExp(filters.level1, 'i');
        if (filters.level2)   query.level2   = new RegExp(filters.level2, 'i');
        if (filters.level3)   query.level3   = new RegExp(filters.level3, 'i');
        if (filters.level4)   query.level4   = new RegExp(filters.level4, 'i');
        if (filters.columnText) query.columnText = new RegExp(filters.columnText, 'i');
        if (filters.uom)      query.uom      = new RegExp(filters.uom, 'i');
        if (filters.ghgUnit)  query.ghgUnit  = filters.ghgUnit;
        break;

      case 'Country':
        Model = CountryEF;
        useAggregate = true;

        // Build $match for top‐level country filters (using correct field names from DB)
        const match = {};
        if (filters.country)        match.country        = new RegExp(filters.country, 'i');
        if (filters.C)              match.country        = new RegExp(filters.C, 'i'); // Support both C and country
        if (filters.regionGrid)     match.regionGrid     = new RegExp(filters.regionGrid, 'i');
        if (filters.emissionFactor) match.emissionFactor = new RegExp(filters.emissionFactor, 'i');
        if (filters.reference)      match.reference      = new RegExp(filters.reference, 'i');
        if (filters.unit)           match.unit           = new RegExp(filters.unit, 'i');

        const from = filters['yearlyValues.from'];
        const to   = filters['yearlyValues.to'];

        pipeline = [
          { $match: match },
          { $unwind: '$yearlyValues' },
          { $match: {
              ...(from ? { 'yearlyValues.from': from } : {}),
              ...(to   ? { 'yearlyValues.to':   to   } : {})
            }
          },
          { $group: {
              _id: '$_id',
              country:         { $first: '$country' },
              regionGrid:      { $first: '$regionGrid' },
              emissionFactor:  { $first: '$emissionFactor' },
              reference:       { $first: '$reference' },
              unit:            { $first: '$unit' },
              yearlyValues:    { $push: '$yearlyValues' },
              createdAt:       { $first: '$createdAt' },
              updatedAt:       { $first: '$updatedAt' }
            }
          },
          { $sort: sort },
          { $skip: skip },
          { $limit: limNum }
        ];
        break;
      
      case 'emissionFactorHub':
  Model = require('../../models/EmissionFactor/EmissionFactorHub');
   if (filters.scope)    query.scope    = new RegExp(filters.scope, 'i');
  if (filters.category)    query.category    = new RegExp(filters.category, 'i');
  if (filters.activity)    query.activity    = new RegExp(filters.activity, 'i');
  if (filters.itemName)    query.itemName    = new RegExp(filters.itemName, 'i');
  if (filters.unit)        query.unit        = filters.unit.toLowerCase();
  if (filters.region)      query.region      = new RegExp(filters.region, 'i');
  if (filters.source)      query.source      = new RegExp(filters.source, 'i');
  if (filters.reference)   query.reference   = new RegExp(filters.reference, 'i');
  if (filters.year)        query.year        = parseInt(filters.year);

  // Handle numeric range filters
  if (filters.minCo2e || filters.maxCo2e) {
    query.Co2e = {};
    if (filters.minCo2e) query.Co2e.$gte = parseFloat(filters.minCo2e);
    if (filters.maxCo2e) query.Co2e.$lte = parseFloat(filters.maxCo2e);
  }
  break;

      default:
        return res.status(400).json({ success: false, error: 'Invalid source parameter' });
    }

    let data;
    let total;

    if (useAggregate) {
      // For Country data using aggregation
      const totalPipeline = [...pipeline];
      // Remove skip and limit for total count
      const countPipeline = totalPipeline.slice(0, -3); // Remove sort, skip, limit
      countPipeline.push({ $count: "total" });
      
      const totalResult = await Model.aggregate(countPipeline);
      total = totalResult.length > 0 ? totalResult[0].total : 0;
      
      data = await Model.aggregate(pipeline);
    } else {
      // For other sources using regular find
      total = await Model.countDocuments(query);
      data = await Model.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limNum);
    }

    // Enhance data with GWP values if requested
    let enhancedData = data;
    if (shouldIncludeGWP && data.length > 0) {
      try {
        enhancedData = await enhanceDataWithGWP(data, source);
        console.log(`Enhanced ${enhancedData.length} records with GWP values for source: ${source}`);
      } catch (error) {
        console.error('Error enhancing data with GWP values:', error);
        // Continue with original data if GWP enhancement fails
        enhancedData = data;
      }
    }

    return res.status(200).json({
      success: true,
      data: enhancedData,
      pagination: {
        total,
        page: pgNum,
        pages: Math.ceil(total / limNum),
        limit: limNum
      },
      gwpInfo: shouldIncludeGWP ? {
        included: true,
        lastUpdated: new Date().toISOString(),
        note: "GWP values are fetched from the latest available AR assessment (AR6 currently, AR7 when available)",
        searchStrategy: {
          EPA: "Primary: level3EPA, Fallback: ghgUnitEPA, level2EPA",
          IPCC: "Primary: level2, Fallback: Unit, level3",
          DEFRA: "Primary: ghgUnit",
          Country: "No GWP values - Country emission factors don't require GWP",
          emissionFactorHub: "Primary: categoryName, Fallback: CO2e"
        }
      } : {
        included: false
      }
    });
  } catch (err) {
    console.error('Error in getEmissionFactors:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};


/**
 * GET /api/emission-factors/distinct?source=EPA&key=level1EPA
 * Returns all distinct values for `key` in the chosen `source`.
 */
exports.getDistinctValues = async (req, res) => {
  try {
    const { source, key } = req.query;
    if (!source || !key) {
      return res.status(400).json({ success: false, error: 'Must provide both source and key' });
    }

    let Model;
    let allowedKeys = [];
    let fieldKey = key;

    switch (source) {
      case 'EPA':
        Model = EPAData;
        allowedKeys = [
          'scopeEPA','level1EPA','level2EPA','level3EPA','level4EPA',
          'columnTextEPA','uomEPA','ghgUnitEPA', 'ghgConversionFactorEPA',
        ];
        break;

      case 'IPCC':
        Model = IPCCData;
        allowedKeys = [
          'level1','level2','level3','Cpool',
          'TypeOfParameter','Unit','TechnologiesOrPractices', 'ParametersOrConditions',
          'RegionOrRegionalConditions','AbatementOrControlTechnologies', 'OtherProperties',
          'Equation', 'IPCCWorksheet', 'TechnicalReference', 'SourceOfData','DataProvider'
        ];
        break;

      case 'DEFRA':
        Model = DefraData;
        allowedKeys = [
          'scope','level1','level2','level3','level4',
          'columnText','uom','ghgUnit'
        ];
        break;

      case 'Country':
        Model = CountryEF;
        allowedKeys = [
          'C','country','regionGrid','emissionFactor',
          'reference','unit','yearlyValues', 
          'yearlyValues.from', 'yearlyValues.to'
        ];
        break;
      
      case 'emissionFactorHub':
      Model = require('../../models/EmissionFactor/EmissionFactorHub');
        allowedKeys = [
        'scope',
        'category', 'activity', 'itemName', 'unit', 
        'source', 'reference', 'year', 'region', 'notes'
        ];
        break;
      default:
        return res.status(400).json({ success: false, error: 'Invalid source parameter' });
    }

    if (!allowedKeys.includes(key)) {
      return res.status(400).json({ success: false, error: `Key "${key}" not allowed for source ${source}` });
    }
     // —— SPECIAL HANDLING FOR Country.yearlyValues —— 

    if (source === 'Country') {
      // 1) all {from,to} pairs
       if (key === 'C') {
        fieldKey = 'country';
      }

      if (fieldKey === 'yearlyValues') {
        const pairs = await Model.aggregate([
          { $unwind: '$yearlyValues' },
          { $group: { 
              _id: { from: '$yearlyValues.from', to: '$yearlyValues.to' } 
            } 
          },
          { $sort: { '_id.from': 1 } },
          { $project: { _id: 0, from: '$_id.from', to: '$_id.to' } }
        ]);
        return res.status(200).json({ success: true, key, values: pairs });
      }

      // 2) distinct "from" dates
      if (fieldKey === 'yearlyValues.from' || key === 'yearlyValues.to') {
        const path = fieldKey.split('.')[1]; // "from" or "to"
        const docs = await Model.aggregate([
          { $unwind: '$yearlyValues' },
          { $group: { _id: `$yearlyValues.${path}` } },
          { $sort: { '_id': 1 } },
          { $project: { _id: 0, value: '$_id' } }
        ]);
        const values = docs.map(d => d.value);
        return res.status(200).json({ success: true, key, values });
      }
    }

    // Fetch distinct values and sort alphabetically
    const values = await Model.distinct(fieldKey);
    //const values = await Model.distinct(fieldKey);
    values.sort((a, b) => {
      if (a == null) return 1;
      if (b == null) return -1;
      return a.toString().localeCompare(b.toString(), undefined, { sensitivity: 'base' });
    });

    return res.status(200).json({ success: true, key, values });
  } catch (err) {
    console.error('distinct error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};