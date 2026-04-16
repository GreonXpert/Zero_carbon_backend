/**
 * ESGLink PDF Templates
 *
 * Provides HTML rendering for ESGLink client data — used to generate PDFs
 * at the submitClientData stage. Mirrors the purpose of ZeroCarbon's
 * renderClientDataHTML but shows ESGLink-specific fields only.
 */

/**
 * Renders an HTML string for ESGLink client submission data.
 * Displays: company info, esgLinkAssessmentLevel (module + frameworks), submission metadata.
 *
 * @param {Object} client - Mongoose Client document
 * @returns {string} HTML string suitable for PDF generation
 */
function renderEsgLinkClientDataHTML(client) {
  const companyInfo    = client.submissionData?.companyInfo || {};
  const assessment     = client.submissionData?.esgLinkAssessmentLevel || {};
  const primary        = companyInfo.primaryContactPerson || {};
  const alternate      = companyInfo.alternateContactPerson || {};
  const submittedAt    = client.submissionData?.submittedAt
    ? new Date(client.submissionData.submittedAt).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'long', year: 'numeric',
      })
    : 'N/A';

  const selectedModule     = assessment.module || null;
  const selectedFrameworks = Array.isArray(assessment.frameworks) ? assessment.frameworks : [];

  const frameworkBadges = selectedFrameworks.length
    ? selectedFrameworks
        .map(f => `<span style="display:inline-block;background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;border-radius:4px;padding:3px 10px;margin:2px 4px 2px 0;font-size:13px;font-weight:600;">${f}</span>`)
        .join('')
    : '<span style="color:#888;font-style:italic;">None selected</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ESGLink Client Data — ${client.clientId}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f5f7fa; color: #222; font-size: 14px; }
    .page { max-width: 800px; margin: 32px auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); overflow: hidden; }
    .header { background: linear-gradient(135deg, #1a6b3a 0%, #2e9d5e 100%); color: #fff; padding: 32px 40px; }
    .header h1 { font-size: 22px; font-weight: 700; letter-spacing: 0.5px; }
    .header .subtitle { font-size: 13px; opacity: 0.85; margin-top: 6px; }
    .header .client-id { font-size: 13px; opacity: 0.9; margin-top: 4px; }
    .section { padding: 28px 40px; border-bottom: 1px solid #e8edf2; }
    .section:last-child { border-bottom: none; }
    .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #1a6b3a; margin-bottom: 16px; }
    .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 32px; }
    .field-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 3px; }
    .field-value { font-size: 14px; color: #222; }
    .field-value.empty { color: #aaa; font-style: italic; }
    .module-badge { display: inline-block; background: #1a6b3a; color: #fff; border-radius: 4px; padding: 4px 14px; font-size: 13px; font-weight: 700; letter-spacing: 0.5px; }
    .module-none { color: #aaa; font-style: italic; font-size: 14px; }
    .footer { background: #f5f7fa; padding: 18px 40px; text-align: center; font-size: 12px; color: #aaa; }
  </style>
</head>
<body>
  <div class="page">
    <!-- Header -->
    <div class="header">
      <h1>ESGLink — Client Data Submission</h1>
      <div class="subtitle">This document confirms successful data submission for ESGLink services.</div>
      <div class="client-id">Client ID: <strong>${client.clientId || 'N/A'}</strong> &nbsp;|&nbsp; Submitted: <strong>${submittedAt}</strong></div>
    </div>

    <!-- Company Information -->
    <div class="section">
      <div class="section-title">Company Information</div>
      <div class="field-grid">
        <div class="field">
          <div class="field-label">Company Name</div>
          <div class="field-value ${!companyInfo.companyName ? 'empty' : ''}">${companyInfo.companyName || '—'}</div>
        </div>
        <div class="field">
          <div class="field-label">Company Address</div>
          <div class="field-value ${!companyInfo.companyAddress ? 'empty' : ''}">${companyInfo.companyAddress || '—'}</div>
        </div>
      </div>
    </div>

    <!-- Primary Contact -->
    <div class="section">
      <div class="section-title">Primary Contact Person</div>
      <div class="field-grid">
        <div class="field">
          <div class="field-label">Name</div>
          <div class="field-value ${!primary.name ? 'empty' : ''}">${primary.name || '—'}</div>
        </div>
        <div class="field">
          <div class="field-label">Designation</div>
          <div class="field-value ${!primary.designation ? 'empty' : ''}">${primary.designation || '—'}</div>
        </div>
        <div class="field">
          <div class="field-label">Email</div>
          <div class="field-value ${!primary.email ? 'empty' : ''}">${primary.email || '—'}</div>
        </div>
        <div class="field">
          <div class="field-label">Phone Number</div>
          <div class="field-value ${!primary.phoneNumber ? 'empty' : ''}">${primary.phoneNumber || '—'}</div>
        </div>
      </div>
    </div>

    ${alternate.name ? `
    <!-- Alternate Contact -->
    <div class="section">
      <div class="section-title">Alternate Contact Person</div>
      <div class="field-grid">
        <div class="field">
          <div class="field-label">Name</div>
          <div class="field-value">${alternate.name}</div>
        </div>
        <div class="field">
          <div class="field-label">Designation</div>
          <div class="field-value ${!alternate.designation ? 'empty' : ''}">${alternate.designation || '—'}</div>
        </div>
        <div class="field">
          <div class="field-label">Email</div>
          <div class="field-value ${!alternate.email ? 'empty' : ''}">${alternate.email || '—'}</div>
        </div>
        <div class="field">
          <div class="field-label">Phone Number</div>
          <div class="field-value ${!alternate.phoneNumber ? 'empty' : ''}">${alternate.phoneNumber || '—'}</div>
        </div>
      </div>
    </div>
    ` : ''}

    <!-- ESGLink Assessment Level -->
    <div class="section">
      <div class="section-title">ESGLink Assessment Level</div>

      <div style="margin-bottom:20px;">
        <div class="field-label" style="margin-bottom:8px;">Product Module</div>
        ${selectedModule
          ? `<span class="module-badge">${selectedModule}</span>`
          : `<span class="module-none">Not selected (optional)</span>`}
      </div>

      <div>
        <div class="field-label" style="margin-bottom:8px;">Reporting Frameworks</div>
        <div>${frameworkBadges}</div>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      Generated by GreonXpert ESGLink Platform &nbsp;|&nbsp; ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}
    </div>
  </div>
</body>
</html>`;
}

module.exports = { renderEsgLinkClientDataHTML };
