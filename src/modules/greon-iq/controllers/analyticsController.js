'use strict';

// ============================================================================
// analyticsController.js — GreOn IQ interaction analytics
//
// GET /api/greon-iq/analytics
//   Query params:
//     clientId  — required for consultant_admin / super_admin
//     period    — 'week' | 'month' | 'all'  (default: 'month')
//
// Returns aggregated counts from GreOnIQInteractionEvent:
//   summary          — totals per eventType
//   exportsByFormat  — pdf / docx / xlsx breakdown
//   dailyActivity    — per-day counts for charting (last N days)
//   topMessages      — messages with the most likes (top 5)
// ============================================================================

const GreOnIQInteractionEvent = require('../models/GreOnIQInteractionEvent');
const ChatMessage             = require('../models/ChatMessage');

// ── Helpers ──────────────────────────────────────────────────────────────────

function periodStartDate(period) {
  if (period === 'week')  return new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
  if (period === 'month') return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return null; // 'all'
}

function dateLabel(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildDailyBuckets(period) {
  const days = period === 'week' ? 7 : period === 'month' ? 30 : null;
  if (!days) return null;
  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    buckets[dateLabel(d)] = { date: dateLabel(d), likes: 0, dislikes: 0, exports: 0, pins: 0 };
  }
  return buckets;
}

// ── Controller ────────────────────────────────────────────────────────────────

async function getSummary(req, res) {
  try {
    const user     = req.user;
    const clientId = user.clientId || req.query.clientId;
    const period   = ['week', 'month', 'all'].includes(req.query.period)
      ? req.query.period
      : 'month';

    if (!clientId) {
      return res.status(400).json({
        success: false,
        code:    'MISSING_CLIENT_ID',
        message: 'clientId is required.',
      });
    }

    const startDate = periodStartDate(period);
    const matchBase = { clientId };
    if (startDate) matchBase.createdAt = { $gte: startDate };

    // ── Run all aggregations in parallel ──────────────────────────────────
    const [eventCounts, exportFormats, dailyRaw] = await Promise.all([

      // 1. Total per eventType
      GreOnIQInteractionEvent.aggregate([
        { $match: matchBase },
        { $group: { _id: '$eventType', count: { $sum: 1 } } },
      ]),

      // 2. Export format breakdown
      GreOnIQInteractionEvent.aggregate([
        { $match: { ...matchBase, eventType: 'export', exportFormat: { $ne: null } } },
        { $group: { _id: '$exportFormat', count: { $sum: 1 } } },
      ]),

      // 3. Daily activity (only for week/month)
      startDate
        ? GreOnIQInteractionEvent.aggregate([
            { $match: { ...matchBase, eventType: { $in: ['like', 'dislike', 'export', 'pin'] } } },
            {
              $group: {
                _id: {
                  date:      { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                  eventType: '$eventType',
                },
                count: { $sum: 1 },
              },
            },
            { $sort: { '_id.date': 1 } },
          ])
        : Promise.resolve([]),
    ]);

    // ── Build summary object ───────────────────────────────────────────────
    const summary = {
      totalLikes:          0,
      totalDislikes:       0,
      totalExports:        0,
      totalPins:           0,
      totalUnpins:         0,
      totalFeedbackClears: 0,
    };
    for (const e of eventCounts) {
      if (e._id === 'like')            summary.totalLikes          = e.count;
      if (e._id === 'dislike')         summary.totalDislikes       = e.count;
      if (e._id === 'export')          summary.totalExports        = e.count;
      if (e._id === 'pin')             summary.totalPins           = e.count;
      if (e._id === 'unpin')           summary.totalUnpins         = e.count;
      if (e._id === 'feedback_clear')  summary.totalFeedbackClears = e.count;
    }

    // ── Build export-format breakdown ──────────────────────────────────────
    const exportsByFormat = { pdf: 0, docx: 0, xlsx: 0 };
    for (const f of exportFormats) {
      if (f._id) exportsByFormat[f._id] = f.count;
    }

    // ── Build daily activity array ─────────────────────────────────────────
    let dailyActivity = null;
    if (startDate) {
      const buckets = buildDailyBuckets(period);
      for (const row of dailyRaw) {
        const bucket = buckets[row._id.date];
        if (bucket) {
          if (row._id.eventType === 'like')    bucket.likes    += row.count;
          if (row._id.eventType === 'dislike') bucket.dislikes += row.count;
          if (row._id.eventType === 'export')  bucket.exports  += row.count;
          if (row._id.eventType === 'pin')     bucket.pins     += row.count;
        }
      }
      dailyActivity = Object.values(buckets);
    }

    // ── Top 5 liked messages ───────────────────────────────────────────────
    const topLikedRaw = await GreOnIQInteractionEvent.aggregate([
      { $match: { ...matchBase, eventType: 'like' } },
      { $group: { _id: '$messageId', likeCount: { $sum: 1 } } },
      { $sort: { likeCount: -1 } },
      { $limit: 5 },
    ]);

    const topMessages = [];
    for (const row of topLikedRaw) {
      if (!row._id) continue;
      const msg = await ChatMessage.findById(row._id).select('content sessionId role').lean();
      if (msg && msg.role === 'assistant') {
        topMessages.push({
          messageId: row._id,
          likeCount: row.likeCount,
          preview:   (msg.content || '').slice(0, 120),
          sessionId: msg.sessionId,
        });
      }
    }

    return res.status(200).json({
      success: true,
      period,
      clientId,
      summary,
      exportsByFormat,
      dailyActivity,
      topMessages,
    });
  } catch (err) {
    console.error('[GreOnIQ] analytics error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

module.exports = { getSummary };
