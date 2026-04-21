'use strict';

// ============================================================================
// docxExporter.js — Converts report data to .docx buffer
//
// Uses the `docx` npm package if available.
// Falls back to returning a plain-text buffer with a warning if docx is not
// installed (so the export pipeline never hard-crashes).
//
// Fixes vs original:
//   1. Markdown narrative is parsed into real DOCX elements (headings, bullets,
//      bold text) instead of dumped as a raw string.
//   2. Tables use normalizeTable() so all four column/row shapes work correctly.
// ============================================================================

const { normalizeTable } = require('./tableNormalizer');

/**
 * @param {object} reportData  — from reportService.assembleReportData() or
 *                               exportService._toReportDataShape()
 * @returns {Promise<Buffer>}
 */
async function toDocx(reportData) {
  try {
    const {
      Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
      HeadingLevel, WidthType, BorderStyle,
    } = require('docx');

    const { meta, sections, exclusions } = reportData;
    const children = [];

    // ── Title ──────────────────────────────────────────────────────────────
    children.push(new Paragraph({
      text:    meta.title || 'GreOn IQ Report',
      heading: HeadingLevel.TITLE,
    }));

    // ── Meta line ──────────────────────────────────────────────────────────
    const metaParts = [];
    if (meta.clientName) metaParts.push(`Client: ${meta.clientName}`);
    if (meta.period)     metaParts.push(`Period: ${meta.period}`);
    metaParts.push(`Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
    children.push(new Paragraph({
      children: [new TextRun({ text: metaParts.join('   |   '), color: '666666', size: 20 })],
    }));
    children.push(new Paragraph({ text: '' }));

    // ── Sections ───────────────────────────────────────────────────────────
    for (const section of (sections || [])) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));

      if (section.narrative) {
        // Parse markdown into proper DOCX paragraphs — no raw ** or ## in output
        const narrativeParas = _markdownToDocxParagraphs(
          section.narrative,
          { Paragraph, TextRun, HeadingLevel }
        );
        children.push(...narrativeParas);
      }
      children.push(new Paragraph({ text: '' }));

      // ── Tables ────────────────────────────────────────────────────────
      for (const table of (section.tables || [])) {
        const norm = normalizeTable(table);

        children.push(new Paragraph({ text: norm.title, heading: HeadingLevel.HEADING_2 }));

        const border    = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
        const borders   = { top: border, bottom: border, left: border, right: border };
        const colCount  = Math.max(norm.columns.length, 1);
        const colWidth  = Math.floor(9360 / colCount);

        // Header row — green background, bold labels
        const headerRow = new TableRow({
          children: norm.columns.map((col) => new TableCell({
            borders,
            width:   { size: colWidth, type: WidthType.DXA },
            shading: { fill: 'D4EDDA' },
            children: [new Paragraph({
              children: [new TextRun({ text: col.label, bold: true })],
            })],
          })),
        });

        // Detect period column (first col named 'period' or label containing 'period')
        const periodColKey = norm.columns.find(
          (c) => c.key === 'period' || c.label.toLowerCase().includes('period')
        )?.key;

        // Data rows — "Year XXXX" rows get a distinct amber background
        const dataRows = norm.rows.map((row) => {
          const periodVal = periodColKey ? String(row[periodColKey] ?? '') : '';
          const isYearRow = /^Year\s+\d{4}/i.test(periodVal);
          return new TableRow({
            children: norm.columns.map((col) => new TableCell({
              borders,
              width:    { size: colWidth, type: WidthType.DXA },
              shading:  isYearRow ? { fill: 'FFF3CD' } : undefined,
              children: [new Paragraph({
                children: [new TextRun({
                  text: String(row[col.key] ?? '—'),
                  bold: isYearRow,
                  color: isYearRow ? '856404' : undefined,
                })],
              })],
            })),
          });
        });

        children.push(new Table({
          width:        { size: 9360, type: WidthType.DXA },
          columnWidths: norm.columns.map(() => colWidth),
          rows:         [headerRow, ...dataRows],
        }));

        if (norm.totalRows > norm.rows.length) {
          children.push(new Paragraph({
            children: [new TextRun({
              text:    `Showing ${norm.rows.length} of ${norm.totalRows} records.`,
              italics: true,
              size:    20,
            })],
          }));
        }
        children.push(new Paragraph({ text: '' }));
      }
    }

    // ── Exclusions ─────────────────────────────────────────────────────────
    if (exclusions?.length) {
      children.push(new Paragraph({ text: 'Data Exclusions', heading: HeadingLevel.HEADING_1 }));
      for (const excl of exclusions) {
        children.push(new Paragraph({
          bullet:   { level: 0 },
          children: [new TextRun(excl)],
        }));
      }
      children.push(new Paragraph({ text: '' }));
    }

    // ── Footer note ────────────────────────────────────────────────────────
    children.push(new Paragraph({
      children: [new TextRun({
        text:  'Report generated by GreOn IQ. Data sourced from internal systems only.',
        color: '999999',
        size:  18,
      })],
    }));

    const doc = new Document({ sections: [{ children }] });
    return Packer.toBuffer(doc);
  } catch (err) {
    console.error('[GreOnIQ] docxExporter: docx package error:', err.message);
    const text = `GreOn IQ Report\n\nDOCX generation is not available: ${err.message}\nPlease use PDF or Excel export instead.`;
    return Buffer.from(text, 'utf8');
  }
}

// ── Inline bold parser ────────────────────────────────────────────────────────
// Splits a line on **...** and produces alternating bold/non-bold TextRun objects.
// Example: "**High:** April with **69 tCO₂e**." →
//   [TextRun("High:", bold), TextRun(" April with "), TextRun("69 tCO₂e", bold), TextRun(".")]
function _parseInlineBold(text, TextRun) {
  if (!text) return [new TextRun('')];
  // split(/\*\*(.+?)\*\*/) puts bold content at odd indices
  const parts = text.split(/\*\*(.+?)\*\*/);
  const runs  = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    runs.push(new TextRun({ text: parts[i], bold: i % 2 === 1 }));
  }
  return runs.length > 0 ? runs : [new TextRun('')];
}

// ── Markdown → DOCX paragraphs ────────────────────────────────────────────────
// Handles the markdown format produced by DeepSeek in qr.answer:
//   ## Heading         → HeadingLevel.HEADING_2
//   ### Heading        → HeadingLevel.HEADING_3
//   *   bullet line    → bullet paragraph with inline bold
//   -   bullet line    → bullet paragraph with inline bold
//   1.  ordered item   → bullet paragraph (docx has no native ordered list easily)
//   **Label:**         → bold paragraph (full-line bold label)
//   regular text       → paragraph with inline bold parsing
//   empty line         → spacer paragraph (consecutive blanks collapsed)
function _markdownToDocxParagraphs(text, { Paragraph, TextRun, HeadingLevel }) {
  if (!text) return [];

  const lines  = text.split('\n');
  const result = [];
  let lastWasEmpty = false;

  for (const line of lines) {
    // ── Empty line ──────────────────────────────────────────────────────
    if (line.trim() === '') {
      if (!lastWasEmpty) {
        result.push(new Paragraph({ text: '' }));
        lastWasEmpty = true;
      }
      continue;
    }
    lastWasEmpty = false;

    // ── ### Heading ─────────────────────────────────────────────────────
    if (line.startsWith('### ')) {
      result.push(new Paragraph({
        text:    line.slice(4).trim(),
        heading: HeadingLevel.HEADING_3,
      }));
      continue;
    }

    // ── ## Heading ──────────────────────────────────────────────────────
    if (line.startsWith('## ')) {
      result.push(new Paragraph({
        text:    line.slice(3).trim(),
        heading: HeadingLevel.HEADING_2,
      }));
      continue;
    }

    // ── # Heading ───────────────────────────────────────────────────────
    if (line.startsWith('# ')) {
      result.push(new Paragraph({
        text:    line.slice(2).trim(),
        heading: HeadingLevel.HEADING_1,
      }));
      continue;
    }

    // ── Bullet: "*   text"  or  "- text"  or  "1. text" ─────────────────
    // DeepSeek uses '*   ' (asterisk + 3 spaces) for unordered lists
    const bulletMatch =
      line.match(/^\*\s{1,4}(.+)$/) ||
      line.match(/^-\s+(.+)$/)      ||
      line.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch) {
      result.push(new Paragraph({
        bullet:   { level: 0 },
        children: _parseInlineBold(bulletMatch[1], TextRun),
      }));
      continue;
    }

    // ── Full-line bold label: **Something:** ────────────────────────────
    // e.g. "**Scope 2 Emissions in 2026:**"
    if (/^\*\*.+\*\*:?\s*$/.test(line.trim())) {
      const label = line.trim().replace(/^\*\*/, '').replace(/\*\*:?\s*$/, '');
      result.push(new Paragraph({
        children: [new TextRun({ text: label + ':', bold: true })],
      }));
      continue;
    }

    // ── Horizontal rule ─────────────────────────────────────────────────
    if (/^---+$/.test(line.trim())) {
      result.push(new Paragraph({ text: '' }));
      continue;
    }

    // ── Regular line (may contain inline **bold**) ───────────────────────
    result.push(new Paragraph({
      children: _parseInlineBold(line.trim(), TextRun),
    }));
  }

  return result;
}

module.exports = { toDocx };
