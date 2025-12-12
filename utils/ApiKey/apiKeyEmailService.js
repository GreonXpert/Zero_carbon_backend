// utils/ApiKey/apiKeyEmailService.js
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

/**
 * Create email transporter
 * Configure with your email service (Gmail, SendGrid, AWS SES, etc.)
 */
const createTransporter = () => {
  // ✅ Uses your existing credentials
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,  // ✅ greonxpert@gmail.com
      pass: process.env.EMAIL_PASS   // ✅ rvabjsgqnylyjumd
    }
  });
};

/**
 * Send API key PDF via email
 * @param {Object} options - Email options
 * @param {Array} options.recipients - Array of recipient email addresses
 * @param {string} options.pdfPath - Path to PDF file
 * @param {Object} options.apiKeyData - API key data
 * @param {Object} options.clientData - Client data
 * @param {Object} options.creatorData - User who created the key
 * @returns {Promise<Object>} - Email send result
 */
const sendApiKeyEmail = async (options) => {
  const {
    recipients,
    pdfPath,
    apiKeyData,
    clientData,
    creatorData
  } = options;

  try {
    const transporter = createTransporter();

    // Verify transporter configuration
    await transporter.verify();
    console.log('[Email Service] Transporter is ready');

    // Prepare email content
    const emailHtml = generateEmailHtml(apiKeyData, clientData, creatorData);
    const emailText = generateEmailText(apiKeyData, clientData, creatorData);

    // Prepare attachments
    const attachments = [
      {
        filename: `API_Key_${apiKeyData.keyType}_${clientData.clientId}.pdf`,
        path: pdfPath,
        contentType: 'application/pdf'
      }
    ];

    // Send email to each recipient
    const sendPromises = recipients.map(async (recipient) => {
      const mailOptions = {
        from: {
          name: process.env.EMAIL_FROM_NAME || 'Zero Carbon Platform',
          address: process.env.EMAIL_FROM_ADDRESS || 'noreply@zerohero.ebhoom.com'
        },
        to: recipient.email,
        subject: `🔑 New API Key Created - ${apiKeyData.keyType} for ${clientData.clientId}`,
        text: emailText,
        html: emailHtml,
        attachments: attachments
      };

      try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email Service] Email sent to ${recipient.email}:`, info.messageId);
        return {
          success: true,
          recipient: recipient.email,
          messageId: info.messageId
        };
      } catch (error) {
        console.error(`[Email Service] Failed to send email to ${recipient.email}:`, error);
        return {
          success: false,
          recipient: recipient.email,
          error: error.message
        };
      }
    });

    const results = await Promise.all(sendPromises);

    return {
      success: results.every(r => r.success),
      results: results,
      totalSent: results.filter(r => r.success).length,
      totalFailed: results.filter(r => !r.success).length
    };

  } catch (error) {
    console.error('[Email Service] Error sending API key email:', error);
    throw error;
  }
};

/**
 * Generate HTML email content
 */
const generateEmailHtml = (apiKeyData, clientData, creatorData) => {
  const baseUrl = process.env.FRONTEND_URL || 'https://app.zerohero.ebhoom.com';
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@zerohero.ebhoom.com';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 10px 10px 0 0;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
    }
    .content {
      background: #ffffff;
      padding: 30px;
      border: 1px solid #e0e0e0;
      border-top: none;
    }
    .warning-box {
      background: #FFF3CD;
      border: 2px solid #FFC107;
      border-radius: 8px;
      padding: 15px;
      margin: 20px 0;
    }
    .warning-box h3 {
      margin-top: 0;
      color: #856404;
    }
    .info-table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    .info-table td {
      padding: 10px;
      border-bottom: 1px solid #e0e0e0;
    }
    .info-table td:first-child {
      font-weight: 600;
      color: #555;
      width: 40%;
    }
    .key-display {
      background: #f8f9fa;
      border: 2px dashed #dee2e6;
      border-radius: 8px;
      padding: 15px;
      margin: 20px 0;
      font-family: 'Courier New', monospace;
      font-size: 14px;
      word-break: break-all;
      color: #E74C3C;
    }
    .button {
      display: inline-block;
      background: #667eea;
      color: white;
      padding: 12px 30px;
      text-decoration: none;
      border-radius: 5px;
      margin: 20px 0;
    }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 0 0 10px 10px;
      text-align: center;
      font-size: 12px;
      color: #6c757d;
      border: 1px solid #e0e0e0;
      border-top: none;
    }
    .security-tips {
      background: #e7f3ff;
      border-left: 4px solid #2196F3;
      padding: 15px;
      margin: 20px 0;
    }
    .security-tips ul {
      margin: 10px 0;
      padding-left: 20px;
    }
    .security-tips li {
      margin: 5px 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🔑 New API Key Created</h1>
    <p>Zero Carbon Platform - Emissions Management System</p>
  </div>

  <div class="content">
    <p>Hello,</p>
    
    <p>A new API key has been created for <strong>${clientData.clientName || clientData.clientId}</strong> by <strong>${creatorData.userName}</strong>.</p>

    <div class="warning-box">
      <h3>⚠️ IMPORTANT SECURITY NOTICE</h3>
      <p><strong>This is the only time the full API key will be available.</strong></p>
      <p>The API key is attached as a PDF document. Please store it securely and never share it publicly or commit it to version control.</p>
    </div>

    ${apiKeyData.apiKey ? `
    <h3>Full API Key (One-time display):</h3>
    <div class="key-display">
      ${apiKeyData.apiKey}
    </div>
    ` : ''}

    <h3>API Key Details:</h3>
    <table class="info-table">
      <tr>
        <td>Key Type</td>
        <td><strong>${apiKeyData.keyType}</strong></td>
      </tr>
      <tr>
        <td>Key Prefix</td>
        <td>${apiKeyData.keyPrefix}***</td>
      </tr>
      <tr>
        <td>Client ID</td>
        <td>${clientData.clientId}</td>
      </tr>
      <tr>
        <td>Status</td>
        <td><span style="color: green;">●</span> ACTIVE</td>
      </tr>
      <tr>
        <td>Created</td>
        <td>${new Date(apiKeyData.createdAt || Date.now()).toLocaleString()}</td>
      </tr>
      <tr>
        <td>Expires</td>
        <td>${new Date(apiKeyData.expiresAt).toLocaleString()}</td>
      </tr>
      <tr>
        <td>Days Until Expiry</td>
        <td>${apiKeyData.daysUntilExpiry || calculateDaysUntilExpiry(apiKeyData.expiresAt)} days</td>
      </tr>
      ${apiKeyData.isSandbox || apiKeyData.isSandboxKey ? `
      <tr>
        <td>Sandbox Key</td>
        <td>Yes (${apiKeyData.sandboxDuration || 'N/A'} days)</td>
      </tr>
      ` : ''}
    </table>

    ${(apiKeyData.keyType === 'NET_API' || apiKeyData.keyType === 'NET_IOT') ? `
    <h3>Configuration:</h3>
    <table class="info-table">
      <tr>
        <td>Project ID</td>
        <td>${apiKeyData.metadata?.projectId || apiKeyData.projectId}</td>
      </tr>
      <tr>
        <td>Methodology</td>
        <td>${apiKeyData.metadata?.calculationMethodology || apiKeyData.calculationMethodology}</td>
      </tr>
    </table>
    ` : ''}

    ${(apiKeyData.keyType === 'DC_API' || apiKeyData.keyType === 'DC_IOT') ? `
    <h3>Configuration:</h3>
    <table class="info-table">
      <tr>
        <td>Node ID</td>
        <td>${apiKeyData.metadata?.nodeId || apiKeyData.nodeId}</td>
      </tr>
      <tr>
        <td>Scope Identifier</td>
        <td>${apiKeyData.metadata?.scopeIdentifier || apiKeyData.scopeIdentifier}</td>
      </tr>
    </table>
    ` : ''}

    <div class="security-tips">
      <h3>🔒 Security Best Practices:</h3>
      <ul>
        <li>Store the API key securely in environment variables</li>
        <li>Never commit API keys to version control (Git, etc.)</li>
        <li>Use HTTPS for all API requests</li>
        <li>Rotate keys regularly before expiration</li>
        <li>Revoke keys immediately if compromised</li>
        <li>Monitor API key usage regularly in the dashboard</li>
      </ul>
    </div>

    <p><strong>📎 Attached:</strong> Complete API key documentation in PDF format</p>

    <center>
      <a href="${baseUrl}/api-keys" class="button">View All API Keys →</a>
    </center>

    <p style="margin-top: 30px;">If you have any questions or need assistance, please contact our support team.</p>
  </div>

  <div class="footer">
    <p><strong>Zero Carbon Platform</strong></p>
    <p>Emissions Management System</p>
    <p>Email: <a href="mailto:${supportEmail}">${supportEmail}</a></p>
    <p style="margin-top: 15px; font-size: 11px;">
      This email was sent to you because an API key was created for your client account.
      <br>
      Generated on ${new Date().toLocaleString()}
    </p>
  </div>
</body>
</html>
  `;
};

/**
 * Generate plain text email content (fallback)
 */
const generateEmailText = (apiKeyData, clientData, creatorData) => {
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@zerohero.ebhoom.com';

  return `
🔑 NEW API KEY CREATED
Zero Carbon Platform - Emissions Management System

Hello,

A new API key has been created for ${clientData.clientName || clientData.clientId} by ${creatorData.userName}.

⚠️ IMPORTANT SECURITY NOTICE
This is the only time the full API key will be available. The API key is attached as a PDF document. Please store it securely and never share it publicly.

${apiKeyData.apiKey ? `FULL API KEY (One-time display):
${apiKeyData.apiKey}

` : ''}
API KEY DETAILS:
- Key Type: ${apiKeyData.keyType}
- Key Prefix: ${apiKeyData.keyPrefix}***
- Client ID: ${clientData.clientId}
- Status: ACTIVE
- Created: ${new Date(apiKeyData.createdAt || Date.now()).toLocaleString()}
- Expires: ${new Date(apiKeyData.expiresAt).toLocaleString()}
- Days Until Expiry: ${apiKeyData.daysUntilExpiry || calculateDaysUntilExpiry(apiKeyData.expiresAt)} days
${apiKeyData.isSandbox || apiKeyData.isSandboxKey ? `- Sandbox Key: Yes (${apiKeyData.sandboxDuration || 'N/A'} days)\n` : ''}

${(apiKeyData.keyType === 'NET_API' || apiKeyData.keyType === 'NET_IOT') ? `
CONFIGURATION:
- Project ID: ${apiKeyData.metadata?.projectId || apiKeyData.projectId}
- Methodology: ${apiKeyData.metadata?.calculationMethodology || apiKeyData.calculationMethodology}
` : ''}

${(apiKeyData.keyType === 'DC_API' || apiKeyData.keyType === 'DC_IOT') ? `
CONFIGURATION:
- Node ID: ${apiKeyData.metadata?.nodeId || apiKeyData.nodeId}
- Scope Identifier: ${apiKeyData.metadata?.scopeIdentifier || apiKeyData.scopeIdentifier}
` : ''}

🔒 SECURITY BEST PRACTICES:
• Store the API key securely in environment variables
• Never commit API keys to version control
• Use HTTPS for all API requests
• Rotate keys regularly before expiration
• Revoke keys immediately if compromised
• Monitor API key usage regularly

📎 ATTACHED: Complete API key documentation in PDF format

If you have any questions, please contact: ${supportEmail}

---
Zero Carbon Platform
Generated on ${new Date().toLocaleString()}
  `;
};

/**
 * Calculate days until expiry
 */
const calculateDaysUntilExpiry = (expiryDate) => {
  if (!expiryDate) return 'N/A';
  const now = new Date();
  const expiry = new Date(expiryDate);
  const diffMs = expiry - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  return diffDays > 0 ? diffDays : 'Expired';
};

/**
 * Get recipients for API key email
 * @param {Object} client - Client document
 * @param {Object} User - User model
 * @returns {Promise<Array>} - Array of recipient objects {email, name, role}
 */
const getApiKeyRecipients = async (client, User) => {
  const recipients = [];

  try {
    // Get client admins
    if (client.adminEmails && client.adminEmails.length > 0) {
      client.adminEmails.forEach(email => {
        recipients.push({
          email: email,
          name: 'Client Admin',
          role: 'client_admin'
        });
      });
    }

    // Get consultant admin
    if (client.leadInfo?.consultantAdminId) {
      const consultantAdmin = await User.findById(client.leadInfo.consultantAdminId)
        .select('email userName')
        .lean();
      
      if (consultantAdmin && consultantAdmin.email) {
        recipients.push({
          email: consultantAdmin.email,
          name: consultantAdmin.userName,
          role: 'consultant_admin'
        });
      }
    }

    // Get assigned consultant
    if (client.leadInfo?.assignedConsultantId) {
      const consultant = await User.findById(client.leadInfo.assignedConsultantId)
        .select('email userName')
        .lean();
      
      if (consultant && consultant.email) {
        recipients.push({
          email: consultant.email,
          name: consultant.userName,
          role: 'consultant'
        });
      }
    }

    // Get workflow assigned consultant
    if (client.workflowTracking?.assignedConsultantId) {
      const workflowConsultant = await User.findById(client.workflowTracking.assignedConsultantId)
        .select('email userName')
        .lean();
      
      if (workflowConsultant && workflowConsultant.email) {
        // Check if not already added
        const exists = recipients.some(r => r.email === workflowConsultant.email);
        if (!exists) {
          recipients.push({
            email: workflowConsultant.email,
            name: workflowConsultant.userName,
            role: 'consultant'
          });
        }
      }
    }

    // Remove duplicates based on email
    const uniqueRecipients = recipients.filter((recipient, index, self) =>
      index === self.findIndex((r) => r.email === recipient.email)
    );

    return uniqueRecipients;

  } catch (error) {
    console.error('[Email Service] Error getting recipients:', error);
    return recipients;
  }
};

module.exports = {
  sendApiKeyEmail,
  getApiKeyRecipients
};