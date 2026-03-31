'use strict';

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const xlsx = require('xlsx');
const csv = require('csvtojson');
const CCTSEntity = require('../../models/CCTS/CCTSEntity');

// ─── Socket.IO ────────────────────────────────────────────────────────────────
let socketIO = null;
exports.setSocketIO = (io) => { socketIO = io; };

function emitUpdate(action, count = 1) {
  if (socketIO) {
    socketIO.emit('ccts:updated', { action, count, timestamp: new Date().toISOString() });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getUser = (req) => req.user?.userName || req.user?.email || req.user?.id || 'system';

const parseNum = (val) => {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(String(val).trim().replace(/,/g, ''));
  return isNaN(n) ? null : n;
};

const clean = (val) => (val !== undefined && val !== null ? String(val).trim() : '');

/**
 * Normalise a raw Excel/CSV row to our schema fields.
 * Handles multiple column name variants that may appear in uploaded files.
 */
function normalizeRow(raw) {
  const g = (...keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') {
        return String(raw[k]).trim();
      }
    }
    return '';
  };

  return {
    sector: g('Sector', 'sector', 'SECTOR'),
    subSector: g('Sub-sector', 'Sub Sector', 'SubSector', 'subSector', 'SUB-SECTOR', 'SUB SECTOR'),
    registrationNumber: g(
      'Registration Number', 'registrationNumber', 'Reg No', 'Reg. No', 'RegNo',
      'REGISTRATION NUMBER', 'Registration No', 'Reg No.'
    ),
    entityName: g('Entity Name', 'entityName', 'Name', 'ENTITY NAME', 'Obligated Entity'),
    state: g('State', 'state', 'STATE'),
    obligatedEntityAddress: g(
      'Obligated Entity Address', 'obligatedEntityAddress', 'Address', 'ADDRESS',
      'Entity Address', 'Obligated Entity Add'
    ),
    baselineOutput: parseNum(
      g(
        'Baseline Output (2023-2024)(Tonne)',
        'Baseline Output (2023-2024) (Tonne)',
        'Baseline Output',
        'baselineOutput',
        'Baseline Output (Tonne)',
        'Baseline Output(Tonne)'
      )
    ),
    baselineGHGEmissionIntensity: parseNum(
      g(
        'Baseline GHG Emission Intensity (2024-24) -(tCO2e/ tonne eq.product)',
        'Baseline GHG Emission Intensity (2023-24) -(tCO2e/ tonne eq.product)',
        'Baseline GHG Emission Intensity',
        'baselineGHGEmissionIntensity',
        'Baseline GHG',
        'Baseline GEI',
        'Baseline GHG Intensity'
      )
    ),
    targetGEI_2025_26: parseNum(
      g(
        'Target Get 2025-26-(tCO2e / tonne eq.product)',
        'Target GEI 2025-26 (tCO2e / tonne eq.product)',
        'Target GEI 2025-26',
        'targetGEI_2025_26',
        'Target GEI 2025/26'
      )
    ),
    targetGEI_2026_27: parseNum(
      g(
        'Target GEI 2026-27 (tCO2e / tonne eq.product)',
        'Target GEI 2026-27',
        'targetGEI_2026_27',
        'Target GEI 2026/27'
      )
    ),
    targetReduction_2025_26: parseNum(
      g(
        'Target Reduction 2025-26 from baseline (tCO2e / tonne eq.product)',
        'Target Reduction 2025-26',
        'targetReduction_2025_26',
        'Target Reduction 2025/26'
      )
    ),
    targetReduction_2026_27: parseNum(
      g(
        'Target Reduction 2026-27 from baseline (tCO2e / tonne eq.product)',
        'Target Reduction 2026-27',
        'targetReduction_2026_27',
        'Target Reduction 2026/27'
      )
    ),
    targetEstimatedReduction_2025_26: parseNum(
      g(
        'Target Estimated Reduction 2025-26 from baseline (Tonne)',
        'Target Estimated Reduction 2025-26',
        'targetEstimatedReduction_2025_26',
        'Est. Reduction 2025-26',
        'Estimated Reduction 2025-26'
      )
    ),
    targetEstimatedReduction_2026_27: parseNum(
      g(
        'Target Estimated Reduction 2026-27 from baseline (Tonne)',
        'Target Estimated Reduction 2026-27',
        'targetEstimatedReduction_2026_27',
        'Est. Reduction 2026-27',
        'Estimated Reduction 2026-27'
      )
    ),
    source: g('Source', 'source', 'SOURCE', 'PDF Source', 'Source URL', 'Document Source'),
  };
}

// ─── GET list ─────────────────────────────────────────────────────────────────
exports.getCCTSEntities = async (req, res) => {
  try {
    const {
      search,
      sector,
      subSector,
      state,
      source,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 50,
    } = req.query;

    const filter = {};

    if (search && search.trim()) {
      filter.$text = { $search: search.trim() };
    }
    if (sector)    filter.sector    = { $regex: new RegExp(sector.trim(), 'i') };
    if (subSector) filter.subSector = { $regex: new RegExp(subSector.trim(), 'i') };
    if (state)     filter.state     = { $regex: new RegExp(state.trim(), 'i') };
    if (source)    filter.source    = { $regex: new RegExp(source.trim(), 'i') };

    const allowedSort = [
      'sector',
      'subSector',
      'registrationNumber',
      'entityName',
      'state',
      'source',
      'baselineOutput',
      'baselineGHGEmissionIntensity',
      'targetGEI_2025_26',
      'targetGEI_2026_27',
      'targetReduction_2025_26',
      'targetReduction_2026_27',
      'targetEstimatedReduction_2025_26',
      'targetEstimatedReduction_2026_27',
      'createdAt',
      'updatedAt',
    ];

    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'createdAt';
    const safeSortOrder = sortOrder === 'asc' ? 1 : -1;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const sortObj = {};
    if (search && search.trim()) sortObj.score = { $meta: 'textScore' };
    sortObj[safeSortBy] = safeSortOrder;

    const [data, total] = await Promise.all([
      CCTSEntity.find(
        filter,
        search && search.trim() ? { score: { $meta: 'textScore' } } : undefined
      )
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CCTSEntity.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        limit: limitNum,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── GET single ───────────────────────────────────────────────────────────────
exports.getCCTSEntityById = async (req, res) => {
  try {
    const entity = await CCTSEntity.findById(req.params.id).lean();
    if (!entity) return res.status(404).json({ success: false, error: 'Entity not found' });
    res.status(200).json({ success: true, data: entity });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── CREATE single ────────────────────────────────────────────────────────────
exports.createCCTSEntity = async (req, res) => {
  try {
    const userName = getUser(req);

    const payload = {
      ...req.body,
      source: clean(req.body.source),
      createdBy: userName,
      updatedBy: userName,
    };

    const entity = await CCTSEntity.create(payload);

    emitUpdate('create', 1);
    res.status(201).json({
      success: true,
      data: entity,
      message: 'Entity created successfully',
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, error: 'Registration number already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── UPDATE (PATCH) ───────────────────────────────────────────────────────────
exports.updateCCTSEntity = async (req, res) => {
  try {
    const userName = getUser(req);

    const payload = {
      ...req.body,
      ...(req.body.source !== undefined ? { source: clean(req.body.source) } : {}),
      updatedBy: userName,
    };

    const updated = await CCTSEntity.findByIdAndUpdate(
      req.params.id,
      payload,
      { new: true, runValidators: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    emitUpdate('update', 1);
    res.status(200).json({
      success: true,
      data: updated,
      message: 'Entity updated successfully',
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, error: 'Registration number already exists' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── DELETE single ────────────────────────────────────────────────────────────
exports.deleteCCTSEntity = async (req, res) => {
  try {
    const deleted = await CCTSEntity.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ success: false, error: 'Entity not found' });
    emitUpdate('delete', 1);
    res.status(200).json({ success: true, message: 'Entity deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── BULK DELETE ──────────────────────────────────────────────────────────────
exports.bulkDeleteCCTSEntities = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: '`ids` must be a non-empty array' });
    }

    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid ObjectIds provided' });
    }

    const result = await CCTSEntity.deleteMany({ _id: { $in: validIds } });
    emitUpdate('bulk-delete', result.deletedCount);

    res.status(200).json({
      success: true,
      deleted: result.deletedCount,
      message: `${result.deletedCount} entity(ies) deleted successfully`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── BULK UPLOAD ──────────────────────────────────────────────────────────────
exports.bulkUpload = async (req, res) => {
  const BATCH_SIZE = 1000;
  const MAX_ERRORS = 50;

  const results = {
    fileType: '',
    totalRows: 0,
    validRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const userName = getUser(req);

  const addError = (row, msg) => {
    results.skipped++;
    if (results.errors.length < MAX_ERRORS) {
      results.errors.push({ row, error: msg });
    }
  };

  try {
    let rawRows = [];

    if (ext === '.csv') {
      results.fileType = 'csv';
      rawRows = await csv().fromFile(filePath);
    } else if (ext === '.xlsx' || ext === '.xls') {
      results.fileType = ext.replace('.', '');
      const workbook = xlsx.readFile(filePath, { cellDates: true });
      const sheetName = workbook.SheetNames[0];
      rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    } else {
      return res.status(400).json({ success: false, error: `Unsupported file type: ${ext}` });
    }

    results.totalRows = rawRows.length;

    const ops = [];

    for (let i = 0; i < rawRows.length; i++) {
      const rowNum = i + 2;
      const r = normalizeRow(rawRows[i]);

      if (!r.registrationNumber) {
        addError(rowNum, 'Missing Registration Number — row skipped');
        continue;
      }

      results.validRows++;

      ops.push({
        updateOne: {
          filter: { registrationNumber: r.registrationNumber },
          upsert: true,
          update: {
            $set: {
              sector: r.sector || undefined,
              subSector: r.subSector || undefined,
              entityName: r.entityName || undefined,
              state: r.state || undefined,
              obligatedEntityAddress: r.obligatedEntityAddress || undefined,
              source: r.source || undefined,
              baselineOutput: r.baselineOutput,
              baselineGHGEmissionIntensity: r.baselineGHGEmissionIntensity,
              targetGEI_2025_26: r.targetGEI_2025_26,
              targetGEI_2026_27: r.targetGEI_2026_27,
              targetReduction_2025_26: r.targetReduction_2025_26,
              targetReduction_2026_27: r.targetReduction_2026_27,
              targetEstimatedReduction_2025_26: r.targetEstimatedReduction_2025_26,
              targetEstimatedReduction_2026_27: r.targetEstimatedReduction_2026_27,
              updatedBy: userName,
            },
            $setOnInsert: {
              registrationNumber: r.registrationNumber,
              createdBy: userName,
            },
          },
        },
      });

      if (ops.length >= BATCH_SIZE) {
        await flushBatch(ops, results);
        ops.length = 0;
      }
    }

    if (ops.length > 0) {
      await flushBatch(ops, results);
    }

    emitUpdate('bulk-upload', results.created + results.updated);

    res.status(200).json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    fs.unlink(filePath, () => {});
  }
};

// ── Helper: flush bulkWrite batch ─────────────────────────────────────────────
async function flushBatch(ops, results) {
  if (!ops.length) return;
  try {
    const r = await CCTSEntity.bulkWrite(ops, { ordered: false });
    results.created += r.upsertedCount ?? 0;
    results.updated += r.modifiedCount ?? 0;
  } catch (err) {
    if (err?.name === 'BulkWriteError' || err?.result) {
      const r = err.result || err;
      results.created += r.upsertedCount ?? 0;
      results.updated += r.modifiedCount ?? 0;
    } else {
      throw err;
    }
  }
}