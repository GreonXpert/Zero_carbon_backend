'use strict';

// ============================================================================
// pdfExporter.js — Branded PDF generation via Puppeteer
//
// toPdf(reportData)                  — existing report format (sections-based)
// toPdfFromQueryResponse(qr, user)   — chat query response format (new)
//
// Logo: user.profileImage.url (S3) or fallback to assets/GreOn.IQ.jpg
// Colors: dynamic per trace.product (zero_carbon = teal, esg_link = blue)
// ============================================================================

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const https     = require('https');
const http      = require('http');
const { normalizeTable } = require('./tableNormalizer');

// ── Logo asset path (fallback) ────────────────────────────────────────────────
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'GreOn.IQ.jpg');

// ── Theme definitions ─────────────────────────────────────────────────────────
const THEMES = {
  zero_carbon: {
    page:       '#F4F5F2',
    surface:    '#FFFFFF',
    surfaceAlt: '#F0FAF9',
    ink:        '#374151',
    ink2:       '#374151',
    ink3:       '#6B7280',
    line:       '#E5E7EB',
    lineSoft:   '#EEF0EB',
    brand:      '#00D1B2',
    brandDeep:  '#00A27A',
    brandInk:   '#00A27A',   // header background
    brandSoft:  '#E6F9F5',   // meta bar background
    tableHead:  '#00A27A',
  },
  esg_link: {
    page:       '#F0F9FF',
    surface:    '#FFFFFF',
    surfaceAlt: '#EFF6FF',
    ink:        '#1E3A5F',
    ink2:       '#1E3A5F',
    ink3:       '#9CA3AF',
    line:       '#DBEAFE',
    lineSoft:   '#EFF6FF',
    brand:      '#60A5FA',
    brandDeep:  '#3B82F6',
    brandInk:   '#1E3A5F',   // header background
    brandSoft:  '#E0F2FE',   // meta bar background
    tableHead:  '#3B82F6',
  },
};

// Legacy BRAND constant — kept for toPdf() backward compat
const BRAND = {
  page:       '#F4F5F2',
  surface:    '#FFFFFF',
  surfaceAlt: '#F7F8F5',
  ink:        '#0E1512',
  ink2:       '#3A433F',
  ink3:       '#6B7570',
  line:       '#E6E8E3',
  lineSoft:   '#EEF0EB',
  brand:      '#34D399',
  brandDeep:  '#10B981',
  brandInk:   '#064E3B',
  brandSoft:  '#E7FBF2',
  tableHead:  '#064E3B',
};

function _getTheme(product) {
  return THEMES[product] || THEMES.zero_carbon;
}

// ── Shared Puppeteer launcher ─────────────────────────────────────────────────
async function _launchAndRender(html) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format:              'A4',
      printBackground:     true,
      margin: { top: '16mm', right: '14mm', bottom: '20mm', left: '14mm' },
      displayHeaderFooter: true,
      headerTemplate:      '<span></span>',
      footerTemplate: `
        <div style="width:100%;font-family:Arial,sans-serif;font-size:9px;
                    color:#6B7570;padding:0 14mm;display:flex;
                    justify-content:space-between;align-items:center;">
          <span>GreOn IQ — Confidential</span>
          <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>`,
    });
  } finally {
    await browser.close();
  }
}

// ── Logo helpers ──────────────────────────────────────────────────────────────

function _readLocalLogo() {
  try {
    const buf = fs.readFileSync(LOGO_PATH);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function _fetchUrl(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ data: Buffer.concat(chunks), ct: res.headers['content-type'] || 'image/jpeg' }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function _fetchLogoDataUri(user) {
  const s3Url = user && user.profileImage && user.profileImage.url;
  if (s3Url) {
    const result = await _fetchUrl(s3Url);
    if (result) {
      return `data:${result.ct};base64,${result.data.toString('base64')}`;
    }
  }
  return _readLocalLogo();
}

// ── Escape helper ─────────────────────────────────────────────────────────────
function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Minimal markdown → HTML ───────────────────────────────────────────────────
function _mdToHtml(md) {
  return String(md)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h3>$1</h3>')
    .replace(/^# (.+)$/gm,   '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/^\s*\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/^---+$/gm, '<hr/>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(.+)/s, '<p>$1</p>');
}

// ─────────────────────────────────────────────────────────────────────────────
// toPdf — report-format export with dynamic theme + user logo
// ─────────────────────────────────────────────────────────────────────────────
async function toPdf(reportData, user) {
  const product = (reportData._plan && reportData._plan.product) || 'zero_carbon';
  const brand   = _getTheme(product);
  const logoUri = await _fetchLogoDataUri(user);
  const html    = _buildHtml(reportData, brand, logoUri);
  return _launchAndRender(html);
}

function _buildHtml(reportData, B, logoUri) {
  B = B || BRAND;
  const { meta, sections = [], exclusions = [], followupQuestions = [] } = reportData;
  const logoHtml = logoUri
    ? `<img src="${logoUri}" alt="GreOn IQ" class="logo" />`
    : `<span class="logo-text">GreOn IQ</span>`;

  const generatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const sectionsHtml = sections.map((s) => _sectionHtml(s, B)).join('');

  const exclusionsHtml = exclusions.length ? `
    <div class="section">
      <div class="section-header">
        <span class="dot warn"></span>
        <h2>Data Exclusions &amp; Limitations</h2>
      </div>
      <div class="section-body">
        <ul class="exclusion-list">
          ${exclusions.map((e) => `<li>${_esc(e)}</li>`).join('')}
        </ul>
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${_esc(meta.title || 'GreOn IQ Report')}</title>
  ${_sharedStyles(B)}
</head>
<body>
  <div class="report-header">
    ${logoHtml}
    <div class="header-right">
      <h1>${_esc(meta.title || 'GreOn IQ Report')}</h1>
      <div class="subtitle">Sustainability Analytics Report</div>
    </div>
  </div>
  <div class="meta-bar">
    ${meta.clientName ? `<span class="meta-item"><strong>Client:</strong> ${_esc(meta.clientName)}</span>` : ''}
    ${meta.period     ? `<span class="meta-item"><strong>Period:</strong> ${_esc(meta.period)}</span>` : ''}
    ${meta.domain     ? `<span class="meta-item"><strong>Domain:</strong> ${_esc(meta.domain.replace(/_/g, ' '))}</span>` : ''}
    <span class="meta-item"><strong>Generated:</strong> ${_esc(generatedAt)} IST</span>
  </div>
  <div class="content">
    ${sectionsHtml}
    ${exclusionsHtml}
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// toPdfFromQueryResponse — new chat-response format export
// ─────────────────────────────────────────────────────────────────────────────
async function toPdfFromQueryResponse(queryResponse, user) {
  const product = (queryResponse && queryResponse.trace && queryResponse.trace.product) || 'zero_carbon';
  const brand   = _getTheme(product);
  const logoUri = await _fetchLogoDataUri(user);
  const html    = _buildHtmlFromQueryResponse(queryResponse, brand, logoUri);
  return _launchAndRender(html);
}

function _buildHtmlFromQueryResponse(qr, B, logoUri) {
  const trace    = qr.trace || {};
  const tables   = qr.tables   || [];
  const charts   = qr.charts   || [];
  const followup = qr.followupQuestions || [];
  const answer   = qr.answer   || '';

  const product       = trace.product || 'zero_carbon';
  const productLabel  = product === 'esg_link' ? 'ESG Link' : 'Zero Carbon';
  const clientId      = trace.clientId || '—';
  const periodLabel   = (trace.dateRange && trace.dateRange.label) || '—';
  const generatedAt   = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const intentLabel   = trace.intent ? trace.intent.replace(/_/g, ' ') : '—';

  const logoHtml = logoUri
    ? `<img src="${logoUri}" alt="Logo" class="logo" />`
    : `<span class="logo-text">GreOn IQ</span>`;

  // Answer section
  const answerHtml = answer ? `
    <div class="section">
      <div class="section-header">
        <span class="dot"></span>
        <h2>Analysis</h2>
      </div>
      <div class="section-body">
        <div class="narrative">${_mdToHtml(answer)}</div>
      </div>
    </div>` : '';

  // Tables section
  const tablesHtml = tables.length ? `
    <div class="section">
      <div class="section-header">
        <span class="dot"></span>
        <h2>Data Tables</h2>
      </div>
      <div class="section-body">
        ${tables.map((t) => _tableHtml(t, B)).join('')}
      </div>
    </div>` : '';

  // Charts — filter out all-zero charts
  const nonZeroCharts = charts.filter((c) => {
    const data = c.data || [];
    return data.some((d) => (d.value || 0) !== 0);
  });

  const chartsHtml = nonZeroCharts.length ? `
    <div class="section">
      <div class="section-header">
        <span class="dot"></span>
        <h2>Charts</h2>
      </div>
      <div class="section-body">
        ${nonZeroCharts.map((c) => _chartHtml(c, B)).join('')}
      </div>
    </div>` : '';

  // Follow-up questions
  const followupHtml = followup.length ? `
    <div class="section">
      <div class="section-header">
        <span class="dot accent"></span>
        <h2>Suggested Follow-up Questions</h2>
      </div>
      <div class="section-body">
        <ul class="followup-list">
          ${followup.map((q) => `<li>${_esc(q)}</li>`).join('')}
        </ul>
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>GreOn IQ Analytics Report</title>
  ${_sharedStyles(B)}
  <style>
    /* ── Chart styles ── */
    .chart-block   { margin-bottom: 24px; }
    .chart-title   { font-size: 11px; font-weight: 600; color: ${B.ink}; margin-bottom: 10px;
                     text-transform: uppercase; letter-spacing: 0.4px; }
    .chart-unit    { font-size: 10px; color: ${B.ink3}; margin-bottom: 8px; }
    .bar-row       { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; min-height: 20px; }
    .bar-label     { flex: 0 0 170px; font-size: 10px; color: ${B.ink2};
                     white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
    .bar-track     { flex: 1; background: ${B.lineSoft}; border-radius: 3px; height: 12px;
                     position: relative; overflow: hidden; }
    .bar-fill      { height: 100%; border-radius: 3px; min-width: 2px; }
    .bar-value     { flex: 0 0 110px; font-size: 10px; color: ${B.ink}; font-weight: 500; }

    /* ── Follow-up ── */
    .followup-list { list-style: none; padding: 0; }
    .followup-list li {
      padding: 7px 12px 7px 28px;
      position: relative; font-size: 11px;
      color: ${B.ink2}; border-bottom: 1px solid ${B.lineSoft};
    }
    .followup-list li:last-child { border-bottom: none; }
    .followup-list li::before   { content: '?'; position: absolute; left: 10px;
                                   font-weight: 700; color: ${B.brand}; }
    .dot.accent { background: ${B.brand}; opacity: 0.6; }
  </style>
</head>
<body>

  <!-- Header -->
  <div class="report-header">
    ${logoHtml}
    <div class="header-right">
      <h1>GreOn IQ Analytics</h1>
      <div class="subtitle">${_esc(productLabel)} · Sustainability Report</div>
    </div>
  </div>

  <!-- Meta bar -->
  <div class="meta-bar">
    <span class="meta-item"><strong>Client:</strong> ${_esc(clientId)}</span>
    <span class="meta-item"><strong>Period:</strong> ${_esc(periodLabel)}</span>
    <span class="meta-item"><strong>Domain:</strong> ${_esc(intentLabel)}</span>
    <span class="meta-item"><strong>Generated:</strong> ${_esc(generatedAt)} IST</span>
  </div>

  <!-- Body -->
  <div class="content">
    ${answerHtml}
    ${tablesHtml}
    ${chartsHtml}
    ${followupHtml}
  </div>

</body>
</html>`;
}

// ── Table HTML ────────────────────────────────────────────────────────────────
function _tableHtml(t, B) {
  const norm = normalizeTable(t);
  const cols = norm.columns;
  const rows = norm.rows;

  const headers = cols.map((c) => `<th>${_esc(c.label)}</th>`).join('');

  const bodyRows = rows.map((row) => {
    const cells = cols.map((col) =>
      `<td>${_esc(String(row[col.key] ?? '—'))}</td>`
    ).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const noteHtml = norm.totalRows > rows.length
    ? `<p class="table-note">Showing ${rows.length} of ${norm.totalRows} records.</p>`
    : '';

  return `
    <div class="table-title">${_esc(norm.title)}</div>
    <div class="table-wrap">
      <table>
        <thead><tr>${headers}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    ${noteHtml}`;
}

// ── CSS bar chart renderer ────────────────────────────────────────────────────
function _chartHtml(chart, B) {
  const data  = (chart.data || []).filter((d) => d.value != null);
  const unit  = chart.unit || '';
  const title = chart.title || '';

  if (!data.length) return '';

  const maxVal = Math.max(...data.map((d) => Math.abs(d.value)));
  if (maxVal === 0) return '';

  // For trend charts: sort chronologically (best-effort)
  let sorted = [...data];
  if (chart.type === 'trend') {
    sorted = _sortChronologically(sorted);
  }

  // Deduplicate by label (keep highest value for duplicates)
  const seen = new Map();
  for (const d of sorted) {
    const key = d.label;
    if (!seen.has(key) || d.value > seen.get(key).value) {
      seen.set(key, d);
    }
  }
  const deduped = [...seen.values()];

  const bars = deduped.map((d) => {
    const pct   = maxVal > 0 ? Math.round((Math.abs(d.value) / maxVal) * 100) : 0;
    const fmtVal = Number.isFinite(d.value)
      ? d.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
      : '—';
    return `
      <div class="bar-row">
        <span class="bar-label">${_esc(d.label)}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%;background:${B.brandDeep};"></div>
        </div>
        <span class="bar-value">${_esc(fmtVal)} ${_esc(unit)}</span>
      </div>`;
  }).join('');

  return `
    <div class="chart-block">
      <div class="chart-title">${_esc(title)}</div>
      ${unit ? `<div class="chart-unit">Unit: ${_esc(unit)}</div>` : ''}
      ${bars}
    </div>`;
}

// Sort data entries by parsed date label (Month YYYY or Year YYYY)
function _sortChronologically(data) {
  const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
                   jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

  function _score(label) {
    if (!label) return Infinity;
    const s = label.trim().toLowerCase();
    // "Year YYYY"
    const yrMatch = s.match(/^year\s+(\d{4})$/);
    if (yrMatch) return new Date(Number(yrMatch[1]), 6).getTime();
    // "MMM YYYY"
    const mMatch = s.match(/^([a-z]{3})\s+(\d{4})$/);
    if (mMatch) {
      const mon = MONTHS[mMatch[1]];
      return new Date(Number(mMatch[2]), mon != null ? mon : 0).getTime();
    }
    // "MMM YYYY – MMM YYYY" (range — use start)
    const rangeMatch = s.match(/^([a-z]{3})\s+(\d{4})/);
    if (rangeMatch) {
      const mon = MONTHS[rangeMatch[1]];
      return new Date(Number(rangeMatch[2]), mon != null ? mon : 0).getTime();
    }
    return Infinity;
  }

  return [...data].sort((a, b) => _score(a.label) - _score(b.label));
}

// ── Section renderer (used by toPdf legacy path) ─────────────────────────────
function _sectionHtml(section, B) {
  const tablesHtml = (section.tables || []).map((t) => _tableHtml(t, B)).join('');

  return `
    <div class="section">
      <div class="section-header">
        <span class="dot"></span>
        <h2>${_esc(section.heading || '')}</h2>
      </div>
      <div class="section-body">
        ${section.narrative ? `<div class="narrative">${_mdToHtml(section.narrative)}</div>` : ''}
        ${tablesHtml}
      </div>
    </div>`;
}

// ── Shared CSS (parameterised by brand tokens) ────────────────────────────────
function _sharedStyles(B) {
  return `<style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 12px;
      color: ${B.ink};
      background: ${B.page};
    }
    .report-header {
      background: ${B.brandInk};
      padding: 32px 40px 28px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .logo          { height: 44px; object-fit: contain; }
    .logo-text     { font-size: 22px; font-weight: 800; color: ${B.brand}; letter-spacing: -0.5px; }
    .header-right  { text-align: right; }
    .header-right h1 {
      font-size: 20px; font-weight: 700;
      color: ${B.brand}; letter-spacing: -0.3px; line-height: 1.2;
    }
    .header-right .subtitle { font-size: 11px; color: rgba(255,255,255,0.65); margin-top: 4px; }
    .meta-bar {
      background: ${B.brandSoft};
      border-bottom: 2px solid ${B.brandDeep};
      padding: 10px 40px;
      display: flex; flex-wrap: wrap; gap: 24px;
      font-size: 11px; color: ${B.brandInk};
    }
    .meta-bar .meta-item strong { font-weight: 600; }
    .content { padding: 24px 40px 8px; }
    .section {
      background: ${B.surface};
      border: 1px solid ${B.line};
      border-radius: 8px;
      margin-bottom: 20px;
      overflow: hidden;
      page-break-inside: avoid;
    }
    .section-header {
      background: ${B.surfaceAlt};
      border-bottom: 1px solid ${B.line};
      padding: 10px 16px;
      display: flex; align-items: center; gap: 10px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: ${B.brand}; flex-shrink: 0; }
    .dot.warn { background: #F59E0B; }
    .section-header h2 { font-size: 13px; font-weight: 600; color: ${B.ink}; }
    .section-body { padding: 14px 16px; }
    .narrative { font-size: 12px; color: ${B.ink2}; line-height: 1.75; margin-bottom: 14px; }
    .narrative h3 { font-size: 12px; font-weight: 600; color: ${B.ink}; margin: 10px 0 4px; }
    .narrative ul, .narrative ol { padding-left: 18px; margin: 4px 0 8px; }
    .narrative li  { margin-bottom: 2px; }
    .narrative strong { color: ${B.ink}; }
    .table-wrap  { overflow-x: auto; margin-bottom: 14px; }
    .table-title { font-size: 11px; font-weight: 600; color: ${B.ink}; margin: 12px 0 6px;
                   text-transform: uppercase; letter-spacing: 0.4px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    thead tr { background: ${B.tableHead || B.brandInk}; }
    thead th  { padding: 7px 12px; text-align: left; font-weight: 600; color: #fff; white-space: nowrap; }
    tbody tr:nth-child(even) { background: ${B.surfaceAlt}; }
    tbody tr:nth-child(odd)  { background: ${B.surface}; }
    tbody td { padding: 5px 12px; color: ${B.ink2}; border-bottom: 1px solid ${B.lineSoft}; }
    .table-note { font-size: 10px; color: ${B.ink3}; font-style: italic; margin-top: 2px; }
    .exclusion-list { list-style: none; padding: 0; }
    .exclusion-list li {
      padding: 5px 12px 5px 22px; position: relative;
      color: ${B.ink2}; font-size: 11px;
      border-bottom: 1px solid ${B.lineSoft};
    }
    .exclusion-list li:last-child { border-bottom: none; }
    .exclusion-list li::before { content: '⚠'; position: absolute; left: 4px; color: #F59E0B; }
    @media print { .section { page-break-inside: avoid; } }
  </style>`;
}

module.exports = { toPdf, toPdfFromQueryResponse };
