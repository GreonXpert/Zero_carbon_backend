// utils/jobs/esgLinkExpiryChecker.js
// Daily cron job that manages the ESGLink subscription expiry lifecycle:
//   1. Pre-expiry warnings (30d, 7d, 1d before end date)
//   2. active → grace_period transition (on/after end date, within 30 days)
//   3. grace_period → expired transition (>30 days after end date)
//
// Runs daily at 02:00 UTC.
// Safe to re-run: deduplicates warnings via expiryWarningsSent[], skips
// already-transitioned clients.

'use strict';

const cron    = require('node-cron');
const moment  = require('moment');
const Client  = require('../../../client-management/client/Client');
const User    = require('../../../../common/models/User');
const { sendMail }              = require('../../../../common/utils/mail');
const { emitBatchClientUpdate } = require('../dashboardEmitter');

const GRACE_PERIOD_DAYS  = 30;
const WARNING_THRESHOLDS = [30, 7, 1]; // days before expiry

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pre-expiry warnings
// ─────────────────────────────────────────────────────────────────────────────
async function checkEsgPreExpiryWarnings() {
  const now             = moment();
  const thirtyDaysAhead = moment().add(GRACE_PERIOD_DAYS, 'days').toDate();

  const clients = await Client.find({
    accessibleModules: 'esg_link',
    'accountDetails.esgLinkSubscription.subscriptionStatus': 'active',
    'accountDetails.esgLinkSubscription.subscriptionEndDate': {
      $gt:  now.toDate(),
      $lte: thirtyDaysAhead,
    },
  });

  console.log(`[ESGLink Expiry] Pre-expiry check: ${clients.length} client(s) within warning window`);

  for (const client of clients) {
    const esl          = client.accountDetails.esgLinkSubscription;
    const daysLeft     = moment(esl.subscriptionEndDate).diff(now, 'days');
    const warningsSent = esl.expiryWarningsSent || [];

    for (const threshold of WARNING_THRESHOLDS) {
      if (daysLeft > threshold) continue; // not yet at this threshold

      const alreadySent = warningsSent.some(w => w.daysBeforeExpiry === threshold);
      if (alreadySent) continue;

      const clientAdmin = await User.findById(client.accountDetails.clientAdminId);
      if (clientAdmin) {
        const endDateStr = moment(esl.subscriptionEndDate).format('DD/MM/YYYY');
        await sendMail(
          clientAdmin.email,
          `ESGLink - Subscription Expiring in ${threshold} Day${threshold > 1 ? 's' : ''}`,
          `Dear ${clientAdmin.userName || 'Client Admin'},\n\n` +
          `Your ESGLink subscription is expiring in ${threshold} day${threshold > 1 ? 's' : ''} on ${endDateStr}.\n\n` +
          `Please contact your consultant to renew your subscription and avoid service interruption.\n\n` +
          `After expiry you will have a ${GRACE_PERIOD_DAYS}-day grace period before access is fully revoked.`
        );
      }

      esl.expiryWarningsSent = [
        ...warningsSent,
        { daysBeforeExpiry: threshold, sentAt: new Date() },
      ];
      client.markModified('accountDetails.esgLinkSubscription.expiryWarningsSent');
      await client.save();
      console.log(`[ESGLink Expiry] Sent ${threshold}-day warning to client ${client.clientId}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. active → grace_period
// ─────────────────────────────────────────────────────────────────────────────
async function checkEsgActiveToGracePeriod() {
  const clients = await Client.find({
    accessibleModules: 'esg_link',
    'accountDetails.esgLinkSubscription.subscriptionStatus': 'active',
    'accountDetails.esgLinkSubscription.subscriptionEndDate': { $exists: true, $ne: null, $lte: new Date() },
  });

  console.log(`[ESGLink Expiry] Grace-period check: ${clients.length} client(s) to move to grace_period`);

  const updatedIds = [];

  for (const client of clients) {
    const esl        = client.accountDetails.esgLinkSubscription;
    const graceEnds  = moment(esl.subscriptionEndDate).add(GRACE_PERIOD_DAYS, 'days').format('DD/MM/YYYY');

    esl.subscriptionStatus = 'grace_period';

    const clientAdmin = await User.findById(client.accountDetails.clientAdminId);
    if (clientAdmin) {
      await sendMail(
        clientAdmin.email,
        'ESGLink - Subscription Expired (Grace Period Active)',
        `Dear ${clientAdmin.userName || 'Client Admin'},\n\n` +
        `Your ESGLink subscription has expired.\n\n` +
        `You are currently in a ${GRACE_PERIOD_DAYS}-day grace period. ` +
        `Please renew your subscription to continue uninterrupted access.\n\n` +
        `Grace period ends on: ${graceEnds}\n\n` +
        `Contact your consultant for renewal.`
      );
    }

    client.timeline.push({
      stage:       'active',
      status:      'grace_period',
      action:      'ESGLink subscription moved to grace period (auto)',
      performedBy: null,
      notes:       'Automatic system update — subscription end date passed',
    });

    await client.save();
    updatedIds.push(client._id);
    console.log(`[ESGLink Expiry] Client ${client.clientId} → grace_period`);
  }

  if (updatedIds.length > 0) {
    await emitBatchClientUpdate(updatedIds, 'updated', null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. grace_period → expired
// ─────────────────────────────────────────────────────────────────────────────
async function checkEsgGracePeriodToExpired() {
  const graceCutoff = moment().subtract(GRACE_PERIOD_DAYS, 'days').toDate();

  const clients = await Client.find({
    accessibleModules: 'esg_link',
    'accountDetails.esgLinkSubscription.subscriptionStatus': 'grace_period',
    'accountDetails.esgLinkSubscription.subscriptionEndDate': { $exists: true, $ne: null, $lte: graceCutoff },
  });

  console.log(`[ESGLink Expiry] Full-expiry check: ${clients.length} client(s) to fully expire`);

  const updatedIds = [];

  for (const client of clients) {
    const esl = client.accountDetails.esgLinkSubscription;

    esl.subscriptionStatus = 'expired';
    esl.isActive           = false;

    // Deactivate ESGLink-only users (dual-module users keep their accounts)
    await User.updateMany(
      {
        clientId:          client.clientId,
        accessibleModules: { $size: 1, $all: ['esg_link'] },
      },
      { isActive: false }
    );

    client.timeline.push({
      stage:       'active',
      status:      'expired',
      action:      'ESGLink subscription fully expired (auto)',
      performedBy: null,
      notes:       `Automatic system update — grace period of ${GRACE_PERIOD_DAYS} days exhausted`,
    });

    await client.save();
    updatedIds.push(client._id);
    console.log(`[ESGLink Expiry] Client ${client.clientId} → expired (ESGLink-only users deactivated)`);
  }

  if (updatedIds.length > 0) {
    await emitBatchClientUpdate(updatedIds, 'updated', null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual trigger (for admin endpoints / testing)
// ─────────────────────────────────────────────────────────────────────────────
async function manualEsgLinkExpiryCheck() {
  console.log('[ESGLink Expiry] Manual check triggered');
  await checkEsgPreExpiryWarnings();
  await checkEsgActiveToGracePeriod();
  await checkEsgGracePeriodToExpired();
  console.log('[ESGLink Expiry] Manual check complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron initialiser
// ─────────────────────────────────────────────────────────────────────────────
function startEsgLinkExpiryChecker() {
  const job = cron.schedule('0 2 * * *', async () => {
    console.log('[ESGLink Expiry] Starting daily check...');
    try {
      await checkEsgPreExpiryWarnings();
      await checkEsgActiveToGracePeriod();
      await checkEsgGracePeriodToExpired();
      console.log('[ESGLink Expiry] Daily check completed');
    } catch (error) {
      console.error('[ESGLink Expiry] Error during daily check:', error);
    }
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  console.log('[ESGLink Expiry] Cron initialized — runs daily at 02:00 UTC');
  return job;
}

module.exports = {
  startEsgLinkExpiryChecker,
  manualEsgLinkExpiryCheck,
};
