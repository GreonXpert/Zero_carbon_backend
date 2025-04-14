// const mongoose = require('mongoose');

// const FuelCombustionSchema = new mongoose.Schema(
//   {
//     category: { type: String, required: true },
//     activity: { type: String, required: true },
//     fuel: { type: String, required: true },
//     NCV: { type: Number, required: true }, // Net Calorific Value (TJ/Gg)
//     CO2: { type: Number, required: true }, // Original CO2 value
//     CH4: { type: Number, required: true }, // Original CH4 value
//     N2O: { type: Number, required: true }, // Original N2O value
//     unit: { type: String, default: 'Kg/TJ' },
//     source: {type: String, },
//     reference: {type: String},
        

   
//     assessmentType: { type: String, required: true }, // AR5, AR6, etc.

//     // Calculated values per Kg/T
//     CO2_KgT: { type: Number },
//     CH4_KgT: { type: Number },
//     N2O_KgT: { type: Number },
//     CO2e: { type: Number },

//     // Fuel Density Input
//     fuelDensityLiter: { type: Number }, // Fuel Density in Kg/L
//     fuelDensityM3: { type: Number },    // Fuel Density in Kg/m³

//     // Calculated densities
//     CO2_KgL: { type: Number },
//     CO2_Kgm3: { type: Number },
//     CH4_KgL: { type: Number },
//     CH4_Kgm3: { type: Number },
//     N2O_KgL: { type: Number },
//     N2O_Kgm3: { type: Number },

//     // CO2e based on density
//     CO2e_KgL: { type: Number }, // CO2e (Kg/L)
//     CO2e_Kgm3: { type: Number }, // CO2e (Kg/m³)
//   },
//   {
//     timestamps: true, // Automatically add createdAt and updatedAt fields
//   }
// );

// module.exports = mongoose.model('FuelCombustion', FuelCombustionSchema);



const mongoose = require('mongoose');

const AssessmentSchema = new mongoose.Schema({
  assessmentType: { type: String, required: true }, // e.g., AR5, AR6
  CO2_KgT: { type: Number },
  CH4_KgT: { type: Number },
  N2O_KgT: { type: Number },
  CO2e: { type: Number },
  CO2_KgL: { type: Number },
  CO2_Kgm3: { type: Number },
  CH4_KgL: { type: Number },
  CH4_Kgm3: { type: Number },
  N2O_KgL: { type: Number },
  N2O_Kgm3: { type: Number },
  CO2e_KgL: { type: Number },
  CO2e_Kgm3: { type: Number },
});

const FuelCombustionSchema = new mongoose.Schema({
  category: { type: String, required: true },
  activity: { type: String, required: true },
  fuel: { type: String, required: true },
  NCV: { type: Number, required: true }, // Net Calorific Value (TJ/Gg)
  CO2: { type: Number, required: true }, // Original CO2 value
  CH4: { type: Number, required: true }, // Original CH4 value
  N2O: { type: Number, required: true }, // Original N2O value
  unit: { type: String, default: 'Kg/TJ' },
  source: { type: String },
  reference: { type: String },
  fuelDensityLiter: { type: Number }, // Fuel Density in Kg/L
  fuelDensityM3: { type: Number }, // Fuel Density in Kg/m³
  assessments: [AssessmentSchema], // Array of assessment results
}, { timestamps: true });

module.exports = mongoose.model('FuelCombustion', FuelCombustionSchema);