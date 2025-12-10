// jobs/apiKeyExpiryChecker.js
const cron = require('node-cron');
// ✅ FIXED: Correct path - models is one level up from jobs
const ApiKey = require('../../models/ApiKey');
// ✅ FIXED: Correct path - utils/ApiKey is one level up from jobs
const { createKeyExpiryWarning, createKeyExpiredNotification } = require('../ApiKey/apiKeyNotifications');

/**
 * Check for expiring and expired API keys
 * Runs daily at 9:00 AM IST
 */
function startApiKeyExpiryChecker() {
  // Schedule: Run every day at 9:00 AM
  // Format: minute hour day month weekday
  const schedule = '0 9 * * *';

  const job = cron.schedule(schedule, async () => {
    console.log('[API Key Checker] Starting daily expiry check...');
    
    try {
      await checkExpiringKeys();
      await checkExpiredKeys();
      console.log('[API Key Checker] Daily check completed successfully');
    } catch (error) {
      console.error('[API Key Checker] Error during daily check:', error);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata' // IST timezone
  });

  console.log('[API Key Checker] Cron job initialized - runs daily at 9:00 AM IST');
  
  return job;
}

/**
 * Check for keys expiring within warning windows (7 days and 1 day)
 */
async function checkExpiringKeys() {
  const now = new Date();
  const sevenDaysFromNow = new Date();
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
  
  const oneDayFromNow = new Date();
  oneDayFromNow.setDate(oneDayFromNow.getDate() + 1);

  try {
    // Find all active keys expiring within 7 days
    const expiringKeys = await ApiKey.find({
      status: 'ACTIVE',
      expiresAt: { $gte: now, $lte: sevenDaysFromNow }
    });

    console.log(`[API Key Checker] Found ${expiringKeys.length} keys expiring within 7 days`);

    for (const key of expiringKeys) {
      const daysUntilExpiry = Math.ceil((key.expiresAt - now) / (1000 * 60 * 60 * 24));

      // Send 7-day warning
      if (daysUntilExpiry === 7) {
        const alreadySent7Day = key.expiryWarningsSent.some(w => w.daysBeforeExpiry === 7);
        
        if (!alreadySent7Day) {
          console.log(`[API Key Checker] Sending 7-day warning for key ${key.keyPrefix}***`);
          await createKeyExpiryWarning(key, 7);
        }
      }

      // Send 1-day warning
      if (daysUntilExpiry === 1) {
        const alreadySent1Day = key.expiryWarningsSent.some(w => w.daysBeforeExpiry === 1);
        
        if (!alreadySent1Day) {
          console.log(`[API Key Checker] Sending 1-day warning for key ${key.keyPrefix}***`);
          await createKeyExpiryWarning(key, 1);
        }
      }
    }

  } catch (error) {
    console.error('[API Key Checker] Error checking expiring keys:', error);
  }
}

/**
 * Check for expired keys and mark them
 */
async function checkExpiredKeys() {
  try {
    // Find all active keys that have already expired
    const expiredKeys = await ApiKey.find({
      status: 'ACTIVE',
      expiresAt: { $lt: new Date() }
    });

    console.log(`[API Key Checker] Found ${expiredKeys.length} expired keys`);

    for (const key of expiredKeys) {
      console.log(`[API Key Checker] Processing expired key ${key.keyPrefix}***`);
      
      // Send expiry notification if not already sent
      if (!key.expiryNotificationSent) {
        await createKeyExpiredNotification(key);
      } else {
        // Just mark as expired
        await key.markExpired();
      }
    }

  } catch (error) {
    console.error('[API Key Checker] Error checking expired keys:', error);
  }
}

/**
 * Manual trigger for checking expiring keys (for testing or admin use)
 */
async function manualExpiryCheck() {
  console.log('[API Key Checker] Manual expiry check triggered');
  
  try {
    await checkExpiringKeys();
    await checkExpiredKeys();
    console.log('[API Key Checker] Manual check completed');
    return { success: true, message: 'Expiry check completed' };
  } catch (error) {
    console.error('[API Key Checker] Manual check failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get statistics about API keys
 */
async function getApiKeyStats() {
  try {
    const now = new Date();
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    const stats = {
      active: await ApiKey.countDocuments({ status: 'ACTIVE' }),
      expired: await ApiKey.countDocuments({ status: 'EXPIRED' }),
      revoked: await ApiKey.countDocuments({ status: 'REVOKED' }),
      expiringSoon: await ApiKey.countDocuments({
        status: 'ACTIVE',
        expiresAt: { $gte: now, $lte: sevenDaysFromNow }
      }),
      overdue: await ApiKey.countDocuments({
        status: 'ACTIVE',
        expiresAt: { $lt: now }
      }),
      byType: {
        NET_API: await ApiKey.countDocuments({ keyType: 'NET_API' }),
        NET_IOT: await ApiKey.countDocuments({ keyType: 'NET_IOT' }),
        DC_API: await ApiKey.countDocuments({ keyType: 'DC_API' }),
        DC_IOT: await ApiKey.countDocuments({ keyType: 'DC_IOT' })
      },
      sandboxKeys: await ApiKey.countDocuments({ isSandboxKey: true, status: 'ACTIVE' })
    };

    return stats;
  } catch (error) {
    console.error('[API Key Checker] Error getting stats:', error);
    throw error;
  }
}

module.exports = {
  startApiKeyExpiryChecker,
  checkExpiringKeys,
  checkExpiredKeys,
  manualExpiryCheck,
  getApiKeyStats
};