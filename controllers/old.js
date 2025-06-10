// controllers/CalculateEmissionCO2eController.js
const moment    = require("moment");
const csvtojson = require("csvtojson");
const CalculateEmissionCO2e = require("../models/CalculateEmissionCO2e");
const Flowchart             = require("../models/Flowchart");
const FuelCombustion        = require("../models/FuelCombustion");
const EmissionFactor        = require("../models/EmissionFactor");
const emissionFactor2 = require("../models/countryEmissionFactorModel");
const emissionFactor3 = require("../models/EmissionFactorScope3");

const User      = require("../models/User");
const DataEntry = require("../models/DataEntry")


// Normalize common unit variants to DB conventions
function normalizeUnit(u) {
  if (!u || typeof u !== 'string') return 'other';

  const low = u.trim().toLowerCase();

  // special handling for kWh (+ net/gross CV)
  const kwhMatch = low.match(/^kwh(?:\s*\((net|gross)\s*cv\))?$/);
  if (kwhMatch) {
    return kwhMatch[1]
      ? `kwh_${kwhMatch[1]}_cv`   // "kwh_net_cv" or "kwh_gross_cv"
      : 'kwh';                   // "kwh"
  }

  // map of all other accepted variants → normalized value
  const unitMap = {
    // currencies
    dollar:      'usd', dollars:   'usd', usd:       'usd', '$':        'usd',
    rupee:       'inr', rupees:    'inr', inr:       'inr', '₹':        'inr',
    dirham:      'aed', dirhams:   'aed', aed:       'aed', dh:         'aed',
    riyal:       'sar', riyals:    'sar', sar:       'sar', sr:         'sar',
    dinar:       'kwd', dinars:    'kwd', kwd:       'kwd', bhd:        'kwd', jod: 'kwd',
    'singapore dollar': 'sgd', 'singapore dollars':'sgd', sgd:'sgd','s$':'sgd',
    ringgit:     'myr','malaysian ringgit':'myr', myr:'myr','rm':'myr',

    // counts
    number:      'count', count:'count', pieces:'count',

    // mass
    tonnes:      'tonne', tons:'tonne', tonne:'tonne', ton:'tonne',
    kg:          'kg', kilogram:'kg', kilograms:'kg',

    // volume
    l:           'l', litre:'l', litres:'l', liter:'l', liters:'l', ltr:'l',
    gallon:      'gal', gallons:'gal', gal:'gal',
    cubic_meter: 'm3', m3:'m3', 'm³':'m3',

    // length/area
    km:          'km', kilometer:'km', kilometers:'km',
    mile:        'mile', miles:'mile',
    square_meter:'m2', m2:'m2', 'm²':'m2',

    // energy
    mwh:         'mwh', 'mwh':'mwh',

    // time
    hour:        'h', hours:'h', hr:'h', hrs:'h',

    // specialized
    'passenger-km':'pkm', pkm:'pkm',
    'tonne-km':'tkm', tkm:'tkm'
  };

  return unitMap[low] || 'other';
}

// Compute emissions given override {standards, activity, fuel, unit}
async function computeEmissions(
  qty,
  assessmentType,
  uncQty = 0,
  uncFac = 0,
  override
) {
  let { standards, activity, fuel, unit } = override;
  if (!standards||!activity||!fuel||!unit)
    throw new Error("Override must include standards, activity, fuel, unit");

  unit = normalizeUnit(unit);
  const adjusted = qty * (1 + uncQty/100);
  const applyUnc = f => f * (1 + uncFac/100);

  if (standards === "IPCC") {
    const doc = await FuelCombustion.findOne({ activity, fuel });
    if (!doc) throw new Error("No IPCC data for this activity/fuel");
    const asmt = doc.assessments.find(a=>a.assessmentType===assessmentType);
    if (!asmt) throw new Error(`IPCC assessment "${assessmentType}" not found`);
    return {
      emissionCO2:  adjusted * applyUnc(asmt.CO2_KgL),
      emissionCH4:  adjusted * applyUnc(asmt.CH4_KgL),
      emissionN2O:  adjusted * applyUnc(asmt.N2O_KgL),
      emissionCO2e: adjusted * applyUnc(asmt.CO2e_KgL)
    };
  }

  if (standards === "DEFRA") {
    const doc = await EmissionFactor.findOne({ "activities.name": activity });
    if (!doc) throw new Error("No DEFRA data for this activity");
    const fuelObj = doc.activities
      .find(a=>a.name===activity)
      ?.fuels.find(f=>f.name===fuel);
    if (!fuelObj) throw new Error("Fuel not found in DEFRA data");

    const unitObj = fuelObj.units.find(u=>
      u.type.trim().toLowerCase() === unit.trim().toLowerCase()
    );
    if (!unitObj) {
      const avail = fuelObj.units.map(u=>u.type).join(", ");
      throw new Error(`Unit "${unit}" not in DEFRA data (available: ${avail})`);
    }
    return {
      emissionCO2:  adjusted * applyUnc(unitObj.kgCO2),
      emissionCH4:  adjusted * applyUnc(unitObj.kgCH4),
      emissionN2O:  adjusted * applyUnc(unitObj.kgN2O),
      emissionCO2e: adjusted * applyUnc(unitObj.kgCO2e)
    };
  }

  throw new Error("Unsupported standard: must be IPCC or DEFRA");
}

exports.calculateAndSaveEmission = async (req, res) => {
  try {
    const {
      periodOfDate,
      startDate,
      assessmentType,
      uncertaintyLevelConsumedData = 0,
      uncertaintyLevelEmissionFactor = 0,
      userId,
      nodeId,
      scopeIndex,
      comments = "",
      fuelSupplier = ""
    } = req.body;

    // 1. load flowchart
    const flowchart = await Flowchart.findOne({ userId });
    if (!flowchart) {
      return res.status(400).json({ message: "No flowchart for this user." });
    }
    //find the specific node and its API flag
   const nodeConfig = flowchart.nodes.find(n => n.id === nodeId);
   if (!nodeConfig) {
     return res.status(400).json({ message: `Node ${nodeId} not in flowchart.` });
   }
   
    // 2. collect rawData & totalQty
    let rawData = [], totalQty = 0;

     
    // CSV branch (file field must be named "document")
    if (req.file) {
      if (!nodeId) {
        return res.status(400).json({ message: "nodeId is required for CSV" });
      }
      const rows = await csvtojson().fromFile(req.file.path);
      for (const { date, quantity } of rows) {
        if (!date || !quantity) {
          return res.status(400).json({
            message: "CSV must have columns: date, quantity"
          });
        }
        const qty  = parseFloat(quantity);
        const node = flowchart.nodes.find(n=>n.id===nodeId);
        if (!node) {
          return res.status(400).json({ message:`No node ${nodeId}` });
        }
        totalQty += qty;
        rawData.push({
          nodeId,
          quantity:  qty,
          timestamp: moment(date,"DD/MM/YYYY").toDate(),
          inputType: node.details.inputType,
          scopeIndex: scopeIndex!=null ? +scopeIndex : undefined
        });
      }
    }

    // Manual/API/MQTT branch
    if (req.body.consumedData) {
      if (!nodeId) {
        return res.status(400).json({
          message: "nodeId is required for manual/API entries"
        });
      }
      const qty  = parseFloat(req.body.consumedData);
      const node = flowchart.nodes.find(n=>n.id===nodeId);
      if (!node) {
        return res.status(400).json({ message:`No node ${nodeId}` });
      }
      totalQty += qty;
      rawData.push({
        nodeId,
        quantity:  qty,
        timestamp: new Date(),
        inputType: node.details.inputType,
        scopeIndex: scopeIndex!=null ? +scopeIndex : undefined
      });
    }

    if (!rawData.length) {
      return res.status(400).json({
        message: "Provide a CSV file or consumedData in body."
      });
    }

    // 3. compute emissions per entry & sum
    let sumCO2=0, sumCH4=0, sumN2O=0, sumCO2e=0, metadataStandard=null;
    for (const entry of rawData) {
      const node   = flowchart.nodes.find(n=>n.id===entry.nodeId);
      const scopes = node.details.scopeDetails;
      if (!scopes?.length) {
        return res.status(400).json({
          message:`Node ${entry.nodeId} has no scopeDetails`
        });
      }
      let idx = entry.scopeIndex;
      if (scopes.length===1) idx=0;
      else if (idx==null||idx<0||idx>=scopes.length) {
        return res.status(400).json({
          message:
            `Node ${entry.nodeId} has ${scopes.length} scopes; `+
            `specify scopeIndex (0–${scopes.length-1})`
        });
      }
      const d = scopes[idx];
      const override = {
        standards: d.emissionFactor,
        activity:  d.activity,
        fuel:      d.fuel,
        unit:      d.units
      };

      const { emissionCO2, emissionCH4, emissionN2O, emissionCO2e } =
        await computeEmissions(
          entry.quantity,
          assessmentType,
          uncertaintyLevelConsumedData,
          uncertaintyLevelEmissionFactor,
          override
        );

      Object.assign(entry, { emissionCO2, emissionCH4, emissionN2O, emissionCO2e });

      sumCO2  += emissionCO2;
      sumCH4  += emissionCH4;
      sumN2O  += emissionN2O;
      sumCO2e += emissionCO2e;

      if (metadataStandard===null) metadataStandard = d.emissionFactor;
    }

    // 4. compute endDate
    const m = moment(startDate,"DD/MM/YYYY");
    let endDate;
    switch(periodOfDate) {
      case "daily":    endDate = m.clone().add(1,"day"  ).format("DD/MM/YYYY"); break;
      case "weekly":   endDate = m.clone().add(1,"week" ).format("DD/MM/YYYY"); break;
      case "monthly":  endDate = m.clone().add(1,"month").format("DD/MM/YYYY"); break;
      case "3-months": endDate = m.clone().add(3,"months").format("DD/MM/YYYY");break;
      case "yearly":   endDate = m.clone().add(1,"year" ).format("DD/MM/YYYY"); break;
      default:
        return res.status(400).json({
          message:
            "Invalid periodOfDate. Use 'daily','weekly','monthly','3-months','yearly'."
        });
    }

    // 5. pick just the one node + its edges
    const selectedNode = flowchart.nodes.find(n=>n.id===nodeId);
    const connectedEdges = flowchart.edges.filter(e=>
      e.source===nodeId || e.target===nodeId
    );

    // 6. save
    const newCalc = new CalculateEmissionCO2e({
      siteId: nodeId,
      periodOfDate,
      startDate,
      endDate,
      consumedData: totalQty,
      assessmentType,
      uncertaintyLevelConsumedData,
      uncertaintyLevelEmissionFactor,
      emissionCO2: sumCO2,
      emissionCH4: sumCH4,
      emissionN2O: sumN2O,
      emissionCO2e: sumCO2e,
      standards: metadataStandard,
      userId,
      comments,
      fuelSupplier,
      documents: req.file ? req.file.path : "",
      rawData,
      flowchartNodes: [ selectedNode ],
      flowchartEdges: connectedEdges
    });

    await newCalc.save();
    if (flowchart.apiStatus) {
           await DataEntry.deleteMany({
             companyName: user.companyName,
             date: { $gte: startOfDay, $lte: endOfDay }
           });
         }
    return res.status(201).json({ message:"Calculation saved.", data:newCalc });
  }
  catch(err) {
    console.error(err);
    return res.status(500).json({
      message:"Error processing emissions.",
      error:  err.message
    });
  }
};
