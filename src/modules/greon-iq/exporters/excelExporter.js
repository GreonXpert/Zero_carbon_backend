'use strict';

// ============================================================================
// excelExporter.js — Converts report table data to Excel (xlsx)
//
// Uses exceljs (supports cell-level styling) so that:
//   - Column widths are set from header label lengths
//   - Header row is bold with a green background
//   - "Year XXXX" rows (period rows) get a distinct amber background
//   - Numbers stay as numbers (not strings)
// ============================================================================

const ExcelJS    = require('exceljs');
const { normalizeTable } = require('./tableNormalizer');

// Colour constants (ARGB hex — ExcelJS uses 8-char ARGB, no '#')
const HEADER_FILL  = 'FFD4EDDA'; // soft green — matches DOCX header
const YEAR_FILL    = 'FFFFF3CD'; // light amber — for "Year XXXX" rows
const HEADER_FONT  = '00000000'; // black
const YEAR_FONT    = 'FF856404'; // amber-brown text

/**
 * @param {object} reportData  — from reportService.assembleReportData() or
 *                               exportService._toReportDataShape()
 * @returns {Promise<Buffer>}
 */
async function toExcel(reportData) {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'GreOn IQ';
  wb.created  = new Date();
  wb.modified = new Date();

  let sheetIndex = 0;

  for (const section of (reportData.sections || [])) {
    for (const table of (section.tables || [])) {
      const norm = normalizeTable(table);
      if (norm.columns.length === 0 || norm.rows.length === 0) continue;

      const sheetName = (norm.title || `Sheet${sheetIndex + 1}`).slice(0, 31);
      const ws = wb.addWorksheet(sheetName, {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      // ── Column definitions + widths ──────────────────────────────────────
      ws.columns = norm.columns.map((col) => ({
        header: col.label,
        key:    col.key,
        width:  Math.min(40, Math.max(14, col.label.length + 4)),
      }));

      // ── Style header row ────────────────────────────────────────────────
      const headerRow = ws.getRow(1);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: HEADER_FONT } };
        cell.fill = {
          type:    'pattern',
          pattern: 'solid',
          fgColor: { argb: HEADER_FILL },
        };
        cell.alignment = { vertical: 'middle' };
      });
      headerRow.commit();

      // ── Detect the period column key (first column named 'period') ───────
      const periodColKey = norm.columns.find(
        (c) => c.key === 'period' || c.label.toLowerCase().includes('period')
      )?.key;

      // ── Data rows ───────────────────────────────────────────────────────
      for (const rowObj of norm.rows) {
        const values = norm.columns.reduce((acc, col) => {
          const v = rowObj[col.key];
          acc[col.key] = v === null || v === undefined ? '' : v;
          return acc;
        }, {});

        const exRow = ws.addRow(values);

        // Highlight "Year XXXX" rows
        const periodVal = periodColKey ? String(rowObj[periodColKey] ?? '') : '';
        if (/^Year\s+\d{4}/i.test(periodVal)) {
          exRow.eachCell((cell) => {
            cell.fill = {
              type:    'pattern',
              pattern: 'solid',
              fgColor: { argb: YEAR_FILL },
            };
            cell.font = { color: { argb: YEAR_FONT }, bold: true };
          });
        }

        exRow.commit();
      }

      if (norm.totalRows > norm.rows.length) {
        ws.addRow([`Showing ${norm.rows.length} of ${norm.totalRows} records.`]);
      }

      sheetIndex++;
    }
  }

  if (sheetIndex === 0) {
    const ws = wb.addWorksheet('Info');
    ws.addRow(['No tabular data available for this report.']);
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { toExcel };
