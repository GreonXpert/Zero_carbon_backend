'use strict';
/**
 * metricController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ESGLink Core — Metric Library handlers.
 *
 * Endpoints:
 *   Global metrics (no clientId in path):
 *     1.  POST   /metrics                         → createGlobalMetric
 *     2.  GET    /metrics                         → listGlobalMetrics
 *     3.  GET    /metrics/:metricId               → getMetricById
 *     4.  PUT    /metrics/:metricId               → updateMetric
 *     5.  PATCH  /metrics/:metricId/publish       → publishMetric
 *     6.  PATCH  /metrics/:metricId/retire        → retireMetric
 *     7.  DELETE /metrics/:metricId               → deleteMetric
 *
 *   Client-scoped metric routes:
 *     8.  POST   /:clientId/metrics               → createClientMetric
 *     9.  GET    /:clientId/metrics               → listClientMetrics
 *     10. GET    /:clientId/metrics/available     → listAvailableMetrics
 */

const mongoose = require('mongoose');
const EsgMetric = require('../models/EsgMetric');
const Client    = require('../../../../../modules/client-management/client/Client');
const Formula   = require('../../../../zero-carbon/reduction/models/Formula');
const {
  canManageGlobalMetric,
  canManageClientMetric,
  canViewClientMetrics,
} = require('../utils/metricPermissions');
const {
  generateMetricCode,
  validateSubcategoryCode,
  hasDefinitionChange,
} = require('../services/metricService');
const { logEventFireAndForget } = require('../../../../../common/services/audit/auditLogService');

// ── Shared helpers ─────────────────────────────────────────────────────────────

/**
 * Permission gate — sends 403 / 404 and returns true when denied.
 * Returns false when allowed (caller continues).
 */
const _guardPermission = (perm, res) => {
  if (perm.allowed) return false;
  if (perm.reason === 'Client not found') {
    res.status(404).json({ message: 'Client not found', code: 'CLIENT_NOT_FOUND' });
  } else {
    res.status(403).json({ message: 'Permission denied', reason: perm.reason });
  }
  return true;
};

/**
 * Validates formulaId exists and is not deleted.
 * Returns { valid, formula, message }.
 */
const _validateFormulaId = async (formulaId) => {
  if (!mongoose.Types.ObjectId.isValid(formulaId)) {
    return { valid: false, message: 'formulaId is not a valid ObjectId' };
  }
  const formula = await Formula.findOne({ _id: formulaId, isDeleted: { $ne: true } })
    .select('_id name expression variables');
  if (!formula) {
    return { valid: false, message: 'Formula not found or has been deleted' };
  }
  return { valid: true, formula };
};

/**
 * Builds common metric query filters from query params.
 * Returns a Mongoose filter object.
 */
const _buildListFilter = (query, baseFilter) => {
  const filter = { ...baseFilter, isDeleted: false };
  if (query.esgCategory)      filter.esgCategory     = query.esgCategory;
  if (query.subcategoryCode)  filter.subcategoryCode = query.subcategoryCode;
  if (query.metricType)       filter.metricType      = query.metricType;
  if (query.publishedStatus)  filter.publishedStatus = query.publishedStatus;
  return filter;
};

// ── 1. createGlobalMetric ─────────────────────────────────────────────────────

const createGlobalMetric = async (req, res) => {
  try {
    const perm = canManageGlobalMetric(req.user);
    if (_guardPermission(perm, res)) return;

    const { metricName, metricDescription, esgCategory, subcategoryCode, metricType,
            primaryUnit, allowedUnits, dataType, formulaId,
            isBrsrCore, regulatorySourceRef, notesForUi } = req.body;

    // Required field validation
    if (!metricName || !esgCategory || !subcategoryCode || !metricType) {
      return res.status(400).json({
        message: 'metricName, esgCategory, subcategoryCode, and metricType are required',
        code: 'MISSING_REQUIRED_FIELDS',
      });
    }

    // subcategoryCode must match esgCategory
    const subCatCheck = validateSubcategoryCode(esgCategory, subcategoryCode);
    if (!subCatCheck.valid) {
      return res.status(400).json({ message: subCatCheck.message, code: 'INVALID_SUBCATEGORY' });
    }

    // formulaId required for derived / intensity
    if ((metricType === 'derived' || metricType === 'intensity')) {
      if (!formulaId) {
        return res.status(400).json({
          message: `formulaId is required when metricType is '${metricType}'`,
          code: 'FORMULA_REQUIRED',
        });
      }
      const fCheck = await _validateFormulaId(formulaId);
      if (!fCheck.valid) {
        return res.status(400).json({ message: fCheck.message, code: 'INVALID_FORMULA' });
      }
    }

    // Auto-generate metric code
    const metricCode = await generateMetricCode({
      esgCategory, subcategoryCode, isGlobal: true, clientId: null,
    });

    const metric = new EsgMetric({
      metricCode,
      metricName,
      metricDescription:    metricDescription    || null,
      esgCategory,
      subcategoryCode,
      metricType,
      isGlobal:             true,
      clientId:             null,
      primaryUnit:          primaryUnit           || null,
      allowedUnits:         allowedUnits          || [],
      dataType:             dataType              || 'number',
      formulaId:            formulaId             || null,
      publishedStatus:      'draft',
      version:              1,
      isBrsrCore:           isBrsrCore            || false,
      regulatorySourceRef:  regulatorySourceRef   || null,
      notesForUi:           notesForUi            || null,
      createdBy:            req.user._id,
    });

    await metric.save();

    logEventFireAndForget({
      req,
      module:        'esg_metric',
      action:        'create',
      subAction:     'global_metric_created',
      entityType:    'EsgMetric',
      entityId:      metric._id.toString(),
      clientId:      null,
      changeSummary: `Global metric "${metric.metricName}" (${metric.metricCode}) created`,
      severity:      'info',
      status:        'success',
    });

    return res.status(201).json({
      message: 'Global metric created successfully',
      metric: {
        _id:             metric._id,
        metricCode:      metric.metricCode,
        metricName:      metric.metricName,
        esgCategory:     metric.esgCategory,
        subcategoryCode: metric.subcategoryCode,
        metricType:      metric.metricType,
        publishedStatus: metric.publishedStatus,
        version:         metric.version,
        isGlobal:        metric.isGlobal,
        createdAt:       metric.createdAt,
      },
    });
  } catch (err) {
    console.error('[metricController] createGlobalMetric error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 2. listGlobalMetrics ──────────────────────────────────────────────────────

const listGlobalMetrics = async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.userType === 'super_admin' || user.userType === 'consultant_admin';

    // Admins see all statuses; others see only published
    let baseFilter = { isGlobal: true };
    if (!isAdmin) {
      baseFilter.publishedStatus = 'published';
    }

    const filter = _buildListFilter(req.query, baseFilter);

    // Admins can explicitly filter by status; non-admins have it locked to 'published'
    // so if they pass publishedStatus !== 'published', override it back
    if (!isAdmin) {
      filter.publishedStatus = 'published';
    }

    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const [metrics, total] = await Promise.all([
      EsgMetric.find(filter)
        .select('-__v')
        .sort({ esgCategory: 1, subcategoryCode: 1, metricCode: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      EsgMetric.countDocuments(filter),
    ]);

    return res.status(200).json({
      total,
      page,
      limit,
      metrics,
    });
  } catch (err) {
    console.error('[metricController] listGlobalMetrics error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 3. getMetricById ──────────────────────────────────────────────────────────

const getMetricById = async (req, res) => {
  try {
    const { metricId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(metricId)) {
      return res.status(400).json({ message: 'Invalid metricId', code: 'INVALID_ID' });
    }

    const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false }).lean();
    if (!metric) {
      return res.status(404).json({ message: 'Metric not found', code: 'METRIC_NOT_FOUND' });
    }

    // Visibility check
    if (metric.isGlobal) {
      // Global metrics: any authenticated esg_link user can view
      // (auth + eslGate already enforced at route level)
    } else {
      // Client-scoped: check view permission
      const perm = await canViewClientMetrics(req.user, metric.clientId);
      if (_guardPermission(perm, res)) return;
    }

    // Populate formula if metric is derived / intensity and has formulaId
    let formulaDetails = null;
    if (
      metric.formulaId &&
      (metric.metricType === 'derived' || metric.metricType === 'intensity')
    ) {
      formulaDetails = await Formula.findOne({
        _id: metric.formulaId,
        isDeleted: { $ne: true },
      }).select('_id name expression variables').lean();
    }

    return res.status(200).json({
      metric: {
        ...metric,
        formula: formulaDetails || null,
      },
    });
  } catch (err) {
    console.error('[metricController] getMetricById error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 4. updateMetric ───────────────────────────────────────────────────────────

const updateMetric = async (req, res) => {
  try {
    const { metricId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(metricId)) {
      return res.status(400).json({ message: 'Invalid metricId', code: 'INVALID_ID' });
    }

    const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false });
    if (!metric) {
      return res.status(404).json({ message: 'Metric not found', code: 'METRIC_NOT_FOUND' });
    }

    if (metric.publishedStatus === 'retired') {
      return res.status(400).json({
        message: 'Retired metrics cannot be updated',
        code: 'METRIC_RETIRED',
      });
    }

    // Permission check based on scope
    if (metric.isGlobal) {
      const perm = canManageGlobalMetric(req.user);
      if (_guardPermission(perm, res)) return;
    } else {
      const perm = await canManageClientMetric(req.user, metric.clientId);
      if (_guardPermission(perm, res)) return;
    }

    // Only these fields can be updated (metricCode, esgCategory, subcategoryCode,
    // metricType, isGlobal, clientId are immutable after creation)
    const ALLOWED_UPDATE_FIELDS = [
      'metricName', 'metricDescription', 'primaryUnit', 'allowedUnits',
      'dataType', 'formulaId', 'isBrsrCore', 'regulatorySourceRef', 'notesForUi',
    ];

    const payload = {};
    for (const field of ALLOWED_UPDATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        payload[field] = req.body[field];
      }
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        message: 'No updatable fields provided',
        code: 'NO_UPDATE_FIELDS',
      });
    }

    // Validate formulaId if being updated
    if (payload.formulaId) {
      const fCheck = await _validateFormulaId(payload.formulaId);
      if (!fCheck.valid) {
        return res.status(400).json({ message: fCheck.message, code: 'INVALID_FORMULA' });
      }
    }

    // Track if formulaId is changing (for subAction specificity)
    const formulaChanged =
      Object.prototype.hasOwnProperty.call(payload, 'formulaId') &&
      String(metric.formulaId) !== String(payload.formulaId);

    // Version bump only for definition-level changes
    const bumpVersion = hasDefinitionChange(payload);
    if (bumpVersion) {
      payload.version = metric.version + 1;
    }
    payload.updatedBy = req.user._id;

    Object.assign(metric, payload);
    await metric.save();

    logEventFireAndForget({
      req,
      module:        'esg_metric',
      action:        'update',
      subAction:     formulaChanged ? 'formula_ref_changed' : 'metric_updated',
      entityType:    'EsgMetric',
      entityId:      metric._id.toString(),
      clientId:      metric.clientId || null,
      changeSummary: `Metric "${metric.metricName}" (${metric.metricCode}) updated${bumpVersion ? ` — version bumped to ${metric.version}` : ''}`,
      metadata:      { updatedFields: Object.keys(payload).filter(f => f !== 'updatedBy'), versionBumped: bumpVersion },
      severity:      'info',
      status:        'success',
    });

    return res.status(200).json({
      message: 'Metric updated successfully',
      metric: {
        _id:             metric._id,
        metricCode:      metric.metricCode,
        metricName:      metric.metricName,
        publishedStatus: metric.publishedStatus,
        version:         metric.version,
        updatedAt:       metric.updatedAt,
      },
    });
  } catch (err) {
    console.error('[metricController] updateMetric error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 5. publishMetric ──────────────────────────────────────────────────────────

const publishMetric = async (req, res) => {
  try {
    const { metricId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(metricId)) {
      return res.status(400).json({ message: 'Invalid metricId', code: 'INVALID_ID' });
    }

    const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false });
    if (!metric) {
      return res.status(404).json({ message: 'Metric not found', code: 'METRIC_NOT_FOUND' });
    }

    // Publish is only valid for global metrics in draft status
    if (!metric.isGlobal) {
      return res.status(400).json({
        message: 'Client-scoped metrics are published automatically on creation',
        code: 'INVALID_OPERATION',
      });
    }

    const perm = canManageGlobalMetric(req.user);
    if (_guardPermission(perm, res)) return;

    if (metric.publishedStatus !== 'draft') {
      return res.status(400).json({
        message: `Cannot publish a metric with status '${metric.publishedStatus}'. Only draft metrics can be published.`,
        code: 'INVALID_STATUS_TRANSITION',
      });
    }

    metric.publishedStatus = 'published';
    metric.publishedAt     = new Date();
    metric.updatedBy       = req.user._id;
    await metric.save();

    logEventFireAndForget({
      req,
      module:        'esg_metric',
      action:        'update',
      subAction:     'metric_published',
      entityType:    'EsgMetric',
      entityId:      metric._id.toString(),
      clientId:      null,
      changeSummary: `Global metric "${metric.metricName}" (${metric.metricCode}) published`,
      severity:      'info',
      status:        'success',
    });

    return res.status(200).json({
      message: 'Metric published successfully',
      metric: {
        _id:             metric._id,
        metricCode:      metric.metricCode,
        metricName:      metric.metricName,
        publishedStatus: metric.publishedStatus,
        publishedAt:     metric.publishedAt,
      },
    });
  } catch (err) {
    console.error('[metricController] publishMetric error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 6. retireMetric ───────────────────────────────────────────────────────────

const retireMetric = async (req, res) => {
  try {
    const { metricId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(metricId)) {
      return res.status(400).json({ message: 'Invalid metricId', code: 'INVALID_ID' });
    }

    const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false });
    if (!metric) {
      return res.status(404).json({ message: 'Metric not found', code: 'METRIC_NOT_FOUND' });
    }

    // Permission based on scope
    if (metric.isGlobal) {
      const perm = canManageGlobalMetric(req.user);
      if (_guardPermission(perm, res)) return;
    } else {
      const perm = await canManageClientMetric(req.user, metric.clientId);
      if (_guardPermission(perm, res)) return;
    }

    if (metric.publishedStatus !== 'published') {
      return res.status(400).json({
        message: `Cannot retire a metric with status '${metric.publishedStatus}'. Only published metrics can be retired.`,
        code: 'INVALID_STATUS_TRANSITION',
      });
    }

    metric.publishedStatus = 'retired';
    metric.retiredAt       = new Date();
    metric.updatedBy       = req.user._id;
    await metric.save();

    logEventFireAndForget({
      req,
      module:        'esg_metric',
      action:        'update',
      subAction:     'metric_retired',
      entityType:    'EsgMetric',
      entityId:      metric._id.toString(),
      clientId:      metric.clientId || null,
      changeSummary: `Metric "${metric.metricName}" (${metric.metricCode}) retired`,
      severity:      'warning',
      status:        'success',
    });

    return res.status(200).json({
      message: 'Metric retired successfully',
      note: 'Any existing boundary mappings referencing this metric should be reviewed in Step 3.',
      metric: {
        _id:             metric._id,
        metricCode:      metric.metricCode,
        metricName:      metric.metricName,
        publishedStatus: metric.publishedStatus,
        retiredAt:       metric.retiredAt,
      },
    });
  } catch (err) {
    console.error('[metricController] retireMetric error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 7. deleteMetric ───────────────────────────────────────────────────────────

const deleteMetric = async (req, res) => {
  try {
    const { metricId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(metricId)) {
      return res.status(400).json({ message: 'Invalid metricId', code: 'INVALID_ID' });
    }

    const metric = await EsgMetric.findOne({ _id: metricId, isDeleted: false });
    if (!metric) {
      return res.status(404).json({ message: 'Metric not found', code: 'METRIC_NOT_FOUND' });
    }

    // Delete is restricted to super_admin / consultant_admin (global-manage level)
    const perm = canManageGlobalMetric(req.user);
    if (_guardPermission(perm, res)) return;

    metric.isDeleted  = true;
    metric.deletedAt  = new Date();
    metric.deletedBy  = req.user._id;
    await metric.save();

    logEventFireAndForget({
      req,
      module:        'esg_metric',
      action:        'delete',
      subAction:     'metric_deleted',
      entityType:    'EsgMetric',
      entityId:      metric._id.toString(),
      clientId:      metric.clientId || null,
      changeSummary: `Metric "${metric.metricName}" (${metric.metricCode}) soft-deleted`,
      severity:      'warning',
      status:        'success',
    });

    return res.status(200).json({
      message: 'Metric deleted successfully',
      deletedAt: metric.deletedAt,
    });
  } catch (err) {
    console.error('[metricController] deleteMetric error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 8. createClientMetric ─────────────────────────────────────────────────────

const createClientMetric = async (req, res) => {
  try {
    const { clientId } = req.params;

    const perm = await canManageClientMetric(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    // Verify client has esg_link module access
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found', code: 'CLIENT_NOT_FOUND' });
    }
    if (!Array.isArray(client.accessibleModules) || !client.accessibleModules.includes('esg_link')) {
      return res.status(403).json({
        message: 'Client does not have esg_link module access',
        code: 'MODULE_NOT_ACCESSIBLE',
      });
    }

    const { metricName, metricDescription, esgCategory, subcategoryCode,
            primaryUnit, allowedUnits, dataType, formulaId } = req.body;

    if (!metricName || !esgCategory || !subcategoryCode) {
      return res.status(400).json({
        message: 'metricName, esgCategory, and subcategoryCode are required',
        code: 'MISSING_REQUIRED_FIELDS',
      });
    }

    const subCatCheck = validateSubcategoryCode(esgCategory, subcategoryCode);
    if (!subCatCheck.valid) {
      return res.status(400).json({ message: subCatCheck.message, code: 'INVALID_SUBCATEGORY' });
    }

    // formulaId validation if provided
    if (formulaId) {
      const fCheck = await _validateFormulaId(formulaId);
      if (!fCheck.valid) {
        return res.status(400).json({ message: fCheck.message, code: 'INVALID_FORMULA' });
      }
    }

    const metricCode = await generateMetricCode({
      esgCategory, subcategoryCode, isGlobal: false, clientId,
    });

    // Client-scoped metrics: type is always 'client_defined', published immediately
    const metric = new EsgMetric({
      metricCode,
      metricName,
      metricDescription: metricDescription || null,
      esgCategory,
      subcategoryCode,
      metricType:        'client_defined',
      isGlobal:          false,
      clientId,
      primaryUnit:       primaryUnit || null,
      allowedUnits:      allowedUnits || [],
      dataType:          dataType || 'number',
      formulaId:         formulaId || null,
      publishedStatus:   'published',     // immediately available
      publishedAt:       new Date(),
      version:           1,
      createdBy:         req.user._id,
    });

    await metric.save();

    logEventFireAndForget({
      req,
      module:        'esg_metric',
      action:        'create',
      subAction:     'client_metric_created',
      entityType:    'EsgMetric',
      entityId:      metric._id.toString(),
      clientId,
      changeSummary: `Client-scoped metric "${metric.metricName}" (${metric.metricCode}) created for client ${clientId}`,
      severity:      'info',
      status:        'success',
    });

    return res.status(201).json({
      message: 'Client-scoped metric created successfully',
      metric: {
        _id:             metric._id,
        metricCode:      metric.metricCode,
        metricName:      metric.metricName,
        esgCategory:     metric.esgCategory,
        subcategoryCode: metric.subcategoryCode,
        metricType:      metric.metricType,
        publishedStatus: metric.publishedStatus,
        clientId:        metric.clientId,
        version:         metric.version,
        createdAt:       metric.createdAt,
      },
    });
  } catch (err) {
    console.error('[metricController] createClientMetric error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 9. listClientMetrics ──────────────────────────────────────────────────────

const listClientMetrics = async (req, res) => {
  try {
    const { clientId } = req.params;

    const perm = await canViewClientMetrics(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const filter = _buildListFilter(req.query, { isGlobal: false, clientId });

    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip  = (page - 1) * limit;

    const [metrics, total] = await Promise.all([
      EsgMetric.find(filter)
        .select('-__v')
        .sort({ esgCategory: 1, subcategoryCode: 1, metricCode: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      EsgMetric.countDocuments(filter),
    ]);

    return res.status(200).json({ total, page, limit, metrics });
  } catch (err) {
    console.error('[metricController] listClientMetrics error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── 10. listAvailableMetrics ──────────────────────────────────────────────────

const listAvailableMetrics = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Consultant-level access required (used for boundary mapping preparation)
    const perm = await canManageClientMetric(req.user, clientId);
    if (_guardPermission(perm, res)) return;

    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const skip  = (page - 1) * limit;

    // Build optional domain filter
    const domainFilter = {};
    if (req.query.esgCategory)     domainFilter.esgCategory     = req.query.esgCategory;
    if (req.query.subcategoryCode) domainFilter.subcategoryCode = req.query.subcategoryCode;
    if (req.query.metricType)      domainFilter.metricType      = req.query.metricType;

    // Union: published global metrics + all client-scoped metrics for this client
    const [globalMetrics, clientMetrics] = await Promise.all([
      EsgMetric.find({ isGlobal: true, publishedStatus: 'published', isDeleted: false, ...domainFilter })
        .select('-__v')
        .sort({ esgCategory: 1, subcategoryCode: 1, metricCode: 1 })
        .lean(),
      EsgMetric.find({ isGlobal: false, clientId, isDeleted: false, ...domainFilter })
        .select('-__v')
        .sort({ esgCategory: 1, subcategoryCode: 1, metricCode: 1 })
        .lean(),
    ]);

    const allMetrics = [...globalMetrics, ...clientMetrics];
    const total = allMetrics.length;
    const paginated = allMetrics.slice(skip, skip + limit);

    return res.status(200).json({
      total,
      page,
      limit,
      globalCount:      globalMetrics.length,
      clientScopedCount: clientMetrics.length,
      metrics:          paginated,
    });
  } catch (err) {
    console.error('[metricController] listAvailableMetrics error:', err);
    return res.status(500).json({ message: 'Internal server error', code: 'SERVER_ERROR' });
  }
};

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  createGlobalMetric,
  listGlobalMetrics,
  getMetricById,
  updateMetric,
  publishMetric,
  retireMetric,
  deleteMetric,
  createClientMetric,
  listClientMetrics,
  listAvailableMetrics,
};
