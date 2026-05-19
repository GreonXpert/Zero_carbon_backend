'use strict';

// Daily cron job (03:00 UTC) that sends proactive expiry warnings for ESG API keys.
//
// Thresholds: 30d → client_admin only (medium)
//              7d → client_admin + assigned consultant (high)
//              3d → client_admin + assigned consultant (urgent)
//
// Deduplication: expiryWarningsSent[] on EsgApiKey prevents re-sending the same
// threshold warning — same pattern used by zeroCarbonExpiryChecker.js.

const cron    = require('node-cron');
const EsgApiKey = require('../../data-collection/api-key/models/EsgApiKey');
const Client    = require('../../../../../modules/client-management/client/Client');
const { createEsgApiKeyNotification } = require('../../../../../modules/client-management/utils/notificationHelper');

const WARNING_THRESHOLDS = [30, 7, 3]; // days before expiry

async function checkEsgApiKeyExpiry() {
  try {
    const now = new Date();

    for (const days of WARNING_THRESHOLDS) {
      const windowEnd   = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const windowStart = new Date(now.getTime() + (days - 1) * 24 * 60 * 60 * 1000);

      // Keys expiring within the 1-day band for this threshold that haven't
      // had this specific warning sent yet.
      const keys = await EsgApiKey.find({
        status:    'ACTIVE',
        expiresAt: { $gt: windowStart, $lte: windowEnd },
        'expiryWarningsSent.daysBeforeExpiry': { $ne: days },
      });

      console.log(`[ESG API Key Expiry] ${days}-day check: ${keys.length} key(s) to notify`);

      for (const key of keys) {
        const client = await Client.findOne({ clientId: key.clientId }).lean(false);
        if (!client) {
          console.warn(`[ESG API Key Expiry] Client not found for clientId ${key.clientId}, skipping key ${key._id}`);
          continue;
        }

        await createEsgApiKeyNotification(`expiring_${days}`, key, client);

        key.expiryWarningsSent.push({ daysBeforeExpiry: days, sentAt: new Date() });
        await key.save();

        console.log(`[ESG API Key Expiry] Sent ${days}-day warning for key ${key.keyPrefix}... (client ${key.clientId})`);
      }
    }
  } catch (err) {
    console.error('[ESG API Key Expiry] Error during expiry check:', err.message);
  }
}

/**
 * Registers the daily ESG API key expiry warning cron (03:00 UTC).
 * Exported for use in registerJobs.js.
 */
function startEsgApiKeyExpiryChecker() {
  cron.schedule('0 3 * * *', async () => {
    console.log('[ESG API Key Expiry] Starting daily expiry warning check...');
    await checkEsgApiKeyExpiry();
    console.log('[ESG API Key Expiry] Daily check completed');
  }, {
    scheduled: true,
    timezone:  'UTC',
  });

  console.log('[ESG API Key Expiry] Cron initialized — runs daily at 03:00 UTC');
}

/**
 * Manual trigger for admin use / testing — runs the check immediately.
 */
async function checkEsgApiKeyExpiryNow() {
  console.log('[ESG API Key Expiry] Manual check triggered');
  await checkEsgApiKeyExpiry();
  console.log('[ESG API Key Expiry] Manual check complete');
}

module.exports = { startEsgApiKeyExpiryChecker, checkEsgApiKeyExpiryNow };
