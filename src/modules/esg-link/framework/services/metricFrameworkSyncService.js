'use strict';

const EsgMetric              = require('../../esgLink_core/metric/models/EsgMetric');
const QuestionMetricMapping  = require('../models/QuestionMetricMapping.model');

/**
 * Rebuilds the frameworkMappings cache and isBrsrCore flag on an EsgMetric
 * document every time a QuestionMetricMapping is created, updated, or deactivated.
 *
 * This is the ONLY function that should write frameworkMappings to EsgMetric.
 * Do NOT update that field directly anywhere else.
 *
 * @param {string|ObjectId} metricId
 * @returns {Promise<void>}
 */
const syncMetricFrameworkFlags = async (metricId) => {
  try {
    const activeMappings = await QuestionMetricMapping.find(
      { metricId, active: true },
      {
        frameworkCode: 1,
        questionCode:  1,
        sectionCode:   1,
        principleCode: 1,
        indicatorType: 1,
        isCore:        1,
        isBrsrCore:    1,
        _id:           1,
      }
    ).lean();

    const frameworkMappings = activeMappings.map((m) => ({
      frameworkCode: m.frameworkCode,
      questionCode:  m.questionCode,
      sectionCode:   m.sectionCode   || null,
      principleCode: m.principleCode || null,
      indicatorType: m.indicatorType || null,
      isCore:        m.isCore        || false,
      mappingId:     m._id,
    }));

    const brsrMappings = activeMappings.filter((m) => m.frameworkCode === 'BRSR');
    const isBrsrCore   = brsrMappings.some((m) => m.isCore || m.isBrsrCore);

    await EsgMetric.findByIdAndUpdate(
      metricId,
      { $set: { isBrsrCore, frameworkMappings } },
      { timestamps: false }   // don't bump updatedAt for a cache rebuild
    );
  } catch (err) {
    // Log but do not propagate — sync failures must not break the mapping operation
    console.error('[metricFrameworkSyncService] syncMetricFrameworkFlags failed:', err);
  }
};

module.exports = { syncMetricFrameworkFlags };
