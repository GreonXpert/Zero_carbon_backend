'use strict';

// ============================================================================
// analyticsController.js — GreOn IQ interaction analytics
//
// GET /api/greon-iq/analytics
//   Query params:
//     clientId  — required for consultant_admin / super_admin
//     period    — 'week' | 'month' | 'all'  (default: 'month')
//
//   Returns aggregated counts from GreOnIQInteractionEvent + ChatAuditLog:
//     summary          — totals per eventType + activeUsers
//     exportsByFormat  — pdf / docx / xlsx breakdown
//     dailyActivity    — per-day counts for charting (last N days)
//     topMessages      — messages with the most likes (top 5)
//     intentDistribution — top 10 intents by query count
//     moduleUsage      — modules queried most frequently
//
// GET /api/greon-iq/analytics/top-questions
//   Query params: clientId, period, limit (default 20)
//   Returns top intents with sample question and count.
//
// GET /api/greon-iq/analytics/liked-messages
//   Query params: clientId, period, page, limit
//   Returns paginated list of liked assistant messages with content preview.
//
// GET /api/greon-iq/analytics/pinned-sessions
//   Query params: clientId
//   Returns all currently-pinned sessions for the client.
// ============================================================================

const GreOnIQInteractionEvent = require('../models/GreOnIQInteractionEvent');
const ChatMessage             = require('../models/ChatMessage');
const ChatAuditLog            = require('../models/ChatAuditLog');
const ChatSession             = require('../models/ChatSession');

// ── Shared helpers ────────────────────────────────────────────────────────────

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

async function resolveScope(user, queryClientId) {
  const { resolveClientScope } = require('../services/clientScopeResolver');
  return resolveClientScope(user, queryClientId);
}

// ── getSummary — GET /analytics ───────────────────────────────────────────────

async function getSummary(req, res) {
  try {
    const user   = req.user;
    const period = ['week', 'month', 'all'].includes(req.query.period)
      ? req.query.period
      : 'month';

    const scopeResult = await resolveScope(user, req.query.clientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    if (scopeResult.needsClientResolution) {
      return res.status(400).json({ success: false, code: 'CLIENT_ID_REQUIRED', message: 'clientId is required for your role.' });
    }
    const { clientId } = scopeResult;

    const startDate  = periodStartDate(period);
    const matchBase  = { clientId };
    const auditMatch = { clientId, status: 'success' };
    if (startDate) {
      matchBase.createdAt  = { $gte: startDate };
      auditMatch.createdAt = { $gte: startDate };
    }

    // ── Run all aggregations in parallel ──────────────────────────────────
    const [
      eventCounts,
      exportFormats,
      dailyRaw,
      intentRaw,
      moduleRaw,
      activeUserIds,
    ] = await Promise.all([

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

      // 4. Intent distribution from audit log (top 10)
      ChatAuditLog.aggregate([
        { $match: { ...auditMatch, normalizedIntent: { $ne: null } } },
        { $group: { _id: '$normalizedIntent', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // 5. Module usage from audit log
      ChatAuditLog.aggregate([
        { $match: { ...auditMatch, modulesUsed: { $exists: true, $ne: [] } } },
        { $unwind: '$modulesUsed' },
        { $group: { _id: '$modulesUsed', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // 6. Active unique users
      ChatAuditLog.distinct('userId', auditMatch),
    ]);

    // ── Build summary object ───────────────────────────────────────────────
    const summary = {
      totalLikes:          0,
      totalDislikes:       0,
      totalExports:        0,
      totalPins:           0,
      totalUnpins:         0,
      totalFeedbackClears: 0,
      activeUsers:         activeUserIds.length,
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

    // ── Intent distribution ────────────────────────────────────────────────
    const intentDistribution = intentRaw.map((r) => ({ intent: r._id, count: r.count }));

    // ── Module usage ───────────────────────────────────────────────────────
    const moduleUsage = moduleRaw.map((r) => ({ module: r._id, count: r.count }));

    return res.status(200).json({
      success: true,
      period,
      clientId,
      summary,
      exportsByFormat,
      dailyActivity,
      topMessages,
      intentDistribution,
      moduleUsage,
    });
  } catch (err) {
    console.error('[GreOnIQ] analytics error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// ── getTopQuestions — GET /analytics/top-questions ───────────────────────────

async function getTopQuestions(req, res) {
  try {
    const user   = req.user;
    const period = ['week', 'month', 'all'].includes(req.query.period)
      ? req.query.period
      : 'month';
    const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 50);

    const scopeResult = await resolveScope(user, req.query.clientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    if (scopeResult.needsClientResolution) {
      return res.status(400).json({ success: false, code: 'CLIENT_ID_REQUIRED', message: 'clientId is required for your role.' });
    }
    const { clientId } = scopeResult;

    const startDate  = periodStartDate(period);
    const auditMatch = { clientId, status: 'success', normalizedIntent: { $ne: null } };
    if (startDate) auditMatch.createdAt = { $gte: startDate };

    const raw = await ChatAuditLog.aggregate([
      { $match: auditMatch },
      {
        $group: {
          _id:            '$normalizedIntent',
          count:          { $sum: 1 },
          sampleQuestion: { $last: '$question' },
          lastSeen:       { $max: '$createdAt' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]);

    const topIntents = raw.map((r) => ({
      intent:         r._id,
      count:          r.count,
      sampleQuestion: r.sampleQuestion,
      lastSeen:       r.lastSeen,
    }));

    return res.status(200).json({ success: true, period, clientId, topIntents });
  } catch (err) {
    console.error('[GreOnIQ] top-questions error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// ── getLikedMessages — GET /analytics/liked-messages ─────────────────────────

async function getLikedMessages(req, res) {
  try {
    const user   = req.user;
    const period = ['week', 'month', 'all'].includes(req.query.period)
      ? req.query.period
      : 'month';
    const page   = Math.max(parseInt(req.query.page,  10) || 1, 1);
    const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 50);

    const scopeResult = await resolveScope(user, req.query.clientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    if (scopeResult.needsClientResolution) {
      return res.status(400).json({ success: false, code: 'CLIENT_ID_REQUIRED', message: 'clientId is required for your role.' });
    }
    const { clientId } = scopeResult;

    const startDate  = periodStartDate(period);
    const matchBase  = { clientId, eventType: 'like' };
    if (startDate) matchBase.createdAt = { $gte: startDate };

    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      GreOnIQInteractionEvent.find(matchBase)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      GreOnIQInteractionEvent.countDocuments(matchBase),
    ]);

    // Populate message content for each event
    const messageIds = events.map((e) => e.messageId).filter(Boolean);
    const messages   = await ChatMessage.find({ _id: { $in: messageIds } })
      .select('content sessionId')
      .lean();
    const msgMap = {};
    for (const m of messages) msgMap[String(m._id)] = m;

    const likedMessages = events.map((e) => {
      const msg = e.messageId ? msgMap[String(e.messageId)] : null;
      return {
        messageId: e.messageId,
        sessionId: msg?.sessionId || e.sessionId,
        userId:    e.userId,
        likedAt:   e.createdAt,
        preview:   msg ? (msg.content || '').slice(0, 200) : null,
      };
    });

    return res.status(200).json({
      success: true,
      period,
      clientId,
      page,
      limit,
      total,
      likedMessages,
    });
  } catch (err) {
    console.error('[GreOnIQ] liked-messages error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

// ── getPinnedSessions — GET /analytics/pinned-sessions ───────────────────────

async function getPinnedSessions(req, res) {
  try {
    const user = req.user;

    const scopeResult = await resolveScope(user, req.query.clientId);
    if (scopeResult.error) {
      return res.status(400).json({ success: false, code: scopeResult.code, message: scopeResult.error });
    }
    if (scopeResult.needsClientResolution) {
      return res.status(400).json({ success: false, code: 'CLIENT_ID_REQUIRED', message: 'clientId is required for your role.' });
    }
    const { clientId } = scopeResult;

    const sessions = await ChatSession.find({ clientId, isPinned: true, isActive: true })
      .select('title userId messageCount updatedAt createdAt')
      .sort({ updatedAt: -1 })
      .lean();

    const pinnedSessions = sessions.map((s) => ({
      sessionId:    s._id,
      title:        s.title,
      userId:       s.userId,
      messageCount: s.messageCount,
      updatedAt:    s.updatedAt,
      createdAt:    s.createdAt,
    }));

    return res.status(200).json({
      success: true,
      clientId,
      total:          pinnedSessions.length,
      pinnedSessions,
    });
  } catch (err) {
    console.error('[GreOnIQ] pinned-sessions error:', err.message);
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}

module.exports = { getSummary, getTopQuestions, getLikedMessages, getPinnedSessions };
