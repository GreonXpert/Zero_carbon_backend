// controllers/Calculation/emissionIntegration.js

const { calculateEmissions } = require('./emissionCalculationController');
const { updateSummariesOnDataChange } = require('./CalculationSummary');
const DataEntry = require('../../models/DataEntry');
const Flowchart = require('../../models/Flowchart');

const {getActiveFlowchart}= require ('../../utils/DataCollection/dataCollection');

/**
 * Integration function to be called from saveAPIData, saveIoTData, saveManualData
 * This function prepares the data and triggers emission calculation
 */
const triggerEmissionCalculation = async (dataEntry) => {
  try {
    // Extract required fields
    const { clientId, nodeId, scopeIdentifier, _id: dataEntryId } = dataEntry;

      console.log(`🔄 Starting emission calculation for DataEntry: ${dataEntryId}`);


    // Create request object for emission calculation
    const calculationRequest = {
      body: {
        clientId,
        nodeId,
        scopeIdentifier,
        dataEntryId: dataEntryId.toString()
      }
    };

    // Mock response to capture result
    let calculationResult = null;
    const mockResponse = {
      status: (code) => ({
        json: (data) => {
          calculationResult = { status: code, data };
          return data;
        }
      }),
      json: (data) => {
        calculationResult = { status: 200, data };
        return data;
      }
    };

    // Call the emission calculation
    await calculateEmissions(calculationRequest, mockResponse);

    // Log the result
    if (calculationResult && calculationResult.data.success) {
      console.log(`✅ Emission calculated for DataEntry: ${dataEntryId}`);
      
      // Update the data entry with calculation results
      if (calculationResult.data.emissions) {
        dataEntry.calculatedEmissions = calculationResult.data.emissions;
        dataEntry.emissionCalculationStatus = 'completed';
        dataEntry.emissionCalculatedAt = new Date();
        await dataEntry.save();
        // 🆕 Trigger summary updates after successful calculation
        console.log(`📊 Triggering summary updates for client: ${clientId}`);
      try {
          await updateSummariesOnDataChange(dataEntry);
          console.log(`📊 ✅ Summary updates completed for client: ${clientId}`);
        } catch (summaryError) {
          console.error(`📊 ❌ Error updating summaries for client ${clientId}:`, summaryError);
          // Don't throw error to avoid affecting the main calculation flow
          dataEntry.summaryUpdateStatus = 'failed';
          dataEntry.summaryUpdateError = summaryError.message;
          await dataEntry.save();
        }
      }
    } else {
      console.error(`❌ Emission calculation failed for DataEntry: ${dataEntryId}`);
      dataEntry.emissionCalculationStatus = 'failed';
      dataEntry.emissionCalculationError = calculationResult?.data?.message || 'Unknown error';
      await dataEntry.save();
    }

    return calculationResult;

  } catch (error) {
    console.error('Error in triggerEmissionCalculation:', error);
    
    // Update data entry with error status
    try {
      dataEntry.emissionCalculationStatus = 'error';
      dataEntry.emissionCalculationError = error.message;
      await dataEntry.save();
    } catch (saveError) {
      console.error('Error updating data entry:', saveError);
    }
    
    return { success: false, error: error.message };
  }

};

/**
 * Batch process emissions for historical data
 * Useful for recalculating emissions after flowchart updates
 */
const recalculateHistoricalEmissions = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier, startDate, endDate } = req.body;

    // Build query
    const query = {
      clientId,
      processingStatus: { $ne: 'failed' }
    };

    if (nodeId) query.nodeId = nodeId;
    if (scopeIdentifier) query.scopeIdentifier = scopeIdentifier;
    if (startDate && endDate) {
      query.timestamp = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    // Find all matching data entries
    const dataEntries = await DataEntry.find(query)
      .select('_id clientId nodeId scopeIdentifier')
      .lean();

    console.log(`Found ${dataEntries.length} entries to recalculate`);

    // Process in batches of 50
    const batchSize = 50;
    const results = {
      total: dataEntries.length,
      success: 0,
      failed: 0,
      errors: []
    };

    for (let i = 0; i < dataEntries.length; i += batchSize) {
      const batch = dataEntries.slice(i, i + batchSize);
      
      // Process batch in parallel
      const batchPromises = batch.map(async (entry) => {
        try {
          const dataEntry = await DataEntry.findById(entry._id);
          const result = await triggerEmissionCalculation(dataEntry);
          
          if (result?.data?.success) {
            results.success++;
          } else {
            results.failed++;
            results.errors.push({
              dataEntryId: entry._id,
              error: result?.data?.message || 'Unknown error'
            });
          }
        } catch (error) {
          results.failed++;
          results.errors.push({
            dataEntryId: entry._id,
            error: error.message
          });
        }
      });

      await Promise.all(batchPromises);
      
      // Log progress
      console.log(`Processed ${Math.min(i + batchSize, dataEntries.length)}/${dataEntries.length} entries`);
    }
     // 🆕 Update summaries after batch recalculation if requested
    if (updateSummaries && results.success > 0) {
      try {
        console.log(`📊 Updating summaries after batch recalculation for client: ${clientId}`);
        const { recalculateAndSaveSummary } = require('./CalculationSummary');
        
        // Update all relevant summary periods
        const now = new Date();
        await Promise.all([
          recalculateAndSaveSummary(clientId, 'monthly', now.getFullYear(), now.getMonth() + 1),
          recalculateAndSaveSummary(clientId, 'yearly', now.getFullYear()),
          recalculateAndSaveSummary(clientId, 'all-time')
        ]);
        
        console.log(`📊 ✅ Summaries updated after batch recalculation`);
      } catch (summaryError) {
        console.error(`📊 ❌ Error updating summaries after batch recalculation:`, summaryError);
        results.summaryUpdateError = summaryError.message;
      }
    }
    return res.status(200).json({
      success: true,
      message: 'Historical recalculation completed',
      results
    });

  } catch (error) {
    console.error('Error in recalculateHistoricalEmissions:', error);
    return res.status(500).json({
      success: false,
      message: 'Error recalculating historical emissions',
      error: error.message
    });
  }
};

/**
 * 🆕 Batch update summaries for multiple clients
 * Useful for system maintenance or data migration
 */
const batchUpdateSummaries = async (req, res) => {
  try {
    const { clientIds, periodTypes = ['monthly', 'yearly', 'all-time'], year, month } = req.body;

    // Check permissions - only super admin
    if (req.user.userType !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Permission denied. Only super admin can perform batch summary updates.'
      });
    }

    if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'clientIds array is required'
      });
    }

    const { recalculateAndSaveSummary } = require('./CalculationSummary');
    const results = {
      totalClients: clientIds.length,
      successfulClients: 0,
      failedClients: 0,
      errors: [],
      summariesCreated: 0
    };

    for (const clientId of clientIds) {
      try {
        console.log(`📊 Updating summaries for client: ${clientId}`);
        let clientSummaryCount = 0;

        for (const periodType of periodTypes) {
          try {
            const summary = await recalculateAndSaveSummary(
              clientId, 
              periodType, 
              year, 
              month, 
              null, 
              null, 
              req.user._id
            );
            
            if (summary) {
              clientSummaryCount++;
              results.summariesCreated++;
            }
          } catch (periodError) {
            console.error(`Error updating ${periodType} summary for client ${clientId}:`, periodError);
            results.errors.push({
              clientId,
              periodType,
              error: periodError.message
            });
          }
        }

        if (clientSummaryCount > 0) {
          results.successfulClients++;
          console.log(`📊 ✅ Updated ${clientSummaryCount} summaries for client: ${clientId}`);
        } else {
          results.failedClients++;
        }

      } catch (clientError) {
        console.error(`Error updating summaries for client ${clientId}:`, clientError);
        results.failedClients++;
        results.errors.push({
          clientId,
          error: clientError.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Batch summary update completed. Updated summaries for ${results.successfulClients}/${results.totalClients} clients.`,
      results
    });

  } catch (error) {
    console.error('Error in batchUpdateSummaries:', error);
    return res.status(500).json({
      success: false,
      message: 'Error performing batch summary update',
      error: error.message
    });
  }
};


/**
 * Modified saveAPIData function with emission calculation
 */
const saveAPIDataWithEmission = async (apiData) => {
  try {
    // Save the data entry first
    const dataEntry = new DataEntry(apiData);
    await dataEntry.save();

    // Trigger emission calculation
    await triggerEmissionCalculation(dataEntry);

    return dataEntry;
  } catch (error) {
    console.error('Error in saveAPIDataWithEmission:', error);
    throw error;
  }
};

/**
 * Modified saveIoTData function with emission calculation
 */
const saveIoTDataWithEmission = async (iotData) => {
  try {
    // Save the data entry first
    const dataEntry = new DataEntry(iotData);
    await dataEntry.save();

    // Trigger emission calculation
    await triggerEmissionCalculation(dataEntry);

    return dataEntry;
  } catch (error) {
    console.error('Error in saveIoTDataWithEmission:', error);
    throw error;
  }
};

/**
 * Modified saveManualData function with emission calculation
 */
const saveManualDataWithEmission = async (manualData) => {
  try {
    // Save the data entry first
    const dataEntry = new DataEntry(manualData);
    await dataEntry.save();

    // Trigger emission calculation
    await triggerEmissionCalculation(dataEntry);

    return dataEntry;
  } catch (error) {
    console.error('Error in saveManualDataWithEmission:', error);
    throw error;
  }
};

/**
 * Validate emission calculation prerequisites
 */
const validateEmissionPrerequisites = async (clientId, nodeId, scopeIdentifier) => {
try {
// Check if flowchart exists
const activeChart = await getActiveFlowchart(clientId);
if (!activeChart) {
  return res.status(404).json({ message: 'No active flowchart found' });
}
const flowchart = activeChart.chart;
if (!flowchart) {
return {
isValid: false,
message: 'No active flowchart found for client'
};
}
// Check if node exists
const node = flowchart.nodes.find(n => n.id === nodeId);
if (!node) {
return {
isValid: false,
message: 'Node not found in flowchart'
};
}
// Check if scope configuration exists
const scopeConfig = node.details.scopeDetails.find(
s => s.scopeIdentifier === scopeIdentifier
);
if (!scopeConfig) {
return {
isValid: false,
message: 'Scope configuration not found'
};
}
// Check if emission factor is configured
if (!scopeConfig.emissionFactor) {
return {
isValid: false,
message: 'Emission factor not configured for this scope'
};
}
// For Custom Scope 1 EFs, ensure the right parameters are actually set
if (scopeConfig.scopeType === 'Scope 1' && scopeConfig.emissionFactor === 'Custom') {
const c = scopeConfig.emissionFactorValues.customEmissionFactor || {};
// 1) Combustion-style (we already had this)
if (
scopeConfig.categoryName.includes('Stationary Combustion') ||
scopeConfig.categoryName.includes('Mobile Combustion') ||
scopeConfig.categoryName.includes('Combustion')
) {
if (c.CO2_gwp == null && c.CH4_gwp == null && c.N2O_gwp == null) {
return {
isValid: false,
message: 'At least one custom GWP (CO2_gwp, CH4_gwp or N2O_gwp) must be configured'
};
}
}
// 2) Refrigeration‐only fugitive
// 2) Refrigeration‐only fugitive (match purely on activity)
 else if (/ref.*?geration/i.test(scopeConfig.activity) && scopeConfig.calculationModel === 'tier 1') {
      if (c.leakageRate == null || c.Gwp_refrigerant == null) {
        return {
          isValid: false,
          message: 'Leakage rate and refrigerant GWP must be configured for refrigeration'
        };
      }
    }
// 3) SF₆‐only fugitive
else if (
scopeConfig.categoryName.includes('Fugitive') &&
/SF6/i.test(scopeConfig.activity)
) {
if (c.GWP_SF6 == null) {
return {
isValid: false,
message: 'SF₆ GWP must be configured for custom emission factor'
};
}
}
// 4) CH₄-Leaks fugitive (before the generic‐fugitive catch-all)
    else if (/CH4[_ ]?Leaks/i.test(scopeConfig.activity)) {
    const c = scopeConfig.emissionFactorValues.customEmissionFactor || {};
      if (scopeConfig.calculationModel === 'tier 1') {
        if (c.EmissionFactorFugitiveCH4Leak == null || c.GWP_CH4_leak == null) {
          return { isValid: false,
                   message: 'EmissionFactorFugitiveCH4Leak and GWP_CH4_leak must be configured for CH₄ leaks (Tier 1)' };
        }
      } else {
        if (c.EmissionFactorFugitiveCH4Component == null || c.GWP_CH4_Component == null) {
          return { isValid: false,
                   message: 'EmissionFactorFugitiveCH4Component and GWP_CH4_Component must be configured for CH₄ leaks (Tier 2)' };
        }
      }
    }

// 4) Process Emission
else if (scopeConfig.categoryName.includes('Process Emission')) {
if (scopeConfig.calculationModel === 'tier 1') {
if (c.industryAverageEmissionFactor == null) {
return {
isValid: false,
message: 'Industry Average Emission Factor not configured for custom Process Emission'
};
}
}
else if (scopeConfig.calculationModel === 'tier 2') {
if (c.stoichiometicFactor == null || c.conversionEfficiency == null) {
return {
isValid: false,
message: 'Stoichiometric factor or conversion efficiency not configured for custom Process Emission'
};
}
}
}
}
return {
isValid: true,
scopeConfig
};
} catch (error) {
console.error('Error validating prerequisites:', error);
return {
isValid: false,
message: error.message
};
}
};

/**
 * 🆕 Get summary update status for a client
 */
const getSummaryUpdateStatus = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Check if user has permission to view this client's data
    // Add permission checking logic here

    // Get recent data entries and their summary update status
    const recentEntries = await DataEntry.find({
      clientId,
      timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
    })
    .select('_id timestamp emissionCalculationStatus summaryUpdateStatus summaryUpdateError')
    .sort({ timestamp: -1 })
    .limit(100)
    .lean();

    const stats = {
      total: recentEntries.length,
      emissionCalculated: recentEntries.filter(e => e.emissionCalculationStatus === 'completed').length,
      summaryUpdated: recentEntries.filter(e => e.summaryUpdateStatus !== 'failed').length,
      errors: recentEntries.filter(e => e.summaryUpdateStatus === 'failed').length
    };

    // Get latest summary update timestamps
    const EmissionSummary = require('../../models/EmissionSummary');
    const latestSummaries = await EmissionSummary.find({ clientId })
      .select('period metadata.lastCalculated')
      .sort({ 'metadata.lastCalculated': -1 })
      .limit(5)
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        clientId,
        stats,
        recentEntries: recentEntries.slice(0, 10), // Last 10 entries
        latestSummaries
      }
    });

  } catch (error) {
    console.error('Error getting summary update status:', error);
    return res.status(500).json({
      success: false,
      message: 'Error getting summary update status',
      error: error.message
    });
  }
};
/**
 * [NEW] Central handler for data changes (creations, updates, deletions)
 * to trigger summary recalculations.
 */
const handleDataChange = async (entry) => {
  try {
    if (entry._id) { // For new or updated entries
      console.log(`🔄 Recalculating summaries due to change in DataEntry: ${entry._id}`);
      await triggerEmissionCalculation(entry);
    } else { // For deleted entries
      console.log(`🔄 Recalculating summaries due to deletion of an entry on ${entry.timestamp}`);
      const { clientId, timestamp } = entry;
      const entryDate = moment.utc(timestamp);
      
      // Recalculate all affected periods
      await recalculateAndSaveSummary(clientId, 'daily', entryDate.year(), entryDate.month() + 1, null, entryDate.date());
      await recalculateAndSaveSummary(clientId, 'monthly', entryDate.year(), entryDate.month() + 1);
      await recalculateAndSaveSummary(clientId, 'yearly', entryDate.year());
      await recalculateAndSaveSummary(clientId, 'all-time');
    }
  } catch (error) {
    console.error('Error handling data change:', error);
    // Don't re-throw to avoid crashing the main operation
  }
};

module.exports = {
  triggerEmissionCalculation,
  recalculateHistoricalEmissions,
  batchUpdateSummaries,
  saveAPIDataWithEmission,
  saveIoTDataWithEmission,
  saveManualDataWithEmission,
  validateEmissionPrerequisites,
  getSummaryUpdateStatus,
  handleDataChange
};