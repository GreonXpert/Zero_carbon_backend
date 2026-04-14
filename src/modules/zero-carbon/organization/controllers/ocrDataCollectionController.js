// controllers/Organization/ocrDataCollectionController.js
// OCR document upload and data extraction controller
//
// Four exported functions:
//
//  1. saveOCRData        — LEGACY one-shot flow (POST /ocr-data)
//                          Kept for backwards compat. Extracts and saves immediately.
//
//  2. extractOCRPreview  — STEP 1 of two-step flow (POST /ocr-extract)
//                          Accepts one or more images / a PDF, extracts ALL fields,
//                          runs model matching, returns preview to frontend.
//                          Does NOT write any DataEntry to the database.
//
//  3. confirmOCRSave     — STEP 2 of two-step flow (POST /ocr-confirm)
//                          Receives user-confirmed (and possibly corrected) data,
//                          saves a DataEntry per record, triggers emission calculation,
//                          and stores field-mapping feedback for future improvements.
//
//  4. verifyOCRData      — VERIFY flow (POST /verify-ocr)
//                          Accepts a single image, runs OCR, extracts ALL values,
//                          groups them by type (consumption / monetary / meter readings /
//                          demand / other) and highlights the scope-specific primary field.
//                          Scope 2 Electricity → shows kWh consumed (NOT ₹ payable).
//                          Scope 3 spend-based → shows ₹ spend.
//                          Scope 1 combustion  → shows fuel quantity.
//                          Does NOT save anything — pure read-only verification step.
//                          Frontend shows all groups, user corrects if needed, then
//                          calls /ocr-confirm with the verified values.

'use strict';

const DataCollectionConfig = require('../models/DataCollectionConfig');
const Client               = require('../../../client-management/client/Client');
const DataEntry            = require('../models/DataEntry');

const {
  findNodeAndScope,
  canWriteManualOrCSV,
  saveOneEntry,
  reflectSwitchInputTypeInClient
} = require('./dataCollectionController');

const {
  validateEmissionPrerequisites
} = require('../../calculation/emissionIntegration');

const { buildOcrS3Key, uploadOcrToS3 } = require('../../ocr/utils/uploads/ocr/upload');
const { preprocessImage }              = require('../../ocr/utils/preprocessImage');
const { extractTextFromImage }         = require('../../ocr/utils/extractTextFromImage');
const { extractTextFromPDF }           = require('../../ocr/utils/extractTextFromPDF');
const { extractTextWithTextract, shouldUseTextractFallback } = require('../../ocr/utils/textractOCR');

// Legacy extractor (canonical field names — used by saveOCRData)
const { extractFields, mapScopeToCategory } = require('../../ocr/utils/fieldExtractor');

// New universal extractor + model matcher (used by extractOCRPreview)
const { extractAllFields }                   = require('../../ocr/utils/universalFieldExtractor');
const { matchFields, buildSuggestedDataValues, getCanonicalFieldOptions } = require('../../ocr/utils/modelMatcher');
const { createSession, getSession, deleteSession, getSessionExpiry } = require('../../ocr/utils/ocrSessionStore');
const { saveFeedback, getFeedbackForScope }  = require('./ocrFeedbackController');

const PDF_MIME   = 'application/pdf';
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/tiff'];

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract text from a single file buffer (image or PDF single-page).
 *
 * Engine selection strategy:
 *   1. Always try Tesseract first (free, offline, fast for clean/scanned images).
 *   2. If Tesseract confidence < threshold (default 50), fall back to AWS Textract.
 *      Textract uses the same AWS credentials already configured for S3 and handles
 *      real-world phone photos (perspective, blur, glare) far better than Tesseract.
 *      It extracts FORMS (key-value pairs) and TABLES (kWh reading rows) natively.
 *   3. If Textract also fails, return the Tesseract result as the last resort.
 *
 * Returns { text, confidence, pageCount: 1, pages: [...], ocrEngine }
 */
async function extractSingleFileText(buffer, mimetype) {
  if (mimetype === PDF_MIME) {
    return extractTextFromPDF(buffer);
  }

  if (IMAGE_MIME.includes(mimetype)) {
    // ── Step 1: Tesseract (preprocessed image) ──────────────────────────────
    const processedBuffer  = await preprocessImage({ buffer });
    const tesseractResult  = await extractTextFromImage(processedBuffer);

    // ── Step 2: AWS Textract fallback when Tesseract confidence is low ───────
    if (shouldUseTextractFallback(tesseractResult.confidence)) {
      console.log(`[OCR] Tesseract confidence ${tesseractResult.confidence}% — switching to AWS Textract fallback`);
      try {
        // Send the ORIGINAL (unprocessed, colour) buffer to Textract.
        // Textract handles raw phone photos natively — preprocessing degrades its accuracy.
        const textractResult = await extractTextWithTextract(buffer);
        console.log(`[OCR] AWS Textract confidence: ${textractResult.confidence}%`);
        return {
          text:       textractResult.text,
          confidence: textractResult.confidence,
          pageCount:  1,
          ocrEngine:  'textract',
          pages: [{ pageNumber: 1, text: textractResult.text, confidence: textractResult.confidence }]
        };
      } catch (textractErr) {
        // Textract failed — fall through and return the Tesseract result anyway
        console.warn(`[OCR] Textract fallback failed: ${textractErr.message} — using Tesseract result`);
      }
    }

    return {
      text:       tesseractResult.text,
      confidence: tesseractResult.confidence,
      pageCount:  1,
      ocrEngine:  'tesseract',
      pages: [{ pageNumber: 1, text: tesseractResult.text, confidence: tesseractResult.confidence }]
    };
  }

  throw new Error(`Unsupported file type: ${mimetype}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1: saveOCRData (LEGACY — one-shot)
// POST /data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-data
// ─────────────────────────────────────────────────────────────────────────────

const saveOCRData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Document file is required. Upload a JPEG, PNG, TIFF, or PDF via the "ocrFile" field.'
      });
    }

    const { buffer, mimetype, originalname } = req.file;

    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({ success: false, message: 'Node/scope not found in flowchart or process flowchart' });
    }
    const { node, scope } = located;

    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({ success: false, message: 'Permission denied', reason: perm.reason });
    }

    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation?.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Emission prerequisites are not satisfied for this scope',
        issues: validation?.issues || []
      });
    }

    const s3Key = buildOcrS3Key(clientId, nodeId, scopeIdentifier, originalname);
    let s3UploadOk = false;
    let s3Warning = null;
    try {
      await uploadOcrToS3(buffer, s3Key, mimetype);
      s3UploadOk = true;
    } catch (s3Err) {
      console.warn('[saveOCRData] S3 upload failed (non-blocking):', s3Err.message);
      s3Warning = `Document not stored in S3: ${s3Err.message}`;
    }

    let ocrResult;
    try {
      ocrResult = await extractSingleFileText(buffer, mimetype);
    } catch (ocrErr) {
      console.error('[saveOCRData] OCR extraction error:', ocrErr.message);
      return res.status(422).json({
        success: false,
        message: `OCR processing failed: ${ocrErr.message}`,
        s3Key,
        hint: 'The document was saved to S3. You can retry using the /ocr-extract endpoint.'
      });
    }

    const { text } = ocrResult;
    if (!text || !text.trim()) {
      return res.status(422).json({
        success: false,
        message: 'OCR could not extract any text from the document',
        s3Key,
        ocrConfidence: ocrResult.confidence
      });
    }

    const category = mapScopeToCategory(scope);
    const extracted = extractFields(text, category);

    if (Object.keys(extracted.dataValues).length === 0) {
      return res.status(422).json({
        success: false,
        message: 'No recognisable emission data found in the document',
        s3Key,
        ocrConfidence: ocrResult.confidence,
        rawTextPreview: text.slice(0, 500),
        warnings: extracted.warnings,
        hint: 'Consider using the /ocr-extract endpoint for a full review with manual correction.'
      });
    }

    let entry, calcResult;
    try {
      ({ entry, calcResult } = await saveOneEntry({
        req,
        clientId,
        nodeId,
        scopeIdentifier,
        scope,
        node,
        inputSource: 'OCR',
        overrideInputType: 'OCR',
        row: {
          dataValues: extracted.dataValues,
          date: extracted.date,
          time: extracted.time
        },
        ocrMeta: {
          fileName: originalname,
          s3Key,
          ocrConfidence: ocrResult.confidence,
          rawText: text.slice(0, 2000)
        }
      }));
    } catch (saveErr) {
      console.error('[saveOCRData] saveOneEntry failed:', saveErr.message);
      return res.status(500).json({ success: false, message: 'Failed to save OCR data entry', error: saveErr.message, s3Key });
    }

    try {
      let config = await DataCollectionConfig.findOne({ clientId, nodeId, scopeIdentifier });
      if (!config) {
        config = new DataCollectionConfig({ clientId, nodeId, scopeIdentifier, scopeType: scope.scopeType, inputType: 'OCR', collectionFrequency: 'monthly' });
      }
      config.updateCollectionStatus(entry._id, entry.timestamp || new Date());
      await config.save();
    } catch (cfgErr) {
      console.warn('[saveOCRData] DataCollectionConfig update failed:', cfgErr.message);
    }

    try {
      const userId = req.user._id || req.user.id;
      await reflectSwitchInputTypeInClient({
        clientId,
        previousType: scope.inputType || 'OCR',
        newType: 'OCR',
        nodeId,
        scopeIdentifier,
        connectionDetails: { documentName: originalname, s3Key, ocrConfidence: ocrResult.confidence },
        userId
      });
    } catch (clientErr) {
      console.warn('[saveOCRData] Client OCR tracking update failed:', clientErr.message);
    }

    if (global.io) global.io.emit('ocrDataSaved', { clientId, nodeId, scopeIdentifier, dataEntryId: entry._id });
    if (global.broadcastDataCompletionUpdate) global.broadcastDataCompletionUpdate(clientId);

    const warnings = extracted.warnings || [];
    if (ocrResult.confidence < 70) warnings.push(`OCR confidence is ${ocrResult.confidence}% — please review the extracted values.`);
    if (s3Warning) warnings.push(s3Warning);

    return res.status(201).json({
      success: true,
      message: 'OCR data saved successfully',
      dataEntryId: entry._id,
      inputType: 'OCR',
      ocrConfidence: ocrResult.confidence,
      extractedFields: extracted.dataValues,
      extractedDate: extracted.date,
      extractedTime: extracted.time,
      s3DocumentKey: s3UploadOk ? s3Key : null,
      s3Stored: s3UploadOk,
      pageCount: ocrResult.pageCount || 1,
      warnings,
      emissionCalculationStatus: entry.emissionCalculationStatus,
      calculationResponse: calcResult?.data || null
    });

  } catch (error) {
    console.error('[saveOCRData] Unexpected error:', error);
    return res.status(500).json({ success: false, message: 'Server error during OCR processing', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2: extractOCRPreview (STEP 1)
// POST /data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-extract
// Accepts: multipart/form-data, field name: ocrFiles (array, up to 20)
// Does NOT write DataEntry. Returns preview with model-matched suggestions.
// ─────────────────────────────────────────────────────────────────────────────

const extractOCRPreview = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    // ── Validate files ────────────────────────────────────────────────────────
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one document file is required. Upload images (JPEG/PNG/TIFF) or a PDF via the "ocrFiles" field.'
      });
    }

    // ── Find node/scope ───────────────────────────────────────────────────────
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({ success: false, message: 'Node/scope not found in flowchart or process flowchart' });
    }
    const { node, scope } = located;

    // ── Permission check ──────────────────────────────────────────────────────
    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({ success: false, message: 'Permission denied', reason: perm.reason });
    }

    // ── Emission prerequisites ────────────────────────────────────────────────
    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation?.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Emission prerequisites are not satisfied for this scope',
        issues: validation?.issues || []
      });
    }

    // ── Load feedback history for this client/scope ───────────────────────────
    const feedbackHistory = await getFeedbackForScope(clientId, scopeIdentifier);

    // ── Canonical field options for frontend dropdowns ────────────────────────
    const fieldOptions = getCanonicalFieldOptions(scope.scopeType, scope.categoryName);

    // ── Process each file ─────────────────────────────────────────────────────
    const records = [];
    let recordIndex = 0;

    for (const file of files) {
      const { buffer, mimetype, originalname } = file;

      // Validate file type
      if (mimetype !== PDF_MIME && !IMAGE_MIME.includes(mimetype)) {
        records.push({
          recordIndex: recordIndex++,
          sourceFile: originalname,
          error: `Unsupported file type: ${mimetype}. Accepted: JPEG, PNG, TIFF, PDF.`,
          extractedPairs: [],
          suggestedDataValues: {}
        });
        continue;
      }

      // S3 upload (non-blocking — preview proceeds even if S3 fails)
      const s3Key = buildOcrS3Key(clientId, nodeId, scopeIdentifier, originalname);
      let s3UploadOk = false;
      let s3Warning = null;
      try {
        await uploadOcrToS3(buffer, s3Key, mimetype);
        s3UploadOk = true;
      } catch (s3Err) {
        console.warn(`[extractOCRPreview] S3 upload failed for ${originalname}:`, s3Err.message);
        s3Warning = `Document not stored in S3: ${s3Err.message}`;
      }

      // OCR extraction
      let ocrResult;
      try {
        ocrResult = await extractSingleFileText(buffer, mimetype);
      } catch (ocrErr) {
        console.error(`[extractOCRPreview] OCR failed for ${originalname}:`, ocrErr.message);
        records.push({
          recordIndex: recordIndex++,
          sourceFile: originalname,
          s3Key: s3UploadOk ? s3Key : null,
          s3Stored: s3UploadOk,
          error: `OCR processing failed: ${ocrErr.message}`,
          extractedPairs: [],
          suggestedDataValues: {},
          warnings: s3Warning ? [s3Warning] : []
        });
        continue;
      }

      // For PDFs: create one record per page; for images: one record
      const pagesToProcess = ocrResult.pages || [{ pageNumber: null, text: ocrResult.text, confidence: ocrResult.confidence }];

      for (const pageData of pagesToProcess) {
        const { pageNumber, text: pageText, confidence: pageConf } = pageData;

        const warnings = [];
        if (s3Warning) warnings.push(s3Warning);

        if (!pageText || !pageText.trim()) {
          records.push({
            recordIndex: recordIndex++,
            sourceFile: originalname,
            sourcePage: pageNumber,
            s3Key: s3UploadOk ? s3Key : null,
            s3Stored: s3UploadOk,
            ocrConfidence: pageConf || 0,
            extractedPairs: [],
            date: null,
            time: '00:00:00',
            suggestedDataValues: {},
            warnings: [...warnings, 'No text could be extracted from this page. Try a higher resolution image.'],
            userAction: 'pending'
          });
          recordIndex++;
          continue;
        }

        // Universal field extraction
        const { extractedPairs, date, time, rawText } = extractAllFields(pageText);

        // Model matching
        const matchedPairs = matchFields(
          extractedPairs,
          scope.scopeType,
          scope.categoryName,
          clientId,
          scopeIdentifier,
          feedbackHistory
        );

        // Build suggested data values from high-confidence matches
        const suggestedDataValues = buildSuggestedDataValues(matchedPairs, 60);

        if (pageConf < 70) {
          warnings.push(`OCR confidence is ${pageConf}% — extracted values may be inaccurate. Please review carefully.`);
        }
        if (!date) {
          warnings.push('Could not extract a date from this document. Please enter the date manually.');
        }
        if (Object.keys(suggestedDataValues).length === 0) {
          warnings.push('No emission-relevant fields were matched with sufficient confidence. Please map fields manually.');
        }

        records.push({
          recordIndex: recordIndex++,
          sourceFile: originalname,
          sourcePage: pageNumber,
          s3Key: s3UploadOk ? s3Key : null,
          s3Stored: s3UploadOk,
          ocrConfidence: pageConf || 0,
          date: date || null,
          time: time || '00:00:00',
          extractedPairs: matchedPairs,
          suggestedDataValues,
          fieldOptions,       // available canonical fields for manual mapping dropdown
          warnings,
          userAction: 'pending'
        });
      }
    }

    // ── Create session ────────────────────────────────────────────────────────
    const extractionId = createSession({
      clientId,
      nodeId,
      scopeIdentifier,
      scopeType: scope.scopeType,
      categoryName: scope.categoryName,
      records
    });

    return res.status(200).json({
      success: true,
      extractionId,
      sessionExpiresAt: getSessionExpiry(extractionId),
      message: 'Extraction complete. Review the extracted fields, make any corrections, then POST to /ocr-confirm to save.',
      records,
      totalRecords: records.length,
      fieldOptions
    });

  } catch (error) {
    console.error('[extractOCRPreview] Unexpected error:', error);
    return res.status(500).json({ success: false, message: 'Server error during OCR extraction', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3: confirmOCRSave (STEP 2)
// POST /data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/ocr-confirm
// Body: { extractionId?, records: [{ recordIndex, date, time, s3Key, ocrConfidence,
//          sourceFile, confirmedDataValues, corrections }] }
// ─────────────────────────────────────────────────────────────────────────────

const confirmOCRSave = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { extractionId, records: confirmedRecords } = req.body;

    // ── Validate input ────────────────────────────────────────────────────────
    if (!Array.isArray(confirmedRecords) || confirmedRecords.length === 0) {
      return res.status(400).json({ success: false, message: 'records array is required and must not be empty' });
    }

    // ── Find node/scope ───────────────────────────────────────────────────────
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({ success: false, message: 'Node/scope not found' });
    }
    const { node, scope } = located;

    // ── Permission check ──────────────────────────────────────────────────────
    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({ success: false, message: 'Permission denied', reason: perm.reason });
    }

    // ── Emission prerequisites ────────────────────────────────────────────────
    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation?.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Emission prerequisites are not satisfied for this scope',
        issues: validation?.issues || []
      });
    }

    // ── Process each confirmed record ─────────────────────────────────────────
    const results = [];
    const errors  = [];
    const allCorrections = [];

    for (const record of confirmedRecords) {
      const { recordIndex, date, time, s3Key, ocrConfidence, sourceFile, confirmedDataValues, corrections } = record;

      // Validate confirmedDataValues
      if (!confirmedDataValues || typeof confirmedDataValues !== 'object') {
        errors.push({ recordIndex, error: 'confirmedDataValues is required' });
        continue;
      }

      const numericEntries = Object.entries(confirmedDataValues).filter(([, v]) => typeof v === 'number' && v > 0);
      if (numericEntries.length === 0) {
        errors.push({ recordIndex, error: 'confirmedDataValues must contain at least one positive numeric value' });
        continue;
      }

      // Duplicate submission check: same s3Key already saved?
      if (s3Key) {
        try {
          const existing = await DataEntry.findOne({
            clientId,
            nodeId,
            scopeIdentifier,
            'sourceDetails.ocrDocumentKey': s3Key
          }).lean();
          if (existing) {
            errors.push({
              recordIndex,
              error: 'This document has already been submitted',
              existingDataEntryId: existing._id
            });
            continue;
          }
        } catch (dupErr) {
          console.warn('[confirmOCRSave] Duplicate check failed (non-blocking):', dupErr.message);
        }
      }

      // Save entry
      try {
        const { entry, calcResult } = await saveOneEntry({
          req,
          clientId,
          nodeId,
          scopeIdentifier,
          scope,
          node,
          inputSource: 'OCR',
          overrideInputType: 'OCR',
          row: {
            dataValues: confirmedDataValues,
            date: date || null,
            time: time || '00:00:00'
          },
          ocrMeta: {
            fileName: sourceFile || '',
            s3Key: s3Key || null,
            ocrConfidence: ocrConfidence || null,
            rawText: ''   // raw text not re-sent on confirm
          }
        });

        results.push({
          recordIndex,
          dataEntryId: entry._id,
          emissionCalculationStatus: entry.emissionCalculationStatus,
          calculationResponse: calcResult?.data || null
        });

        // Collect corrections for feedback storage
        if (Array.isArray(corrections) && corrections.length > 0) {
          allCorrections.push(...corrections);
        }

      } catch (saveErr) {
        console.error(`[confirmOCRSave] saveOneEntry failed for record ${recordIndex}:`, saveErr.message);
        errors.push({ recordIndex, error: saveErr.message });
      }
    }

    // ── Update DataCollectionConfig (non-blocking) ────────────────────────────
    if (results.length > 0) {
      setImmediate(async () => {
        try {
          let config = await DataCollectionConfig.findOne({ clientId, nodeId, scopeIdentifier });
          if (!config) {
            config = new DataCollectionConfig({ clientId, nodeId, scopeIdentifier, scopeType: scope.scopeType, inputType: 'OCR', collectionFrequency: 'monthly' });
          }
          config.updateCollectionStatus(results[0].dataEntryId, new Date());
          await config.save();
        } catch (cfgErr) {
          console.warn('[confirmOCRSave] DataCollectionConfig update failed:', cfgErr.message);
        }

        // Save feedback corrections
        if (allCorrections.length > 0) {
          await saveFeedback(clientId, nodeId, scopeIdentifier, scope.scopeType, scope.categoryName, allCorrections);
        }
      });
    }

    // ── Update client OCR tracking (non-blocking) ─────────────────────────────
    if (results.length > 0) {
      setImmediate(async () => {
        try {
          const userId = req.user._id || req.user.id;
          await reflectSwitchInputTypeInClient({
            clientId,
            previousType: scope.inputType || 'OCR',
            newType: 'OCR',
            nodeId,
            scopeIdentifier,
            connectionDetails: { ocrConfidence: confirmedRecords[0]?.ocrConfidence },
            userId
          });
        } catch (clientErr) {
          console.warn('[confirmOCRSave] Client tracking update failed:', clientErr.message);
        }
      });
    }

    // ── Delete session if present (cleanup) ───────────────────────────────────
    if (extractionId) {
      deleteSession(extractionId);
    }

    // ── Socket events ─────────────────────────────────────────────────────────
    if (results.length > 0) {
      if (global.io) global.io.emit('ocrDataSaved', { clientId, nodeId, scopeIdentifier, savedCount: results.length });
      if (global.broadcastDataCompletionUpdate) global.broadcastDataCompletionUpdate(clientId);
    }

    // ── Response ──────────────────────────────────────────────────────────────
    const statusCode = errors.length > 0 && results.length === 0 ? 400
                     : errors.length > 0 ? 207   // multi-status: some saved, some failed
                     : 201;

    return res.status(statusCode).json({
      success: results.length > 0,
      message: results.length > 0
        ? `${results.length} record(s) saved successfully${errors.length > 0 ? `, ${errors.length} failed` : ''}.`
        : 'No records were saved.',
      savedCount: results.length,
      results,
      errors
    });

  } catch (error) {
    console.error('[confirmOCRSave] Unexpected error:', error);
    return res.status(500).json({ success: false, message: 'Server error during OCR confirm-save', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SCOPE PRIMARY FIELD CONFIG
// Tells verifyOCRData which field is the ONE value the emission engine needs
// for each scope/category, and why other values (e.g. ₹ payable) must be ignored.
// ─────────────────────────────────────────────────────────────────────────────
const SCOPE_PRIMARY_FIELD_CONFIG = {
  'Scope 2': {
    'Purchased Electricity': {
      field: 'consumed_electricity',
      label: 'Electricity Consumed (kWh)',
      unit: 'kwh',
      description: 'Total kWh units consumed in the billing period.',
      importantNote: 'Use the CONSUMPTION / CONS value in kWh — NOT the bill amount (₹ Payable). Bills always show both; only the kWh figure is used for emissions.',
      lookFor: ['cons', 'consumption', 'units consumed', 'kwh', 'kwh/a/i cons', 'kwh/nl/i', 'kwh/op/i'],
      avoidLabels: ['payable', 'bill amount', 'amount', 'charges', 'energy charges', 'total amount']
    },
    'Purchased Steam':   { field: 'consumed_steam',    label: 'Steam Consumed (MJ)',    unit: 'mj',  description: 'Total steam energy consumed.', importantNote: '', lookFor: ['steam consumed', 'steam'], avoidLabels: [] },
    'Purchased Heating': { field: 'consumed_heating',  label: 'Heating Consumed (MJ)',  unit: 'mj',  description: 'Total heat energy consumed.',  importantNote: '', lookFor: ['heat consumed', 'heating'], avoidLabels: [] },
    'Purchased Cooling': { field: 'consumed_cooling',  label: 'Cooling Consumed (MJ)',  unit: 'mj',  description: 'Total cooling energy consumed.', importantNote: '', lookFor: ['cooling consumed', 'chilled water'], avoidLabels: [] }
  },
  'Scope 1': {
    'Stationary Combustion': { field: 'fuelConsumption', label: 'Fuel Consumed (L / kg / m³)', unit: 'l', description: 'Total fuel quantity consumed.', importantNote: '', lookFor: ['fuel consumed', 'fuel consumption', 'quantity', 'litres', 'liters'], avoidLabels: ['amount', 'cost', 'price'] },
    'Mobile Combustion':     { field: 'fuelConsumption', label: 'Fuel Consumed (L)',            unit: 'l', description: 'Total fuel used by vehicles.', importantNote: '', lookFor: ['fuel consumed', 'fuel filled', 'litres'], avoidLabels: ['amount', 'cost'] },
    'Fugitive Emissions':    { field: 'activityData',    label: 'Refrigerant Quantity (kg)',    unit: 'kg', description: 'Total refrigerant charged/consumed.', importantNote: '', lookFor: ['refrigerant', 'gas charged', 'kg charged'], avoidLabels: [] },
    'Process Emission':      { field: 'productionOutput', label: 'Production Output (tonnes)',  unit: 'tonnes', description: 'Total production output.', importantNote: '', lookFor: ['production output', 'output', 'production'], avoidLabels: [] }
  },
  'Scope 3': {
    'Purchased Goods and Services': { field: 'procurementSpend',    label: 'Procurement Spend (₹)',        unit: 'inr', description: 'Total amount spent on goods/services (Tier 1 spend-based).', importantNote: '', lookFor: ['total', 'amount', 'spend', 'invoice amount', 'payable'], avoidLabels: [] },
    'Capital Goods':                { field: 'procurementSpend',    label: 'Capital Goods Spend (₹)',      unit: 'inr', description: 'Total capital expenditure (Tier 1 spend-based).', importantNote: '', lookFor: ['total', 'amount', 'spend', 'payable'], avoidLabels: [] },
    'Business Travel':              { field: 'travelSpend',         label: 'Travel Spend (₹) or Distance (km)', unit: 'inr', description: 'Travel spend (Tier 1) or distance (Tier 2).', importantNote: '', lookFor: ['fare', 'amount', 'distance', 'km'], avoidLabels: [] },
    'Upstream Transport and Distribution': { field: 'transportationSpend', label: 'Transport Spend (₹) or Distance × Mass', unit: 'inr', description: 'Transport spend (Tier 1) or distance × allocation (Tier 2).', importantNote: '', lookFor: ['freight', 'transport cost', 'shipping', 'distance'], avoidLabels: [] },
    'Waste Generated in Operations': { field: 'wasteMass', label: 'Waste Mass (kg)',    unit: 'kg',  description: 'Total mass of waste generated.', importantNote: '', lookFor: ['waste', 'weight', 'mass', 'kg'], avoidLabels: [] },
    'Employee Commuting':            { field: 'employee_commuting', label: 'Commute Distance (km)', unit: 'km', description: 'Total commute distance.', importantNote: '', lookFor: ['distance', 'km', 'commute'], avoidLabels: [] },
    'Fuel and energy':               { field: 'fuelConsumed',       label: 'Fuel Consumed (L) / Electricity (kWh)', unit: 'l', description: 'Upstream fuel or electricity for Well-to-Tank / T&D losses.', importantNote: '', lookFor: ['fuel consumed', 'electricity', 'kwh', 'litres'], avoidLabels: [] }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// VALUE CATEGORISATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const MONETARY_LABEL_TOKENS   = ['amount', 'payable', 'charge', 'charges', 'bill', 'rent', 'surcharge', 'duty', 'tax', 'gst', 'fee', 'deposit', 'refund', 'adjustment', 'acd', 'adj', 'interest', 'penalty', 'arrear', 'advance', 'balance', 'due', 'fixed charges', 'meter rent', 'fuel sur', 'round off', 'total bill'];
const MONETARY_UNIT_TOKENS    = ['inr', '₹', 'rs', 'usd', '$', 'eur', '€', 'gbp', '£'];
const CONSUMPTION_LABEL_TOKENS = ['cons', 'consumption', 'consumed', 'kwh', 'net energy', 'net consumption', 'recorded consumption', 'total units'];
const METER_READ_LABEL_TOKENS  = ['curr', 'prev', 'current reading', 'previous reading'];
const DEMAND_LABEL_TOKENS      = ['demand', 'load', 'kva', 'sanctioned load', 'contracted demand', 'billing demand'];

function categorizePairs(extractedPairs) {
  const consumptionValues = [];
  const monetaryValues    = [];
  const meterReadings     = [];
  const demandValues      = [];
  const otherValues       = [];

  for (const pair of extractedPairs) {
    if (pair.numericValue == null) continue;   // skip non-numeric

    const labelLow = (pair.rawLabel || '').toLowerCase();
    const unitLow  = (pair.rawUnit  || '').toLowerCase();

    const isMonetary    = MONETARY_UNIT_TOKENS.some(u => unitLow.includes(u))  || MONETARY_LABEL_TOKENS.some(t => labelLow.includes(t));
    const isConsumption = !isMonetary && CONSUMPTION_LABEL_TOKENS.some(t => labelLow.includes(t));
    const isMeterRead   = !isMonetary && !isConsumption && METER_READ_LABEL_TOKENS.some(t => labelLow.includes(t));
    const isDemand      = !isMonetary && !isConsumption && !isMeterRead && DEMAND_LABEL_TOKENS.some(t => labelLow.includes(t));

    const item = { label: pair.rawLabel, value: pair.numericValue, unit: pair.rawUnit || null };

    if (isMonetary)       monetaryValues.push(item);
    else if (isConsumption) consumptionValues.push(item);
    else if (isMeterRead)   meterReadings.push(item);
    else if (isDemand)      demandValues.push(item);
    else                    otherValues.push(item);
  }

  return { consumptionValues, monetaryValues, meterReadings, demandValues, otherValues };
}

/**
 * Given model-matched pairs and the scope primary field config, pick the best
 * candidate value for the primary field and build a confidence-rated result.
 */
function detectPrimaryValue(matchedPairs, primaryConfig, categorized) {
  if (!primaryConfig) return null;

  // 1. Try high-confidence model-matched pairs for the primary field
  const highConf = matchedPairs
    .filter(p => p.bestMatch?.canonicalField === primaryConfig.field && (p.bestMatch?.confidence || 0) >= 55 && p.numericValue != null)
    .sort((a, b) => (b.bestMatch?.confidence || 0) - (a.bestMatch?.confidence || 0));

  if (highConf.length > 0) {
    const best = highConf[0];
    return {
      field:      primaryConfig.field,
      value:      best.numericValue,
      unit:       best.rawUnit || primaryConfig.unit,
      rawLabel:   best.rawLabel,
      confidence: best.bestMatch.confidence,
      detectionMethod: 'model-match'
    };
  }

  // 2. Search all pairs for labels matching 'lookFor' tokens
  const lookForTokens = primaryConfig.lookFor || [];
  const avoidTokens   = primaryConfig.avoidLabels || [];

  for (const pair of matchedPairs) {
    if (pair.numericValue == null) continue;
    const labelLow = (pair.rawLabel || '').toLowerCase();
    const isAvoided = avoidTokens.some(t => labelLow.includes(t));
    if (isAvoided) continue;
    const isMatch = lookForTokens.some(t => labelLow.includes(t));
    if (isMatch) {
      return {
        field:      primaryConfig.field,
        value:      pair.numericValue,
        unit:       pair.rawUnit || primaryConfig.unit,
        rawLabel:   pair.rawLabel,
        confidence: 55,
        detectionMethod: 'label-search'
      };
    }
  }

  // 3. Fall back to consumption values from categorization (for Scope 2)
  if (primaryConfig.unit === 'kwh' && categorized.consumptionValues.length > 0) {
    const best = categorized.consumptionValues[0];
    return {
      field:      primaryConfig.field,
      value:      best.value,
      unit:       best.unit || 'kWh',
      rawLabel:   best.label,
      confidence: 40,
      detectionMethod: 'category-fallback'
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 4: verifyOCRData
// POST /data-collection/clients/:clientId/nodes/:nodeId/scopes/:scopeIdentifier/verify-ocr
// Accepts: multipart/form-data, field name: ocrFile (single image)
// Does NOT save anything. Returns structured breakdown of ALL extracted values
// with the scope-specific primary field highlighted.
// ─────────────────────────────────────────────────────────────────────────────

const verifyOCRData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'A document file is required. Upload a JPEG, PNG, or TIFF image via the "ocrFile" field.'
      });
    }

    const { buffer, mimetype, originalname } = req.file;

    // ── Validate file type ────────────────────────────────────────────────────
    if (!IMAGE_MIME.includes(mimetype)) {
      return res.status(400).json({
        success: false,
        message: `Unsupported file type: ${mimetype}. Accepted: image/jpeg, image/png, image/tiff.`
      });
    }

    // ── Find node/scope ───────────────────────────────────────────────────────
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({ success: false, message: 'Node/scope not found in flowchart or process flowchart' });
    }
    const { scope } = located;
    const { scopeType, categoryName } = scope;

    // ── OCR extraction (Tesseract → Textract fallback) ────────────────────────
    let ocrResult;
    try {
      ocrResult = await extractSingleFileText(buffer, mimetype);
    } catch (ocrErr) {
      return res.status(422).json({ success: false, message: `OCR processing failed: ${ocrErr.message}` });
    }

    const { text, confidence: ocrConfidence, ocrEngine } = ocrResult;

    if (!text || !text.trim()) {
      return res.status(422).json({
        success: false,
        message: 'OCR could not extract any text from this image.',
        ocrConfidence,
        ocrEngine,
        hint: 'Try a clearer photo with better lighting, or ensure the text is in focus.'
      });
    }

    // ── Extract ALL key-value pairs ───────────────────────────────────────────
    const { extractedPairs, date, time, rawText } = extractAllFields(text);

    // ── Model matching for this scope ─────────────────────────────────────────
    const feedbackHistory = await getFeedbackForScope(clientId, scopeIdentifier);
    const matchedPairs = matchFields(extractedPairs, scopeType, categoryName, clientId, scopeIdentifier, feedbackHistory);

    // ── Categorise values into readable groups ────────────────────────────────
    const categorized = categorizePairs(extractedPairs);

    // ── Scope primary field config ────────────────────────────────────────────
    const primaryConfig = SCOPE_PRIMARY_FIELD_CONFIG[scopeType]?.[categoryName] || null;

    // ── Detect the best value for the primary field ───────────────────────────
    const detectedPrimary = detectPrimaryValue(matchedPairs, primaryConfig, categorized);

    // ── Build suggested data values (what to pass to /ocr-confirm) ───────────
    const suggestedDataValues = {};
    if (detectedPrimary) {
      suggestedDataValues[detectedPrimary.field] = detectedPrimary.value;
    }

    // ── Warnings ──────────────────────────────────────────────────────────────
    const warnings = [];
    if (ocrConfidence < 60) {
      warnings.push(`OCR confidence is ${ocrConfidence}% (${ocrEngine}). Values may be inaccurate — please verify carefully.`);
    }
    if (!date) {
      warnings.push('No billing date detected. Please enter the date manually when saving.');
    }
    if (!detectedPrimary) {
      warnings.push(`Could not automatically detect "${primaryConfig?.label || 'the primary field'}". Please select the correct value from the list below.`);
    }
    if (detectedPrimary?.confidence < 60) {
      warnings.push(`Primary value detected with low confidence (${detectedPrimary.confidence}%). Please confirm it is correct.`);
    }

    // ── Response ──────────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'OCR extraction complete. Review all detected values and confirm the primary field before saving.',

      // — OCR quality —
      ocrEngine,
      ocrConfidence,

      // — Scope context —
      scopeInfo: primaryConfig
        ? {
            scopeType,
            categoryName,
            primaryField:       primaryConfig.field,
            primaryFieldLabel:  primaryConfig.label,
            description:        primaryConfig.description,
            importantNote:      primaryConfig.importantNote || null
          }
        : { scopeType, categoryName, primaryField: null, primaryFieldLabel: null, description: 'No primary field configuration found for this scope/category.' },

      // — Detected primary value (use this for emission calculation) —
      detectedPrimaryValue: detectedPrimary || null,

      // — ALL extracted values grouped by type —
      // The frontend must show all groups so the user can pick the correct value
      // if auto-detection is wrong.
      allExtractedValues: {
        consumptionValues: categorized.consumptionValues,   // kWh, m³, liters etc.
        monetaryValues:    categorized.monetaryValues,      // ₹ amounts (bill, charges, payable)
        meterReadings:     categorized.meterReadings,       // curr/prev meter numbers
        demandValues:      categorized.demandValues,         // kW / kVA demand values
        otherValues:       categorized.otherValues           // anything else numeric
      },

      // — All matched pairs (detailed, for advanced use) —
      matchedPairs: matchedPairs.map(p => ({
        rawLabel:      p.rawLabel,
        rawValue:      p.rawValue,
        rawUnit:       p.rawUnit || null,
        numericValue:  p.numericValue,
        bestMatch:     p.bestMatch || null
      })),

      // — Suggested values to pass to /ocr-confirm —
      suggestedDataValues,

      // — Billing date/time if detected —
      detectedDate: date || null,
      detectedTime: time || '00:00:00',

      // — Raw text for debugging / manual reading —
      rawText: rawText || text,

      warnings
    });

  } catch (error) {
    console.error('[verifyOCRData] Unexpected error:', error);
    return res.status(500).json({ success: false, message: 'Server error during OCR verification', error: error.message });
  }
};

module.exports = { saveOCRData, extractOCRPreview, confirmOCRSave, verifyOCRData };
