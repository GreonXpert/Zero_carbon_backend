# 🐛 THRESHOLD VERIFICATION - BUG ANALYSIS & FIXES

## Critical Bug Found: Encrypted DataValues Not Being Decrypted

### Root Cause

The `historicalAverageService.js` queries DataEntry documents but the **dataValues field is encrypted** in MongoDB:
```json
"dataValues": "v1:16b55ab25965f9305653825a:f03172c12542b3e70c553449a39bec34:..."
```

When the `post('find')` hook tries to decrypt, it depends on:
1. The encryption plugin being properly registered
2. The post('find') hook being called
3. The decryption succeeding without errors

**BUT** - if decryption fails or the hook doesn't fire, the raw encrypted string is used, which resolves to `NaN` when summed:
```javascript
const n = Number("v1:...") // Returns NaN
if (isFinite(n)) total += n; // Fails, total stays 0
```

When incoming value is 0 or undefined, the threshold check auto-passes (line 114):
```javascript
if (!isFinite(rawIncoming) || rawIncoming < 0) return PASS;
```

### Why All 10 Entries Passed

1. Entry 1: No baseline → auto-pass ✓
2. Entry 2: Only 1 in history, needs 3 → auto-pass ✓  
3. Entry 3: Only 2 in history, needs 3 → auto-pass ✓
4. Entry 4-10: Historical average query returns encrypted values
   - post('find') hook should decrypt BUT...
   - Even if decryption runs, the values might be corrupted
   - OR the hook isn't running at all

### Missing FIELD_ENCRYPTION_KEY Environment Variable

**CRITICAL BUG**: The encryption/decryption requires `FIELD_ENCRYPTION_KEY` environment variable:
```javascript
const hex = process.env.FIELD_ENCRYPTION_KEY;
if (!hex || hex.length !== 64) {
  throw new Error('[EncryptionUtil] FIELD_ENCRYPTION_KEY must be a 64-character hex string...');
}
```

**If this env var is missing or wrong:**
- ✗ Decryption will fail (try/catch silently returns null)
- ✗ dataValues will be null instead of numeric values
- ✗ Threshold check sees 0 incoming value → auto-passes

---

## All Issues Found

| # | Issue | Location | Impact | Fix |
|----|-------|----------|--------|-----|
| 1 | Missing FIELD_ENCRYPTION_KEY env var | .env | Decryption fails silently | Add to .env |
| 2 | Encrypted values not decrypted in baseline query | historicalAverageService.js | Baseline = 0, all entries pass | Explicit decrypt in query |
| 3 | No error logging when decryption fails | encryptionUtil.js | Silent failure, no visibility | Add logging |
| 4 | resolveDataEntryRawValue doesn't handle encrypted strings | historicalAverageService.js | Returns 0 for encrypted data | Decrypt before summing |
| 5 | Threshold check passes on NaN/0 values | thresholdVerificationService.js | All anomalies ignored | Better validation |
| 6 | No validation that dataValues exist | dataCollectionController.js | Silent failures in toNumericMap | Add checks |

---

## Required Fixes (In Order)

### FIX 1: Verify FIELD_ENCRYPTION_KEY in .env
```bash
# Check if set:
grep FIELD_ENCRYPTION_KEY .env

# Generate if missing:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Add to .env:
FIELD_ENCRYPTION_KEY=<64-char-hex-string>
```

### FIX 2: Decrypt dataValues Before Calculating Baseline
File: `src/modules/zero-carbon/verification/services/historicalAverageService.js`

Change getDataEntryHistoricalAverage to explicitly decrypt and validate:

```javascript
const entries = await DataEntry.find({...})
  .sort({ timestamp: -1 })
  .limit(sampleSize)
  .select("dataValues")
  .lean();

// After fetching, manually decrypt since post('find') may not have fired
const { decrypt } = require('../../../common/utils/encryptionUtil');
const decrypted Entries = entries.map(e => {
  if (e.dataValues && typeof e.dataValues === 'string') {
    return { ...e, dataValues: decrypt(e.dataValues) };
  }
  return e;
});

const dailyValues = decryptedEntries.map(e => {
  const raw = resolveDataEntryRawValue(e);
  if (raw === 0) {
    console.warn(`⚠️ Entry ${e._id} resolved to 0 (possible decryption failure)`);
  }
  return normalizeToDailyValue(raw, frequency);
});
```

### FIX 3: Add Validation to resolveDataEntryRawValue
```javascript
function resolveDataEntryRawValue(entry) {
  if (!entry.dataValues) return 0;

  let total = 0;
  const values = entry.dataValues;

  // Handle encrypted string case
  if (typeof values === 'string' && values.startsWith('v1:')) {
    console.error(`❌ [resolveDataEntryRawValue] Entry ${entry._id} still encrypted! Decryption failed.`);
    return 0;
  }

  // ... rest of function
}
```

### FIX 4: Better Logging in Threshold Check
```javascript
if (!isFinite(rawIncoming) || rawIncoming < 0) {
  console.log(`⚠️ [checkDataEntry] Incoming value invalid: ${rawIncoming} (type: ${typeof rawIncoming})`);
  return PASS;
}
```

---

## Testing After Fixes

1. **Verify .env has FIELD_ENCRYPTION_KEY**
2. **Restart backend server**
3. **Send new test data** (entries 11-14)
4. **Check console logs** for decryption messages
5. **Verify PendingApproval records created** for anomalous values

---

## Long-term Solution

Instead of relying on post('find') hooks with .lean(), use a helper function that ensures decryption:

```javascript
async function getDecryptedDataEntries(query, limit, sampleSize) {
  const DataEntry = require('../models/DataEntry');
  const { decrypt } = require('../../../common/utils/encryptionUtil');
  
  const entries = await DataEntry.find(query)
    .sort({ timestamp: -1 })
    .limit(sampleSize)
    .select("dataValues timestamp _id")
    .lean();

  return entries.map(e => {
    if (e.dataValues && typeof e.dataValues === 'string') {
      try {
        e.dataValues = decrypt(e.dataValues);
      } catch (err) {
        console.error(`Decryption failed for entry ${e._id}:`, err.message);
        e.dataValues = null;
      }
    }
    return e;
  });
}
```
