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
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f8fafc; }
    .email-container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 16px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); overflow: hidden; }
    .header { 
      background: linear-gradient(135deg, #1AC99F 0%, #3bf6d7ff 50%, #1E6565 100%); 
      padding: 40px 30px; 
      text-align: center; 
      position: relative;
      overflow: hidden;
    }
    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><pattern id="grain" width="100" height="100" patternUnits="userSpaceOnUse"><circle cx="25" cy="25" r="1" fill="white" opacity="0.1"/><circle cx="75" cy="75" r="1" fill="white" opacity="0.1"/><circle cx="50" cy="10" r="0.5" fill="white" opacity="0.1"/></pattern></defs><rect width="100" height="100" fill="url(%23grain)"/></svg>') repeat;
      opacity: 0.1;
    }
    .brand-logo { 
      font-size: 28px; 
      font-weight: 800; 
      color: #ffffff; 
      margin-bottom: 12px; 
      letter-spacing: -0.5px;
      position: relative;
      z-index: 2;
    }
    .email-title { 
      font-size: 24px; 
      font-weight: 700; 
      color: #ffffff; 
      margin: 8px 0;
      position: relative;
      z-index: 2;
    }
    .email-subtitle {
      color: rgba(255, 255, 255, 0.9);
      font-size: 16px;
      font-weight: 400;
      position: relative;
      z-index: 2;
    }
    .content { 
      padding: 40px 30px 30px; 
      color: #1f2937; 
      line-height: 1.7;
    }
    .greeting { 
      font-size: 18px; 
      margin-bottom: 20px; 
      color: #1f2937;
    }
    .message { 
      font-size: 16px; 
      margin-bottom: 25px; 
      color: #4b5563;
    }
    .detail-section {
      background: linear-gradient(135deg, #f1f5f9 0%, #f8fafc 100%);
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 24px;
      margin: 25px 0;
      position: relative;
    }
    .detail-section::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: linear-gradient(90deg, #1AC99F, #1E6565);
      border-radius: 12px 12px 0 0;
    }
    .detail-row { 
      display: flex; 
      gap: 20px; 
      margin: 16px 0;
      flex-wrap: wrap;
    }
    .detail-col { 
      flex: 1; 
      min-width: 150px;
    }
    .detail-label { 
      color: #6b7280; 
      font-size: 13px; 
      font-weight: 600; 
      text-transform: uppercase; 
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .detail-value { 
      font-weight: 700; 
      font-size: 15px; 
      color: #1f2937;
      word-break: break-word;
    }
    .info-card {
      background: linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%);
      border-left: 4px solid #29ae3fff;
      border-radius: 8px;
      padding: 20px;
      margin: 25px 0;
      box-shadow: 0 2px 8px rgba(59, 130, 246, 0.1);
    }
    .info-card-title {
      font-weight: 700;
      font-size: 16px;
      color: #1E6565;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .info-list {
      list-style: none;
      padding: 0;
    }
    .info-list li {
      padding: 6px 0;
      color: #4b5563;
      font-size: 14px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .info-list li::before {
      content: '✓';
      color: #10b981;
      font-weight: bold;
      font-size: 12px;
      margin-top: 2px;
    }
    .proposal-highlight {
      background: linear-gradient(135deg, #fef3c7 0%, #fef9c3 100%);
      border: 2px solid #f59e0b;
      border-radius: 12px;
      padding: 20px;
      margin: 25px 0;
      text-align: center;
    }
    .proposal-number {
      font-size: 24px;
      font-weight: 800;
      color: #92400e;
      margin-bottom: 8px;
    }
    .proposal-amount {
      font-size: 32px;
      font-weight: 900;
      color: #1f2937;
      margin: 12px 0;
    }
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #1AC99F 0%, #1E6565 100%);
      color: #ffffff;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 16px;
      text-align: center;
      margin: 20px 0;
      box-shadow: 0 4px 12px rgba(59, 246, 87, 0.3);
      transition: all 0.3s ease;
    }
    .cta-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(81, 246, 59, 0.4);
    }
    .footer {
      background: #f8fafc;
      border-top: 1px solid #e5e7eb;
      padding: 30px;
      text-align: center;
      color: #6b7280;
    }
    .footer-brand {
      font-weight: 700;
      color: #1E6565;
      font-size: 18px;
      margin-bottom: 8px;
    }
    .footer-text {
      font-size: 13px;
      line-height: 1.6;
    }
    .timestamp {
      color: #9ca3af;
      font-size: 12px;
      margin-top: 10px;
    }
    @media (max-width: 640px) {
      .email-container { margin: 10px; border-radius: 12px; }
      .header { padding: 30px 20px; }
      .content { padding: 30px 20px; }
      .detail-row { flex-direction: column; gap: 12px; }
      .detail-col { min-width: auto; }
    }
  </style>
`;

function detailRow(client) {
  return `
    <div class="detail-section">
      <div class="detail-row">
        <div class="detail-col">
          <div class="detail-label">📋 Client ID</div>
          <div class="detail-value">${client.clientId}</div>
        </div>
        <div class="detail-col">
          <div class="detail-label">🏢 Company</div>
          <div class="detail-value">${client?.leadInfo?.companyName || '—'}</div>
        </div>
        <div class="detail-col">
          <div class="detail-label">📊 Stage / Status</div>
          <div class="detail-value">${client.stage} / ${client.status}</div>
        </div>
      </div>
    </div>
  `;
}

function envelope({ title, subtitle, bodyHtml, cta }) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - ZeroCarbon</title>
      ${baseEmailStyles}
    </head>
    <body>
      <div class="email-container">
        <div class="header">
          <div class="brand-logo">🌱 ZeroCarbon</div>
          <div class="email-title">${title}</div>
          ${subtitle ? `<div class="email-subtitle">${subtitle}</div>` : ''}
        </div>
        <div class="content">
          ${bodyHtml}
          ${cta ? `<div style="text-align: center; margin-top: 30px;"><a class="cta-button" href="${cta.href}" target="_blank">${cta.label}</a></div>` : ''}
        </div>
        <div class="footer">
          <div class="footer-brand">ZeroCarbon Platform</div>
          <div class="footer-text">
            Empowering businesses with sustainable solutions
            <div class="timestamp">Sent on ${moment().format('DD MMM YYYY, HH:mm [IST]')}</div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

function getClientEmail(client) {
  return client?.submissionData?.companyInfo?.primaryContactPerson?.email
    || client?.leadInfo?.email;
}

async function sendEmail({ client, to, subject, html, attachments }) {
  const mailOptions = {
    from: `"ZeroCarbon Platform" <${process.env.EMAIL_USER}>`,
    to: to || getClientEmail(client),
    subject,
    html,
    attachments: attachments || []
  };
  return transporter.sendMail(mailOptions);
}

/** Public, action-specific helpers */
async function sendClientDataSubmittedEmail(client, attachments) {
  const html = envelope({
    title: 'Data Successfully Submitted',
    subtitle: 'Your company data has been received',
    bodyHtml: `
      <div class="greeting">Dear <strong>${client?.leadInfo?.contactPersonName || 'Valued Client'}</strong>,</div>
      
      <div class="message">
        Thank you for submitting your company data! We've successfully received your information and our expert consultants are excited to help you on your sustainability journey.
      </div>
      
      ${detailRow(client)}
      
      <div class="info-card">
        <div class="info-card-title">⏰ What's Next?</div>
        <ul class="info-list">
          <li><strong>Data Validation:</strong> We'll review completeness and consistency</li>
          <li><strong>Proposal Preparation:</strong> Our team will prepare a customized proposal</li>
          <li><strong>Follow-up:</strong> You'll receive detailed timelines within 24-48 hours</li>
          <li><strong>Consultation:</strong> Schedule a call to discuss your sustainability goals</li>
        </ul>
      </div>
      
      <div class="message">
        📎 <strong>Attached:</strong> PDF snapshot of your submitted details for your records.
      </div>
      
      <div class="message" style="font-style: italic; color: #6b7280;">
        We appreciate your trust in ZeroCarbon and look forward to helping you achieve your environmental goals!
      </div>
    `,
    cta: process.env.FRONTEND_URL ? { href: `${process.env.FRONTEND_URL}`, label: '🌐 Open ZeroCarbon Dashboard' } : null
  });

  return sendEmail({ client, subject: '✅ ZeroCarbon – Data Successfully Submitted', html, attachments });
}

async function sendClientDataUpdatedEmail(client, attachments) {
  const html = envelope({
    title: 'Data Successfully Updated',
    subtitle: 'Your company information has been refreshed',
    bodyHtml: `
      <div class="greeting">Dear <strong>${client?.leadInfo?.contactPersonName || 'Valued Client'}</strong>,</div>
      
      <div class="message">
        Great news! Your company data has been successfully updated in our system. All changes have been saved and are now reflected in your profile.
      </div>
      
      ${detailRow(client)}
      
      <div class="info-card">
        <div class="info-card-title">📄 Updated Information</div>
        <ul class="info-list">
          <li>Latest company data snapshot attached as PDF</li>
          <li>All changes have been validated and saved</li>
          <li>Your sustainability assessment will reflect these updates</li>
        </ul>
      </div>
      
      <div class="message">
        If you need to make additional changes or have any questions, please don't hesitate to reach out to our team.
      </div>
    `
  });
  
  return sendEmail({ client, subject: '🔄 ZeroCarbon – Data Successfully Updated', html, attachments });
}

async function sendProposalCreatedEmail(client, attachments) {
  const p = client?.proposalData || {};
  const html = envelope({
    title: 'Your Proposal is Ready!',
    subtitle: 'Customized sustainability solution prepared',
    bodyHtml: `
      <div class="greeting">Dear <strong>${client?.submissionData?.companyInfo?.primaryContactPerson?.name || client?.leadInfo?.contactPersonName || 'Valued Client'}</strong>,</div>
      
      <div class="message">
        🎉 Excellent news! Your personalized sustainability proposal has been prepared by our expert team and is ready for your review.
      </div>
      
      ${detailRow(client)}
      
      <div class="proposal-highlight">
        <div class="proposal-number">Proposal #${p.proposalNumber || 'N/A'}</div>
        <div class="proposal-amount">${p?.pricing?.totalAmount ? `${p.pricing.totalAmount} ${p?.pricing?.currency || 'INR'}` : 'Contact for Pricing'}</div>
        <div style="color: #6b7280; font-size: 14px;">
          Valid until: ${p.validUntil ? moment(p.validUntil).format('DD MMM YYYY') : 'Contact us for details'}
        </div>
      </div>
      
      <div class="info-card">
        <div class="info-card-title">📋 Proposal Includes</div>
        <ul class="info-list">
          <li>Comprehensive sustainability assessment methodology</li>
          <li>Customized carbon footprint analysis approach</li>
          <li>Implementation timeline and milestones</li>
          <li>Expert consultation and ongoing support</li>
          <li>Detailed pricing breakdown and payment options</li>
        </ul>
      </div>
      
      <div class="message">
        📎 <strong>Attached:</strong> Complete proposal document in PDF format.
      </div>
      
      <div class="message" style="font-style: italic; color: #6b7280;">
        Ready to start your sustainability journey? Let's discuss how we can help you achieve your environmental goals!
      </div>
    `,
    cta: process.env.FRONTEND_URL ? { href: `${process.env.FRONTEND_URL}`, label: '🚀 Review Proposal in Dashboard' } : null
  });
  
  return sendEmail({ client, subject: '🎯 ZeroCarbon – Your Sustainability Proposal is Ready!', html, attachments });
}

async function sendProposalUpdatedEmail(client, attachments) {
  const p = client?.proposalData || {};
  const html = envelope({
    title: 'Proposal Successfully Updated',
    subtitle: 'Your customized proposal has been revised',
    bodyHtml: `
      <div class="greeting">Dear <strong>${client?.submissionData?.companyInfo?.primaryContactPerson?.name || client?.leadInfo?.contactPersonName || 'Valued Client'}</strong>,</div>
      
      <div class="message">
        Perfect! Your sustainability proposal has been updated based on your feedback and requirements. All requested changes have been incorporated.
      </div>
      
      ${detailRow(client)}
      
      <div class="proposal-highlight">
        <div class="proposal-number">Updated Proposal #${p.proposalNumber || 'N/A'}</div>
        <div class="proposal-amount">${p?.pricing?.totalAmount ? `${p.pricing.totalAmount} ${p?.pricing?.currency || 'INR'}` : 'Contact for Pricing'}</div>
        <div style="color: #6b7280; font-size: 14px;">
          Valid until: ${p.validUntil ? moment(p.validUntil).format('DD MMM YYYY') : 'Contact us for details'}
        </div>
      </div>
      
      <div class="info-card">
        <div class="info-card-title">🔄 What's Changed</div>
        <ul class="info-list">
          <li>Updated pricing based on revised scope</li>
          <li>Modified timeline to match your requirements</li>
          <li>Enhanced service offerings per your feedback</li>
          <li>Refreshed terms and conditions</li>
        </ul>
      </div>
      
      <div class="message">
        📎 <strong>Attached:</strong> Updated proposal document with all revisions highlighted.
      </div>
      
      <div class="message" style="font-style: italic; color: #6b7280;">
        Questions about the updates? Our team is here to help you every step of the way!
      </div>
    `
  });
  
  return sendEmail({ client, subject: '🔄 ZeroCarbon – Your Proposal Has Been Updated', html, attachments });
}

module.exports = {
  sendClientDataSubmittedEmail,
  sendClientDataUpdatedEmail,
  sendProposalCreatedEmail,
  sendProposalUpdatedEmail
};
