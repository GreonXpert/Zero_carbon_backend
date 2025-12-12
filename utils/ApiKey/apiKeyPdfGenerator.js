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

      // Pipe to file
      const writeStream = fs.createWriteStream(outputPath);
      doc.pipe(writeStream);

      // Add header with logo/branding
      doc.fontSize(24)
         .fillColor('#2C3E50')
         .text('Zero Carbon Platform', { align: 'center' })
         .moveDown(0.5);

      doc.fontSize(14)
         .fillColor('#7F8C8D')
         .text('API Key Credentials', { align: 'center' })
         .moveDown(2);

      // Add warning banner
      doc.rect(50, doc.y, 495, 80)
         .fillAndStroke('#FFF3CD', '#FFC107');

      doc.fontSize(12)
         .fillColor('#856404')
         .text('⚠️ IMPORTANT SECURITY NOTICE', 70, doc.y - 70, { 
           width: 455,
           align: 'center'
         })
         .moveDown(0.5);

      doc.fontSize(10)
         .text('This API key provides access to your emissions data. Store it securely and never share it publicly.', 70, doc.y, {
           width: 455,
           align: 'center'
         })
         .text('This is the only time the full key will be displayed.', {
           width: 455,
           align: 'center'
         });

      doc.moveDown(3);

      // Client Information Section
      addSectionHeader(doc, 'Client Information');
      addKeyValue(doc, 'Client ID', clientData.clientId);
      addKeyValue(doc, 'Client Name', clientData.clientName || 'N/A');
      addKeyValue(doc, 'Company', clientData.companyName || 'N/A');
      doc.moveDown(1);

      // API Key Information Section
      addSectionHeader(doc, 'API Key Details');
      addKeyValue(doc, 'Key Type', apiKeyData.keyType);
      addKeyValue(doc, 'Key ID', apiKeyData.keyId || apiKeyData._id);
      
      // Show full API key only once
      if (apiKeyData.apiKey) {
        doc.fontSize(10)
           .fillColor('#333333')
           .text('Full API Key:', 50, doc.y);
        
        doc.rect(50, doc.y + 5, 495, 30)
           .fillAndStroke('#F8F9FA', '#DEE2E6');
        
        doc.fontSize(9)
           .fillColor('#E74C3C')
           .font('Courier')
           .text(apiKeyData.apiKey, 60, doc.y - 18, {
             width: 475
           })
           .font('Helvetica');
        
        doc.moveDown(2);
      } else {
        addKeyValue(doc, 'Key Prefix', apiKeyData.keyPrefix);
      }

      addKeyValue(doc, 'Status', apiKeyData.status || 'ACTIVE');
      addKeyValue(doc, 'Created', formatDate(apiKeyData.createdAt || new Date()));
      addKeyValue(doc, 'Expires', formatDate(apiKeyData.expiresAt));
      addKeyValue(doc, 'Days Until Expiry', apiKeyData.daysUntilExpiry || calculateDaysUntilExpiry(apiKeyData.expiresAt));
      
      if (apiKeyData.isSandbox || apiKeyData.isSandboxKey) {
        addKeyValue(doc, 'Sandbox Key', 'Yes');
        addKeyValue(doc, 'Sandbox Duration', `${apiKeyData.sandboxDuration || 'N/A'} days`);
      }

      doc.moveDown(1);

      // Endpoint Specific Information
      addSectionHeader(doc, 'Endpoint Configuration');
      
      if (apiKeyData.keyType === 'NET_API' || apiKeyData.keyType === 'NET_IOT') {
        addKeyValue(doc, 'Project ID', apiKeyData.metadata?.projectId || apiKeyData.projectId);
        addKeyValue(doc, 'Calculation Methodology', apiKeyData.metadata?.calculationMethodology || apiKeyData.calculationMethodology);
        
        const baseUrl = process.env.API_BASE_URL || 'https://api.zerohero.ebhoom.com';
        const endpointType = apiKeyData.keyType === 'NET_API' ? 'api' : 'iot';
        const endpoint = `${baseUrl}/api/net-reduction/${clientData.clientId}/${apiKeyData.metadata?.projectId || apiKeyData.projectId}/${apiKeyData.metadata?.calculationMethodology || apiKeyData.calculationMethodology}/${endpointType}`;
        
        doc.moveDown(0.5);
        doc.fontSize(10)
           .fillColor('#333333')
           .text('Endpoint URL:', 50, doc.y);
        
        doc.fontSize(8)
           .fillColor('#3498DB')
           .text(endpoint, 50, doc.y + 5, {
             width: 495,
             link: endpoint
           });
        
        doc.moveDown(1);
      } else if (apiKeyData.keyType === 'DC_API' || apiKeyData.keyType === 'DC_IOT') {
        addKeyValue(doc, 'Node ID', apiKeyData.metadata?.nodeId || apiKeyData.nodeId);
        addKeyValue(doc, 'Scope Identifier', apiKeyData.metadata?.scopeIdentifier || apiKeyData.scopeIdentifier);
        
        const baseUrl = process.env.API_BASE_URL || 'https://api.zerohero.ebhoom.com';
        const endpointType = apiKeyData.keyType === 'DC_API' ? 'api-data' : 'iot-data';
        const endpoint = `${baseUrl}/api/data-collection/clients/${clientData.clientId}/nodes/${apiKeyData.metadata?.nodeId || apiKeyData.nodeId}/scopes/${apiKeyData.metadata?.scopeIdentifier || apiKeyData.scopeIdentifier}/${endpointType}`;
        
        doc.moveDown(0.5);
        doc.fontSize(10)
           .fillColor('#333333')
           .text('Endpoint URL:', 50, doc.y);
        
        doc.fontSize(8)
           .fillColor('#3498DB')
           .text(endpoint, 50, doc.y + 5, {
             width: 495,
             link: endpoint
           });
        
        doc.moveDown(1);
      }

      // Usage Example Section
      doc.moveDown(1);
      addSectionHeader(doc, 'Usage Example');
      
      const curlExample = generateCurlExample(apiKeyData, clientData);
      
      doc.rect(50, doc.y, 495, 100)
         .fillAndStroke('#F8F9FA', '#DEE2E6');
      
      doc.fontSize(8)
         .fillColor('#2C3E50')
         .font('Courier')
         .text(curlExample, 60, doc.y - 90, {
           width: 475,
           height: 80
         })
         .font('Helvetica');
      
      doc.moveDown(6);

      // Additional Information
      if (apiKeyData.description) {
        addSectionHeader(doc, 'Description');
        doc.fontSize(10)
           .fillColor('#333333')
           .text(apiKeyData.description, 50, doc.y, {
             width: 495
           });
        doc.moveDown(1);
      }

      // Security Recommendations
      doc.moveDown(1);
      addSectionHeader(doc, 'Security Best Practices');
      
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
        doc.text(tip, 50, doc.y, { width: 495 });
        doc.moveDown(0.3);
      });

      // Footer
      doc.moveDown(2);
      doc.fontSize(8)
         .fillColor('#95A5A6')
         .text('____________________________________________________________', 50, doc.y, {
           align: 'center'
         })
         .moveDown(0.5);
      
      doc.fontSize(8)
         .text('Zero Carbon Platform - Emissions Management System', {
           align: 'center'
         })
         .text(`Generated on ${new Date().toLocaleString()}`, {
           align: 'center'
         })
         .moveDown(0.5)
         .text('For support, contact: support@zerohero.ebhoom.com', {
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
const addSectionHeader = (doc, title) => {
  doc.fontSize(14)
     .fillColor('#2C3E50')
     .text(title, 50, doc.y)
     .moveDown(0.5);
  
  doc.moveTo(50, doc.y)
     .lineTo(545, doc.y)
     .strokeColor('#BDC3C7')
     .stroke();
  
  doc.moveDown(0.5);
};

/**
 * Helper function to add key-value pairs
 */
const addKeyValue = (doc, key, value) => {
  doc.fontSize(10)
     .fillColor('#555555')
     .text(key + ':', 50, doc.y, { continued: true })
     .fillColor('#2C3E50')
     .text('  ' + value, { width: 400 });
  
  doc.moveDown(0.3);
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