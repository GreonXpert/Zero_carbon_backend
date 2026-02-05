// models/EmissionSummary.js

const mongoose = require('mongoose');

/**
 * Nested schema for the EMISSION side.
 * This groups everything under `emissionSummary` so that
 * emission and reduction both have a clean, structured object.
 */
const emissionDetailsSchema = new mongoose.Schema(
  {
    // Optional copy of period info (handy for frontend grouping)
    period: {
      type: {
        type: String,
        enum: ['daily', 'weekly', 'monthly', 'yearly', 'all-time'],
      },
      year: Number,
      month: Number, // 1-12
      week: Number,  // 1-53
      day: Number,   // 1-31
      date: Date,    // Specific date for daily summaries
      from: Date,    // Start date for the period
      to: Date       // End date for the period
    },

    // Total emissions across all scopes
    totalEmissions: {
      CO2e: { type: Number, default: 0 },
      CO2: { type: Number, default: 0 },
      CH4: { type: Number, default: 0 },
      N2O: { type: Number, default: 0 },
      uncertainty: { type: Number, default: 0 }
    },

    // Emissions by scope type
    byScope: {
      'Scope 1': {
        CO2e: { type: Number, default: 0 },
        CO2: { type: Number, default: 0 },
        CH4: { type: Number, default: 0 },
        N2O: { type: Number, default: 0 },
        uncertainty: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 }
      },
      'Scope 2': {
        CO2e: { type: Number, default: 0 },
        CO2: { type: Number, default: 0 },
        CH4: { type: Number, default: 0 },
        N2O: { type: Number, default: 0 },
        uncertainty: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 }
      },
      'Scope 3': {
        CO2e: { type: Number, default: 0 },
        CO2: { type: Number, default: 0 },
        CH4: { type: Number, default: 0 },
        N2O: { type: Number, default: 0 },
        uncertainty: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 }
      }
    },

    // Emissions by category
    byCategory: {
      type: Map,
      of: {
        scopeType: String,
        CO2e: { type: Number, default: 0 },
        CO2: { type: Number, default: 0 },
        CH4: { type: Number, default: 0 },
        N2O: { type: Number, default: 0 },
        uncertainty: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 },
        activities: {
          type: Map,
          of: {
            CO2e: { type: Number, default: 0 },
            CO2: { type: Number, default: 0 },
            CH4: { type: Number, default: 0 },
            N2O: { type: Number, default: 0 },
            uncertainty: { type: Number, default: 0 },
            dataPointCount: { type: Number, default: 0 }
          }
        }
      }
    },

    // Emissions by activity (across all categories)
    byActivity: {
      type: Map,
      of: {
        scopeType: String,
        categoryName: String,
        CO2e: { type: Number, default: 0 },
        CO2: { type: Number, default: 0 },
        CH4: { type: Number, default: 0 },
        N2O: { type: Number, default: 0 },
        uncertainty: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 }
      }
    },

    // Emissions by node
    byNode: {
      type: Map,
      of: {
        nodeLabel: String,
        department: String,
        location: String,
        CO2e: { type: Number, default: 0 },
        CO2: { type: Number, default: 0 },
        CH4: { type: Number, default: 0 },
        N2O: { type: Number, default: 0 },
        uncertainty: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 },
        byScope: {
          'Scope 1': {
            CO2e: { type: Number, default: 0 },
            CO2: { type: Number, default: 0 },
            CH4: { type: Number, default: 0 },
            N2O: { type: Number, default: 0 },
            uncertainty: { type: Number, default: 0 },
            dataPointCount: { type: Number, default: 0 }
          },
          'Scope 2': {
            CO2e: { type: Number, default: 0 },
            CO2: { type: Number, default: 0 },
            CH4: { type: Number, default: 0 },
            N2O: { type: Number, default: 0 },
            uncertainty: { type: Number, default: 0 },
            dataPointCount: { type: Number, default: 0 }
          },
          'Scope 3': {
            CO2e: { type: Number, default: 0 },
            CO2: { type: Number, default: 0 },
            CH4: { type: Number, default: 0 },
            N2O: { type: Number, default: 0 },
            uncertainty: { type: Number, default: 0 },
            dataPointCount: { type: Number, default: 0 }
          }
        }
      }
    },

    

    // Emissions by department
    byDepartment: {
      type: Map,
      of: {
        CO2e: { type: Number, default: 0 },
        CO2: { type: Number, default: 0 },
        CH4: { type: Number, default: 0 },
        N2O: { type: Number, default: 0 },
        uncertainty: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 },
        nodeCount: { type: Number, default: 0 }
      }
    },

    // Emissions by location
    byLocation: {
      type: Map,
      of: {
        CO2e: { type: Number, default: 0 },
        CO2: { type: Number, default: 0 },
        CH4: { type: Number, default: 0 },
        N2O: { type: Number, default: 0 },
        uncertainty: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 },
        nodeCount: { type: Number, default: 0 }
      }
    },

    // Input type breakdown
    byInputType: {
      manual: {
        CO2e: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 }
      },
      API: {
        CO2e: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 }
      },
      IOT: {
        CO2e: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 }
      }
    },

    // Emission factor source breakdown
    byEmissionFactor: {
      type: Map,
      of: {
        CO2e: { type: Number, default: 0 },
        dataPointCount: { type: Number, default: 0 },
        scopeTypes: {
          'Scope 1': { type: Number, default: 0 },
          'Scope 2': { type: Number, default: 0 },
          'Scope 3': { type: Number, default: 0 }
        }
      }
    },

    // Trends (comparing with previous period)
    trends: {
      totalEmissionsChange: {
        value: { type: Number, default: 0 },
        percentage: { type: Number, default: 0 },
        direction: { type: String, enum: ['up', 'down', 'same'], default: 'same' }
      },
      scopeChanges: {
        'Scope 1': {
          value: { type: Number, default: 0 },
          percentage: { type: Number, default: 0 },
          direction: { type: String, enum: ['up', 'down', 'same'], default: 'same' }
        },
        'Scope 2': {
          value: { type: Number, default: 0 },
          percentage: { type: Number, default: 0 },
          direction: { type: String, enum: ['up', 'down', 'same'], default: 'same' }
        },
        'Scope 3': {
          value: { type: Number, default: 0 },
          percentage: { type: Number, default: 0 },
          direction: { type: String, enum: ['up', 'down', 'same'], default: 'same' }
        }
      }
    },

    // Metadata specific to emission calculations
    metadata: {
      totalDataPoints: { type: Number, default: 0 },
      dataEntriesIncluded: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DataEntry' }],
      lastCalculated: { type: Date, default: Date.now },
      calculatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      version: { type: Number, default: 1 },
      isComplete: { type: Boolean, default: false },
      hasErrors: { type: Boolean, default: false },
      errors: [String],
      calculationDuration: Number, // in milliseconds
      // 🆕 Allocation metadata
    allocationApplied: { type: Boolean, default: false },
    sharedScopeIdentifiers: { type: Number, default: 0 },
    allocationWarnings: [String],
    // 🆕 ADD THESE:
  migratedData: { type: Boolean, default: false },
  preventAutoRecalculation: { type: Boolean, default: false }

    }
  },
  { _id: false }
);

/**
 * ROOT SCHEMA
 */
const emissionSummarySchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      index: true
    },

    // Time period for this summary (root for querying)
    period: {
      type: {
        type: String,
        enum: ['daily', 'weekly', 'monthly', 'yearly', 'all-time'],
        required: true
      },
      year: Number,
      month: Number, // 1-12
      week: Number,  // 1-53
      day: Number,   // 1-31
      date: Date,    // Specific date for daily summaries
      from: Date,    // Start date for the period
      to: Date       // End date for the period
    },

    /**
     * NEW: All emission-related details are grouped here.
     * This replaces the old root fields:
     *  totalEmissions, byScope, byCategory, byActivity,
     *  byNode, byDepartment, byLocation, byInputType,
     *  byEmissionFactor, trends, metadata (emission related).
     */
    emissionSummary: {
      type: emissionDetailsSchema,
      default: {}
    },

    /**
     * 🆕 PROCESS EMISSION SUMMARY
     * Filtered emission summary based on ProcessFlowchart nodes and scopes.
     * Only includes nodes and scopeIdentifiers that exist in the client's ProcessFlowchart.
     * This provides process-level emissions tracking separate from organization-level.
     * 
     * Structure mirrors emissionSummary for consistency:
     * - period: Time period matching root period
     * - totalEmissions: Total emissions from ProcessFlowchart nodes only
     * - byScope: Breakdown by Scope 1/2/3 (filtered)
     * - byCategory: Categories from ProcessFlowchart nodes only
     * - byActivity: Activities from ProcessFlowchart nodes only
     * - byNode: Only nodes that exist in ProcessFlowchart with allowed scopes
     * - byDepartment: Departments from ProcessFlowchart nodes only
     * - byLocation: Locations from ProcessFlowchart nodes only
     * - byInputType: Input type breakdown (filtered)
     * - byEmissionFactor: Emission factor breakdown (filtered)
     * - trends: Period-over-period comparison
     * - metadata: Calculation metadata specific to process emissions
     */
    processEmissionSummary: {
      type: emissionDetailsSchema,
      default: {}
    },

    /**
     * Global metadata for the summary document.
     * We KEEP this because it’s already used for:
     *  - metadata.lastCalculated (indexes)
     *  - metadata.hasReductionSummary, lastReductionSummaryCalculatedAt
     *    (set by netReductionSummaryController)
     */
    metadata: {
      totalDataPoints: { type: Number, default: 0 },
      dataEntriesIncluded: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DataEntry' }],
      lastCalculated: { type: Date, default: Date.now },
      calculatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      version: { type: Number, default: 1 },
      isComplete: { type: Boolean, default: false },
      hasErrors: { type: Boolean, default: false },
      errors: [String],
      calculationDuration: Number // in milliseconds
    },

    /**
     * REDUCTION SUMMARY (unchanged)
     */
    reductionSummary: {
      totalNetReduction: { type: Number, default: 0 },   // tCO2e
      entriesCount: { type: Number, default: 0 },

      /**
       * ✅ NEW (Backward Compatible)
       * Additional analytics for the Reduction Dashboard.
       *
       * This is OPTIONAL. If it is not present in old documents,
       * existing code continues to work.
       */
      calculationSummary: {
        // 1) Core KPIs
        totalNetReduction: { type: Number, default: 0 },
        totalTargetEmissionReduction: { type: Number, default: 0 },
        achievementPercentage: { type: Number, default: 0 },
        dataCompletenessPercentage: { type: Number, default: 0 },

        // 2) Trend Chart Data
        trendChart: {
          monthly: {
            type: [
              new mongoose.Schema(
                {
                  projectId: String,
                  projectName: String,
                  periodKey: String, // YYYY-MM
                  emissionReductionValue: { type: Number, default: 0 },
                  trendPercent: { type: Number, default: null },
                  trendDirection: { type: String, default: null } // up | down | flat
                },
                { _id: false }
              )
            ],
            default: []
          },
          quarterly: {
            type: [
              new mongoose.Schema(
                {
                  projectId: String,
                  projectName: String,
                  periodKey: String, // YYYY-Q#
                  emissionReductionValue: { type: Number, default: 0 },
                  trendPercent: { type: Number, default: null },
                  trendDirection: { type: String, default: null }
                },
                { _id: false }
              )
            ],
            default: []
          },
          yearly: {
            type: [
              new mongoose.Schema(
                {
                  projectId: String,
                  projectName: String,
                  periodKey: String, // YYYY
                  emissionReductionValue: { type: Number, default: 0 },
                  trendPercent: { type: Number, default: null },
                  trendDirection: { type: String, default: null }
                },
                { _id: false }
              )
            ],
            default: []
          }
        },

        // 3) GHG Mechanism Split
        ghgMechanismSplit: {
          totalReduction: { type: Number, default: 0 },
          totalRemoval: { type: Number, default: 0 },
          reductionPercent: { type: Number, default: 0 },
          removalPercent: { type: Number, default: 0 }
        },

        // 4) Top Source Table
        topSources: {
          type: [
            new mongoose.Schema(
              {
                source: { type: String, default: 'Unknown' },
                type: { type: String, default: 'unknown' }, // Removal | Reduction | unknown
                category: { type: String, default: 'Unknown' },
                emissionReduction: { type: Number, default: 0 },
                trend: { type: Number, default: null } // percent change vs previous period
              },
              { _id: false }
            )
          ],
          default: []
        },

        // 5) Process & Product Analysis Table
        processProductAnalysis: {
          type: [
            new mongoose.Schema(
              {
                project: { type: String, default: '' },
                projectId: { type: String, default: '' },
                processName: { type: String, default: null },
                unit: { type: String, default: null },
                emissionReduction: { type: Number, default: 0 },
                intensity: { type: Number, default: null },
                trend: { type: Number, default: null },
                status: { type: String, default: 'unknown' }
              },
              { _id: false }
            )
          ],
          default: []
        },

        // 6) Period Comparison
        periodComparison: {
          type: [
            new mongoose.Schema(
              {
                project: { type: String, default: '' },
                projectId: { type: String, default: '' },
                emissionReduction: { type: Number, default: 0 },
                previousEmissionReduction: { type: Number, default: 0 },
                delta: { type: Number, default: 0 },
                deltaPercent: { type: Number, default: null }
              },
              { _id: false }
            )
          ],
          default: []
        },

        // 7) Data Completeness Per Project
        dataCompletenessByProject: {
          type: [
            new mongoose.Schema(
              {
                projectName: { type: String, default: '' },
                projectId: { type: String, default: '' },
                percentage: { type: Number, default: 0 }
              },
              { _id: false }
            )
          ],
          default: []
        },

        // 8) Category Priorities
        categoryPriorities: {
          type: [
            new mongoose.Schema(
              {
                category: { type: String, default: 'Unknown' },
                totalEmissionReduction: { type: Number, default: 0 },
                sharePercent: { type: Number, default: 0 },
                trend: { type: Number, default: null }
              },
              { _id: false }
            )
          ],
          default: []
        },

        // Meta (optional)
        meta: {
          periodType: { type: String, default: '' },
          from: { type: Date, default: null },
          to: { type: Date, default: null },
          computedAt: { type: Date, default: null }
        }
      },

      // Array so frontend can list all projects
      byProject: [{
        projectId: { type: String },
        projectName: { type: String },
        projectActivity: { type: String },
        category: { type: String },
        scope: { type: String },   // text like "Scope 1", "Scope 2", etc.
        location: { type: String },   // formatted label, e.g. "Mumbai, India"
        methodology: { type: String },   // methodology1 / methodology2 / unknown
        totalNetReduction: { type: Number, default: 0 },
        entriesCount: { type: Number, default: 0 }
      }],

      // Simple objects keyed by name, e.g. "Scope 1", "Energy Efficiency"
      byCategory: {
        type: Map,
        of: new mongoose.Schema(
          {
            totalNetReduction: { type: Number, default: 0 },
            entriesCount: { type: Number, default: 0 }
          },
          { _id: false }
        ),
        default: {}
      },

      byScope: {
        type: Map,
        of: new mongoose.Schema(
          {
            totalNetReduction: { type: Number, default: 0 },
            entriesCount: { type: Number, default: 0 }
          },
          { _id: false }
        ),
        default: {}
      },

      byLocation: {
        type: Map,
        of: new mongoose.Schema(
          {
            totalNetReduction: { type: Number, default: 0 },
            entriesCount: { type: Number, default: 0 }
          },
          { _id: false }
        ),
        default: {}
      },

      byProjectActivity: {
        type: Map,
        of: new mongoose.Schema(
          {
            totalNetReduction: { type: Number, default: 0 },
            entriesCount: { type: Number, default: 0 }
          },
          { _id: false }
        ),
        default: {}
      },

      byMethodology: {
        type: Map,
        of: new mongoose.Schema(
          {
            totalNetReduction: { type: Number, default: 0 },
            entriesCount: { type: Number, default: 0 }
          },
          { _id: false }
        ),
        default: {}
      }
    }
  },
  {
    timestamps: true,
    indexes: [
      { clientId: 1, 'period.type': 1, 'period.year': 1, 'period.month': 1 },
      { clientId: 1, 'metadata.lastCalculated': -1 },
      { 'period.from': 1, 'period.to': 1 }
    ]
  }
);
emissionSummarySchema.index({
  clientId: 1,
  'period.type': 1,
  'period.year': -1,
  'period.month': -1,
  'period.week': -1,
  'period.day': -1
});
// =========================
// Instance Helper Methods
// =========================

/**
 * Helper method to get emission totals.
 * Now reads from `emissionSummary`, but falls back to old root fields
 * in case some legacy documents still have them.
 */
emissionSummarySchema.methods.getEmissionTotals = function () {
  const es = this.emissionSummary || {};
  const totalEmissions = es.totalEmissions || this.totalEmissions || {};
  const byScope = es.byScope || this.byScope || {};

  const s1 = byScope['Scope 1'] || {};
  const s2 = byScope['Scope 2'] || {};
  const s3 = byScope['Scope 3'] || {};

  return {
    totalCO2e: totalEmissions.CO2e || 0,
    scope1CO2e: s1.CO2e || 0,
    scope2CO2e: s2.CO2e || 0,
    scope3CO2e: s3.CO2e || 0,
    uncertainty: totalEmissions.uncertainty || 0
  };
};

/**
 * Helper method to get top categories.
 * Uses emissionSummary.byCategory, with fallback to old root byCategory.
 */
emissionSummarySchema.methods.getTopCategories = function (limit = 5) {
  const es = this.emissionSummary || {};
  const byCategory = es.byCategory || this.byCategory;

  if (!byCategory) return [];

  const categories = [];
  const iterable =
    byCategory instanceof Map ? byCategory : Object.entries(byCategory);

  for (const [categoryName, categoryData] of iterable) {
    if (!categoryData) continue;
    const totalEmissions =
      es.totalEmissions || this.totalEmissions || { CO2e: 0 };

    categories.push({
      categoryName,
      scopeType: categoryData.scopeType,
      CO2e: categoryData.CO2e,
      percentage:
        totalEmissions.CO2e > 0
          ? ((categoryData.CO2e / totalEmissions.CO2e) * 100).toFixed(2)
          : 0
    });
  }

  return categories.sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
};

/**
 * Helper method to get top activities.
 */
emissionSummarySchema.methods.getTopActivities = function (limit = 5) {
  const es = this.emissionSummary || {};
  const byActivity = es.byActivity || this.byActivity;

  if (!byActivity) return [];

  const activities = [];
  const iterable =
    byActivity instanceof Map ? byActivity : Object.entries(byActivity);

  for (const [activityName, activityData] of iterable) {
    if (!activityData) continue;
    const totalEmissions =
      es.totalEmissions || this.totalEmissions || { CO2e: 0 };

    activities.push({
      activityName,
      scopeType: activityData.scopeType,
      categoryName: activityData.categoryName,
      CO2e: activityData.CO2e,
      percentage:
        totalEmissions.CO2e > 0
          ? ((activityData.CO2e / totalEmissions.CO2e) * 100).toFixed(2)
          : 0
    });
  }

  return activities.sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
};

/**
 * Helper method to get top nodes.
 */
emissionSummarySchema.methods.getTopNodes = function (limit = 5) {
  const es = this.emissionSummary || {};
  const byNode = es.byNode || this.byNode;

  if (!byNode) return [];

  const nodes = [];
  const iterable =
    byNode instanceof Map ? byNode : Object.entries(byNode);

  for (const [nodeId, nodeData] of iterable) {
    if (!nodeData) continue;
    const totalEmissions =
      es.totalEmissions || this.totalEmissions || { CO2e: 0 };

    nodes.push({
      nodeId,
      nodeLabel: nodeData.nodeLabel,
      department: nodeData.department,
      location: nodeData.location,
      CO2e: nodeData.CO2e,
      percentage:
        totalEmissions.CO2e > 0
          ? ((nodeData.CO2e / totalEmissions.CO2e) * 100).toFixed(2)
          : 0
    });
  }

  return nodes.sort((a, b) => b.CO2e - a.CO2e).slice(0, limit);
};

// =========================
// Static Helpers
// =========================

/**
 * Static method to get date range for period type
 * (unchanged, still uses root `period`)
 */
emissionSummarySchema.statics.getDateRangeForPeriod = function (
  periodType,
  year,
  month,
  week,
  day
) {
  const now = new Date();
  let from, to;

  switch (periodType) {
    case 'daily':
      if (year && month && day) {
        from = new Date(year, month - 1, day, 0, 0, 0);
        to = new Date(year, month - 1, day, 23, 59, 59);
      } else {
        from = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          0,
          0,
          0
        );
        to = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          23,
          59,
          59
        );
      }
      break;

    case 'weekly':
      // Implementation for weekly range
      if (year && week) {
        const firstDayOfYear = new Date(year, 0, 1);
        const daysToWeek = (week - 1) * 7;
        from = new Date(
          firstDayOfYear.getTime() + daysToWeek * 24 * 60 * 60 * 1000
        );
        to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000);
      } else {
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        from = new Date(
          startOfWeek.getFullYear(),
          startOfWeek.getMonth(),
          startOfWeek.getDate(),
          0,
          0,
          0
        );
        to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000);
      }
      break;

    case 'monthly':
      if (year && month) {
        from = new Date(year, month - 1, 1, 0, 0, 0);
        to = new Date(year, month, 0, 23, 59, 59);
      } else {
        from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        to = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
          23,
          59,
          59
        );
      }
      break;

    case 'yearly':
      if (year) {
        from = new Date(year, 0, 1, 0, 0, 0);
        to = new Date(year, 11, 31, 23, 59, 59);
      } else {
        from = new Date(now.getFullYear(), 0, 1, 0, 0, 0);
        to = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
      }
      break;

    case 'all-time':
      from = new Date(2020, 0, 1, 0, 0, 0); // Start from 2020
      to = now;
      break;

    default:
      throw new Error(`Invalid period type: ${periodType}`);
  }

  return { from, to };
};

module.exports = mongoose.model('EmissionSummary', emissionSummarySchema);