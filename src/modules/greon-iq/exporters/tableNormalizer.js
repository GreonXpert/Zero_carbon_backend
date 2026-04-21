'use strict';

// ============================================================================
// tableNormalizer.js — Normalises all table shapes into one canonical form.
//
// Input shapes supported:
//   A: columns=[{key,label}], rows=[{key:val}]   ← query response (primary)
//   B: columns=['string'],    rows=[{key:val}]    ← legacy object rows
//   C: columns=['string'],    rows=[['v1','v2']]  ← legacy report service (array rows)
//   D: columns=[{key,label}], rows=[['v1','v2']]  ← mixed
//
// Output: { title, columns:[{key,label}], rows:[{col_key:value}], totalRows, exportable }
//
// Key invariants:
//   - Numbers stay as numbers; strings stay as strings
//   - null/undefined → null (NOT '—' — em-dash is added at render time only)
//   - Column order is preserved
//   - Object-column rows: resolved by col.key (Shape A)
//   - String-column rows: resolved by original column string as lookup key (Shape B)
//   - Array rows: resolved positionally (Shape C/D)
// ============================================================================

function normalizeTable(table) {
  if (!table || typeof table !== 'object') {
    return { title: '', columns: [], rows: [], totalRows: 0, exportable: false };
  }

  const rawCols = Array.isArray(table.columns) ? table.columns : [];
  const rawRows = Array.isArray(table.rows)    ? table.rows    : [];

  // ── 1. Normalise columns → every entry becomes { key, label } ─────────────
  const columns = rawCols.map((col, i) => {
    if (col !== null && typeof col === 'object') {
      // Shape A or D — already has key/label
      return {
        key:   String(col.key   != null ? col.key   : `col_${i}`),
        label: String(col.label != null ? col.label : col.key != null ? col.key : `Column ${i + 1}`),
      };
    }
    // Shape B or C — string column; synthetic key for export
    return {
      key:   `col_${i}`,
      label: String(col != null ? col : `Column ${i + 1}`),
    };
  });

  // ── 2. Normalise rows → every entry becomes { col.key: value } ────────────
  const rows = rawRows.map((row) => {
    const obj = {};

    if (Array.isArray(row)) {
      // Shape C or D — positional mapping
      columns.forEach((col, i) => {
        const v = i < row.length ? row[i] : null;
        obj[col.key] = v === undefined ? null : v;
      });
      return obj;
    }

    if (row !== null && typeof row === 'object') {
      columns.forEach((col, i) => {
        const rawCol = rawCols[i];
        // Shape A: object column → use rawCol.key for lookup
        // Shape B: string column → use original string for lookup
        const lookupKey = (rawCol !== null && typeof rawCol === 'object')
          ? String(rawCol.key != null ? rawCol.key : '')
          : String(rawCol != null ? rawCol : '');
        const v = row[lookupKey];
        obj[col.key] = v === undefined ? null : v;
      });
      return obj;
    }

    // Unexpected row type — fill with nulls
    columns.forEach((col) => { obj[col.key] = null; });
    return obj;
  });

  // ── 3. exportable flag ────────────────────────────────────────────────────
  const hasData = rows.some((row) =>
    columns.some((col) => row[col.key] !== null && row[col.key] !== undefined)
  );

  return {
    title:      String(table.title != null ? table.title : ''),
    columns,
    rows,
    totalRows:  typeof table.totalRows === 'number' ? table.totalRows : rows.length,
    exportable: columns.length > 0 && rows.length > 0 && hasData,
  };
}

module.exports = { normalizeTable };
