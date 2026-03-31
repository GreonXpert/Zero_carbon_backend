const mongoose = require('mongoose');

const CCTSEntitySchema = new mongoose.Schema(
  {
    sector: { type: String, trim: true, index: true },
    subSector: { type: String, trim: true, index: true },
    registrationNumber: { type: String, trim: true, required: true, unique: true, index: true },
    entityName: { type: String, trim: true, index: true },
    state: { type: String, trim: true, index: true },
    obligatedEntityAddress: { type: String, trim: true },

    // Baseline (2023-2024)
    baselineOutput: { type: Number, default: null },                 // Tonne
    baselineGHGEmissionIntensity: { type: Number, default: null },  // tCO2e / tonne eq.product

    // Targets
    targetGEI_2025_26: { type: Number, default: null },             // tCO2e / tonne eq.product
    targetGEI_2026_27: { type: Number, default: null },             // tCO2e / tonne eq.product
    targetReduction_2025_26: { type: Number, default: null },       // tCO2e / tonne eq.product
    targetReduction_2026_27: { type: Number, default: null },       // tCO2e / tonne eq.product
    targetEstimatedReduction_2025_26: { type: Number, default: null }, // Tonne
    targetEstimatedReduction_2026_27: { type: Number, default: null }, // Tonne

    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// Compound index for filter performance
CCTSEntitySchema.index({ sector: 1, subSector: 1, state: 1 });

// Full-text search index
CCTSEntitySchema.index(
  {
    entityName: 'text',
    registrationNumber: 'text',
    sector: 'text',
    subSector: 'text',
    state: 'text',
    obligatedEntityAddress: 'text',
  },
  {
    weights: {
      registrationNumber: 10,
      entityName: 8,
      sector: 5,
      subSector: 4,
      state: 3,
      obligatedEntityAddress: 1,
    },
    name: 'ccts_text_search',
  }
);

module.exports = mongoose.model('CCTSEntity', CCTSEntitySchema);
