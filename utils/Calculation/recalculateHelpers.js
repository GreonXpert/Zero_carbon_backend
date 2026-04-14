// utils/recalculateHelpers.js

/**
 * Recalculates cumulative values for all entries that come after a newly inserted entry
 * This is necessary when entries are inserted with past dates
 */

/**
 * Recalculate NetReductionEntry cumulative values after a historical entry is inserted
 * @param {Object} insertedEntry - The newly saved NetReductionEntry
 */
async function recalculateNetReductionEntriesAfter(insertedEntry) {
  try {
    const NetReductionEntry = require('../models/Reduction/NetReductionEntry');
    
    console.log(`🔄 Recalculating net reduction entries after timestamp: ${insertedEntry.timestamp}`);
    
    // Find all entries that come AFTER the inserted entry (same client, project, methodology)
    const laterEntries = await NetReductionEntry.find({
      clientId: insertedEntry.clientId,
      projectId: insertedEntry.projectId,
      calculationMethodology: insertedEntry.calculationMethodology,
      timestamp: { $gt: insertedEntry.timestamp },
      _id: { $ne: insertedEntry._id }
    }).sort({ timestamp: 1 }); // Sort ascending (earliest first)
    
    if (laterEntries.length === 0) {
      console.log('✅ No later entries to recalculate');
      return { recalculated: 0 };
    }
    
    console.log(`📊 Found ${laterEntries.length} entries to recalculate`);
    
    // Helper function for rounding
    const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
    
    // Process each entry sequentially to maintain cumulative chain
    for (let i = 0; i < laterEntries.length; i++) {
      const entry = laterEntries[i];
      
      // Find the previous entry (which could be the newly inserted one or another recalculated one)
      const prev = await NetReductionEntry.findOne({
        clientId: entry.clientId,
        projectId: entry.projectId,
        calculationMethodology: entry.calculationMethodology,
        _id: { $ne: entry._id },
        timestamp: { $lt: entry.timestamp }
      })
        .sort({ timestamp: -1 })
        .select('cumulativeNetReduction highNetReduction lowNetReduction m3');
      
      // Recalculate cumulative values
      if (prev) {
        entry.cumulativeNetReduction = round6((prev.cumulativeNetReduction || 0) + (entry.netReduction || 0));
        entry.highNetReduction = Math.max(prev.highNetReduction ?? entry.netReduction, entry.netReduction);
        entry.lowNetReduction = Math.min(
          (typeof prev.lowNetReduction === 'number' ? prev.lowNetReduction : entry.netReduction),
          entry.netReduction
        );
        
        // 🔹 If Methodology 3, also recalculate cumulative totals in m3
        if (entry.calculationMethodology === 'methodology3' && entry.m3 && prev.m3) {
          entry.m3.cumulativeBE = round6((prev.m3.cumulativeBE || 0) + (entry.m3.BE_total || 0));
          entry.m3.cumulativePE = round6((prev.m3.cumulativePE || 0) + (entry.m3.PE_total || 0));
          entry.m3.cumulativeLE = round6((prev.m3.cumulativeLE || 0) + (entry.m3.LE_total || 0));
          entry.m3.cumulativeNetWithoutUncertainty = round6(
            (prev.m3.cumulativeNetWithoutUncertainty || 0) + (entry.m3.netWithoutUncertainty || 0)
          );
          entry.m3.cumulativeNetWithUncertainty = round6(
            (prev.m3.cumulativeNetWithUncertainty || 0) + (entry.m3.netWithUncertainty || 0)
          );
          
          // 🔹 Recalculate per-item cumulative values in breakdown
          if (entry.m3.breakdown) {
            // Baseline items
            if (entry.m3.breakdown.baseline && Array.isArray(entry.m3.breakdown.baseline)) {
              for (const item of entry.m3.breakdown.baseline) {
                const prevItem = prev.m3.breakdown?.baseline?.find(b => b.id === item.id);
                item.cumulativeValue = round6(
                  (prevItem?.cumulativeValue || 0) + (item.value || 0)
                );
              }
            }
            
            // Project items
            if (entry.m3.breakdown.project && Array.isArray(entry.m3.breakdown.project)) {
              for (const item of entry.m3.breakdown.project) {
                const prevItem = prev.m3.breakdown?.project?.find(p => p.id === item.id);
                item.cumulativeValue = round6(
                  (prevItem?.cumulativeValue || 0) + (item.value || 0)
                );
              }
            }
            
            // Leakage items
            if (entry.m3.breakdown.leakage && Array.isArray(entry.m3.breakdown.leakage)) {
              for (const item of entry.m3.breakdown.leakage) {
                const prevItem = prev.m3.breakdown?.leakage?.find(l => l.id === item.id);
                item.cumulativeValue = round6(
                  (prevItem?.cumulativeValue || 0) + (item.value || 0)
                );
              }
            }
          }
          
          entry.markModified('m3');
        }
      } else {
        // This should not happen if data is consistent, but handle gracefully
        entry.cumulativeNetReduction = round6(entry.netReduction || 0);
        entry.highNetReduction = entry.netReduction || 0;
        entry.lowNetReduction = entry.netReduction || 0;
      }
      
      // Save without triggering pre-save hook again (set skipRecalculation flag)
      entry._skipRecalculation = true;
      await entry.save();
      
      console.log(`✅ Recalculated entry ${i + 1}/${laterEntries.length} (${entry._id})`);
    }
    
    console.log(`✅ Successfully recalculated ${laterEntries.length} entries`);
    return { recalculated: laterEntries.length };
    
  } catch (error) {
    console.error('❌ Error recalculating net reduction entries:', error);
    throw error;
  }
}

/**
 * Recalculate DataEntry cumulative values after a historical entry is inserted
 * @param {Object} insertedEntry - The newly saved DataEntry
 */
async function recalculateDataEntriesAfter(insertedEntry) {
  try {
    const DataEntry = require('../../models/Organization/DataEntry');
    
    console.log(`🔄 Recalculating data entries after timestamp: ${insertedEntry.timestamp}`);
    
    // Find all entries that come AFTER the inserted entry (same stream: client, node, scope, inputType)
    const laterEntries = await DataEntry.find({
      clientId: insertedEntry.clientId,
      nodeId: insertedEntry.nodeId,
      scopeIdentifier: insertedEntry.scopeIdentifier,
      inputType: insertedEntry.inputType,
      timestamp: { $gt: insertedEntry.timestamp },
      _id: { $ne: insertedEntry._id },
      isSummary: false // Don't recalculate summary entries
    }).sort({ timestamp: 1 }); // Sort ascending (earliest first)
    
    if (laterEntries.length === 0) {
      console.log('✅ No later entries to recalculate');
      return { recalculated: 0 };
    }
    
    console.log(`📊 Found ${laterEntries.length} entries to recalculate`);
    
    // Process each entry sequentially to maintain cumulative chain
    for (let i = 0; i < laterEntries.length; i++) {
      const entry = laterEntries[i];
      
      // Find the previous entry
      const previousEntry = await DataEntry.findOne({
        clientId: entry.clientId,
        nodeId: entry.nodeId,
        scopeIdentifier: entry.scopeIdentifier,
        inputType: entry.inputType,
        _id: { $ne: entry._id },
        timestamp: { $lt: entry.timestamp },
        isSummary: false
      }).sort({ timestamp: -1 });
      
      // Recalculate cumulative tracking
      const cumulativeValues = {};
      const highData = {};
      const lowData = {};
      const lastEnteredData = {};

      // Support both Map and plain object for dataValues
      const dataEntries = entry.dataValues instanceof Map
        ? [...entry.dataValues.entries()]
        : Object.entries(entry.dataValues || {});

      for (const [key, value] of dataEntries) {
        const numValue = Number(value);

        // Store last entered
        lastEnteredData[key] = numValue;

        // Calculate cumulative
        let cumulativeValue = numValue;
        if (previousEntry && previousEntry.cumulativeValues) {
          const prevCum = previousEntry.cumulativeValues instanceof Map
            ? (previousEntry.cumulativeValues.get(key) || 0)
            : (previousEntry.cumulativeValues[key] || 0);
          cumulativeValue = prevCum + numValue;
        }
        cumulativeValues[key] = cumulativeValue;

        // Update high/low
        let highValue = numValue;
        let lowValue = numValue;

        if (previousEntry && previousEntry.highData && previousEntry.lowData) {
          const prevHigh = previousEntry.highData instanceof Map
            ? previousEntry.highData.get(key)
            : previousEntry.highData[key];
          const prevLow = previousEntry.lowData instanceof Map
            ? previousEntry.lowData.get(key)
            : previousEntry.lowData[key];

          if (prevHigh !== undefined) {
            highValue = Math.max(prevHigh, numValue);
          }
          if (prevLow !== undefined) {
            lowValue = Math.min(prevLow, numValue);
          }
        }

        highData[key] = highValue;
        lowData[key] = lowValue;
      }
      
      // Update the entry
      entry.cumulativeValues = cumulativeValues;
      entry.highData = highData;
      entry.lowData = lowData;
      entry.lastEnteredData = lastEnteredData;
      
      // Save without triggering pre-save hook again
      entry._skipRecalculation = true;
      await entry.save();
      
      console.log(`✅ Recalculated entry ${i + 1}/${laterEntries.length} (${entry._id})`);
    }
    
    console.log(`✅ Successfully recalculated ${laterEntries.length} entries`);
    return { recalculated: laterEntries.length };
    
  } catch (error) {
    console.error('❌ Error recalculating data entries:', error);
    throw error;
  }
}

module.exports = {
  recalculateNetReductionEntriesAfter,
  recalculateDataEntriesAfter
};