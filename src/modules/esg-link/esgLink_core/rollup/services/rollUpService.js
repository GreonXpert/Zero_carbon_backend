'use strict';

const EsgRollUpBehavior = require('../models/EsgRollUpBehavior');

const BUILT_IN_BEHAVIORS = [
  { code: 'sum',     label: 'Sum',     description: 'Sum all node values for the metric.',     isBuiltIn: true, isActive: true },
  { code: 'average', label: 'Average', description: 'Average all node values for the metric.', isBuiltIn: true, isActive: true },
];

async function seedBuiltInBehaviors() {
  for (const b of BUILT_IN_BEHAVIORS) {
    await EsgRollUpBehavior.updateOne(
      { code: b.code },
      { $setOnInsert: b },
      { upsert: true }
    );
  }
}

async function listBehaviors({ includeInactive = false } = {}) {
  const query = { isDeleted: false };
  if (!includeInactive) query.isActive = true;
  return EsgRollUpBehavior.find(query).sort({ isBuiltIn: -1, code: 1 }).lean();
}

async function getByCode(code) {
  return EsgRollUpBehavior.findOne({ code: code.toLowerCase(), isDeleted: false }).lean();
}

async function createBehavior({ code, label, description, createdBy }) {
  const existing = await EsgRollUpBehavior.findOne({ code: code.toLowerCase(), isDeleted: false });
  if (existing) throw Object.assign(new Error(`RollUpBehavior '${code}' already exists`), { status: 409 });
  return EsgRollUpBehavior.create({ code: code.toLowerCase(), label, description, isBuiltIn: false, createdBy });
}

async function updateBehavior(id, { label, description, isActive, updatedBy }) {
  const doc = await EsgRollUpBehavior.findOne({ _id: id, isDeleted: false });
  if (!doc) throw Object.assign(new Error('RollUpBehavior not found'), { status: 404 });
  if (label       !== undefined) doc.label       = label;
  if (description !== undefined) doc.description = description;
  if (isActive    !== undefined) doc.isActive    = isActive;
  doc.updatedBy = updatedBy;
  await doc.save();
  return doc.toObject();
}

async function deleteBehavior(id, deletedBy) {
  const doc = await EsgRollUpBehavior.findOne({ _id: id, isDeleted: false });
  if (!doc) throw Object.assign(new Error('RollUpBehavior not found'), { status: 404 });
  if (doc.isBuiltIn) throw Object.assign(new Error('Built-in behaviors cannot be deleted'), { status: 400 });
  doc.isDeleted = true;
  doc.deletedAt = new Date();
  doc.deletedBy = deletedBy;
  await doc.save();
  return { deleted: true };
}

module.exports = {
  seedBuiltInBehaviors,
  listBehaviors,
  getByCode,
  createBehavior,
  updateBehavior,
  deleteBehavior,
};
