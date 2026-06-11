'use strict';

const mongoose    = require('mongoose');
const RagAuditLog = require('../models/RagAuditLog');

const auditController = {
  async list(req, res, next) {
    try {
      const {
        action, actorId, resourceType, resourceId,
        organizationId, startDate, endDate,
        page = '1', limit = '50', sortOrder = 'desc'
      } = req.query;

      const query = {};

      if (action)         query.action = { $in: action.split(',') };
      if (actorId)        query['actor.userId']         = new mongoose.Types.ObjectId(actorId);
      if (resourceType)   query['resource.type']        = resourceType;
      if (resourceId)     query['resource.id']          = new mongoose.Types.ObjectId(resourceId);
      // organizationId is a custom string (e.g. "Greon008") — no ObjectId cast needed
      if (organizationId) query['actor.organizationId'] = organizationId;
      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate)   query.timestamp.$lte = new Date(endDate);
      }

      const p     = parseInt(page,  10);
      const l     = Math.min(parseInt(limit, 10), 200);
      const sort  = { timestamp: sortOrder === 'asc' ? 1 : -1 };

      const [logs, total] = await Promise.all([
        RagAuditLog.find(query).sort(sort).skip((p - 1) * l).limit(l).lean(),
        RagAuditLog.countDocuments(query)
      ]);

      res.json({ logs, total, page: p, pages: Math.ceil(total / l) });
    } catch (err) { next(err); }
  },

  async getById(req, res, next) {
    try {
      const log = await RagAuditLog.findById(req.params.id).lean();
      if (!log) return res.status(404).json({ error: 'AUDIT_LOG_NOT_FOUND' });
      res.json({ log });
    } catch (err) { next(err); }
  }
};

module.exports = { auditController };
