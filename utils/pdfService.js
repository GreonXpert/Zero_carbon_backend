// utils/pdfService.js
const htmlToPdf = require('html-pdf-node');

async function htmlToPdfBuffer(html, filename = 'document.pdf') {
  const file = { content: html };
  const options = {
    format: 'A4',
    margin: { top: 10, right: 12, bottom: 12, left: 12 }
  };

  const buffer = await htmlToPdf.generatePdf(file, options);
  return {
    filename,
    content: buffer,
    contentType: 'application/pdf'
  };
}

module.exports = { htmlToPdfBuffer };
