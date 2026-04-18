'use strict';

const { EsgNotificationPreference } = require('../models/EsgNotificationPreference');

async function getPreferences(req, res) {
  try {
    const userId = (req.user._id || req.user.id).toString();
    let prefs = await EsgNotificationPreference.findOne({ userId });

    if (!prefs) {
      // Return defaults without creating a record
      return res.json({
        success: true,
        data: { userId, appNotifications: true, emailNotifications: true, disabledTypes: [] },
      });
    }

    return res.json({ success: true, data: prefs });
  } catch (err) {
    console.error('[notificationPrefController.getPreferences]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function updatePreferences(req, res) {
  try {
    const userId   = (req.user._id || req.user.id).toString();
    const clientId = req.user.clientId || '';
    const { appNotifications, emailNotifications, disabledTypes } = req.body;

    const update = {};
    if (typeof appNotifications === 'boolean')   update.appNotifications   = appNotifications;
    if (typeof emailNotifications === 'boolean')  update.emailNotifications = emailNotifications;
    if (Array.isArray(disabledTypes))             update.disabledTypes      = disabledTypes;

    const prefs = await EsgNotificationPreference.findOneAndUpdate(
      { userId },
      { $set: { ...update, clientId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, data: prefs });
  } catch (err) {
    console.error('[notificationPrefController.updatePreferences]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getPreferences, updatePreferences };
