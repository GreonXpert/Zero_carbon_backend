'use strict';

/**
 * seedSdaCurves.js
 * ────────────────
 * Seeds the MethodLibrary with the SBTi 1.5 °C-aligned SDA sectoral
 * decarbonization data.
 *
 * Each sector entry stores:
 *   annual_reduction_rate  – compound annual rate used by pathwayService
 *                            to compute: factor_Y = (1 − rate)^(Y − base_year)
 *   label                  – Human-readable sector name shown in the UI
 *   description            – Source reference
 *   typical_denominator    – Suggested denominator unit for the sector
 *
 * Rates are based on SBTi Technical Guidance & Sectoral Pathways
 * (SBTi Corporate Manual v2.0, Oct 2023; Power Sector Science-Based Target
 * Setting Guidance; Buildings Sector Guidance).
 *
 * Usage:
 *   node src/modules/zero-carbon/m3/seeders/seedSdaCurves.js
 * Or call seedSdaCurves() programmatically from server startup / migration.
 */

const mongoose = require('mongoose');
const MethodLibrary = require('../models/MethodLibrary');

const SDA_SECTORS = {
  Power: {
    annual_reduction_rate: 0.082,
    label:                 'Power / Electricity Generation',
    description:           'SBTi Power Sector Science-Based Target Setting Guidance – 1.5 °C pathway. ~82% reduction needed by 2035 vs 2019.',
    typical_denominator:   'MWh',
  },
  Buildings: {
    annual_reduction_rate: 0.021,
    label:                 'Buildings',
    description:           'SBTi Buildings Sector Guidance – 1.5 °C aligned physical intensity pathway. ~50% reduction by 2050.',
    typical_denominator:   'm²',
  },
  Transport_Passenger: {
    annual_reduction_rate: 0.025,
    label:                 'Transport – Passenger',
    description:           'SBTi Transport Sector Guidance – passenger vehicles 1.5 °C pathway. ~55% reduction by 2050.',
    typical_denominator:   'pkm (passenger-km)',
  },
  Transport_Freight: {
    annual_reduction_rate: 0.020,
    label:                 'Transport – Freight',
    description:           'SBTi Transport Sector Guidance – freight 1.5 °C pathway. ~45% reduction by 2050.',
    typical_denominator:   'tkm (tonne-km)',
  },
  Steel: {
    annual_reduction_rate: 0.021,
    label:                 'Steel',
    description:           'SBTi Steel Sector Guidance – 1.5 °C pathway. ~50% reduction by 2050.',
    typical_denominator:   'tonne of steel',
  },
  Cement: {
    annual_reduction_rate: 0.018,
    label:                 'Cement',
    description:           'SBTi Cement Sector Guidance – 1.5 °C pathway. ~40% reduction by 2050.',
    typical_denominator:   'tonne of cementitious material',
  },
  Chemicals: {
    annual_reduction_rate: 0.021,
    label:                 'Chemicals / Plastics',
    description:           'SBTi Chemicals Sector – 1.5 °C aligned intensity pathway.',
    typical_denominator:   'tonne of product',
  },
  Paper: {
    annual_reduction_rate: 0.019,
    label:                 'Paper & Forest Products',
    description:           'SBTi Forest, Land & Agriculture (FLAG) adjacent paper/pulp sector guidance.',
    typical_denominator:   'tonne of paper',
  },
  Industry_General: {
    annual_reduction_rate: 0.021,
    label:                 'General Industry',
    description:           'SBTi SME / General Industry guidance – 1.5 °C aligned absolute-to-physical intensity pathway.',
    typical_denominator:   'unit of production',
  },
};

async function seedSdaCurves() {
  await MethodLibrary.findOneAndUpdate(
    { method_code: 'SDA' },
    {
      $set: {
        method_code:        'SDA',
        method_name:        'Sectoral Decarbonization Approach (SDA)',
        calculation_engine: 'SDA',
        is_active:          true,
        framework_gating:   ['SBTI'],
        required_parameters: {
          sectors: SDA_SECTORS,
          // How to use:
          //   factor_Y = (1 − sector.annual_reduction_rate) ^ (Y − user_base_year)
          //   allowed_GEI_Y = base_GEI × factor_Y
          //   base_GEI = base_year_emissions / base_year_output_value
        },
      },
    },
    { upsert: true, new: true }
  );

  console.log('[seedSdaCurves] SDA sectoral curves upserted successfully.');
  console.log('  Sectors seeded:', Object.keys(SDA_SECTORS).join(', '));
}

// ── Standalone entry-point ────────────────────────────────────────────────────
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/zero_carbon';
  mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(async () => {
      await seedSdaCurves();
      mongoose.disconnect();
    })
    .catch((err) => {
      console.error('[seedSdaCurves] Error:', err.message);
      process.exit(1);
    });
}

module.exports = { seedSdaCurves };
