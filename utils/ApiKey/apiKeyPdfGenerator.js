// utils/ApiKey/apiKeyPdfGenerator.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

/**
 * Generate PDF document for API key
 * @param {Object} apiKeyData - API key data
 * @param {Object} clientData - Client data
 * @param {string} outputPath - Path to save PDF
 * @returns {Promise<string>} - Path to generated PDF
 */
const generateApiKeyPDF = async (apiKeyData, clientData, outputPath) => {
  return new Promise((resolve, reject) => {
    try {
      // Create a document
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: 50,
          bottom: 50,
          left: 50,
          right: 50
        }
      });

      const pageWidth = doc.page.width - 100; // 495 for A4 with 50px margins
      const leftMargin = 50;

      // Pipe to file
      const writeStream = fs.createWriteStream(outputPath);
      doc.pipe(writeStream);

      // Add header with logo/branding
      doc.fontSize(24)
         .fillColor('#2C3E50')
         .text('Zero Carbon Platform', leftMargin, doc.y, { 
           width: pageWidth,
           align: 'center' 
         })
         .moveDown(0.3);

      doc.fontSize(14)
         .fillColor('#7F8C8D')
         .text('API Key Credentials', leftMargin, doc.y, { 
           width: pageWidth,
           align: 'center' 
         })
         .moveDown(1.5);

      // Add warning banner
      const warningY = doc.y;
      const warningHeight = 75;
      
      doc.rect(leftMargin, warningY, pageWidth, warningHeight)
         .fillAndStroke('#FFF3CD', '#FFC107');

      doc.fontSize(12)
         .fillColor('#856404')
         .font('Helvetica-Bold')
         .text('⚠️  IMPORTANT SECURITY NOTICE', leftMargin, warningY + 8, { 
           width: pageWidth,
           align: 'center'
         });

      doc.fontSize(9)
         .fillColor('#856404')
         .font('Helvetica')
         .text('This API key provides access to your emissions data.', leftMargin + 10, warningY + 30, {
           width: pageWidth - 20,
           align: 'center'
         })
         .text('Store it securely and never share it publicly.', {
           width: pageWidth - 20,
           align: 'center'
         })
         .text('This is the only time the full key will be displayed.', {
           width: pageWidth - 20,
           align: 'center'
         });

      doc.moveDown();
      doc.y = warningY + warningHeight + 10;
      doc.moveDown(1);

      // Client Information Section
      addSectionHeader(doc, 'Client Information', leftMargin, pageWidth);
      addKeyValue(doc, 'Client ID', clientData.clientId, leftMargin, pageWidth);
      addKeyValue(doc, 'Client Name', clientData.clientName || 'N/A', leftMargin, pageWidth);
      addKeyValue(doc, 'Company', clientData.companyName || 'N/A', leftMargin, pageWidth);
      doc.moveDown(0.8);

      // API Key Information Section
      addSectionHeader(doc, 'API Key Details', leftMargin, pageWidth);
      addKeyValue(doc, 'Key Type', apiKeyData.keyType, leftMargin, pageWidth);
      addKeyValue(doc, 'Key ID', apiKeyData.keyId || apiKeyData._id, leftMargin, pageWidth);

      // Show full API key only once
      if (apiKeyData.apiKey) {
        doc.fontSize(10)
           .fillColor('#333333')
           .font('Helvetica-Bold')
           .text('Full API Key:', leftMargin, doc.y);

        doc.font('Helvetica');
        doc.moveDown(0.3);

        const apiKeyBoxY = doc.y;
        const apiKeyBoxHeight = 35;

        doc.rect(leftMargin, apiKeyBoxY, pageWidth, apiKeyBoxHeight)
           .fillAndStroke('#F8F9FA', '#DEE2E6');

        doc.fontSize(8)
           .fillColor('#E74C3C')
           .font('Courier')
           .text(apiKeyData.apiKey, leftMargin + 10, apiKeyBoxY + 8, {
             width: pageWidth - 20,
             align: 'left'
           })
           .font('Helvetica');

        doc.y = apiKeyBoxY + apiKeyBoxHeight + 5;
      } else {
        addKeyValue(doc, 'Key Prefix', apiKeyData.keyPrefix, leftMargin, pageWidth);
      }

      addKeyValue(doc, 'Status', apiKeyData.status || 'ACTIVE', leftMargin, pageWidth);
      addKeyValue(doc, 'Created', formatDate(apiKeyData.createdAt || new Date()), leftMargin, pageWidth);
      addKeyValue(doc, 'Expires', formatDate(apiKeyData.expiresAt), leftMargin, pageWidth);
      addKeyValue(doc, 'Days Until Expiry', apiKeyData.daysUntilExpiry || calculateDaysUntilExpiry(apiKeyData.expiresAt), leftMargin, pageWidth);

      if (apiKeyData.isSandbox || apiKeyData.isSandboxKey) {
        addKeyValue(doc, 'Sandbox Key', 'Yes', leftMargin, pageWidth);
        addKeyValue(doc, 'Sandbox Duration', `${apiKeyData.sandboxDuration || 'N/A'} days`, leftMargin, pageWidth);
      }

      doc.moveDown(0.8);

      // Endpoint Specific Information
      addSectionHeader(doc, 'Endpoint Configuration', leftMargin, pageWidth);

      if (apiKeyData.keyType === 'NET_API' || apiKeyData.keyType === 'NET_IOT') {
        addKeyValue(doc, 'Project ID', apiKeyData.metadata?.projectId || apiKeyData.projectId, leftMargin, pageWidth);
        addKeyValue(doc, 'Calculation Methodology', apiKeyData.metadata?.calculationMethodology || apiKeyData.calculationMethodology, leftMargin, pageWidth);

        const baseUrl = process.env.API_BASE_URL || 'https://api.zerohero.ebhoom.com';
        const endpointType = apiKeyData.keyType === 'NET_API' ? 'api' : 'iot';
        const endpoint = `${baseUrl}/api/net-reduction/${clientData.clientId}/${apiKeyData.metadata?.projectId || apiKeyData.projectId}/${apiKeyData.metadata?.calculationMethodology || apiKeyData.calculationMethodology}/${endpointType}`;

        doc.moveDown(0.3);
        doc.fontSize(10)
           .fillColor('#333333')
           .font('Helvetica-Bold')
           .text('Endpoint URL:', leftMargin, doc.y);

        doc.font('Helvetica');
        doc.moveDown(0.2);

        doc.fontSize(8)
           .fillColor('#3498DB')
           .text(endpoint, leftMargin, doc.y, {
             width: pageWidth,
             link: endpoint,
             lineBreak: true
           });

        doc.moveDown(0.8);
      } else if (apiKeyData.keyType === 'DC_API' || apiKeyData.keyType === 'DC_IOT') {
        addKeyValue(doc, 'Node ID', apiKeyData.metadata?.nodeId || apiKeyData.nodeId, leftMargin, pageWidth);
        addKeyValue(doc, 'Scope Identifier', apiKeyData.metadata?.scopeIdentifier || apiKeyData.scopeIdentifier, leftMargin, pageWidth);

        const baseUrl = process.env.API_BASE_URL || 'https://api.zerohero.ebhoom.com';
        const endpointType = apiKeyData.keyType === 'DC_API' ? 'api-data' : 'iot-data';
        const endpoint = `${baseUrl}/api/data-collection/clients/${clientData.clientId}/nodes/${apiKeyData.metadata?.nodeId || apiKeyData.nodeId}/scopes/${apiKeyData.metadata?.scopeIdentifier || apiKeyData.scopeIdentifier}/${endpointType}`;

        doc.moveDown(0.3);
        doc.fontSize(10)
           .fillColor('#333333')
           .font('Helvetica-Bold')
           .text('Endpoint URL:', leftMargin, doc.y);

        doc.font('Helvetica');
        doc.moveDown(0.2);

        doc.fontSize(8)
           .fillColor('#3498DB')
           .text(endpoint, leftMargin, doc.y, {
             width: pageWidth,
             link: endpoint,
             lineBreak: true
           });

        doc.moveDown(0.8);
      }

      // Usage Example Section
      addSectionHeader(doc, 'Usage Example', leftMargin, pageWidth);

      const curlExample = generateCurlExample(apiKeyData, clientData);

      const curlBoxY = doc.y;
      const curlBoxHeight = 90;

      doc.rect(leftMargin, curlBoxY, pageWidth, curlBoxHeight)
         .fillAndStroke('#F8F9FA', '#DEE2E6');

      doc.fontSize(7)
         .fillColor('#2C3E50')
         .font('Courier')
         .text(curlExample, leftMargin + 8, curlBoxY + 8, {
           width: pageWidth - 16,
           height: curlBoxHeight - 16,
           lineBreak: true
         })
         .font('Helvetica');

      doc.y = curlBoxY + curlBoxHeight + 8;
      doc.moveDown(0.5);

      // Additional Information
      if (apiKeyData.description) {
        addSectionHeader(doc, 'Description', leftMargin, pageWidth);
        doc.fontSize(10)
           .fillColor('#333333')
           .text(apiKeyData.description, leftMargin, doc.y, {
             width: pageWidth
           });
        doc.moveDown(0.8);
      }

      // Security Recommendations
      addSectionHeader(doc, 'Security Best Practices', leftMargin, pageWidth);

      const securityTips = [
        '• Store this API key securely in environment variables',
        '• Never commit API keys to version control (Git, etc.)',
        '• Use HTTPS for all API requests',
        '• Rotate keys regularly (before expiration)',
        '• Revoke keys immediately if compromised',
        '• Monitor API key usage regularly',
        '• Restrict API key access to specific IP addresses if possible'
      ];

      doc.fontSize(9)
         .fillColor('#555555');

      securityTips.forEach(tip => {
        doc.text(tip, leftMargin, doc.y, { width: pageWidth });
        doc.moveDown(0.35);
      });

      // Footer
      doc.moveDown(1.5);
      doc.fontSize(7)
         .fillColor('#95A5A6')
         .text('_'.repeat(80), leftMargin, doc.y, {
           align: 'center'
         })
         .moveDown(0.4);

      doc.fontSize(8)
         .fillColor('#7F8C8D')
         .text('Zero Carbon Platform - Emissions Management System', leftMargin, doc.y, {
           width: pageWidth,
           align: 'center'
         })
         .moveDown(0.2)
         .text(`Generated on ${new Date().toLocaleString()}`, {
           width: pageWidth,
           align: 'center'
         })
         .moveDown(0.2)
         .text('For support, contact: support@zerohero.ebhoom.com', {
           width: pageWidth,
           align: 'center'
         });

      // Finalize PDF
      doc.end();

      writeStream.on('finish', () => {
        resolve(outputPath);
      });

      writeStream.on('error', (error) => {
        reject(error);
      });

    } catch (error) {
      reject(error);
    }
  });
};

/**
 * Helper function to add section headers
 */
const addSectionHeader = (doc, title, leftMargin, pageWidth) => {
  doc.fontSize(13)
     .fillColor('#2C3E50')
     .font('Helvetica-Bold')
     .text(title, leftMargin, doc.y, { width: pageWidth });

  doc.font('Helvetica');
  doc.moveDown(0.4);

  doc.moveTo(leftMargin, doc.y)
     .lineTo(leftMargin + pageWidth, doc.y)
     .strokeColor('#BDC3C7')
     .lineWidth(1)
     .stroke();

  doc.moveDown(0.5);
};

/**
 * Helper function to add key-value pairs
 */
const addKeyValue = (doc, key, value, leftMargin, pageWidth) => {
  const keyWidth = 150;
  const valueWidth = pageWidth - keyWidth;

  doc.fontSize(10)
     .fillColor('#555555')
     .font('Helvetica-Bold')
     .text(key + ':', leftMargin, doc.y, { 
       width: keyWidth,
       align: 'left'
     });

  doc.font('Helvetica')
     .fillColor('#2C3E50')
     .fontSize(10)
     .text(value, leftMargin + keyWidth, doc.y - doc.currentLineHeight(), {
       width: valueWidth,
       align: 'left'
     });

  doc.moveDown(0.4);
};

/**
 * Helper function to format dates
 */
const formatDate = (date) => {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/**
 * Helper function to calculate days until expiry
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
 * Generate cURL example for the API key
 */
const generateCurlExample = (apiKeyData, clientData) => {
  const baseUrl = process.env.API_BASE_URL || 'https://api.zerohero.ebhoom.com';
  let endpoint = '';
  let body = '';

  if (apiKeyData.keyType === 'NET_API') {
    endpoint = `${baseUrl}/api/net-reduction/${clientData.clientId}/${apiKeyData.metadata?.projectId || apiKeyData.projectId}/${apiKeyData.metadata?.calculationMethodology || apiKeyData.calculationMethodology}/api`;
    body = '{\n  "value": 150.5,\n  "date": "2025-12-11",\n  "time": "10:30:00"\n}';
  } else if (apiKeyData.keyType === 'NET_IOT') {
    endpoint = `${baseUrl}/api/net-reduction/${clientData.clientId}/${apiKeyData.metadata?.projectId || apiKeyData.projectId}/${apiKeyData.metadata?.calculationMethodology || apiKeyData.calculationMethodology}/iot`;
    body = '{\n  "value": 150.5,\n  "deviceId": "IOT-001"\n}';
  } else if (apiKeyData.keyType === 'DC_API') {
    endpoint = `${baseUrl}/api/data-collection/clients/${clientData.clientId}/nodes/${apiKeyData.metadata?.nodeId || apiKeyData.nodeId}/scopes/${apiKeyData.metadata?.scopeIdentifier || apiKeyData.scopeIdentifier}/api-data`;
    body = '{\n  "activityData": 150.5\n}';
  } else if (apiKeyData.keyType === 'DC_IOT') {
    endpoint = `${baseUrl}/api/data-collection/clients/${clientData.clientId}/nodes/${apiKeyData.metadata?.nodeId || apiKeyData.nodeId}/scopes/${apiKeyData.metadata?.scopeIdentifier || apiKeyData.scopeIdentifier}/iot-data`;
    body = '{\n  "activityData": 150.5,\n  "deviceId": "SENSOR-001"\n}';
  }

  const keyToShow = apiKeyData.apiKey || `${apiKeyData.keyPrefix}***`;

  return `curl -X POST ${endpoint} \\
  -H "X-API-Key: ${keyToShow}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;
};

module.exports = {
  generateApiKeyPDF
};
