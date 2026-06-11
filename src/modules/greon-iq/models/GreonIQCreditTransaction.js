'use strict';

// ============================================================================
// GreonIQCreditTransaction — immutable audit log of every credit wallet event
//
// One record per credit add or deduction.
// amount > 0 = credits added  (initial_grant, activation_bonus, etc.)
// amount < 0 = credits deducted (query_deduction, manual_adjustment)
//
// balanceAfter is a snapshot of the wallet balance immediately after this
// transaction, allowing point-in-time reconstruction.
// ============================================================================

const mongoose = require('mongoose');

const TRANSACTION_TYPES = [
  'initial_grant',        // seeded on user creation
  'activation_bonus',     // +10,000 when client moves to active stage
  'client_assign_bonus',  // +500 when a client is assigned to a consultant
  'query_deduction',      // credits consumed per GreOn IQ query
  'manual_adjustment',    // super_admin / consultant_admin override
];

const GreonIQCreditTransactionSchema = new mongoose.Schema(
  {
    walletId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'GreonIQCreditWallet',
      required: true,
    },
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    type: {
      type:     String,
      enum:     TRANSACTION_TYPES,
      required: true,
    },
    // Positive = added, negative = deducted
    amount: {
      type:     Number,
      required: true,
    },
    // Wallet balance immediately after this transaction
    balanceAfter: {
      type:     Number,
      required: true,
      min:      0,
    },
    // Contextual metadata — shape varies by type:
    //   query_deduction:    { sessionId, messageId, tokensIn, tokensOut, clientId }
    //   activation_bonus:   { clientId, triggeredBy }
    //   client_assign_bonus:{ clientId, triggeredBy }
    //   manual_adjustment:  { reason, triggeredBy }
    metadata: {
      type:    mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    // Append-only — no updatedAt
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Fast retrieval of a user's transaction history (newest first)
GreonIQCreditTransactionSchema.index({ userId: 1, createdAt: -1 });
// Fast retrieval of all transactions for a specific wallet
GreonIQCreditTransactionSchema.index({ walletId: 1, createdAt: -1 });

GreonIQCreditTransactionSchema.statics.TRANSACTION_TYPES = TRANSACTION_TYPES;

module.exports = mongoose.model('GreonIQCreditTransaction', GreonIQCreditTransactionSchema);
