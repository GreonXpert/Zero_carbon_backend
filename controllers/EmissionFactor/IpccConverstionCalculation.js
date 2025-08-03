/**
 * Calculate Emission Factors for GreonXpert
 * This controller handles both mass-based and volume-based emission calculations
 */

const calculateEmissionFactors = async (req, res) => {
  try {
    const {
      // Mass-based calculation parameters
      NCV,          // Net Calorific Value
      CO2,          // CO2 emission factor
      N2O,          // N2O emission factor
      CH4,          // CH4 emission factor
      
      // Volume-based calculation parameters
      volumeType,           // 'liter' or 'cubicMeter'
      fuelDensityLiter,     // Fuel density in kg/L (optional)
      fuelDensityM3         // Fuel density in kg/m³ (optional)
    } = req.body;

    // Validation
    if (!NCV || !CO2 || !N2O || !CH4) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: NCV, CO2, N2O, and CH4 are required"
      });
    }

    // Validate numeric values
    const numericParams = { NCV, CO2, N2O, CH4 };
    for (const [key, value] of Object.entries(numericParams)) {
      if (isNaN(value) || value < 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid ${key} value. Must be a positive number`
        });
      }
    }

    // First Calculation: Mass-based emission factors (kg/TJ)
    const massBasedEmissions = {
      CO2_KgT: (NCV * CO2) / 1000,
      CH4_KgT: (NCV * CH4) / 1000,
      N2O_KgT: (NCV * N2O) / 1000
    };

    // Response object
    const response = {
      success: true,
      data: {
        inputParameters: {
          NCV,
          CO2,
          N2O,
          CH4
        },
        massBasedEmissions: {
          CO2_KgT: massBasedEmissions.CO2_KgT.toFixed(6),
          CH4_KgT: massBasedEmissions.CH4_KgT.toFixed(6),
          N2O_KgT: massBasedEmissions.N2O_KgT.toFixed(6),
          unit: "kg/TJ"
        }
      }
    };

    // Second Calculation: Volume-based emission factors (if density provided)
    if (volumeType && (fuelDensityLiter || fuelDensityM3)) {
      if (volumeType === 'liter' && fuelDensityLiter) {
        // Validate fuel density
        if (isNaN(fuelDensityLiter) || fuelDensityLiter <= 0) {
          return res.status(400).json({
            success: false,
            message: "Invalid fuelDensityLiter value. Must be a positive number"
          });
        }

        // Calculate emissions per liter
        const volumeBasedEmissionsPerLiter = {
          CO2_KgL: (massBasedEmissions.CO2_KgT * fuelDensityLiter) / 1000,
          CH4_KgL: (massBasedEmissions.CH4_KgT * fuelDensityLiter) / 1000,
          N2O_KgL: (massBasedEmissions.N2O_KgT * fuelDensityLiter) / 1000
        };

        response.data.volumeBasedEmissions = {
          perLiter: {
            CO2_KgL: volumeBasedEmissionsPerLiter.CO2_KgL.toFixed(6),
            CH4_KgL: volumeBasedEmissionsPerLiter.CH4_KgL.toFixed(6),
            N2O_KgL: volumeBasedEmissionsPerLiter.N2O_KgL.toFixed(6),
            unit: "kg/L"
          },
          fuelDensityLiter
        };

      } else if (volumeType === 'cubicMeter' && fuelDensityM3) {
        // Validate fuel density
        if (isNaN(fuelDensityM3) || fuelDensityM3 <= 0) {
          return res.status(400).json({
            success: false,
            message: "Invalid fuelDensityM3 value. Must be a positive number"
          });
        }

        // Calculate emissions per cubic meter
        const volumeBasedEmissionsPerM3 = {
          CO2_Kgm3: (massBasedEmissions.CO2_KgT * fuelDensityM3) / 1000,
          CH4_Kgm3: (massBasedEmissions.CH4_KgT * fuelDensityM3) / 1000,
          N2O_Kgm3: (massBasedEmissions.N2O_KgT * fuelDensityM3) / 1000
        };

        response.data.volumeBasedEmissions = {
          perCubicMeter: {
            CO2_Kgm3: volumeBasedEmissionsPerM3.CO2_Kgm3.toFixed(6),
            CH4_Kgm3: volumeBasedEmissionsPerM3.CH4_Kgm3.toFixed(6),
            N2O_Kgm3: volumeBasedEmissionsPerM3.N2O_Kgm3.toFixed(6),
            unit: "kg/m³"
          },
          fuelDensityM3
        };

      } else {
        return res.status(400).json({
          success: false,
          message: "Invalid volume calculation parameters. Please provide either fuelDensityLiter with volumeType='liter' or fuelDensityM3 with volumeType='cubicMeter'"
        });
      }
    }

    // Add calculation timestamp
    response.data.calculatedAt = new Date().toISOString();

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error in calculateEmissionFactors:', error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during emission factor calculation",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Get emission factor calculation guidelines and formulas
 */
const getEmissionFactorInfo = async (req, res) => {
  try {
    const info = {
      success: true,
      data: {
        description: "Emission Factor Calculation API for GreonXpert ZeroCarbon",
        calculations: {
          massBased: {
            description: "Calculate mass-based emission factors (kg/TJ)",
            formulas: {
              "CO2_KgT": "(NCV * CO2) / 1000",
              "CH4_KgT": "(NCV * CH4) / 1000",
              "N2O_KgT": "(NCV * N2O) / 1000"
            },
            requiredParameters: ["NCV", "CO2", "N2O", "CH4"]
          },
          volumeBased: {
            description: "Calculate volume-based emission factors",
            perLiter: {
              formulas: {
                "CO2_KgL": "(CO2_KgT * fuelDensityLiter) / 1000",
                "CH4_KgL": "(CH4_KgT * fuelDensityLiter) / 1000",
                "N2O_KgL": "(N2O_KgT * fuelDensityLiter) / 1000"
              },
              requiredParameters: ["volumeType='liter'", "fuelDensityLiter"]
            },
            perCubicMeter: {
              formulas: {
                "CO2_Kgm³": "(CO2_KgT * fuelDensityM3) / 1000",
                "CH4_Kgm³": "(CH4_KgT * fuelDensityM3) / 1000",
                "N2O_Kgm³": "(N2O_KgT * fuelDensityM3) / 1000"
              },
              requiredParameters: ["volumeType='cubicMeter'", "fuelDensityM3"]
            }
          }
        },
        exampleRequest: {
          NCV: 48.5,
          CO2: 96100,
          N2O: 3,
          CH4: 3,
          volumeType: "liter",
          fuelDensityLiter: 0.82
        }
      }
    };

    return res.status(200).json(info);

  } catch (error) {
    console.error('Error in getEmissionFactorInfo:', error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

module.exports = {
  calculateEmissionFactors,
  getEmissionFactorInfo
};