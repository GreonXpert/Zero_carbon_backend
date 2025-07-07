const EPAData = require('../../models/EmissionFactor/EPAData');
const IPCCData = require('../../models/EmissionFactor/IPCCData');
const DefraData = require('../../models/EmissionFactor/DefraData');
// Make sure you create & export your CountryEmissionFactor model at models/EmissionFactor/CountryEmissionFactor.js
const CountryEF = require('../../models/EmissionFactor/contryEmissionFactorModel');

exports.getEmissionFactors = async (req, res) => {
  try {
    const {
      source,                  // EPA, IPCC, DEFRA, Country
      page = 1,
      limit = 50,
      sortBy = 'createdAt',    // field to sort by
      order = 'desc',          // asc or desc
      ...filters               // all other query params used for filtering
    } = req.query;

    const pgNum = Math.max(parseInt(page, 10), 1);
    const limNum = Math.max(parseInt(limit, 10), 1);
    const skip = (pgNum - 1) * limNum;
    const sortOrder = order === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    let Model;
    let query = {};

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

        // Build $match for top‐level country filters
        const match = {};                              // ← no ": any" here
        if (filters.C)              match.C              = new RegExp(filters.C, 'i');
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
              C:               { $first: '$C' },
              regionGrid:      { $first: '$regionGrid' },
              emissionFactor:  { $first: '$emissionFactor' },
              reference:       { $first: '$reference' },
              unit:            { $first: '$unit' },
              yearlyValues:    { $push: '$yearlyValues' },
              createdAt:       { $first: '$createdAt' }
            }
          },
          { $sort: sort },
          { $skip: skip },
          { $limit: limNum }
        ];
        break;


      default:
        return res.status(400).json({ success: false, error: 'Invalid source parameter' });
    }

    const total = await Model.countDocuments(query);
    const data = await Model.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limNum);

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page: pgNum,
        pages: Math.ceil(total / limNum),
        limit: limNum
      }
    });
  } catch (err) {
    console.error(err);
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
          'C','regionGrid','emissionFactor',
          'reference','unit','yearlyValues', 
          'yearlyValues.from', 'yearlyValues.to'
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
      if (key === 'yearlyValues') {
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
      if (key === 'yearlyValues.from' || key === 'yearlyValues.to') {
        const path = key.split('.')[1]; // "from" or "to"
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
    const values = await Model.distinct(key);
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