'use strict';

/* ─── Config ─────────────────────────────────────────────────────────────── */
const API_BASE = 'https://api.zerocarbon.greonxpert.com';

const CHART_COLORS = [
  '#1BC49D','#13a082','#0b3d31','#57e5c3','#2dd4b0',
  '#f59e0b','#6366f1','#ef4444','#3b82f6','#a855f7',
];
const PIE_COLORS = { '>5%':'#0b3d31', '3–5%':'#13a082', '1–3%':'#1BC49D', '<1%':'#7fe8d3' };

/* ─── App State ──────────────────────────────────────────────────────────── */
const S = {
  rawData:       [],   // all entities from API (full dataset)
  filteredData:  [],   // after applying filters
  charts:        {},   // Chart.js instances keyed by id
  filters:       { search:'', sector:'', subSector:'', state:'' },
  page:          1,
  perPage:       20,
  sortBy:        'entityName',
  sortOrder:     'asc',
  adminPage:     1,
  adminSearch:   '',
  adminSelected: new Set(),
  adminRawData:  [],
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */
const $  = (id) => document.getElementById(id);
const fmtNum = (n, dec = 4) => (n == null || n === '') ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: dec, minimumFractionDigits: 0 });
const fmtTonne = (n) => (n == null) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtGEI   = (n) => (n == null) ? '—' : Number(n).toFixed(4);
const unique   = (arr) => [...new Set(arr.filter(Boolean))].sort();

function reductionPct(e) {
  const b = e.baselineGHGEmissionIntensity, t = e.targetGEI_2026_27;
  if (!b || t == null) return null;
  return ((b - t) / b) * 100;
}

function bandOf(pct) {
  if (pct == null) return null;
  if (pct < 1)  return '<1%';
  if (pct < 3)  return '1–3%';
  if (pct < 5)  return '3–5%';
  return '>5%';
}

function toast(msg, type = 'info', ms = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function destroyChart(key) {
  if (S.charts[key]) { S.charts[key].destroy(); delete S.charts[key]; }
}

/* ─── API Headers (no auth) ──────────────────────────────────────────────── */
function authHeaders() {
  return { 'Content-Type': 'application/json' };
}

/* ─── API ────────────────────────────────────────────────────────────────── */
async function apiFetch(path, opts = {}) {
  const headers = { ...authHeaders(), ...(opts.headers || {}) };
  const r = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || json.message || `HTTP ${r.status}`);
  return json;
}

async function loadAllData() {
  $('loading-cards').classList.remove('hidden');
  try {
    // Fetch up to 2000 in one call for charts + client-side filtering
    const res = await apiFetch('/api/ccts?limit=2000&page=1');
    S.rawData = res.data || [];
    applyFilters();
    populateDropdowns();
  } catch (e) {
    toast('Failed to load registry data: ' + e.message, 'error');
  } finally {
    $('loading-cards').classList.add('hidden');
  }
}

/* ─── Filters ────────────────────────────────────────────────────────────── */
function populateDropdowns() {
  const sectors    = unique(S.rawData.map(e => e.sector));
  const subSectors = unique(S.rawData.map(e => e.subSector));
  const states     = unique(S.rawData.map(e => e.state));

  const fill = (id, opts) => {
    const sel = $(id), cur = sel.value;
    // keep first option (All …)
    while (sel.options.length > 1) sel.remove(1);
    opts.forEach(o => { const opt = new Option(o, o); sel.add(opt); });
    if (opts.includes(cur)) sel.value = cur;
  };
  fill('filter-sector',    sectors);
  fill('filter-subsector', subSectors);
  fill('filter-state',     states);
}

function applyFilters() {
  const { search, sector, subSector, state } = S.filters;
  const q = search.trim().toLowerCase();

  let data = S.rawData.filter(e => {
    if (sector    && e.sector    !== sector)    return false;
    if (subSector && e.subSector !== subSector) return false;
    if (state     && e.state     !== state)     return false;
    if (q) {
      const haystack = `${e.entityName} ${e.registrationNumber} ${e.obligatedEntityAddress} ${e.state} ${e.sector} ${e.subSector} ${e.source || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // Sort
  data = data.slice().sort((a, b) => {
    let av = a[S.sortBy], bv = b[S.sortBy];
    if (av == null) av = S.sortOrder === 'asc' ? Infinity : -Infinity;
    if (bv == null) bv = S.sortOrder === 'asc' ? Infinity : -Infinity;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return S.sortOrder === 'asc' ? -1 : 1;
    if (av > bv) return S.sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  S.filteredData = data;
  S.page = 1;

  renderKPIs();
  renderAllCharts();
  renderEntityCards();
  updateFilteredBadge();
}

function updateFilteredBadge() {
  const n = S.filteredData.length;
  $('filtered-count-badge').textContent = `${n.toLocaleString('en-IN')} ${n === 1 ? 'entity' : 'entities'} shown`;
   $('cards-count-label').textContent = `${n.toLocaleString('en-IN')} records • All fields aligned in page view`;}

/* ─── KPI Cards ──────────────────────────────────────────────────────────── */
function renderKPIs() {
  const d = S.filteredData;
  const total = S.rawData.length;

  $('kpi-entities').textContent = d.length.toLocaleString('en-IN');
  $('kpi-entities-sub').textContent = d.length === total
    ? 'from full registry'
    : `of ${total.toLocaleString('en-IN')} total`;

  $('kpi-sectors').textContent = unique(d.map(e => e.sector)).length;
  $('kpi-states').textContent  = unique(d.map(e => e.state)).length;

  // Populate r3 header stats (Charts Row 3)
  const r3s = $('r3-states-count');
  const r3ss = $('r3-subsectors-count');
  const r3e = $('r3-entities-count');
  if (r3s)  r3s.textContent  = unique(d.map(e => e.state)).length;
  if (r3ss) r3ss.textContent = unique(d.map(e => e.subSector)).length;
  if (r3e)  r3e.textContent  = d.length.toLocaleString('en-IN');
}

/* ─── Charts ─────────────────────────────────────────────────────────────── */
function renderAllCharts() {
  renderSectorChart();
  renderPieChart();
  renderGEIChart();
  renderTopEntities();
  renderStateChart();
  renderSubSectorChart();
}

/* Chart 1 – Sector horizontal bar */
function renderSectorChart() {
  destroyChart('sector');
  const counts = {};
  S.filteredData.forEach(e => { if (e.sector) counts[e.sector] = (counts[e.sector] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]);
  const labels = sorted.map(x => x[0]);
  const values = sorted.map(x => x[1]);

  const ctx = $('chart-sector').getContext('2d');
  S.charts.sector = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((_, i) => {
          const palette = ['#1BC49D','#13a082','#0f6b52','#57e5c3','#2dd4b0','#f59e0b','#6366f1','#ef4444','#3b82f6','#a855f7'];
          return palette[i % palette.length];
        }),
        hoverBackgroundColor: labels.map((_, i) => {
          const palette = ['#13a082','#0f6b52','#0b3d31','#2dd4b0','#1BC49D','#d97706','#4f46e5','#dc2626','#2563eb','#9333ea'];
          return palette[i % palette.length];
        }),
        borderRadius: 8,
        borderSkipped: false,
        borderWidth: 0,
      }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0a3d31',
          titleColor: '#7fe8d3',
          bodyColor: '#d1f5ec',
          padding: 10,
          cornerRadius: 8,
          callbacks: { label: c => `  ${c.parsed.x} entities` }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(27,196,157,.1)', drawBorder: false },
          ticks: { font: { size: 11, family: 'DM Sans, sans-serif' }, color: '#5a8a80' }
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 11, family: 'DM Sans, sans-serif' }, color: '#2d5048' }
        },
      },
    },
  });
}

/* Chart 2 – Target reduction pie */
function renderPieChart() {
  destroyChart('pie');
  const bands = { '>5%':0, '3–5%':0, '1–3%':0, '<1%':0 };
  S.filteredData.forEach(e => {
    const b = bandOf(reductionPct(e));
    if (b) bands[b]++;
  });

  const labels = Object.keys(bands).filter(k => bands[k] > 0);
  const values = labels.map(k => bands[k]);
  const colors = labels.map(k => PIE_COLORS[k]);

  // Legend — new dark band rows
  const legendEl = $('pie-legend');
  const total = values.reduce((a,b)=>a+b,0);

  // Update centre stat
  const centreEl = $('donut-total-val');
  if (centreEl) centreEl.textContent = total > 0 ? total.toLocaleString('en-IN') : '—';

  legendEl.innerHTML = labels.map((l, i) => {
    const pct = total ? Math.round(values[i]/total*100) : 0;
    return `<div class="donut-band-row">
      <div class="donut-band-pip" style="background:${colors[i]};color:${colors[i]}"></div>
      <span class="donut-band-label">${l} reduction</span>
      <span class="donut-band-count">${values[i]}</span>
      <span class="donut-band-pct">${pct}%</span>
    </div>`;
  }).join('');

  const ctx = $('chart-pie').getContext('2d');
  S.charts.pie = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderWidth: 3,
        borderColor: '#f0faf7',
        hoverBorderColor: '#ffffff',
        hoverOffset: 10,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0a3d31',
          titleColor: '#7fe8d3',
          bodyColor: '#d1f5ec',
          borderColor: 'rgba(27,196,157,.3)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: c => `  ${c.label}: ${c.parsed} entities (${total ? Math.round(c.parsed/total*100) : 0}%)`,
          }
        },
      },
    },
  });
}

/* Chart 3 – GEI grouped bar by sector */
function renderGEIChart() {
  destroyChart('gei');
  const sectorMap = {};
  S.filteredData.forEach(e => {
    if (!e.sector) return;
    if (!sectorMap[e.sector]) sectorMap[e.sector] = { bGEI:[], t2526:[], t2627:[] };
    if (e.baselineGHGEmissionIntensity != null) sectorMap[e.sector].bGEI.push(e.baselineGHGEmissionIntensity);
    if (e.targetGEI_2025_26 != null)            sectorMap[e.sector].t2526.push(e.targetGEI_2025_26);
    if (e.targetGEI_2026_27 != null)            sectorMap[e.sector].t2627.push(e.targetGEI_2026_27);
  });

  const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  const sectors = Object.keys(sectorMap);

  const ctx = $('chart-gei').getContext('2d');
  S.charts.gei = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sectors,
      datasets: [
        {
          label: 'Baseline 2023–24',
          data: sectors.map(s => avg(sectorMap[s].bGEI)),
          backgroundColor: 'rgba(245,158,11,.85)',
          hoverBackgroundColor: '#f59e0b',
          borderRadius: 6, borderSkipped: false, borderWidth: 0,
        },
        {
          label: 'Target 2025–26',
          data: sectors.map(s => avg(sectorMap[s].t2526)),
          backgroundColor: 'rgba(27,196,157,.85)',
          hoverBackgroundColor: '#1BC49D',
          borderRadius: 6, borderSkipped: false, borderWidth: 0,
        },
        {
          label: 'Target 2026–27',
          data: sectors.map(s => avg(sectorMap[s].t2627)),
          backgroundColor: 'rgba(11,61,49,.82)',
          hoverBackgroundColor: '#0b3d31',
          borderRadius: 6, borderSkipped: false, borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0a3d31',
          titleColor: '#7fe8d3',
          bodyColor: '#d1f5ec',
          borderColor: 'rgba(27,196,157,.3)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          callbacks: { label: c => `  ${c.dataset.label}: ${c.parsed.y != null ? c.parsed.y.toFixed(4) : '—'} tCO₂e/t` },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11, family: 'DM Sans, sans-serif' }, color: '#4a6360' },
        },
        y: {
          grid: { color: 'rgba(27,196,157,.1)', drawBorder: false },
          ticks: { font: { size: 11, family: 'DM Sans, sans-serif' }, color: '#5a8a80' },
          title: { display: true, text: 'tCO₂e / tonne', font: { size: 10, family: 'DM Sans, sans-serif' }, color: '#84aaa4' },
        },
      },
    },
  });
}

/* Top Entities list */
function renderTopEntities() {
  const list = $('top-entities-list');
  const vol  = $('indicative-volume');

  const withPct = S.filteredData
    .map(e => ({ ...e, _pct: reductionPct(e) }))
    .filter(e => e._pct != null)
    .sort((a,b) => b._pct - a._pct)
    .slice(0, 7);

  if (!withPct.length) {
    list.innerHTML = '<div class="no-data">No reduction data available</div>';
    vol.textContent = '—';
    return;
  }

  const maxPct = withPct[0]._pct;

  list.innerHTML = withPct.map((e, i) => {
    const tonne = e.targetEstimatedReduction_2026_27;
    const rankClass = i === 0 ? 'te2-rank-1' : i === 1 ? 'te2-rank-2' : i === 2 ? 'te2-rank-3' : 'te2-rank-n';
    const barWidth = maxPct > 0 ? Math.round((e._pct / maxPct) * 100) : 0;
    return `<div class="te2-item">
      <div class="te2-rank ${rankClass}">${i + 1}</div>
      <div class="te2-meta">
        <div class="te2-name">${e.entityName || e.registrationNumber || '—'}</div>
        <div class="te2-sector">${[e.subSector || e.sector, e.state].filter(Boolean).join(' · ')}</div>
        <div class="te2-bar-track"><div class="te2-bar-fill" style="width:${barWidth}%"></div></div>
      </div>
      <div class="te2-right">
        <div class="te2-pct">${e._pct.toFixed(2)}%</div>
        <div class="te2-tonne">${tonne != null ? fmtTonne(tonne) + ' t' : '—'}</div>
      </div>
    </div>`;
  }).join('');

  const totalVol = S.filteredData.reduce((s,e) => s + (e.targetEstimatedReduction_2026_27 || 0), 0);
  vol.textContent = totalVol ? fmtTonne(totalVol) + ' tCO₂e' : '—';
}

/* Chart 4 – State bar */
function renderStateChart() {
  destroyChart('state');
  const counts = {};
  S.filteredData.forEach(e => { if (e.state) counts[e.state] = (counts[e.state] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0, 12);

  const ctx = $('chart-state').getContext('2d');
  S.charts.state = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(x=>x[0]),
      datasets: [{ data: sorted.map(x=>x[1]), backgroundColor: sorted.map((_,i)=>CHART_COLORS[i%CHART_COLORS.length]), borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#4a6360', maxRotation: 35, minRotation: 30 } },
        y: { grid: { color: '#e2e8e6' }, ticks: { font: { size: 10 } } },
      },
    },
  });
}

/* Chart 5 – Sub-sector bar */
function renderSubSectorChart() {
  destroyChart('subsector');
  const counts = {};
  S.filteredData.forEach(e => { if (e.subSector) counts[e.subSector] = (counts[e.subSector] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0, 10);

  const ctx = $('chart-subsector').getContext('2d');
  S.charts.subsector = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(x=>x[0]),
      datasets: [{ data: sorted.map(x=>x[1]), backgroundColor: sorted.map((_,i)=>CHART_COLORS[(i+3)%CHART_COLORS.length]), borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#e2e8e6' }, ticks: { font: { size: 10 } } },
        y: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#4a6360' } },
      },
    },
  });
}

/* ─── Entity Cards ───────────────────────────────────────────────────────── */
function renderEntityCards() {
  const container = $('entity-cards');
  const data = S.filteredData;
  const start = (S.page - 1) * S.perPage;
  const slice = data.slice(start, start + S.perPage);

  if (!data.length) {
    container.innerHTML = '<div class="no-data">No entities match the current filters.</div>';
    $('pagination').innerHTML = '';
    return;
  }

  container.innerHTML = slice.map((e, idx) => {
    const globalIdx = start + idx + 1;
    const pct = reductionPct(e);
    return `
    <div class="entity-card">
      <div class="entity-card-header">
        <div>
          <div class="entity-card-name">Entity Profile — ${e.entityName || '—'}</div>
        </div>
        <div class="entity-card-reg">${e.registrationNumber || '—'}</div>
      </div>
      <div class="entity-fields-grid">
        <div class="entity-field">
          <div class="entity-field-label">Entity Serial Number</div>
          <div class="entity-field-value">${globalIdx}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">Covered Sector</div>
          <div class="entity-field-value">${e.sector || '<span class="null-val">—</span>'}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">Sub-Sector</div>
          <div class="entity-field-value">${e.subSector || '<span class="null-val">—</span>'}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">CCTS Registration Number</div>
          <div class="entity-field-value mono">${e.registrationNumber || '—'}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">Legal Entity Name</div>
          <div class="entity-field-value">${e.entityName || '<span class="null-val">—</span>'}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">Registered Facility Address</div>
          <div class="entity-field-value">${e.obligatedEntityAddress || '<span class="null-val">—</span>'}</div>
        </div>
    
        <div class="entity-field">
          <div class="entity-field-label">State / UT</div>
          <div class="entity-field-value">${e.state || '<span class="null-val">—</span>'}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">Baseline Equivalent Product Output (2023–24) (tonnes)</div>
          <div class="entity-field-value">${fmtTonne(e.baselineOutput)}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">Baseline GEI (2023–24) (tCO₂e/tonne)</div>
          <div class="entity-field-value">${fmtGEI(e.baselineGHGEmissionIntensity)}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">GEI Target (2025–26) (tCO₂e/tonne)</div>
          <div class="entity-field-value">${fmtGEI(e.targetGEI_2025_26)}</div>
        </div>
        <div class="entity-field">
          <div class="entity-field-label">GEI Target (2026–27) (tCO₂e/tonne)</div>
          <div class="entity-field-value">${fmtGEI(e.targetGEI_2026_27)}</div>
        </div>
        
        ${pct != null ? `<div class="entity-field">
          <div class="entity-field-label">Reduction % (2026–27)</div>
          <div class="entity-field-value" style="color:var(--primary);font-weight:700">${pct.toFixed(2)}%</div>
        </div>` : '<div class="entity-field"></div>'
      
      }
      </div>
      <div class="entity-reduction-grid">
        <div class="entity-reduction-field">
          <div class="entity-reduction-label">Target GEI Reduction (2025–26) (tCO₂e/tonne)</div>
          <div class="entity-reduction-value ${e.targetReduction_2025_26 == null ? 'null-val' : ''}">${fmtGEI(e.targetReduction_2025_26)}</div>
        </div>
        <div class="entity-reduction-field">
          <div class="entity-reduction-label">Target GEI Reduction (2026–27) (tCO₂e/tonne)</div>
          <div class="entity-reduction-value ${e.targetReduction_2026_27 == null ? 'null-val' : ''}">${fmtGEI(e.targetReduction_2026_27)}</div>
        </div>
        <div class="entity-reduction-field">
          <div class="entity-reduction-label">Indicative Emissions Reduction (2025–26) (tonnes)</div>
          <div class="entity-reduction-value ${e.targetEstimatedReduction_2025_26 == null ? 'null-val' : ''}">${fmtTonne(e.targetEstimatedReduction_2025_26)}</div>
        </div>
        <div class="entity-reduction-field">
          <div class="entity-reduction-label">Indicative Emissions Reduction (2026–27) (tonnes)</div>
          <div class="entity-reduction-value ${e.targetEstimatedReduction_2026_27 == null ? 'null-val' : ''}">${fmtTonne(e.targetEstimatedReduction_2026_27)}</div>
        </div>
        
      </div>
    </div>`;
  }).join('');

  renderPagination($('pagination'), data.length, S.page, S.perPage, (p) => { S.page = p; renderEntityCards(); });
}

/* ─── Pagination helper ──────────────────────────────────────────────────── */
function renderPagination(container, total, current, perPage, onPage) {
  const pages = Math.ceil(total / perPage);
  if (pages <= 1) { container.innerHTML = ''; return; }

  const range = [];
  const delta = 2;
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || (i >= current - delta && i <= current + delta)) range.push(i);
    else if (range[range.length - 1] !== '…') range.push('…');
  }

  container.innerHTML = `
    <button class="page-btn ${current === 1 ? 'disabled' : ''}" onclick="${current > 1 ? `paginate(${current - 1})` : ''}">‹</button>
    ${range.map(p => p === '…'
      ? `<span class="page-info">…</span>`
      : `<button class="page-btn ${p === current ? 'active' : ''}" onclick="paginate(${p})">${p}</button>`
    ).join('')}
    <button class="page-btn ${current === pages ? 'disabled' : ''}" onclick="${current < pages ? `paginate(${current + 1})` : ''}">›</button>
    <span class="page-info">Page ${current}/${pages}</span>
  `;

  // Store callback
  window._paginateCallback = onPage;
}

window.paginate = function(p) {
  if (window._paginateCallback) {
    window._paginateCallback(p);
    window.scrollTo({ top: document.querySelector('.section-header.mt-0')?.offsetTop - 80 || 0, behavior: 'smooth' });
  }
};

/* ─── Modals ─────────────────────────────────────────────────────────────── */
window.showModal = function(id) { $(id).classList.remove('hidden'); };
window.hideModal = function(id) { $(id).classList.add('hidden'); };
window.closeModalOnOverlay = function(e, id) { if (e.target === $(id)) hideModal(id); };


/* ─── Tab Switching ──────────────────────────────────────────────────────── */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => {
    const isActive = p.id === `tab-${tab}`;
    p.classList.toggle('active', isActive);
    p.style.display = isActive ? '' : 'none';
  });
  if (tab === 'admin') loadAdminData();
}

/* ─── Admin: Load table ──────────────────────────────────────────────────── */
async function loadAdminData() {
  $('admin-loading').classList.remove('hidden');
  $('admin-tbody').innerHTML = '';
  try {
    const q = S.adminSearch ? `&search=${encodeURIComponent(S.adminSearch)}` : '';
    const res = await apiFetch(`/api/ccts?limit=50&page=${S.adminPage}${q}`);
    S.adminRawData = res.data || [];
    renderAdminTable(res.pagination);
  } catch (e) {
    toast('Failed to load admin data: ' + e.message, 'error');
  } finally {
    $('admin-loading').classList.add('hidden');
  }
}

function renderAdminTable(pagination) {
  const tbody = $('admin-tbody');
  if (!S.adminRawData.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-data">No entities found</td></tr>';
    $('admin-pagination').innerHTML = '';
    return;
  }

  tbody.innerHTML = S.adminRawData.map((e, i) => {
    const idx = ((S.adminPage - 1) * 50) + i + 1;
    return `<tr>
      <td><input type="checkbox" class="row-check" data-id="${e._id}" /></td>
      <td class="admin-serial">${idx}</td>
      <td class="mono" style="font-size:.78rem">${e.registrationNumber || '—'}</td>
      <td>${e.entityName || '—'}</td>
      <td>${e.sector || '—'}</td>
      <td>${e.state || '—'}</td>
      <td>${fmtGEI(e.baselineGHGEmissionIntensity)}</td>
      <td>${fmtGEI(e.targetGEI_2026_27)}</td>
      <td style="display:flex;gap:.4rem">
        <button class="action-btn action-btn-edit" onclick="openEditModal('${e._id}')">Edit</button>
        <button class="action-btn action-btn-delete" onclick="deleteEntity('${e._id}','${(e.entityName||e.registrationNumber||'').replace(/'/g,"\\'")}')">Delete</button>
      </td>
    </tr>`;
  }).join('');

  // Checkboxes
  tbody.querySelectorAll('.row-check').forEach(cb => {
    cb.checked = S.adminSelected.has(cb.dataset.id);
    cb.addEventListener('change', () => {
      if (cb.checked) S.adminSelected.add(cb.dataset.id);
      else            S.adminSelected.delete(cb.dataset.id);
      updateBulkDeleteBtn();
    });
  });

  if (pagination) {
    renderPagination($('admin-pagination'), pagination.total, S.adminPage, 50, (p) => {
      S.adminPage = p; loadAdminData();
    });
  }
}

function updateBulkDeleteBtn() {
  const btn = $('bulk-delete-btn');
  $('selected-count').textContent = S.adminSelected.size;
  btn.disabled = S.adminSelected.size === 0;
}

/* ─── Admin: Select All ──────────────────────────────────────────────────── */
$('select-all').addEventListener('change', function() {
  document.querySelectorAll('.row-check').forEach(cb => {
    cb.checked = this.checked;
    if (this.checked) S.adminSelected.add(cb.dataset.id);
    else              S.adminSelected.delete(cb.dataset.id);
  });
  updateBulkDeleteBtn();
});

/* ─── Admin: Bulk Delete ─────────────────────────────────────────────────── */
$('bulk-delete-btn').addEventListener('click', async () => {
  if (!S.adminSelected.size) return;
  if (!confirm(`Delete ${S.adminSelected.size} selected entity(ies)? This cannot be undone.`)) return;
  try {
    const res = await apiFetch('/api/ccts/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids: [...S.adminSelected] }),
    });
    toast(`${res.deleted} entity(ies) deleted`, 'success');
    S.adminSelected.clear();
    updateBulkDeleteBtn();
    loadAdminData();
    loadAllData(); // refresh dashboard
  } catch (e) {
    toast('Bulk delete failed: ' + e.message, 'error');
  }
});

/* ─── Admin: Delete single ───────────────────────────────────────────────── */
window.deleteEntity = async function(id, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/ccts/${id}`, { method: 'DELETE' });
    toast('Entity deleted', 'success');
    S.adminSelected.delete(id);
    updateBulkDeleteBtn();
    loadAdminData();
    loadAllData();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'error');
  }
};

/* ─── Admin: Open Edit Modal ─────────────────────────────────────────────── */
window.openEditModal = function(id) {
  const entity = S.adminRawData.find(e => e._id === id);
  if (!entity) return;
  const form = $('edit-entity-form');
  $('edit-id').value = id;
  const fields = ['sector','subSector','registrationNumber','entityName','state','obligatedEntityAddress','source',
  'baselineOutput','baselineGHGEmissionIntensity','targetGEI_2025_26','targetGEI_2026_27',
  'targetReduction_2025_26','targetReduction_2026_27','targetEstimatedReduction_2025_26','targetEstimatedReduction_2026_27'];
  fields.forEach(f => { if (form.elements[f]) form.elements[f].value = entity[f] ?? ''; });
  showModal('edit-modal');
};

/* ─── Admin: Edit Submit ─────────────────────────────────────────────────── */
$('edit-entity-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id  = $('edit-id').value;
  const msg = $('edit-msg');
  const form = e.target;
  const body = {};
new FormData(form).forEach((v, k) => {
  if (v !== '') {
    const textFields = [
      'sector',
      'subSector',
      'registrationNumber',
      'entityName',
      'state',
      'obligatedEntityAddress',
      'source'
    ];
    body[k] = textFields.includes(k) ? v : Number(v);
  }
});
  try {
    await apiFetch(`/api/ccts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    msg.textContent = 'Entity updated successfully.';
    msg.className = 'form-msg success';
    msg.classList.remove('hidden');
    setTimeout(() => { hideModal('edit-modal'); msg.classList.add('hidden'); }, 1500);
    loadAdminData();
    loadAllData();
  } catch (err) {
    msg.textContent = 'Update failed: ' + err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

/* ─── Admin: Add Entity ──────────────────────────────────────────────────── */
$('add-entity-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('add-entity-msg');
  const body = {};
  new FormData(e.target).forEach((v, k) => {
  if (v !== '') {
    body[k] = (
      k !== 'sector' &&
      k !== 'subSector' &&
      k !== 'registrationNumber' &&
      k !== 'entityName' &&
      k !== 'state' &&
      k !== 'obligatedEntityAddress' &&
      k !== 'source'
    ) ? Number(v) : v;
  }
});
  try {
    await apiFetch('/api/ccts', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = 'Entity added successfully!';
    msg.className = 'form-msg success';
    msg.classList.remove('hidden');
    e.target.reset();
    setTimeout(() => msg.classList.add('hidden'), 3000);
    loadAdminData();
    loadAllData();
  } catch (err) {
    msg.textContent = 'Failed: ' + err.message;
    msg.className = 'form-msg error';
    msg.classList.remove('hidden');
  }
});

/* ─── Admin: Bulk Upload ─────────────────────────────────────────────────── */
const dropZone = $('drop-zone');
const fileInput  = $('upload-file');
const uploadBtn  = $('upload-btn');
const uploadFN   = $('upload-filename');
const uploadRes  = $('upload-results');

let selectedFile = null;

function setUploadFile(file) {
  if (!file) return;
  selectedFile = file;
  uploadFN.textContent = `📄 ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`;
  uploadFN.classList.remove('hidden');
  uploadBtn.disabled = false;
  uploadRes.classList.add('hidden');
}

fileInput.addEventListener('change', () => setUploadFile(fileInput.files[0]));
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  setUploadFile(e.dataTransfer.files[0]);
});

uploadBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading…';
  uploadRes.classList.add('hidden');

  const fd = new FormData();
  fd.append('file', selectedFile);

  try {
    const r = await fetch(`${API_BASE}/api/ccts/bulk-upload`, {
      method: 'POST',
      body: fd,
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
    const rs = json.results;

    uploadRes.classList.remove('hidden');
    uploadRes.classList.remove('error-state');
    uploadRes.innerHTML = `
      <div class="result-row"><span class="result-key">File type</span><span class="result-val">${rs.fileType?.toUpperCase()}</span></div>
      <div class="result-row"><span class="result-key">Total rows</span><span class="result-val">${rs.totalRows}</span></div>
      <div class="result-row"><span class="result-key">Valid rows</span><span class="result-val">${rs.validRows}</span></div>
      <div class="result-row"><span class="result-key">Created</span><span class="result-val" style="color:var(--primary)">${rs.created}</span></div>
      <div class="result-row"><span class="result-key">Updated</span><span class="result-val" style="color:var(--info)">${rs.updated}</span></div>
      <div class="result-row"><span class="result-key">Skipped</span><span class="result-val" style="color:var(--warning)">${rs.skipped}</span></div>
      ${rs.errors?.length ? `<div class="upload-errors">${rs.errors.slice(0,10).map(er=>`<div class="upload-error-item">Row ${er.row}: ${er.error}</div>`).join('')}${rs.errors.length>10?`<div class="upload-error-item">… and ${rs.errors.length-10} more errors</div>`:''}</div>` : ''}
    `;
    toast(`Import complete: ${rs.created} created, ${rs.updated} updated`, 'success', 4000);
    loadAdminData();
    loadAllData();
  } catch (err) {
    uploadRes.classList.remove('hidden');
    uploadRes.classList.add('error-state');
    uploadRes.innerHTML = `<div class="result-row"><span class="result-key">Error</span><span class="result-val" style="color:var(--danger)">${err.message}</span></div>`;
    toast('Upload failed: ' + err.message, 'error');
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload & Import';
    selectedFile = null;
    fileInput.value = '';
    uploadFN.classList.add('hidden');
  }
});

/* ─── Admin: Search ──────────────────────────────────────────────────────── */
let adminSearchTimer;
$('admin-search').addEventListener('input', function() {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(() => {
    S.adminSearch = this.value.trim();
    S.adminPage = 1;
    S.adminSelected.clear();
    updateBulkDeleteBtn();
    loadAdminData();
  }, 400);
});

/* ─── Dashboard Filters ──────────────────────────────────────────────────── */
let searchTimer;
$('search-input').addEventListener('input', function() {
  clearTimeout(searchTimer);
  $('search-clear').classList.toggle('hidden', !this.value);
  searchTimer = setTimeout(() => { S.filters.search = this.value; applyFilters(); }, 300);
});

$('search-clear').addEventListener('click', () => {
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  S.filters.search = '';
  applyFilters();
});

$('filter-sector').addEventListener('change', function() {
  S.filters.sector = this.value;
  // Reset sub-sector when sector changes
  if (this.value) {
    const subs = unique(S.rawData.filter(e => e.sector === this.value).map(e => e.subSector));
    const sel = $('filter-subsector');
    while (sel.options.length > 1) sel.remove(1);
    subs.forEach(s => sel.add(new Option(s, s)));
    S.filters.subSector = '';
    sel.value = '';
  } else {
    populateDropdowns();
  }
  applyFilters();
});

$('filter-subsector').addEventListener('change', function() {
  S.filters.subSector = this.value;
  applyFilters();
});

$('filter-state').addEventListener('change', function() {
  S.filters.state = this.value;
  applyFilters();
});

$('reset-filters').addEventListener('click', () => {
  S.filters = { search:'', sector:'', subSector:'', state:'' };
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  $('filter-sector').value    = '';
  $('filter-subsector').value = '';
  $('filter-state').value     = '';
  populateDropdowns();
  applyFilters();
});

$('sort-by').addEventListener('change',    function() { S.sortBy    = this.value; applyFilters(); });
$('sort-order').addEventListener('change', function() { S.sortOrder = this.value; applyFilters(); });

/* ─── Tab Nav ────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ─── Init ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', loadAllData);


    // <div class="entity-field">
        //   <div class="entity-field-label">Source</div>
        //   <div class="entity-field-value">${e.source || '<span class="null-val">—</span>'}</div>
        // </div>