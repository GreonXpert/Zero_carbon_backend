'use strict';

const mongoose = require('mongoose');

/**
 * DailySummarySnapshot — P2-01 pre-computed dashboard cache
 *
 * The nightly summarySnapshotJob computes the yearly and all-time emission
 * summaries for every active client and stores the result here.
 *
 * The dashboard GET /api/summaries/:clientId reads from this collection
 * first (single indexed query, < 50ms) and falls back to the existing
 * EmissionSummary + live-calculation path only when no snapshot is found.
 */
const dailySummarySnapshotSchema = new mongoose.Schema(
  {
    clientId: {
      type:     String,
      required: true,
      index:    true,
    },

    // UTC midnight of the calendar date this snapshot covers.
    // The cron upserts on { clientId, snapshotDate } so there is always
    // at most one snapshot per client per day.
    snapshotDate: {
      type:     Date,
      required: true,
    },

    // When the cron actually ran the computation.
    computedAt: {
      type:    Date,
      default: Date.now,
    },

    // TTL: MongoDB removes the document automatically after this date.
    // Set to 8 days after computedAt — keeps the last week of snapshots
    // for debugging without unbounded growth.
    expiresAt: {
      type:  Date,
    },

    // 'computing' = cron started but not finished (crash guard)
    // 'ready'     = yearlyData + allTimeData are populated and valid
    // 'failed'    = an error occurred; error field has the message
    status: {
      type:    String,
      enum:    ['computing', 'ready', 'failed'],
      default: 'computing',
    },

    // Populated only when status === 'failed'
    error: {
      type:    String,
      default: null,
    },

    // Calendar year for which yearlyData was computed (current year when cron ran).
    yearlyYear: {
      type: Number,
    },

    // Full EmissionSummary lean document for period.type === 'yearly'.
    // Shape mirrors the document returned by EmissionSummary.findOne().lean()
    // and returned by recalculateAndSaveSummary().
    yearlyData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Full EmissionSummary lean document for period.type === 'all-time'.
    allTimeData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'daily_summary_snapshots',
  }
);

// Compound unique index — one snapshot per client per calendar day.
// Listed as a compound index so lookup by (clientId, snapshotDate) is O(log n).
dailySummarySnapshotSchema.index(
  { clientId: 1, snapshotDate: -1 },
  { unique: true, name: 'clientId_snapshotDate_unique' }
);

// TTL index — MongoDB removes expired snapshots automatically.
dailySummarySnapshotSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'snapshot_ttl' }
);

module.exports = mongoose.model('DailySummarySnapshot', dailySummarySnapshotSchema);
