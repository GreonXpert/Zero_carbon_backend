// models/EmissionSummary.js

const mongoose = require('mongoose');

const emissionSummarySchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  
  // Time period for this summary
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

  // Metadata
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
  }
}, {
  timestamps: true,
  indexes: [
    { clientId: 1, 'period.type': 1, 'period.year': 1, 'period.month': 1 },
    { clientId: 1, 'metadata.lastCalculated': -1 },
    { 'period.from': 1, 'period.to': 1 }
  ]
});

// Helper method to get emission totals
emissionSummarySchema.methods.getEmissionTotals = function() {
  return {
    totalCO2e: this.totalEmissions.CO2e,
    scope1CO2e: this.byScope['Scope 1'].CO2e,
    scope2CO2e: this.byScope['Scope 2'].CO2e,
    scope3CO2e: this.byScope['Scope 3'].CO2e,
    uncertainty: this.totalEmissions.uncertainty
  };
};

// Helper method to get top categories
emissionSummarySchema.methods.getTopCategories = function(limit = 5) {
  const categories = [];
  
  for (const [categoryName, categoryData] of this.byCategory) {
    categories.push({
      categoryName,
      scopeType: categoryData.scopeType,
      CO2e: categoryData.CO2e,
      percentage: this.totalEmissions.CO2e > 0 
        ? (categoryData.CO2e / this.totalEmissions.CO2e * 100).toFixed(2)
        : 0
    });
  }
  
  return categories
    .sort((a, b) => b.CO2e - a.CO2e)
    .slice(0, limit);
};

// Helper method to get top activities
emissionSummarySchema.methods.getTopActivities = function(limit = 5) {
  const activities = [];
  
  for (const [activityName, activityData] of this.byActivity) {
    activities.push({
      activityName,
      scopeType: activityData.scopeType,
      categoryName: activityData.categoryName,
      CO2e: activityData.CO2e,
      percentage: this.totalEmissions.CO2e > 0 
        ? (activityData.CO2e / this.totalEmissions.CO2e * 100).toFixed(2)
        : 0
    });
  }
  
  return activities
    .sort((a, b) => b.CO2e - a.CO2e)
    .slice(0, limit);
};

// Helper method to get top nodes
emissionSummarySchema.methods.getTopNodes = function(limit = 5) {
  const nodes = [];
  
  for (const [nodeId, nodeData] of this.byNode) {
    nodes.push({
      nodeId,
      nodeLabel: nodeData.nodeLabel,
      department: nodeData.department,
      location: nodeData.location,
      CO2e: nodeData.CO2e,
      percentage: this.totalEmissions.CO2e > 0 
        ? (nodeData.CO2e / this.totalEmissions.CO2e * 100).toFixed(2)
        : 0
    });
  }
  
  return nodes
    .sort((a, b) => b.CO2e - a.CO2e)
    .slice(0, limit);
};

// Static method to get date range for period type
emissionSummarySchema.statics.getDateRangeForPeriod = function(periodType, year, month, week, day) {
  const now = new Date();
  let from, to;

  switch (periodType) {
    case 'daily':
      if (year && month && day) {
        from = new Date(year, month - 1, day, 0, 0, 0);
        to = new Date(year, month - 1, day, 23, 59, 59);
      } else {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      }
      break;

    case 'weekly':
      // Implementation for weekly range
      if (year && week) {
        const firstDayOfYear = new Date(year, 0, 1);
        const daysToWeek = (week - 1) * 7;
        from = new Date(firstDayOfYear.getTime() + daysToWeek * 24 * 60 * 60 * 1000);
        to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000);
      } else {
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        from = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate(), 0, 0, 0);
        to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000);
      }
      break;

    case 'monthly':
      if (year && month) {
        from = new Date(year, month - 1, 1, 0, 0, 0);
        to = new Date(year, month, 0, 23, 59, 59);
      } else {
        from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
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