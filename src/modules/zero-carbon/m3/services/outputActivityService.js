'use strict';

const OutputActivityRecord = require('../models/OutputActivityRecord');

async function createRecord(data, user) {
  const { target_id, calendar_year, output_value, denominator_unit, source_system } = data;

  if (!target_id || !calendar_year || output_value == null || !denominator_unit) {
    const e = new Error('target_id, calendar_year, output_value, and denominator_unit are required.');
    e.status = 422; throw e;
  }

  // Upsert: one record per target_id + calendar_year
  return OutputActivityRecord.findOneAndUpdate(
    { target_id, calendar_year },
    {
      $set: {
        clientId: data.clientId,
        output_value,
        denominator_unit,
        source_system: source_system || 'Manual',
        created_by: user._id,
      },
    },
    { upsert: true, new: true }
  );
}

async function listRecords(targetId, filters = {}) {
  const query = { target_id: targetId };
  if (filters.calendar_year) query.calendar_year = Number(filters.calendar_year);
  return OutputActivityRecord.find(query).sort({ calendar_year: -1 });
}

async function updateRecord(recordId, data, user) {
  const record = await OutputActivityRecord.findById(recordId);
  if (!record) { const e = new Error('Output activity record not found.'); e.status = 404; throw e; }

  const allowed = ['output_value', 'denominator_unit', 'source_system'];
  for (const key of allowed) {
    if (data[key] !== undefined) record[key] = data[key];
  }
  return record.save();
}

async function deleteRecord(recordId) {
  const record = await OutputActivityRecord.findById(recordId);
  if (!record) { const e = new Error('Output activity record not found.'); e.status = 404; throw e; }
  await record.deleteOne();
  return { deleted: true };
}

module.exports = { createRecord, listRecords, updateRecord, deleteRecord };
