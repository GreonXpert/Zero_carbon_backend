'use strict';

/**
 * Render a complete HTML document for Puppeteer PDF generation.
 *
 * Strategy:
 *  1. If template.sections is available AND report.content has matching keys → use template structure
 *     (gives section titles, field labels, table definitions)
 *  2. If template is null / no section matches → fall back to rendering directly from report.content
 *     (each saved section result is rendered with generic key labels)
 *  3. If report.content is also null/empty → show a "no content" placeholder (don't crash)
 */
function renderReportHTML(report, template) {
  const orgName  = report.organizationId || 'Organisation';
  const title    = report.title          || 'Sustainability Report';
  const year     = report.reportingYear  || new Date().getFullYear();
  const content  = report.content        || {};

  const templateSections = (template?.sections || []).sort((a, b) => a.order - b.order);
  const contentKeys      = Object.keys(content);

  let sectionHTML = '';

  if (templateSections.length > 0 && contentKeys.length > 0) {
    // ── Normal path ───────────────────────────────────────────────────────────
    sectionHTML = templateSections.map(sec => {
      if (sec.type === 'divider') return `<div class="page-break"></div>`;

      const sectionData = content[sec.id];
      if (!sectionData) {
        // Section defined in template but not in snapshot — show empty section
        return `
        <section class="report-section level-${sec.level || 2}" id="section-${sec.id}">
          <h${sec.level || 2} class="section-heading">${escapeHtml(sec.title)}</h${sec.level || 2}>
          <p class="no-data">Content not yet generated for this section.</p>
        </section>`;
      }

      const fieldsHTML  = renderFields(sec.fields  || [], sectionData.fields || {});
      const tablesHTML  = renderTables(sec.tables  || [], sectionData.fields || {});
      const warningsHTML = renderWarnings(sectionData.warnings);

      return `
      <section class="report-section level-${sec.level || 2}" id="section-${sec.id}">
        <h${sec.level || 2} class="section-heading">${escapeHtml(sec.title)}</h${sec.level || 2}>
        ${fieldsHTML}
        ${tablesHTML}
        ${warningsHTML}
      </section>`;
    }).filter(Boolean).join('\n');

  } else if (contentKeys.length > 0) {
    // ── Fallback: template not available — render directly from snapshot content ──
    // Sort by sectionId alphabetically since we have no order info
    sectionHTML = contentKeys.map(sectionId => {
      const sectionData = content[sectionId];
      const fields      = sectionData?.fields || {};
      const fieldKeys   = Object.keys(fields);

      if (fieldKeys.length === 0) return '';

      const fieldsHTML = fieldKeys.map(fieldId => {
        const val = fields[fieldId];
        if (val === undefined || val === null) return '';
        if (Array.isArray(val)) {
          if (val.length === 0) return '';
          const rows = val.map(item =>
            `<tr>${Object.values(item).map(v => `<td>${escapeHtml(String(v ?? ''))}</td>`).join('')}</tr>`
          ).join('');
          const headers = Object.keys(val[0]).map(k => `<th>${escapeHtml(k)}</th>`).join('');
          return `<table class="data-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
        }
        if (typeof val === 'string' && val.length > 60) {
          return `<div class="narrative-field"><p>${escapeHtml(val)}</p></div>`;
        }
        return `<dl class="data-field"><dt>${escapeHtml(fieldId)}</dt><dd>${escapeHtml(String(val))}</dd></dl>`;
      }).filter(Boolean).join('\n');

      if (!fieldsHTML) return '';

      const heading = sectionId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return `
      <section class="report-section level-2" id="section-${sectionId}">
        <h2 class="section-heading">${escapeHtml(heading)}</h2>
        ${fieldsHTML}
      </section>`;
    }).filter(Boolean).join('\n');

  } else {
    // ── No content at all ─────────────────────────────────────────────────────
    sectionHTML = `
    <section class="report-section level-2">
      <p class="no-data" style="text-align:center;color:#888;margin-top:40pt">
        Report content is not yet available.<br>
        The report may still be generating — please wait and try again.
      </p>
    </section>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; line-height: 1.6; }
  @page { size: A4; margin: 25.4mm; }
  .cover { page-break-after: always; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 90vh; text-align: center; }
  .cover h1 { font-size: 28pt; color: #1B4F3A; margin-bottom: 16pt; }
  .cover h2 { font-size: 16pt; color: #555; margin-bottom: 8pt; }
  .cover .year { font-size: 14pt; color: #888; }
  .report-section { margin-bottom: 32pt; }
  .section-heading { color: #1B4F3A; border-bottom: 2px solid #1B4F3A; padding-bottom: 4pt; margin-bottom: 16pt; }
  h2.section-heading { font-size: 16pt; }
  h3.section-heading { font-size: 13pt; }
  .narrative-field p { margin-bottom: 10pt; text-align: justify; }
  .data-field { display: flex; gap: 16pt; margin-bottom: 8pt; }
  .data-field dt { font-weight: 600; min-width: 200pt; color: #444; }
  .data-field dd .unit { color: #888; font-size: 9pt; }
  .data-table { width: 100%; border-collapse: collapse; margin: 16pt 0; font-size: 10pt; }
  .data-table caption { font-weight: 600; text-align: left; margin-bottom: 6pt; color: #1B4F3A; }
  .data-table th { background: #E8F4EC; padding: 6pt 10pt; text-align: left; border: 1px solid #ccc; }
  .data-table td { padding: 5pt 10pt; border: 1px solid #ddd; }
  .data-table tr:nth-child(even) td { background: #F7FAF8; }
  .page-break { page-break-after: always; }
  .no-data { color: #999; font-style: italic; font-size: 10pt; }
  .warning-note { color: #b45309; font-size: 9pt; margin-top: 4pt; }
</style>
</head>
<body>

<div class="cover">
  <h1>${escapeHtml(title)}</h1>
  <h2>${escapeHtml(String(orgName))}</h2>
  <div class="year">Reporting Year: ${escapeHtml(String(year))}</div>
  <div class="year" style="margin-top:8pt;font-size:9pt;color:#aaa">Generated by Greon Xpert RAG Report Composer</div>
</div>

<main>
${sectionHTML}
</main>

</body>
</html>`;
}

// ─── Field renderers ───────────────────────────────────────────────────────────

function renderFields(fieldDefs, fieldsMap) {
  return fieldDefs.map(field => {
    const value = fieldsMap[field.id];
    if (value === undefined || value === null) return '';

    if (field.type === 'generated_text') {
      const text = String(value).trim();
      if (!text) return '';
      // Split into paragraphs on double-newlines
      const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
      const inner = paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
      return `<div class="narrative-field">${inner}</div>`;
    }

    if (field.type === 'numeric') {
      const numStr = Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
      return `<dl class="data-field">
        <dt>${escapeHtml(field.label || field.id)}</dt>
        <dd>${numStr}${field.unit ? ` <span class="unit">${escapeHtml(field.unit)}</span>` : ''}</dd>
      </dl>`;
    }

    return `<dl class="data-field">
      <dt>${escapeHtml(field.label || field.id)}</dt>
      <dd>${escapeHtml(String(value))}</dd>
    </dl>`;
  }).filter(Boolean).join('\n');
}

function renderTables(tableDefs, fieldsMap) {
  return tableDefs.map(table => {
    const data = fieldsMap[table.id];
    if (!Array.isArray(data) || data.length === 0) return '';
    const cols = table.columns || [];
    if (cols.length === 0) return '';
    const headers = cols.map(c => `<th>${escapeHtml(c.label || c.id)}</th>`).join('');
    const rows    = data.map(row =>
      `<tr>${cols.map(c => `<td>${escapeHtml(String(row[c.id] ?? ''))}</td>`).join('')}</tr>`
    ).join('');
    return `<table class="data-table">
      <caption>${escapeHtml(table.title || table.id)}</caption>
      <thead><tr>${headers}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }).filter(Boolean).join('\n');
}

function renderWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  // Only show warnings in dev — in production omit them from PDF
  return ''; // Suppress warnings in PDF output
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

module.exports = { renderReportHTML };
