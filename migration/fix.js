// /**
//  * Normalize a CSV row into the same shape your emission‐calculation logic expects.
//  */
// function processCSVData(rawValues, scopeConfig) {
//   const pd = {};

//   // Helper function to parse numbers from CSV strings
//   const parseNumber = (value) => {
//     const num = Number(value);
//     return isNaN(num) ? 0 : num;
//   };

//   // ───────── Scope 1 ─────────
//   if (scopeConfig.scopeType === 'Scope 1') {
//     // Combustion (Stationary/Mobile)
//     if (scopeConfig.categoryName.includes('Combustion')) {
//       pd.fuelConsumption = parseNumber(
//         rawValues.fuel_consumed ||
//         rawValues.consumption ||
//         rawValues.fuelConsumption ||
//         rawValues.fuel_consumption
//       );
//     }
//     // SF₆-specific fugitive (must come before generic fugitive)
//     else if (
//       scopeConfig.categoryName.includes('Fugitive') &&
//       /SF6/i.test(scopeConfig.activity)
//     ) {
//       pd.nameplateCapacity   = parseNumber(rawValues.nameplateCapacity || rawValues.nameplate_capacity);
//       pd.defaultLeakageRate  = parseNumber(rawValues.defaultLeakageRate || rawValues.default_leakage_rate);
//       pd.decreaseInventory   = parseNumber(rawValues.decreaseInventory || rawValues.decrease_inventory);
//       pd.acquisitions        = parseNumber(rawValues.acquisitions);
//       pd.disbursements       = parseNumber(rawValues.disbursements);
//       pd.netCapacityIncrease = parseNumber(rawValues.netCapacityIncrease || rawValues.net_capacity_increase);
//     }
//     // CH₄-Leaks fugitive
//     else if (
//       scopeConfig.categoryName.includes('Fugitive') &&
//       /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)
//     ) {
//       pd.activityData       = parseNumber(
//         rawValues.activityData ||
//         rawValues.activity_data
//       );
//       pd.numberOfComponents = parseNumber(
//         rawValues.numberOfComponents ||
//         rawValues.number_of_components
//       );
//     }
//     // Generic fugitive / refrigeration
//     else if (
//       scopeConfig.categoryName.includes('Fugitive') ||
//       /ref.*?geration/i.test(scopeConfig.activity)
//     ) {
//       pd.numberOfUnits     = parseNumber(rawValues.numberOfUnits || rawValues.number_of_units || rawValues.unit_count);
//       pd.leakageRate       = parseNumber(rawValues.leakageRate || rawValues.leakage_rate || rawValues.leakage) 
//                           || scopeConfig.emissionFactorValues?.customEmissionFactor?.leakageRate 
//                           || 0;
//       pd.installedCapacity = parseNumber(rawValues.installedCapacity || rawValues.installed_capacity);
//       pd.endYearCapacity   = parseNumber(rawValues.endYearCapacity || rawValues.end_year_capacity);
//       pd.purchases         = parseNumber(rawValues.purchases);
//       pd.disposals         = parseNumber(rawValues.disposals);
//     }
//     // Process Emission
//     else if (scopeConfig.categoryName.includes('Process Emission') || scopeConfig.categoryName.includes('Process Emissions')) {
//       // Tier 1
//       pd.productionOutput = parseNumber(
//         rawValues.productionOutput ||
//         rawValues.production_output
//       );
//       // Tier 2
//       pd.rawMaterialInput = parseNumber(
//         rawValues.rawMaterialInput ||
//         rawValues.raw_material_input
//       );
//     }
//   }

//   // ───────── Scope 2 ─────────
//   else if (scopeConfig.scopeType === 'Scope 2') {
//     const categoryFieldMap = {
//       'Purchased Electricity': 'consumed_electricity',
//       'Purchased Steam': 'consumed_steam',
//       'Purchased Heating': 'consumed_heating',
//       'Purchased Cooling': 'consumed_cooling'
//     };

//     const fieldKey = categoryFieldMap[scopeConfig.categoryName];
    
//     if (fieldKey === 'consumed_electricity') {
//       pd.consumed_electricity = parseNumber(
//         rawValues.consumed_electricity ||
//         rawValues.electricity ||
//         rawValues.power_consumption ||
//         rawValues.electricity_consumed
//       );
//     } else if (fieldKey === 'consumed_steam') {
//       pd.consumed_steam = parseNumber(
//         rawValues.consumed_steam ||
//         rawValues.steam ||
//         rawValues.steam_consumed
//       );
//     } else if (fieldKey === 'consumed_heating') {
//       pd.consumed_heating = parseNumber(
//         rawValues.consumed_heating ||
//         rawValues.heating ||
//         rawValues.heating_consumed
//       );
//     } else if (fieldKey === 'consumed_cooling') {
//       pd.consumed_cooling = parseNumber(
//         rawValues.consumed_cooling ||
//         rawValues.cooling ||
//         rawValues.cooling_consumed
//       );
//     }
//   }

//   // ───────── Scope 3 ─────────
//   else if (scopeConfig.scopeType === 'Scope 3') {
//     switch (scopeConfig.categoryName) {
//       // (1) Purchased Goods and Services
//       case 'Purchased Goods and Services':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.procurementSpend = parseNumber(
//             rawValues.procurementSpend ||
//             rawValues.procurement_spend
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.physicalQuantity = parseNumber(
//             rawValues.physicalQuantity ||
//             rawValues.physical_quantity
//           );
//         }
//         break;

//       // (2) Capital Goods
//       case 'Capital Goods':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.procurementSpend = parseNumber(
//             rawValues.procurementSpend ||
//             rawValues.procurement_spend ||
//             rawValues.capital_spend
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.assetQuantity = parseNumber(
//             rawValues.assetQuantity ||
//             rawValues.asset_quantity
//           );
//         }
//         break;

//       // (3) Fuel and Energy
//       case 'Fuel and energy':
//         pd.fuelConsumed = parseNumber(
//           rawValues.fuelConsumed ||
//           rawValues.fuel_consumed
//         );
//         pd.electricityConsumption = parseNumber(
//           rawValues.electricityConsumption ||
//           rawValues.electricity_consumption ||
//           rawValues.electricity_consumed
//         );
//         pd.tdLossFactor = parseNumber(
//           rawValues.tdLossFactor ||
//           rawValues.td_loss_factor ||
//           rawValues.td_losses
//         );
//         break;

//       // (4) Upstream Transport and Distribution
//       case 'Upstream Transport and Distribution':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.transportationSpend = parseNumber(
//             rawValues.transportationSpend ||
//             rawValues.transportation_spend ||
//             rawValues.transport_spend
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.mass = parseNumber(rawValues.mass || rawValues.weight);
//           pd.distance = parseNumber(rawValues.distance || rawValues.km);
//         }
//         break;

//       // (5) Waste Generated in Operation
//       case 'Waste Generated in Operation':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.wasteMass = parseNumber(
//             rawValues.wasteMass ||
//             rawValues.waste_mass ||
//             rawValues.mass_waste
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.wasteMass = parseNumber(
//             rawValues.wasteMass ||
//             rawValues.waste_mass
//           );
//           pd.treatmentType = rawValues.treatmentType || rawValues.treatment_type || '';
//         }
//         break;

//       // (6) Business Travel
//       case 'Business Travel':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.travelSpend = parseNumber(
//             rawValues.travelSpend ||
//             rawValues.travel_spend
//           );
//           pd.hotelNights = parseNumber(
//             rawValues.hotelNights ||
//             rawValues.hotel_nights
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.numberOfPassengers = parseNumber(
//             rawValues.numberOfPassengers ||
//             rawValues.number_of_passengers ||
//             rawValues.passengers
//           );
//           pd.distanceTravelled = parseNumber(
//             rawValues.distanceTravelled ||
//             rawValues.distance_travelled ||
//             rawValues.distance
//           );
//           pd.hotelNights = parseNumber(
//             rawValues.hotelNights ||
//             rawValues.hotel_nights
//           );
//         }
//         break;

//       // (7) Employee Commuting
//       case 'Employee Commuting':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.employeeCount = parseNumber(
//             rawValues.employeeCount ||
//             rawValues.employee_count ||
//             rawValues.employee_Count
//           );
//           pd.averageCommuteDistance = parseNumber(
//             rawValues.averageCommuteDistance ||
//             rawValues.average_commute_distance ||
//             rawValues.average_Commuting_Distance
//           );
//           pd.workingDays = parseNumber(
//             rawValues.workingDays ||
//             rawValues.working_days ||
//             rawValues.working_Days
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.note = 'Tier 2 calculation in progress';
//         }
//         break;

//       // (8) Upstream Leased Assets
//       case 'Upstream Leased Assets':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.leasedArea = parseNumber(
//             rawValues.leasedArea ||
//             rawValues.leased_area ||
//             rawValues.leased_Area
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.leasedArea = parseNumber(
//             rawValues.leasedArea ||
//             rawValues.leased_area ||
//             rawValues.leased_Area
//           );
//           pd.totalArea = parseNumber(
//             rawValues.totalArea ||
//             rawValues.total_area ||
//             rawValues.total_Area
//           );
//           pd.energyConsumption = parseNumber(
//             rawValues.energyConsumption ||
//             rawValues.energy_consumption ||
//             rawValues.energy_Consumption
//           );
//           pd.BuildingTotalS1_S2 = parseNumber(
//             rawValues.BuildingTotalS1_S2 ||
//             rawValues.buildingTotalS1S2 ||
//             rawValues.building_total_s1_s2
//           );
//         }
//         break;

//       // (9) Downstream Transport and Distribution
//       case 'Downstream Transport and Distribution':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.transportSpend = parseNumber(
//             rawValues.transportSpend ||
//             rawValues.transport_spend ||
//             rawValues.transport_Spend ||
//             rawValues.spendTransport
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.mass = parseNumber(
//             rawValues.mass ||
//             rawValues.transportMass ||
//             rawValues.transport_mass
//           );
//           pd.distance = parseNumber(
//             rawValues.distance ||
//             rawValues.transportDistance ||
//             rawValues.transport_distance
//           );
//         }
//         break;

//       // (10) Processing of Sold Products
//       case 'Processing of Sold Products':
//         pd.productQuantity = parseNumber(
//           rawValues.productQuantity ||
//           rawValues.product_quantity
//         );
//         if (scopeConfig.calculationModel === 'tier 2') {
//           pd.customerType = rawValues.customerType || rawValues.customer_type || '';
//         }
//         break;

//       // (11) Use of Sold Products
//       case 'Use of Sold Products':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.productQuantity = parseNumber(
//             rawValues.productQuantity ||
//             rawValues.product_quantity
//           );
//           pd.averageLifetimeEnergyConsumption = parseNumber(
//             rawValues.averageLifetimeEnergyConsumption ||
//             rawValues.average_lifetime_energy_consumption
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.productQuantity = parseNumber(
//             rawValues.productQuantity ||
//             rawValues.product_quantity
//           );
//           pd.usePattern = parseNumber(
//             rawValues.usePattern ||
//             rawValues.use_pattern
//           ) || 1;
//           pd.energyEfficiency = parseNumber(
//             rawValues.energyEfficiency ||
//             rawValues.energy_efficiency
//           );
//         }
//         break;

//       // (12) End-of-Life Treatment of Sold Products
//       case 'End-of-Life Treatment of Sold Products':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.massEol = parseNumber(
//             rawValues.massEol ||
//             rawValues.mass_eol
//           );
//           pd.toDisposal = parseNumber(
//             rawValues.toDisposal ||
//             rawValues.to_disposal
//           );
//           pd.toLandfill = parseNumber(
//             rawValues.toLandfill ||
//             rawValues.to_landfill
//           );
//           pd.toIncineration = parseNumber(
//             rawValues.toIncineration ||
//             rawValues.to_incineration
//           );
//         }
//         break;

//       // (13) Downstream Leased Assets
//       case 'Downstream Leased Assets':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.leasedArea = parseNumber(
//             rawValues.leasedArea ||
//             rawValues.leased_area ||
//             rawValues.leased_Area
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.leasedArea = parseNumber(
//             rawValues.leasedArea ||
//             rawValues.leased_area ||
//             rawValues.leased_Area
//           );
//           pd.totalArea = parseNumber(
//             rawValues.totalArea ||
//             rawValues.total_area ||
//             rawValues.total_Area
//           );
//           pd.energyConsumption = parseNumber(
//             rawValues.energyConsumption ||
//             rawValues.energy_consumption ||
//             rawValues.energy_Consumption
//           );
//           pd.BuildingTotalS1_S2 = parseNumber(
//             rawValues.BuildingTotalS1_S2 ||
//             rawValues.buildingTotalS1S2 ||
//             rawValues.building_total_s1_s2
//           );
//         }
//         break;

//       // (14) Franchises
//       case 'Franchises':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.franchiseCount = parseNumber(
//             rawValues.franchiseCount ||
//             rawValues.franchise_count ||
//             rawValues.noOfFranchises
//           );
//           pd.avgEmissionPerFranchise = parseNumber(
//             rawValues.avgEmissionPerFranchise ||
//             rawValues.avg_emission_per_franchise ||
//             rawValues.averageEmissionPerFranchise
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.franchiseTotalS1Emission = parseNumber(
//             rawValues.franchiseTotalS1Emission ||
//             rawValues.franchise_total_s1_emission ||
//             rawValues.totalS1Emission
//           );
//           pd.franchiseTotalS2Emission = parseNumber(
//             rawValues.franchiseTotalS2Emission ||
//             rawValues.franchise_total_s2_emission ||
//             rawValues.totalS2Emission
//           );
//           pd.energyConsumption = parseNumber(
//             rawValues.energyConsumption ||
//             rawValues.energy_consumption ||
//             rawValues.energy_Consumption
//           );
//         }
//         break;

//       // (15) Investments
//       case 'Investments':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.investeeRevenue = parseNumber(
//             rawValues.investeeRevenue ||
//             rawValues.investee_revenue
//           );
//           pd.equitySharePercentage = parseNumber(
//             rawValues.equitySharePercentage ||
//             rawValues.equity_share_percentage
//           );
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.investeeScope1Emission = parseNumber(
//             rawValues.investeeScope1Emission ||
//             rawValues.investee_scope1_emission ||
//             rawValues.scope1Emission
//           );
//           pd.investeeScope2Emission = parseNumber(
//             rawValues.investeeScope2Emission ||
//             rawValues.investee_scope2_emission ||
//             rawValues.scope2Emission
//           );
//           pd.equitySharePercentage = parseNumber(
//             rawValues.equitySharePercentage ||
//             rawValues.equity_share_percentage
//           );
//           pd.energyConsumption = parseNumber(
//             rawValues.energyConsumption ||
//             rawValues.energy_consumption
//           );
//         }
//         break;

//       default:
//         console.warn(`Unknown Scope 3 category: ${scopeConfig.categoryName}`);
//         break;
//     }
//   }

//   return pd;
// }



// /**
//  * Normalize a manual‐entry payload into the same shape your 
//  * emission‐calculation logic expects.
//  */
// function processManualData(rawValues, scopeConfig) {
//   const pd = {};

//   if (scopeConfig.scopeType === 'Scope 1') {
//     if (scopeConfig.categoryName.includes('Combustion')) {
//       pd.fuelConsumption = rawValues.fuel_consumed || rawValues.consumption || rawValues.fuelConsumption || 0;
//     } 
//     // SF₆‐specific fugitive (must come before generic fugitive)
//     else if (scopeConfig.categoryName.includes('Fugitive') && /SF6/i.test(scopeConfig.activity)) {
//       pd.nameplateCapacity   = rawValues.nameplateCapacity   ?? 0;
//       pd.defaultLeakageRate  = rawValues.defaultLeakageRate  ?? 0;
//       pd.decreaseInventory   = rawValues.decreaseInventory   ?? 0;
//       pd.acquisitions        = rawValues.acquisitions        ?? 0;
//       pd.disbursements       = rawValues.disbursements       ?? 0;
//       pd.netCapacityIncrease = rawValues.netCapacityIncrease ?? 0;
//     } 
//     // CH₄-Leaks fugitive
//     else if (scopeConfig.categoryName.includes('Fugitive') && /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)) {
//       pd.activityData       = rawValues.activityData       ?? rawValues.activity_data       ?? 0;
//       pd.numberOfComponents = rawValues.numberOfComponents ?? rawValues.number_of_components ?? 0;
//     } 
//     // Generic fugitive / refrigeration
//     else if (
//       scopeConfig.categoryName.includes('Fugitive') ||
//       /ref.*?geration/i.test(scopeConfig.activity)
//     ) {
//       pd.numberOfUnits     = rawValues.unit_count         || 0;
//       pd.leakageRate       = rawValues.leakage            ?? 0;
//       pd.installedCapacity = rawValues.installedCapacity || 0;
//       pd.endYearCapacity   = rawValues.endYearCapacity    || 0;
//       pd.purchases         = rawValues.purchases          || 0;
//       pd.disposals         = rawValues.disposals          || 0;
//     }
//     // // Generic fugitive (non-refrigeration)
//     // else if (scopeConfig.categoryName.includes('Fugitive')) {
//     //   pd.numberOfUnits = rawValues.numberOfUnits || rawValues.unit_count || 0;
//     //   pd.leakageRate = rawValues.leakageRate || rawValues.leakage ?? 0;
//     //   pd.installedCapacity = rawValues.installedCapacity || 0;
//     //   pd.endYearCapacity = rawValues.endYearCapacity || 0;
//     //   pd.purchases = rawValues.purchases || 0;
//     //   pd.disposals = rawValues.disposals || 0;
//     // } 
//     // Process Emission (must come AFTER all fugitive checks)
//     else if (scopeConfig.categoryName.includes('Process Emission')) {
//       pd.productionOutput = rawValues.productionOutput   ?? rawValues.production_output   ?? 0;
//       pd.rawMaterialInput = rawValues.rawMaterialInput   ?? rawValues.raw_material_input ?? 0;
//     }
//   } 
//   else if (scopeConfig.scopeType === 'Scope 2') {
//     // Map category to field name
//     const categoryFieldMap = {
//       'Purchased Electricity': 'consumed_electricity',
//       'Purchased Steam': 'consumed_steam',
//       'Purchased Heating': 'consumed_heating',
//       'Purchased Cooling': 'consumed_cooling'
//     };
    
//     const fieldKey = categoryFieldMap[scopeConfig.categoryName] || 'consumed_electricity';
    
//     if (fieldKey === 'consumed_electricity') {
//       pd.consumed_electricity = rawValues.electricity || rawValues.power_consumption || rawValues.consumed_electricity || 0;
//     } else if (fieldKey === 'consumed_steam') {
//       pd.consumed_steam = rawValues.steam || rawValues.consumed_steam || 0;
//     } else if (fieldKey === 'consumed_heating') {
//       pd.consumed_heating = rawValues.heating || rawValues.consumed_heating || 0;
//     } else if (fieldKey === 'consumed_cooling') {
//       pd.consumed_cooling = rawValues.cooling || rawValues.consumed_cooling || 0;
//     }
//   } 
//   else if (scopeConfig.scopeType === 'Scope 3') {
//     switch (scopeConfig.categoryName) {
//       case 'Purchased Goods and Services':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.procurementSpend = rawValues.procurementSpend ?? rawValues.procurement_spend ?? 0;
//         } else {
//           pd.physicalQuantity = rawValues.physicalQuantity ?? rawValues.physical_quantity ?? 0;
//         }
//         break;
        
//       case 'Capital Goods':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.procurementSpend = rawValues.procurementSpend ?? rawValues.procurement_spend ?? 0;
//         } else {
//           pd.assetQuantity = rawValues.assetQuantity ?? rawValues.asset_quantity ?? 0;
//         }
//         break;
        
//       case 'Fuel and energy':
//         pd.fuelConsumed = rawValues.fuelConsumed ?? rawValues.fuel_consumed ?? 0;
//         pd.electricityConsumption = rawValues.electricityConsumption ?? rawValues.electricity_consumed ?? 0;
//         pd.tdLossFactor = rawValues.tdLossFactor ?? rawValues.td_loss_factor ?? 0;
//         break;
        
//       case 'Upstream Transport and Distribution':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.transportationSpend = rawValues.transportationSpend ?? rawValues.transportation_spend ?? 0;
//         } else {
//           pd.mass = rawValues.mass ?? 0;
//           pd.distance = rawValues.distance ?? 0;
//         }
//         break;
        
//       case 'Waste Generated in Operation':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.wasteMass = rawValues.wasteMass ?? rawValues.mass_waste ?? 0;
//         } else {
//           pd.wasteMass = rawValues.wasteMass ?? 0;
//           pd.treatmentType = rawValues.treatmentType;
//         }
//         break;
        
//       case 'Business Travel':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.travelSpend = rawValues.travelSpend ?? rawValues.travel_spend ?? 0;
//           pd.hotelNights = rawValues.hotelNights ?? rawValues.hotel_nights ?? 0;
//         } else {
//           pd.numberOfPassengers = rawValues.numberOfPassengers ?? rawValues.passengers ?? 0;
//           pd.distanceTravelled = rawValues.distanceTravelled ?? rawValues.distance ?? 0;
//           pd.hotelNights = rawValues.hotelNights ?? rawValues.hotel_nights ?? 0;
//         }
//         break;
        
//       case 'Employee Commuting':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.employeeCount = rawValues.employeeCount ?? rawValues.employee_Count ?? 0;
//           pd.averageCommuteDistance = rawValues.averageCommuteDistance ?? rawValues.average_Commuting_Distance ?? 0;
//           pd.workingDays = rawValues.workingDays ?? rawValues.working_Days ?? 0;
//         } else {
//           pd.note = 'Tier 2 calculation in progress';
//         }
//         break;
        
//       case 'Upstream Leased Assets':
//       case 'Downstream Leased Assets':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.leasedArea = rawValues.leasedArea ?? rawValues.leased_Area ?? 0;
//         } else {
//           pd.leasedArea = rawValues.leasedArea ?? rawValues.leased_Area ?? 0;
//           pd.totalArea = rawValues.totalArea ?? rawValues.total_Area ?? 0;
//           pd.energyConsumption = rawValues.energyConsumption ?? rawValues.energy_Consumption ?? 0;
//           pd.BuildingTotalS1_S2 = rawValues.BuildingTotalS1_S2 ?? rawValues.buildingTotalS1S2 ?? 0;
//         }
//         break;
        
//       case 'Downstream Transport and Distribution':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.transportSpend = rawValues.transportSpend ?? rawValues.transport_Spend ?? rawValues.spendTransport ?? 0;
//         } else {
//           pd.mass = rawValues.mass ?? rawValues.transportMass ?? 0;
//           pd.distance = rawValues.distance ?? rawValues.transportDistance ?? 0;
//         }
//         break;
        
//       case 'Processing of Sold Products':
//         pd.productQuantity = rawValues.productQuantity ?? rawValues.product_quantity ?? 0;
//         if (scopeConfig.calculationModel === 'tier 2') {
//           pd.customerType = rawValues.customerType ?? rawValues.customer_type ?? '';
//         }
//         break;
        
//       case 'End-of-Life Treatment of Sold Products':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.massEol = rawValues.massEol ?? rawValues.mass_eol ?? 0;
//           pd.toDisposal = rawValues.toDisposal ?? rawValues.to_disposal ?? 0;
//           pd.toLandfill = rawValues.toLandfill ?? rawValues.to_landfill ?? 0;
//           pd.toIncineration = rawValues.toIncineration ?? rawValues.to_incineration ?? 0;
//         }
//         break;
        
//       case 'Use of Sold Products':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.productQuantity = rawValues.productQuantity ?? rawValues.product_quantity ?? 0;
//           pd.averageLifetimeEnergyConsumption = rawValues.averageLifetimeEnergyConsumption ?? rawValues.average_lifetime_energy_consumption ?? 0;
//         } else {
//           pd.productQuantity = rawValues.productQuantity ?? rawValues.product_quantity ?? 0;
//           pd.usePattern = rawValues.usePattern ?? rawValues.use_pattern ?? 1;
//           pd.energyEfficiency = rawValues.energyEfficiency ?? rawValues.energy_efficiency ?? 0;
//         }
//         break;
        
//       case 'Franchises':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.franchiseCount = rawValues.franchiseCount ?? rawValues.noOfFranchises ?? 0;
//           pd.avgEmissionPerFranchise = rawValues.avgEmissionPerFranchise ?? rawValues.averageEmissionPerFranchise ?? 0;
//         } else {
//           pd.franchiseTotalS1Emission = rawValues.franchiseTotalS1Emission ?? rawValues.totalS1Emission ?? 0;
//           pd.franchiseTotalS2Emission = rawValues.franchiseTotalS2Emission ?? rawValues.totalS2Emission ?? 0;
//           pd.energyConsumption = rawValues.energyConsumption ?? rawValues.energy_Consumption ?? 0;
//         }
//         break;
        
//       case 'Investments':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.investeeRevenue = rawValues.investeeRevenue ?? rawValues.investee_revenue ?? 0;
//           pd.equitySharePercentage = rawValues.equitySharePercentage ?? rawValues.equity_share_percentage ?? 0;
//         } else {
//           pd.investeeScope1Emission = rawValues.investeeScope1Emission ?? rawValues.scope1Emission ?? 0;
//           pd.investeeScope2Emission = rawValues.investeeScope2Emission ?? rawValues.scope2Emission ?? 0;
//           pd.equitySharePercentage = rawValues.equitySharePercentage ?? rawValues.equity_share_percentage ?? 0;
//           pd.energyConsumption = rawValues.energyConsumption ?? rawValues.energy_consumption ?? 0;
//         }
//         break;
        
//       default:
//         break;
//     }
//   }
  
//   return pd;
// }



// // ─────────────────────────────────────────────────────────────
// // 1) Helper to normalize IoT payloads into the same shape as API
// // ─────────────────────────────────────────────────────────────
// /**
//  * Helper function to process IoT data based on scope configuration
//  */

// function processIoTData(iotData, scopeConfig) {
//   const pd = {};

//   // ───────── Scope 1 ─────────
//   if (scopeConfig.scopeType === 'Scope 1') {
//     // Combustion
//     if (scopeConfig.categoryName.includes('Combustion')) {
//       pd.fuelConsumption = iotData.fuel_consumed || iotData.consumption || 0;
//     }
//     // SF₆‐specific fugitive
//     else if (
//       scopeConfig.categoryName.includes('Fugitive') &&
//       /SF6/i.test(scopeConfig.activity)
//     ) {
//       pd.nameplateCapacity   = iotData.nameplateCapacity     ?? 0;
//       pd.defaultLeakageRate  = iotData.defaultLeakageRate    ?? 0;
//       pd.decreaseInventory   = iotData.decreaseInventory     ?? 0;
//       pd.acquisitions        = iotData.acquisitions          ?? 0;
//       pd.disbursements       = iotData.disbursements         ?? 0;
//       pd.netCapacityIncrease = iotData.netCapacityIncrease   ?? 0;
//     }
//     // CH₄‐Leaks fugitive
//     else if (
//     scopeConfig.categoryName.includes('Fugitive') &&
//     /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)
//   ) {
//     // accept camelCase or snake_case inputs
//     pd.activityData       =
//          iotData.activityData
//       ?? iotData.activity_data
//       ?? 0;
//     pd.numberOfComponents =
//          iotData.numberOfComponents
//       ?? iotData.number_of_components
//       ?? 0;
//   }
//     // Generic fugitive / refrigeration
//     else if (
//       scopeConfig.categoryName.includes('Fugitive') ||
//       /ref.*?geration/i.test(scopeConfig.activity)
//     ) {
//       pd.numberOfUnits     = iotData.unit_count         || 0;
//       pd.leakageRate       = iotData.leakage            ?? 0;
//       pd.installedCapacity = iotData.installedCapacity || 0;
//       pd.endYearCapacity   = iotData.endYearCapacity    || 0;
//       pd.purchases         = iotData.purchases          || 0;
//       pd.disposals         = iotData.disposals          || 0;
//     }
//     // Process Emission
//     else if (scopeConfig.categoryName.includes('Process Emission')) {
//       // Tier 1
//       pd.productionOutput = iotData.productionOutput
//                           ?? iotData.production_output
//                           ?? 0;
//       // Tier 2
//       pd.rawMaterialInput = iotData.rawMaterialInput
//                           ?? iotData.raw_material_input
//                           ?? 0;
//     }
//   }

//   // ───────── Scope 2 ─────────
//   else if (scopeConfig.scopeType === 'Scope 2') {
//     pd.consumed_electricity = iotData.electricity
//                            || iotData.power_consumption
//                            || 0;
//   }

//   // ───────── Scope 3 ─────────
//   else if (scopeConfig.scopeType === 'Scope 3') {
//     switch (scopeConfig.categoryName) {
//       // Purchased Goods and Services
//       case 'Purchased Goods and Services':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.procurementSpend = iotData.procurementSpend ?? 0;
//         } else {
//           pd.physicalQuantity = iotData.physicalQuantity ?? 0;
//         }
//         break;

//       // Capital Goods
//       case 'Capital Goods':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.procurementSpend = iotData.procurementSpend ?? 0;
//         } else {
//           pd.assetQuantity = iotData.assetQuantity ?? 0;
//         }
//         break;

//       // Fuel and energy
//       case 'Fuel and energy':
//         pd.fuelConsumed           = iotData.fuelConsumed
//                                   ?? iotData.fuel_consumed
//                                   ?? 0;
//         pd.electricityConsumption = iotData.electricityConsumption
//                                   ?? iotData.electricity_consumed
//                                   ?? 0;
//         pd.tdLossFactor           = iotData.tdLossFactor
//                                   ?? iotData.td_loss_factor
//                                   ?? 0;
//         break;

//       // Upstream Transport and Distribution
//       case 'Upstream Transport and Distribution':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.transportationSpend = iotData.transportationSpend
//                                  ?? iotData.transportation_spend
//                                  ?? 0;
//         } else {
//           pd.mass     = iotData.mass     ?? 0;
//           pd.distance = iotData.distance ?? 0;
//         }
//         break;

//       // Waste Generated in Operation
//       case 'Waste Generated in Operation':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.wasteMass = iotData.wasteMass
//                        ?? iotData.mass_waste
//                        ?? 0;
//         } else {
//           pd.wasteMass    = iotData.wasteMass ?? 0;
//           pd.treatmentType= iotData.treatmentType;
//         }
//         break;

//       // Business Travel
//       case 'Business Travel':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.travelSpend = iotData.travelSpend    ?? iotData.travel_spend ?? 0;
//           pd.hotelNights = iotData.hotelNights    ?? iotData.hotel_nights ?? 0;
//         } else {
//           pd.numberOfPassengers = iotData.numberOfPassengers ?? iotData.passengers ?? 0;
//           pd.distanceTravelled  = iotData.distanceTravelled  ?? iotData.distance   ?? 0;
//           pd.hotelNights        = iotData.hotelNights        ?? iotData.hotel_nights ?? 0;
//         }
//         break;

//       // Employee Commuting
//       case 'Employee Commuting':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.employeeCount          = iotData.employeeCount           ?? iotData.employee_Count           ?? 0;
//           pd.averageCommuteDistance = iotData.averageCommuteDistance  ?? iotData.average_Commuting_Distance ?? 0;
//           pd.workingDays            = iotData.workingDays             ?? iotData.working_Days             ?? 0;
//         } else {
//           pd.note = 'Tier 2 calculation in progress';
//         }
//         break;

//       // Upstream & Downstream Leased Assets
//       case 'Upstream Leased Assets':
//       case 'Downstream Leased Assets':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.leasedArea = iotData.leasedArea ?? iotData.leased_Area ?? 0;
//         } else {
//           pd.leasedArea        = iotData.leasedArea        ?? iotData.leased_Area        ?? 0;
//           pd.totalArea         = iotData.totalArea         ?? iotData.total_Area         ?? 0;
//           pd.energyConsumption = iotData.energyConsumption ?? iotData.energy_Consumption ?? 0;
//           pd.BuildingTotalS1_S2= iotData.BuildingTotalS1_S2   ?? iotData.buildingTotalS1S2   ?? 0;
//         }
//         break;

//       // Downstream Transport and Distribution
//       case 'Downstream Transport and Distribution':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.transportSpend = iotData.transportSpend
//                             ?? iotData.transport_Spend
//                             ?? iotData.spendTransport
//                             ?? 0;
//         } else {
//           pd.mass     = iotData.mass     ?? iotData.transportMass   ?? 0;
//           pd.distance = iotData.distance ?? iotData.transportDistance ?? 0;
//         }
//         break;

//       // Processing of Sold Products
//       case 'Processing of Sold Products':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.productQuantity = iotData.productQuantity ?? iotData.product_quantity ?? 0;
//         } else {
//           pd.productQuantity = iotData.productQuantity ?? iotData.product_quantity ?? 0;
//           pd.customerType    = iotData.customerType    ?? iotData.customer_type    ?? '';
//         }
//         break;

//       // End-of-Life Treatment of Sold Products
//       case 'End-of-Life Treatment of Sold Products':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.massEol        = iotData.massEol        ?? iotData.mass_eol        ?? 0;
//           pd.toDisposal     = iotData.toDisposal     ?? iotData.to_disposal     ?? 0;
//           pd.toLandfill     = iotData.toLandfill     ?? iotData.to_landfill     ?? 0;
//           pd.toIncineration = iotData.toIncineration ?? iotData.to_incineration ?? 0;
//         }
//         break;

//       // Use of Sold Products
//       case 'Use of Sold Products':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.productQuantity                  = iotData.productQuantity                   ?? iotData.product_quantity                   ?? 0;
//           pd.averageLifetimeEnergyConsumption = iotData.averageLifetimeEnergyConsumption  ?? iotData.average_lifetime_energy_consumption ?? 0;
//         } else {
//           pd.productQuantity  = iotData.productQuantity  ?? iotData.product_quantity ?? 0;
//           pd.usePattern       = iotData.usePattern       ?? iotData.use_pattern    ?? 1;
//           pd.energyEfficiency = iotData.energyEfficiency ?? iotData.energy_efficiency ?? 0;
//         }
//         break;

//       // Franchises
//       case 'Franchises':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.franchiseCount           = iotData.franchiseCount           ?? iotData.noOfFranchises              ?? 0;
//           pd.avgEmissionPerFranchise  = iotData.avgEmissionPerFranchise  ?? iotData.averageEmissionPerFranchise ?? 0;
//         } else {
//           pd.franchiseTotalS1Emission = iotData.franchiseTotalS1Emission ?? iotData.totalS1Emission ?? 0;
//           pd.franchiseTotalS2Emission = iotData.franchiseTotalS2Emission ?? iotData.totalS2Emission ?? 0;
//           pd.energyConsumption        = iotData.energyConsumption        ?? iotData.energy_Consumption ?? 0;
//         }
//         break;

//       // Investments
//       case 'Investments':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.investeeRevenue       = iotData.investeeRevenue       ?? iotData.investee_revenue       ?? 0;
//           pd.equitySharePercentage = iotData.equitySharePercentage ?? iotData.equity_share_percentage ?? 0;
//         } else {
//           pd.investeeScope1Emission  = iotData.investeeScope1Emission  ?? iotData.scope1Emission          ?? 0;
//           pd.investeeScope2Emission  = iotData.investeeScope2Emission  ?? iotData.scope2Emission          ?? 0;
//           pd.equitySharePercentage    = iotData.equitySharePercentage ?? iotData.equity_share_percentage ?? 0;
//           pd.energyConsumption        = iotData.energyConsumption     ?? iotData.energy_consumption      ?? 0;
//         }
//         break;

//       // …add any other Scope 3 categories here…
//     }
//   }

//   return pd;
// }


// // Helper function to process API data based on scope configuration
// function processAPIData(apiData, scopeConfig) {
// const pd = {};
// if (scopeConfig.scopeType === 'Scope 1') {
// if (scopeConfig.categoryName.includes('Combustion')) {
// pd.fuelConsumption = apiData.fuel_consumed || apiData.consumption || 0;
// }
// // ← NEW: SF₆‐specific must come before the generic fugitive check
// else if (
// scopeConfig.categoryName.includes('Fugitive') &&
// /SF6/i.test(scopeConfig.activity)
// ) {
// pd.nameplateCapacity = apiData.nameplateCapacity ?? 0;
// pd.defaultLeakageRate = apiData.defaultLeakageRate ?? 0;
// pd.decreaseInventory = apiData.decreaseInventory ?? 0;
// pd.acquisitions = apiData.acquisitions ?? 0;
// pd.disbursements = apiData.disbursements ?? 0;
// pd.netCapacityIncrease= apiData.netCapacityIncrease ?? 0;
// }
//    else if (
//     scopeConfig.categoryName.includes('Fugitive') &&
//     /CH4[_\s-]?Leaks?/i.test(scopeConfig.activity)
//   ) {
//     // accept camelCase or snake_case inputs
//     pd.activityData       =
//          apiData.activityData
//       ?? apiData.activity_data
//       ?? 0;
//     pd.numberOfComponents =
//          apiData.numberOfComponents
//       ?? apiData.number_of_components
//       ?? 0;
//   }
// else if (
// scopeConfig.categoryName.includes('Fugitive') ||
// /ref.*?geration/i.test(scopeConfig.activity)
// ) {
// pd.numberOfUnits = apiData.unit_count || 0;
// pd.leakageRate = apiData.leakage ?? 0;
// pd.installedCapacity= apiData.installedCapacity || 0;
// pd.endYearCapacity = apiData.endYearCapacity || 0;
// pd.purchases = apiData.purchases || 0;
// pd.disposals = apiData.disposals || 0;
// }
  
// // Process Emission–type
// else if (scopeConfig.categoryName.includes('Process Emission')) {
// // Tier 1 process
// pd.productionOutput = apiData.productionOutput
// ?? apiData.production_output
// ?? 0;
// // Tier 2 process
// pd.rawMaterialInput = apiData.rawMaterialInput
// ?? apiData.raw_material_input
// ?? 0;
// }
// }
// else if (scopeConfig.scopeType === 'Scope 2') {
// pd.consumed_electricity = apiData.electricity
// || apiData.power_consumption
// || 0;
// }
//  // ───────── Scope 3 ───────── 
// else if (scopeConfig.scopeType === 'Scope 3') {
//   switch (scopeConfig.categoryName) {

//     // Purchased Goods and Services
//     case 'Purchased Goods and Services':
//       if (scopeConfig.calculationModel === 'tier 1') {
//         // spend‐based
//         pd.procurementSpend   = apiData.procurementSpend   ?? 0;
//       } else if (scopeConfig.calculationModel === 'tier 2') {
//         // quantity‐based
//         pd.physicalQuantity   = apiData.physicalQuantity   ?? 0;
//       }
//       break;
//     // Capital Goods
//     case 'Capital Goods':
//       if (scopeConfig.calculationModel === 'tier 1') {
//         // spend‐based
//         pd.procurementSpend   = apiData.procurementSpend   ?? 0;
//       } else if (scopeConfig.calculationModel === 'tier 2') {
//         // quantity‐based
//         pd.assetQuantity      = apiData.assetQuantity      ?? 0;
//       }
//       break;
//     case 'Fuel and energy':
//   // Always pull these three fields from the incoming API data
//   pd.fuelConsumed = apiData.fuelConsumed
//                  ?? apiData.fuel_consumed
//                  ?? 0;
//   pd.electricityConsumption = apiData.electricityConsumption
//                             ?? apiData.electricity_consumed
//                             ?? 0;
//   pd.tdLossFactor = apiData.tdLossFactor
//                   ?? apiData.td_loss_factor
//                   ?? 0;
//   break;

//     case 'Upstream Transport and Distribution':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.transportationSpend = apiData.transportationSpend 
//                                  ?? apiData.transportation_spend 
//                                  ?? 0;
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.mass     = apiData.mass     ?? 0;
//           pd.distance = apiData.distance ?? 0;
//         }
//   break;
//     case 'Waste Generated in Operation':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.wasteMass = apiData.wasteMass
//                        ?? apiData.mass_waste
//                        ?? 0;
//         } else if (scopeConfig.calculationModel === 'tier 2') {
//           pd.wasteMass = apiData.wasteMass ?? 0;
//           // if you collect a separate “treatment” mass or type,
//            pd.treatmentType = apiData.treatmentType
//         }
//     break;
//     case 'Business Travel':
//       if (scopeConfig.calculationModel === 'tier 1') {
//         pd.travelSpend      = apiData.travelSpend      ?? apiData.travel_spend    ?? 0;
//         pd.hotelNights      = apiData.hotelNights      ?? apiData.hotel_nights    ?? 0;
//       } else if (scopeConfig.calculationModel === 'tier 2') {
//         pd.numberOfPassengers  = apiData.numberOfPassengers ?? apiData.passengers ?? 0;
//         pd.distanceTravelled   = apiData.distanceTravelled  ?? apiData.distance   ?? 0;
//         pd.hotelNights         = apiData.hotelNights        ?? apiData.hotel_nights ?? 0;
//       }
//       break;
//     case 'Employee Commuting':
//       if(scopeConfig.calculationModel === 'tier 1'){
//         pd.employeeCount = apiData.employeeCount ?? apiData.employee_Count ?? 0;
//         pd.averageCommuteDistance = apiData.averageCommuteDistance ?? apiData.average_Commuting_Distance ?? 0;
//         pd.workingDays = apiData.workingDays ?? apiData.working_Days ?? 0;
      
//       }else if (scopeConfig.calculationModel === 'tier 2'){
//          pd.note = 'Tier 2 calculation in progress';
        
//       }
//     case 'Upstream Leased Assets':
//     case 'Downstream Leased Assets':
//     if (scopeConfig.calculationModel === 'tier 1') {
//       pd.leasedArea = apiData.leasedArea
//                    ?? apiData.leased_Area
//                    ?? 0;
//     }
//     else if (scopeConfig.calculationModel === 'tier 2') {
//       pd.leasedArea        = apiData.leasedArea
//                            ?? apiData.leased_Area
//                            ?? 0;
//       pd.totalArea         = apiData.totalArea
//                            ?? apiData.total_Area
//                            ?? 0;
//       // energyConsumption for Case A
//       pd.energyConsumption = apiData.energyConsumption
//                            ?? apiData.energy_Consumption
//                            ?? 0;
//       // Building total S1+S2 now comes from the payload
//       pd.BuildingTotalS1_S2 = apiData.BuildingTotalS1_S2
//                            ?? apiData.buildingTotalS1S2
//                            ?? 0;
//     }
//     break;
//     case 'Downstream Transport and Distribution':
//     if (scopeConfig.calculationModel === 'tier 1') {
//       // Tier 1: spend‐based
//       pd.transportSpend = apiData.transportSpend
//                        ?? apiData.transport_Spend
//                        ?? apiData.spendTransport
//                        ?? 0;
//     }
//     else if (scopeConfig.calculationModel === 'tier 2') {
//       // Tier 2: mass‐km based
//       pd.mass     = apiData.mass     ?? apiData.transportMass   ?? 0;
//       pd.distance = apiData.distance ?? apiData.transportDistance ?? 0;
//     }
//     break;
//       // ───────── Processing of Sold Products ─────────
//     case 'Processing of Sold Products':
//     if (scopeConfig.calculationModel === 'tier 1') {
//       // Tier 1: Quantity‐based
//       pd.productQuantity = apiData.productQuantity
//                         ?? apiData.product_quantity
//                         ?? 0;
//     }
//     else if (scopeConfig.calculationModel === 'tier 2') {
//       // Tier 2: same quantity + customerType for EF lookup
//       pd.productQuantity = apiData.productQuantity
//                         ?? apiData.product_quantity
//                         ?? 0;
//       pd.customerType    = apiData.customerType
//                         ?? apiData.customer_type
//                         ?? '';
//     }
//     break;
//     case 'End-of-Life Treatment of Sold Products':
//   if (scopeConfig.calculationModel === 'tier 1') {
//     pd.massEol           = apiData.massEol           ?? apiData.mass_eol           ?? 0;
//     pd.toDisposal        = apiData.toDisposal        ?? apiData.to_disposal        ?? 0;
//     pd.toLandfill        = apiData.toLandfill        ?? apiData.to_landfill        ?? 0;
//     pd.toIncineration    = apiData.toIncineration    ?? apiData.to_incineration    ?? 0;
//   }
//   break;

//     // ───────── Use of Sold Products ─────────
//     case 'Use of Sold Products':
//     if (scopeConfig.calculationModel === 'tier 1') {
//       // Tier 1: productQuantity × avgLifetimeEnergyConsumption × usePhase EF
//       pd.productQuantity                   = apiData.productQuantity
//                                            ?? apiData.product_quantity
//                                            ?? 0;
//       pd.averageLifetimeEnergyConsumption  = apiData.averageLifetimeEnergyConsumption
//                                            ?? apiData.average_lifetime_energy_consumption
//                                            ?? 0;
//     } else if (scopeConfig.calculationModel === 'tier 2') {
//       // Tier 2: productQuantity × usePattern × energyEfficiency × grid EF
//       pd.productQuantity    = apiData.productQuantity
//                             ?? apiData.product_quantity
//                             ?? 0;
//       pd.usePattern         = apiData.usePattern
//                             ?? apiData.use_pattern
//                             ?? 1;      // default 0 if missing
//       pd.energyEfficiency   = apiData.energyEfficiency
//                             ?? apiData.energy_efficiency
//                             ?? 0;
//     }
//     break;
//     case 'Franchises':
//       if (scopeConfig.calculationModel === 'tier 1') {
//         pd.franchiseCount            = apiData.franchiseCount
//                                      ?? apiData.noOfFranchises
//                                      ?? 0;
//         pd.avgEmissionPerFranchise  = apiData.avgEmissionPerFranchise
//                                      ?? apiData.averageEmissionPerFranchise
//                                      ?? 0;
//       } else if (scopeConfig.calculationModel === 'tier 2') {
//         // Case A inputs
//         pd.franchiseTotalS1Emission = apiData.franchiseTotalS1Emission
//                                      ?? apiData.totalS1Emission
//                                      ?? 0;
//         pd.franchiseTotalS2Emission = apiData.franchiseTotalS2Emission
//                                      ?? apiData.totalS2Emission
//                                      ?? 0;
//         // Case B input
//         pd.energyConsumption        = apiData.energyConsumption
//                                      ?? apiData.energy_Consumption
//                                      ?? 0;
//       }
//       break;
//     case 'Investments':
//         if (scopeConfig.calculationModel === 'tier 1') {
//           pd.investeeRevenue         = apiData.investeeRevenue         ?? apiData.investee_revenue         ?? 0;
//           pd.equitySharePercentage   = apiData.equitySharePercentage   ?? apiData.equity_share_percentage   ?? 0;
//         }
//         else if (scopeConfig.calculationModel === 'tier 2') {
//           // Case A inputs
//           pd.investeeScope1Emission  = apiData.investeeScope1Emission  ?? apiData.scope1Emission          ?? 0;
//           pd.investeeScope2Emission  = apiData.investeeScope2Emission  ?? apiData.scope2Emission          ?? 0;
//           pd.equitySharePercentage   = apiData.equitySharePercentage   ?? apiData.equity_share_percentage ?? 0;
//           // Case B input
//           pd.energyConsumption       = apiData.energyConsumption       ?? apiData.energy_consumption     ?? 0;
//         }
//         break;
//     // TODO: add other Scope 3 categories here
//     // case 'Fuel- and energy-related activities': …
//     // case 'Transportation and distribution': …
//   }
// }

 

// return pd;
// }




