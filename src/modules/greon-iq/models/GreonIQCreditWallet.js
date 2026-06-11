'use strict';

// ============================================================================
// GreonIQCreditWallet — flat credit balance per user for GreOn IQ access
//
// One wallet per user (unique on userId).
// Roles with wallets: consultant, client_admin, client_employee_head
// Unlimited roles (super_admin, consultant_admin) do NOT have wallets.
//
// Credits are a permanent pool — not period-reset.
// All mutations go through creditWalletService (atomic ops).
// ============================================================================

const mongoose = require('mongoose');

const GreonIQCreditWalletSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    userType: {
      type:     String,
      enum:     ['consultant', 'client_admin', 'client_employee_head'],
      required: true,
    },
    // For client_admin / client_employee_head — the client they belong to.
    // For consultant — null (consultants span multiple clients).
    clientId: {
      type:    String,
      default: null,
    },
    balance: {
      type:    Number,
      default: 0,
      min:     0,
    },
    // Running totals for analytics (never decremented)
    lifetimeAdded: {
      type:    Number,
      default: 0,
      min:     0,
    },
    lifetimeUsed: {
      type:    Number,
      default: 0,
      min:     0,
    },
    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// One wallet per user — enforced at DB level
GreonIQCreditWalletSchema.index({ userId: 1 }, { unique: true });
// Fast lookup by client (for admin views)
GreonIQCreditWalletSchema.index({ clientId: 1 });

module.exports = mongoose.model('GreonIQCreditWallet', GreonIQCreditWalletSchema);
