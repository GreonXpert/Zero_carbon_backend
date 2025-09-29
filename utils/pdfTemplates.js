// utils/pdfTemplates.js
const moment = require('moment');

const baseCSS = `
  <style>
    @page { size: A4; margin: 18mm; }
    body { font-family: -apple-system, BlinkMacSystemFont,'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', Arial, sans-serif; color:#1f2937; }
    .brand { color:#0ea5e9; font-weight:800; letter-spacing:.5px }
    .card { border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin:12px 0; }
    .title { font-size:24px; font-weight:800; margin:0 0 8px 0; }
    .sub { color:#6b7280; margin:0 0 18px 0; }
    .row { display:flex; gap:12px; margin:8px 0; }
    .col { flex:1; }
    .label { font-size:12px; color:#6b7280; }
    .value { font-size:14px; font-weight:600; }
    table { width:100%; border-collapse: collapse; margin-top:10px;}
    th, td { border:1px solid #e5e7eb; padding:8px; text-align:left; font-size:13px;}
    th { background:#f8fafc;}
    .badge { display:inline-block; background:#eef2ff; color:#4f46e5; padding:4px 10px; border-radius:9999px; font-size:11px; font-weight:700;}
    .muted { color:#6b7280; }
    .hr { height:1px; background:#e5e7eb; margin:16px 0; }
  </style>
`;

function safe(v, fallback = '—') {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string' && v.trim() === '') return fallback;
  return v;
}

function renderHeader(client, heading, subtitle) {
  return `
    <div>
      <div class="brand">ZeroCarbon</div>
      <h1 class="title">${heading}</h1>
      <p class="sub">${subtitle}</p>
      <div class="row">
        <div class="col">
          <div class="label">Client ID</div>
          <div class="value">${client.clientId}</div>
        </div>
        <div class="col">
          <div class="label">Company</div>
          <div class="value">${safe(client?.leadInfo?.companyName)}</div>
        </div>
        <div class="col">
          <div class="label">Contact</div>
          <div class="value">${safe(client?.leadInfo?.contactPersonName)}</div>
        </div>
      </div>
      <div class="hr"></div>
    </div>
  `;
}

/** CLIENT DATA PDF */
function renderClientDataHTML(client) {
  const primary = client?.submissionData?.companyInfo?.primaryContactPerson || {};
  const org = client?.submissionData?.organizationalOverview || {};
  const submittedAt = client?.submissionData?.submittedAt || client?.submissionData?.updatedAt;

  return `
    <!doctype html><html><head><meta charset="utf-8" />${baseCSS}</head>
    <body>
      ${renderHeader(
        client,
        'Client Data Snapshot',
        `Generated on ${moment().format('DD MMM YYYY, HH:mm')} • Stage: ${client.stage} • Status: ${client.status}`
      )}

      <div class="card">
        <div class="badge">Company Info</div>
        <div class="row">
          <div class="col">
            <div class="label">Primary Contact</div>
            <div class="value">${safe(primary.name)}</div>
            <div class="muted">${safe(primary.designation)}</div>
          </div>
          <div class="col">
            <div class="label">Email</div><div class="value">${safe(primary.email)}</div>
            <div class="label" style="margin-top:6px;">Phone</div><div class="value">${safe(primary.phoneNumber)}</div>
          </div>
          <div class="col">
            <div class="label">Submitted/Updated On</div>
            <div class="value">${submittedAt ? moment(submittedAt).format('DD MMM YYYY, HH:mm') : '—'}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Organizational Overview</div>
        <div class="row">
          <div class="col">
            <div class="label">Industry Sector</div><div class="value">${safe(org.industrySector)}</div>
          </div>
          <div class="col">
            <div class="label">Employees</div><div class="value">${safe(org.totalEmployees, 0)}</div>
          </div>
          <div class="col">
            <div class="label">Accounting Year</div><div class="value">${safe(org.accountingYear)}</div>
          </div>
        </div>
        <div class="row"><div class="col">
          <div class="label">Company Description</div>
          <div class="value" style="font-weight:500;">${safe(org.companyDescription)}</div>
        </div></div>
      </div>

      <div class="card">
        <div class="badge">Emissions Profile (Consolidated)</div>
        <table>
          <thead><tr><th>Scope</th><th>Included</th><th>Notes</th></tr></thead>
          <tbody>
            <tr>
              <td>Scope 1</td>
              <td>${client?.submissionData?.emissionsProfile?.scope1 ? 'Yes' : '—'}</td>
              <td class="muted">Stationary, Mobile, Process, Fugitive (if provided)</td>
            </tr>
            <tr>
              <td>Scope 2</td>
              <td>${client?.submissionData?.emissionsProfile?.scope2 ? 'Yes' : '—'}</td>
              <td class="muted">Purchased electricity/steam (if provided)</td>
            </tr>
            <tr>
              <td>Scope 3</td>
              <td>${client?.submissionData?.emissionsProfile?.scope3?.includeScope3 ? 'Yes' : '—'}</td>
              <td class="muted">Selected categories (if provided)</td>
            </tr>
          </tbody>
        </table>
      </div>
    </body></html>
  `;
}

/** PROPOSAL PDF */
function renderProposalHTML(client) {
  const p = client?.proposalData || {};
  return `
    <!doctype html><html><head><meta charset="utf-8" />${baseCSS}</head>
    <body>
      ${renderHeader(
        client,
        'Service Proposal',
        `Generated on ${moment().format('DD MMM YYYY, HH:mm')} • Proposal #: ${p.proposalNumber || '—'} • Valid Until: ${p.validUntil ? moment(p.validUntil).format('DD MMM YYYY') : '—'}`
      )}

      <div class="card">
        <div class="badge">Pricing Summary</div>
        <div class="row">
          <div class="col"><div class="label">Currency</div><div class="value">${p?.pricing?.currency || 'INR'}</div></div>
          <div class="col"><div class="label">Total Amount</div><div class="value">${p?.pricing?.totalAmount || 0}</div></div>
          <div class="col"><div class="label">Payment Terms</div><div class="value">${p?.pricing?.paymentTerms || '—'}</div></div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Data Integration Points</div>
        <div class="value">${p?.totalDataIntegrationPoints || 0}</div>
      </div>

      <div class="card">
        <div class="badge">Scopes</div>
        <table>
          <thead><tr><th>Module</th><th>Name</th><th>Data Type</th></tr></thead>
          <tbody>
            ${Object.entries(p?.scopes || {}).map(([k, v]) =>
              `<tr><td>${k}</td><td>${v?.name || '—'}</td><td>${v?.dataType || '—'}</td></tr>`
            ).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="badge">Consolidated Data</div>
        <table>
          <thead><tr><th>Scope</th><th>Category</th><th>Total Points</th><th>Collection Methods</th></tr></thead>
          <tbody>
            ${['scope1','scope2','scope3'].map(s => {
              const c = p?.consolidatedData?.[s] || {};
              return `<tr>
                <td>${s.toUpperCase()}</td>
                <td>${c.category || '—'}</td>
                <td>${c.totalDataPoints ?? '—'}</td>
                <td>${Array.isArray(c.collectionMethods) ? c.collectionMethods.join(', ') : (c.collectionMethods || '—')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="badge">Terms & SLA</div>
        <div class="label">Terms</div><div class="value" style="white-space:pre-wrap">${p.termsAndConditions || '—'}</div>
        <div class="row" style="margin-top:10px">
          <div class="col"><div class="label">Response Time</div><div class="value">${p?.sla?.responseTime || '—'}</div></div>
          <div class="col"><div class="label">Resolution Time</div><div class="value">${p?.sla?.resolutionTime || '—'}</div></div>
          <div class="col"><div class="label">Availability</div><div class="value">${p?.sla?.availability || '—'}</div></div>
        </div>
      </div>
    </body></html>
  `;
}

module.exports = { renderClientDataHTML, renderProposalHTML };
