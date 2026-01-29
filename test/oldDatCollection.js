const uploadCSVData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;

    /* -------------------------------------------------- */
    /* 1) Locate node + scope                              */
    /* -------------------------------------------------- */
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({
        success: false,
        message: 'Node/scope not found in flowchart or process flowchart'
      });
    }

    const { node, scope } = located;

    /* -------------------------------------------------- */
    /* 2) Permission                                      */
    /* -------------------------------------------------- */
    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Permission denied',
        reason: perm.reason
      });
    }

    /* -------------------------------------------------- */
    /* 3) Emission prerequisite validation                */
    /* -------------------------------------------------- */
    const validation = await validateEmissionPrerequisites(
      clientId,
      nodeId,
      scopeIdentifier
    );

    if (!validation?.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Emission prerequisites are not satisfied for this scope',
        issues: validation?.issues || []
      });
    }

    /* -------------------------------------------------- */
    /* 4) Parse input & prepare ORIGINAL payload           */
    /* -------------------------------------------------- */
    let rows = [];
    let fileName = 'uploaded.csv';
    let rawBuffer = null;
    let rawContentType = 'text/csv';

    /* ---------- CASE A: Multipart CSV (memory) ---------- */
    if (req.file?.buffer) {
      fileName = req.file.originalname || 'uploaded.csv';
      rawBuffer = req.file.buffer;

      rows = await csvtojson().fromString(
        req.file.buffer.toString('utf8')
      );

    /* ---------- CASE B: Raw CSV text ---------- */
    } else if (req.body?.csvText) {
      fileName = req.body.fileName || 'uploaded.csv';
      rawBuffer = Buffer.from(String(req.body.csvText), 'utf8');

      rows = await csvtojson().fromString(req.body.csvText);

    /* ---------- CASE C: JSON rows ---------- */
    } else if (Array.isArray(req.body?.rows)) {
      fileName = req.body.fileName || 'rows.json';
      rawContentType = 'application/json';

      rawBuffer = Buffer.from(
        JSON.stringify(req.body.rows, null, 2),
        'utf8'
      );

      rows = req.body.rows;
    } else {
      return res.status(400).json({
        success: false,
        message: 'CSV data not found. Provide multipart file, csvText, or rows[]'
      });
    }

    /* -------------------------------------------------- */
    /* 5) Upload ORIGINAL payload to S3                    */
    /* -------------------------------------------------- */
    const s3Upload = await uploadOrganisationCSVCreate({
      clientId,
      nodeId,
      scopeIdentifier,
      fileName,
      buffer: rawBuffer,
      contentType: rawContentType
    });

    /* -------------------------------------------------- */
    /* 6) Save rows → DataEntry + calculation              */
    /* -------------------------------------------------- */
    const saved = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      try {
        const { entry, calcResult } = await saveOneEntry({
          req,
          clientId,
          nodeId,
          scopeIdentifier,
          scope,
          node,
          inputSource: 'CSV',
          row: rows[i],
          csvMeta: {
            fileName,
            s3: s3Upload
          }
        });

        saved.push({
          rowNumber: i + 1,
          dataEntryId: entry._id,
          emissionCalculationStatus: entry.emissionCalculationStatus,
          calculatedEmissions: entry.calculatedEmissions || null,
          calculationResponse: calcResult?.data || null
        });
      } catch (err) {
        errors.push({
          row: i + 1,
          error: err.message
        });
      }
    }

    /* -------------------------------------------------- */
    /* 7) Broadcast completion                             */
    /* -------------------------------------------------- */
    if (saved.length > 0 && global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(clientId);
    }

    const ok = errors.length === 0;

    return res.status(ok ? 201 : saved.length ? 207 : 400).json({
      success: ok,
      message: ok
        ? `CSV processed: ${saved.length} rows saved`
        : `CSV partially processed: ${saved.length} saved, ${errors.length} errors`,
      fileName,

      /* ✅ S3 info returned */
      s3: {
        bucket: s3Upload.bucket,
        key: s3Upload.key,
        etag: s3Upload.etag
      },

      savedCount: saved.length,
      failedCount: errors.length,
      results: saved,
      errors
    });

  } catch (error) {
    console.error('uploadCSVData error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};


const saveManualData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { entries, singleEntry } = req.body || {};

    // Locate chart/node/scope
    const located = await findNodeAndScope(clientId, nodeId, scopeIdentifier);
    if (!located) {
      return res.status(404).json({ success: false, message: 'Node/scope not found in flowchart or process flowchart' });
    }
    const { node, scope } = located;

    // Permission
    const perm = await canWriteManualOrCSV(req.user, clientId, node, scope);
    if (!perm.allowed) {
      return res.status(403).json({ success: false, message: 'Permission denied', reason: perm.reason });
    }

    // Validate prerequisites before accepting data
    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation?.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Emission prerequisites are not satisfied for this scope',
        issues: validation?.issues || []
      });
    }

    // Normalize inputs into an array of rows
    const rows = Array.isArray(entries)
      ? entries
      : (singleEntry ? [singleEntry] : [req.body]); // backward compatibility for old shape

    const saved = [];
const errors = [];

for (let i = 0; i < rows.length; i++) {
  try {
    const { entry, calcResult } = await saveOneEntry({
      req, clientId, nodeId, scopeIdentifier, scope, node,
      inputSource: 'MANUAL',
      row: rows[i]
    });
    saved.push({
      dataEntryId: entry._id,
      emissionCalculationStatus: entry.emissionCalculationStatus,
      calculatedEmissions: entry.calculatedEmissions || null,
      calculationResponse: calcResult?.data || null
    });
  } catch (err) {
    errors.push({ index: i, error: err.message });
  }
}
    // 🔁 NEW: only broadcast if we actually saved something
    if (saved.length > 0 && global.broadcastDataCompletionUpdate) {
      global.broadcastDataCompletionUpdate(clientId);
    }


const ok = errors.length === 0;
return res.status(ok ? 201 : (saved.length ? 207 : 400)).json({
  success: ok,
  message: ok
    ? 'Manual data saved'
    : (saved.length ? 'Manual data partially saved' : 'Manual data failed'),
  savedCount: saved.length,
  failedCount: errors.length,
  results: saved,
  errors
});
  } catch (error) {
    console.error('saveManualData error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

model get updated I want each function need to update please update to save the  dataEntryCumulative and get  dataEntryCumulative

first function without changing the other parts and without loosing the helper function used inside it update that function write fully for me 