// utils/jobs/zeroCarbonExpiryChecker.js
// Daily cron job that manages the ZeroCarbon subscription expiry lifecycle:
//   1. Pre-expiry warnings (30d, 7d, 1d before end date)
//   2. active → grace_period transition (on/after end date, within 30 days)
//   3. grace_period → expired transition (>30 days after end date)
//
// Runs daily at 02:05 UTC (5-minute offset from ESGLink job to avoid contention).
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
async function checkZcPreExpiryWarnings() {
  const now             = moment();
  const thirtyDaysAhead = moment().add(GRACE_PERIOD_DAYS, 'days').toDate();

  const clients = await Client.find({
    stage: 'active',
    'accountDetails.subscriptionStatus': 'active',
    'accountDetails.subscriptionEndDate': {
      $gt:  now.toDate(),
      $lte: thirtyDaysAhead,
    },
  });

  console.log(`[ZeroCarbon Expiry] Pre-expiry check: ${clients.length} client(s) within warning window`);

  for (const client of clients) {
    const acct         = client.accountDetails;
    const daysLeft     = moment(acct.subscriptionEndDate).diff(now, 'days');
    const warningsSent = acct.expiryWarningsSent || [];

    for (const threshold of WARNING_THRESHOLDS) {
      if (daysLeft > threshold) continue;

      const alreadySent = warningsSent.some(w => w.daysBeforeExpiry === threshold);
      if (alreadySent) continue;

      const clientAdmin = await User.findById(acct.clientAdminId);
      if (clientAdmin) {
        const endDateStr = moment(acct.subscriptionEndDate).format('DD/MM/YYYY');
        await sendMail(
          clientAdmin.email,
          `ZeroCarbon - Subscription Expiring in ${threshold} Day${threshold > 1 ? 's' : ''}`,
          `Dear ${clientAdmin.userName || 'Client Admin'},\n\n` +
          `Your ZeroCarbon subscription is expiring in ${threshold} day${threshold > 1 ? 's' : ''} on ${endDateStr}.\n\n` +
          `Please contact your consultant to renew your subscription and avoid service interruption.\n\n` +
          `After expiry you will have a ${GRACE_PERIOD_DAYS}-day grace period before access is fully revoked.`
        );
      }

      acct.expiryWarningsSent = [
        ...warningsSent,
        { daysBeforeExpiry: threshold, sentAt: new Date() },
      ];
      client.markModified('accountDetails.expiryWarningsSent');
      await client.save();
      console.log(`[ZeroCarbon Expiry] Sent ${threshold}-day warning to client ${client.clientId}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. active → grace_period
// ─────────────────────────────────────────────────────────────────────────────
async function checkZcActiveToGracePeriod() {
  const clients = await Client.find({
    stage: 'active',
    'accountDetails.subscriptionStatus': 'active',
    'accountDetails.subscriptionEndDate': { $exists: true, $ne: null, $lte: new Date() },
  });

  console.log(`[ZeroCarbon Expiry] Grace-period check: ${clients.length} client(s) to move to grace_period`);

  const updatedIds = [];

  for (const client of clients) {
    const acct       = client.accountDetails;
    const graceEnds  = moment(acct.subscriptionEndDate).add(GRACE_PERIOD_DAYS, 'days').format('DD/MM/YYYY');

    acct.subscriptionStatus = 'grace_period';

    const clientAdmin = await User.findById(acct.clientAdminId);
    if (clientAdmin) {
      await sendMail(
        clientAdmin.email,
        'ZeroCarbon - Subscription Expired (Grace Period Active)',
        `Dear ${clientAdmin.userName || 'Client Admin'},\n\n` +
        `Your ZeroCarbon subscription has expired.\n\n` +
        `You are currently in a ${GRACE_PERIOD_DAYS}-day grace period. ` +
        `Please renew your subscription to continue uninterrupted access.\n\n` +
        `Grace period ends on: ${graceEnds}\n\n` +
        `Contact your consultant for renewal.`
      );
    }

    client.timeline.push({
      stage:       'active',
      status:      'grace_period',
      action:      'ZeroCarbon subscription moved to grace period (auto)',
      performedBy: null,
      notes:       'Automatic system update — subscription end date passed',
    });

    await client.save();
    updatedIds.push(client._id);
    console.log(`[ZeroCarbon Expiry] Client ${client.clientId} → grace_period`);
  }

  if (updatedIds.length > 0) {
    await emitBatchClientUpdate(updatedIds, 'updated', null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. grace_period → expired
// ─────────────────────────────────────────────────────────────────────────────
async function checkZcGracePeriodToExpired() {
  const graceCutoff = moment().subtract(GRACE_PERIOD_DAYS, 'days').toDate();

  const clients = await Client.find({
    'accountDetails.subscriptionStatus': 'grace_period',
    'accountDetails.subscriptionEndDate': { $exists: true, $ne: null, $lte: graceCutoff },
  });

  console.log(`[ZeroCarbon Expiry] Full-expiry check: ${clients.length} client(s) to fully expire`);

  const updatedIds = [];

  for (const client of clients) {
    client.accountDetails.subscriptionStatus = 'expired';
    client.accountDetails.isActive           = false;

    // Deactivate ZeroCarbon-only users (ESGLink-only and dual-module users are untouched)
    await User.updateMany(
      {
        clientId:          client.clientId,
        accessibleModules: { $size: 1, $all: ['zero_carbon'] },
      },
      { isActive: false }
    );

    client.timeline.push({
      stage:       'active',
      status:      'expired',
      action:      'ZeroCarbon subscription fully expired (auto)',
      performedBy: null,
      notes:       `Automatic system update — grace period of ${GRACE_PERIOD_DAYS} days exhausted`,
    });

    await client.save();
    updatedIds.push(client._id);
    console.log(`[ZeroCarbon Expiry] Client ${client.clientId} → expired (ZeroCarbon-only users deactivated)`);
  }

  if (updatedIds.length > 0) {
    await emitBatchClientUpdate(updatedIds, 'updated', null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual trigger (for admin endpoints / testing)
// ─────────────────────────────────────────────────────────────────────────────
async function manualZeroCarbonExpiryCheck() {
  console.log('[ZeroCarbon Expiry] Manual check triggered');
  await checkZcPreExpiryWarnings();
  await checkZcActiveToGracePeriod();
  await checkZcGracePeriodToExpired();
  console.log('[ZeroCarbon Expiry] Manual check complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron initialiser
// ─────────────────────────────────────────────────────────────────────────────
function startZeroCarbonExpiryChecker() {
  const job = cron.schedule('5 2 * * *', async () => {
    console.log('[ZeroCarbon Expiry] Starting daily check...');
    try {
      await checkZcPreExpiryWarnings();
      await checkZcActiveToGracePeriod();
      await checkZcGracePeriodToExpired();
      console.log('[ZeroCarbon Expiry] Daily check completed');
    } catch (error) {
      console.error('[ZeroCarbon Expiry] Error during daily check:', error);
    }
  }, {
    scheduled: true,
    timezone: 'UTC',
  });

  console.log('[ZeroCarbon Expiry] Cron initialized — runs daily at 02:05 UTC');
  return job;
}

module.exports = {
  startZeroCarbonExpiryChecker,
  manualZeroCarbonExpiryCheck,
};
