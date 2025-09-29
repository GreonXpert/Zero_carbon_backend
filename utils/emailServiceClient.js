// utils/emailServiceClient.js
const nodemailer = require('nodemailer');
const moment = require('moment');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // already used in utils/mail.js
    pass: process.env.EMAIL_PASS
  }
});

const baseEmailStyles = `
  <style>
    .wrap{max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb}
    .head{background:linear-gradient(135deg,#0ea5e9,#2563eb);padding:28px 24px;color:#fff}
    .brand{font-size:18px;font-weight:800;letter-spacing:.4px;opacity:.95}
    .title{margin:6px 0 0 0;font-size:22px;font-weight:800}
    .content{padding:22px 22px 8px 22px;color:#111827;line-height:1.55}
    .k{color:#6b7280;font-size:12px}
    .v{font-weight:700}
    .row{display:flex;gap:12px;margin:8px 0}
    .col{flex:1}
    .card{background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin:10px 0}
    .btn{display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700}
    .foot{padding:18px 22px;color:#6b7280;border-top:1px solid #e5e7eb;background:#fafafa;font-size:12px}
  </style>
`;

function detailRow(client) {
  return `
    <div class="row">
      <div class="col"><div class="k">Client ID</div><div class="v">${client.clientId}</div></div>
      <div class="col"><div class="k">Company</div><div class="v">${client?.leadInfo?.companyName || '—'}</div></div>
      <div class="col"><div class="k">Stage / Status</div><div class="v">${client.stage} / ${client.status}</div></div>
    </div>
  `;
}

function envelope({ title, bodyHtml, cta }) {
  return `
    ${baseEmailStyles}
    <div class="wrap">
      <div class="head">
        <div class="brand">ZeroCarbon</div>
        <div class="title">${title}</div>
      </div>
      <div class="content">
        ${bodyHtml}
        ${cta ? `<p style="margin-top:14px"><a class="btn" href="${cta.href}" target="_blank">${cta.label}</a></p>` : ''}
      </div>
      <div class="foot">
        Sent ${moment().format('DD MMM YYYY, HH:mm')} • ZeroCarbon Platform
      </div>
    </div>
  `;
}

function getClientEmail(client) {
  return client?.submissionData?.companyInfo?.primaryContactPerson?.email
    || client?.leadInfo?.email;
}

async function sendEmail({ client, to, subject, html, attachments }) {
  const mailOptions = {
    from: `"ZeroCarbon" <${process.env.EMAIL_USER}>`,
    to: to || getClientEmail(client),
    subject,
    html,
    attachments: attachments || []
  };
  return transporter.sendMail(mailOptions);
}

/** Public, action-specific helpers (4 you asked for) */
async function sendClientDataSubmittedEmail(client, attachments) {
  const html = envelope({
    title: 'Client Data Submitted',
    bodyHtml: `
      <p>Dear ${client?.leadInfo?.contactPersonName || 'Client'},</p>
      <p>We’ve received your company data. Our consultants will review and get back to you shortly.</p>
      ${detailRow(client)}
      <div class="card"><strong>What happens next?</strong>
        <ul>
          <li>We validate completeness and consistency</li>
          <li>We prepare a proposal aligned with your assessment scope</li>
          <li>You’ll receive a follow-up email with timelines</li>
        </ul>
      </div>
      <p>Attached is a PDF snapshot of the submitted details for your records.</p>
    `,
    cta: process.env.FRONTEND_URL ? { href: `${process.env.FRONTEND_URL}`, label: 'Open ZeroCarbon' } : null
  });

  return sendEmail({ client, subject: 'ZeroCarbon – Client Data Submitted', html, attachments });
}

async function sendClientDataUpdatedEmail(client, attachments) {
  const html = envelope({
    title: 'Client Data Updated',
    bodyHtml: `
      <p>Dear ${client?.leadInfo?.contactPersonName || 'Client'},</p>
      <p>Your company data has been updated successfully.</p>
      ${detailRow(client)}
      <div class="card">We’ve attached the latest snapshot of your data (PDF).</div>
    `
  });
  return sendEmail({ client, subject: 'ZeroCarbon – Client Data Updated', html, attachments });
}

async function sendProposalCreatedEmail(client, attachments) {
  const p = client?.proposalData || {};
  const html = envelope({
    title: 'Proposal Created',
    bodyHtml: `
      <p>Dear ${client?.submissionData?.companyInfo?.primaryContactPerson?.name || client?.leadInfo?.contactPersonName || 'Client'},</p>
      <p>Your personalized proposal is ready.</p>
      ${detailRow(client)}
      <div class="card">
        <div class="row">
          <div class="col"><div class="k">Proposal #</div><div class="v">${p.proposalNumber || '—'}</div></div>
          <div class="col"><div class="k">Valid Until</div><div class="v">${p.validUntil ? moment(p.validUntil).format('DD MMM YYYY') : '—'}</div></div>
          <div class="col"><div class="k">Amount</div><div class="v">${p?.pricing?.totalAmount ?? '—'} ${p?.pricing?.currency || 'INR'}</div></div>
        </div>
      </div>
      <p>The PDF proposal is attached to this email.</p>
    `,
    cta: process.env.FRONTEND_URL ? { href: `${process.env.FRONTEND_URL}`, label: 'Review in ZeroCarbon' } : null
  });
  return sendEmail({ client, subject: 'ZeroCarbon – Proposal Created', html, attachments });
}

async function sendProposalUpdatedEmail(client, attachments) {
  const p = client?.proposalData || {};
  const html = envelope({
    title: 'Proposal Updated',
    bodyHtml: `
      <p>Dear ${client?.submissionData?.companyInfo?.primaryContactPerson?.name || client?.leadInfo?.contactPersonName || 'Client'},</p>
      <p>Your proposal has been updated as requested.</p>
      ${detailRow(client)}
      <div class="card">
        <div class="row">
          <div class="col"><div class="k">Proposal #</div><div class="v">${p.proposalNumber || '—'}</div></div>
          <div class="col"><div class="k">Valid Until</div><div class="v">${p.validUntil ? moment(p.validUntil).format('DD MMM YYYY') : '—'}</div></div>
          <div class="col"><div class="k">Amount</div><div class="v">${p?.pricing?.totalAmount ?? '—'} ${p?.pricing?.currency || 'INR'}</div></div>
        </div>
      </div>
      <p>The updated PDF proposal is attached.</p>
    `
  });
  return sendEmail({ client, subject: 'ZeroCarbon – Proposal Updated', html, attachments });
}

module.exports = {
  sendClientDataSubmittedEmail,
  sendClientDataUpdatedEmail,
  sendProposalCreatedEmail,
  sendProposalUpdatedEmail
};
