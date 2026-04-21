# GreOn IQ Export Bug — Root Cause & Fix Summary

**Date:** 2026-04-21  
**Affected endpoints:** `POST /api/greon-iq/chat/export-response`, `POST /api/greon-iq/report/export`

---

## Bugs Found

### Bug 1 — `keys.length` false-positive (all exporters)

**Files:** `excelExporter.js`, `docxExporter.js`, `pdfExporter.js`

When columns are plain strings (legacy `reportService` path), the code derived a `keys` array of `null` values:

```js
const keys = columns.map(col => typeof col === 'object' ? col.key : null);
// → [null, null, null]

return keys.length > 0          // ← always true (3 > 0)
  ? keys.map(k => row[k] ?? '') // ← row[null] = undefined → '' or '—'
  : Object.values(row);
```

Every table cell became blank/`—` in the legacy report export path.

### Bug 2 — DOCX narrative rendered as raw markdown

**File:** `docxExporter.js` (original line 41)

```js
children.push(new Paragraph({ children: [new TextRun(section.narrative)] }));
```

`section.narrative = qr.answer` is a markdown string from DeepSeek (contains `**bold**`, `## headings`, `*   bullets`). `TextRun` treated it as a literal string — asterisks, hash signs appeared verbatim in Word documents.

### Bug 3 — `markdownExporter` broke with object-format tables

**File:** `markdownExporter.js`

```js
table.columns.join(' | ')       // → "[object Object] | [object Object]" for {key,label} columns
row.map(c => String(c ?? '—'))  // → TypeError: row.map is not a function for object rows
```

---

## Root Cause Summary

Two parallel data flows feed the same exporters with different table shapes:

| Flow | Columns | Rows |
|------|---------|------|
| `reportService.assembleReportData()` (legacy) | `string[]` | `array[][]` |
| `responseComposerService.compose()` (query) | `[{key,label}]` | `[{key:value}]` |

The exporters had ad-hoc dual-format handling that failed in the legacy path due to the `keys.length` null-key bug, and `markdownExporter` had no handling for the query-response format at all.

---

## Files Changed

| File | Change |
|------|--------|
| `exporters/tableNormalizer.js` | **Created** — shared normalizer for all 4 table shapes |
| `exporters/excelExporter.js` | Uses `normalizeTable()`; added `!cols` widths + `!freeze`; numbers preserved as numbers |
| `exporters/pdfExporter.js` | `_tableHtml()` uses `normalizeTable()`; `keys.length` bug removed |
| `exporters/docxExporter.js` | `_markdownToDocxParagraphs()` + `_parseInlineBold()` added; uses `normalizeTable()` |
| `exporters/markdownExporter.js` | Uses `normalizeTable()`; `_mdEsc()` added for pipe/newline escaping |
| `test-table-normalizer.js` | **Created** — smoke-test script |

---

## Test Cases Used

Run: `node src/modules/greon-iq/test-table-normalizer.js`

- Shape A (object cols + object rows) — primary query response path
- Shape C (string cols + array rows) — legacy report service path
- Null and zero values — zero stays `0`, null stays `null`
- Empty table — `exportable: false`, no crash
- No `undefined` in normalised rows (the key null-key regression check)
- Shape D (object cols + array rows) — mixed shape

---

## Manual Regression Checklist

1. `POST /api/greon-iq/chat/export-response` with `format: pdf` → PDF shows real rows (Apr 2026, 69.942, tCO₂e)
2. Same with `format: xlsx` → values in cells, not blank; column A wide; header frozen at row 1
3. Same with `format: docx` → narrative shows formatted bold/bullets, NOT `**asterisks**`; table rows visible
4. `POST /api/greon-iq/report/preview` → markdown table shows column headers, not `[object Object]`
5. `POST /api/greon-iq/report/export` with `format: xlsx` → legacy string-col/array-row path still works
6. Zero emission value (Mar 2026 = 0) renders as `0`, not `—`

---

## Remaining Risks

- **XLSX cell styling** — SheetJS community edition ignores `ws[cell].s` styles. Header row is not visually bolded. Column widths (`!cols`) and freeze pane (`!freeze`) do work. Upgrade to `xlsx-style` or `exceljs` if bold headers are required.
- **DOCX ordered lists** — numbered lists from DeepSeek (`1.`, `2.`) are rendered as unordered bullets because `docx` package requires complex numbering setup. Acceptable trade-off.
- **Chart export** — charts are not included in XLSX or DOCX exports; only PDF includes them as bar charts. This is by design.
