const mongoose = require('mongoose');

const { Schema } = mongoose;

const NOTIFICATION_TYPES = [
  'due_reminder',
  'overdue_reminder',
  'missed_cycle',
  'submission_received',
  'clarification_requested',
  'clarification_replied',
  'review_passed',
  'approved',
  'rejected',
  'api_key_created',
];

const EsgNotificationPreferenceSchema = new Schema(
  {
    userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    clientId: { type: String, required: true, index: true },

    appNotifications:   { type: Boolean, default: true },
    emailNotifications: { type: Boolean, default: true },

    // Types the user has explicitly disabled
    disabledTypes: [{ type: String, enum: NOTIFICATION_TYPES }],
  },
  { timestamps: true }
);

module.exports = {
  EsgNotificationPreference: mongoose.model(
    'EsgNotificationPreference',
    EsgNotificationPreferenceSchema,
    'esg_notification_preferences'
  ),
  NOTIFICATION_TYPES,
};
