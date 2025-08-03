const express = require('express');
const router = express.Router();
const {
  calculateEmissionFactors,
  getEmissionFactorInfo
} = require('../../controllers/EmissionFactor/IpccConverstionCalculation');

const {auth,checkRole} = require ('../../middleware/auth');

// Apply authentication middleware to all routes
router.use(auth);



const allowedRoles = ['super_admin', 'consultant', 'consultant_admin'];
const viewRoles = ['super_admin', 'consultant', 'consultant_admin', 'client_admin', 'employee_head', 'auditor'];

// Optional: Import authentication middleware if needed
// const { authenticateToken } = require('../../middleware/auth');

/**
 * @route   POST /api/emission-factor/calculate
 * @desc    Calculate emission factors (mass-based and volume-based)
 * @access  Public (or add authentication middleware)
 * @body    {
 *            NCV: number,          // Net Calorific Value (required)
 *            CO2: number,          // CO2 emission factor (required)
 *            N2O: number,          // N2O emission factor (required)
 *            CH4: number,          // CH4 emission factor (required)
 *            volumeType: string,   // 'liter' or 'cubicMeter' (optional)
 *            fuelDensityLiter: number,  // Fuel density in kg/L (optional)
 *            fuelDensityM3: number      // Fuel density in kg/m³ (optional)
 *          }
 */
router.post('/calculate', checkRole(...allowedRoles), calculateEmissionFactors);
// For authenticated routes, use:
// router.post('/calculate', authenticateToken, calculateEmissionFactors);

/**
 * @route   GET /api/emission-factor/info
 * @desc    Get information about emission factor calculations
 * @access  Public
 */
router.get('/info',checkRole(...viewRoles), getEmissionFactorInfo);

/**
 * @route   POST /api/emission-factor/batch-calculate
 * @desc    Calculate emission factors for multiple fuel types
 * @access  Public (or add authentication middleware)
 */
router.post('/batch-calculate', async (req, res) => {
  try {
    const { fuels } = req.body;

    if (!fuels || !Array.isArray(fuels) || fuels.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide an array of fuels for batch calculation"
      });
    }

    const results = [];
    const errors = [];

    // Process each fuel calculation
    for (let i = 0; i < fuels.length; i++) {
      const fuel = fuels[i];
      
      try {
        // Validate required fields
        if (!fuel.NCV || !fuel.CO2 || !fuel.N2O || !fuel.CH4) {
          errors.push({
            index: i,
            fuelName: fuel.fuelName || `Fuel ${i + 1}`,
            error: "Missing required parameters"
          });
          continue;
        }

        // Calculate mass-based emissions
        const massBasedEmissions = {
          CO2_KgT: (fuel.NCV * fuel.CO2) / 1000,
          CH4_KgT: (fuel.NCV * fuel.CH4) / 1000,
          N2O_KgT: (fuel.NCV * fuel.N2O) / 1000
        };

        const result = {
          index: i,
          fuelName: fuel.fuelName || `Fuel ${i + 1}`,
          inputParameters: {
            NCV: fuel.NCV,
            CO2: fuel.CO2,
            N2O: fuel.N2O,
            CH4: fuel.CH4
          },
          massBasedEmissions: {
            CO2_KgT: massBasedEmissions.CO2_KgT.toFixed(6),
            CH4_KgT: massBasedEmissions.CH4_KgT.toFixed(6),
            N2O_KgT: massBasedEmissions.N2O_KgT.toFixed(6),
            unit: "kg/TJ"
          }
        };

        // Calculate volume-based emissions if density provided
        if (fuel.volumeType && (fuel.fuelDensityLiter || fuel.fuelDensityM3)) {
          if (fuel.volumeType === 'liter' && fuel.fuelDensityLiter) {
            result.volumeBasedEmissions = {
              perLiter: {
                CO2_KgL: ((massBasedEmissions.CO2_KgT * fuel.fuelDensityLiter) / 1000).toFixed(6),
                CH4_KgL: ((massBasedEmissions.CH4_KgT * fuel.fuelDensityLiter) / 1000).toFixed(6),
                N2O_KgL: ((massBasedEmissions.N2O_KgT * fuel.fuelDensityLiter) / 1000).toFixed(6),
                unit: "kg/L"
              },
              fuelDensityLiter: fuel.fuelDensityLiter
            };
          } else if (fuel.volumeType === 'cubicMeter' && fuel.fuelDensityM3) {
            result.volumeBasedEmissions = {
              perCubicMeter: {
                CO2_Kgm3: ((massBasedEmissions.CO2_KgT * fuel.fuelDensityM3) / 1000).toFixed(6),
                CH4_Kgm3: ((massBasedEmissions.CH4_KgT * fuel.fuelDensityM3) / 1000).toFixed(6),
                N2O_Kgm3: ((massBasedEmissions.N2O_KgT * fuel.fuelDensityM3) / 1000).toFixed(6),
                unit: "kg/m³"
              },
              fuelDensityM3: fuel.fuelDensityM3
            };
          }
        }

        results.push(result);

      } catch (error) {
        errors.push({
          index: i,
          fuelName: fuel.fuelName || `Fuel ${i + 1}`,
          error: error.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        totalProcessed: fuels.length,
        successfulCalculations: results.length,
        failedCalculations: errors.length,
        results,
        errors: errors.length > 0 ? errors : undefined,
        calculatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error in batch calculation:', error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during batch calculation"
    });
  }
});

/**
 * @route   POST /api/emission-factor/validate
 * @desc    Validate emission factor input parameters
 * @access  Public
 */
router.post('/validate', (req, res) => {
  try {
    const { NCV, CO2, N2O, CH4, fuelDensityLiter, fuelDensityM3 } = req.body;
    const errors = [];
    const warnings = [];

    // Validate required parameters
    if (!NCV) errors.push("NCV (Net Calorific Value) is required");
    if (!CO2) errors.push("CO2 emission factor is required");
    if (!N2O) errors.push("N2O emission factor is required");
    if (!CH4) errors.push("CH4 emission factor is required");

    // Validate numeric values and ranges
    if (NCV && (isNaN(NCV) || NCV <= 0)) {
      errors.push("NCV must be a positive number");
    }
    if (CO2 && (isNaN(CO2) || CO2 < 0)) {
      errors.push("CO2 must be a non-negative number");
    }
    if (N2O && (isNaN(N2O) || N2O < 0)) {
      errors.push("N2O must be a non-negative number");
    }
    if (CH4 && (isNaN(CH4) || CH4 < 0)) {
      errors.push("CH4 must be a non-negative number");
    }

    // Validate optional density parameters
    if (fuelDensityLiter !== undefined) {
      if (isNaN(fuelDensityLiter) || fuelDensityLiter <= 0) {
        errors.push("fuelDensityLiter must be a positive number");
      } else if (fuelDensityLiter > 2) {
        warnings.push("fuelDensityLiter seems unusually high (> 2 kg/L)");
      }
    }

    if (fuelDensityM3 !== undefined) {
      if (isNaN(fuelDensityM3) || fuelDensityM3 <= 0) {
        errors.push("fuelDensityM3 must be a positive number");
      } else if (fuelDensityM3 > 2000) {
        warnings.push("fuelDensityM3 seems unusually high (> 2000 kg/m³)");
      }
    }

    // Check for typical value ranges (warnings only)
    if (NCV && NCV > 100) {
      warnings.push("NCV seems unusually high (> 100 TJ/Gg)");
    }
    if (CO2 && CO2 > 200000) {
      warnings.push("CO2 emission factor seems unusually high (> 200,000 kg/TJ)");
    }

    const isValid = errors.length === 0;

    return res.status(isValid ? 200 : 400).json({
      success: isValid,
      message: isValid ? "All parameters are valid" : "Validation failed",
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    });

  } catch (error) {
    console.error('Error in validation:', error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during validation"
    });
  }
});

module.exports = router;