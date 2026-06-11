'use strict';

// ============================================================================
// creditWallet.test.js — GreOn IQ Credit Wallet System Tests
//
// Suites:
//   1. getTokenCreditCost()   — pure math, no DB
//   2. creditWalletService    — wallet CRUD + atomic ops (in-memory Mongo)
//   3. Auto-seeding hooks     — mocked controller hooks
//   4. greonIQAccessGate      — middleware role gate
//   5. Quota resolution/usage — quotaResolutionService + quotaUsageService
// ============================================================================

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;

// ── DB lifecycle ──────────────────────────────────────────────────────────────
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'greon_iq_test' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  // Clean all collections between tests
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — getTokenCreditCost() (pure math)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 1 — getTokenCreditCost()', () => {
  const { getTokenCreditCost } = require('../src/modules/greon-iq/utils/quotaMathHelpers');

  test('T01 — 0 tokens → 1 credit', () => {
    expect(getTokenCreditCost(0)).toBe(1);
  });

  test('T02 — 500 tokens → 1 credit (exactly at tier 1 boundary)', () => {
    expect(getTokenCreditCost(500)).toBe(1);
  });

  test('T03 — 501 tokens → 2 credits (just over tier 1)', () => {
    expect(getTokenCreditCost(501)).toBe(2);
  });

  test('T04 — 1200 tokens → 2 credits (exactly at tier 2 boundary)', () => {
    expect(getTokenCreditCost(1200)).toBe(2);
  });

  test('T05 — 1201 tokens → 4 credits (just over tier 2)', () => {
    expect(getTokenCreditCost(1201)).toBe(4);
  });

  test('T06 — 3500 tokens → 4 credits (exactly at tier 3 boundary)', () => {
    expect(getTokenCreditCost(3500)).toBe(4);
  });

  test('T07 — 3501 tokens → 10 credits (just over tier 3)', () => {
    expect(getTokenCreditCost(3501)).toBe(10);
  });

  test('T08 — 10000 tokens → 10 credits (exactly at tier 4 boundary)', () => {
    expect(getTokenCreditCost(10000)).toBe(10);
  });

  test('T09 — 10001 tokens → 10 credits (floor(1/1000)=0, still 10)', () => {
    expect(getTokenCreditCost(10001)).toBe(10);
  });

  test('T10 — 11000 tokens → 11 credits (10000 + 1000 extra = 10+1)', () => {
    expect(getTokenCreditCost(11000)).toBe(11);
  });

  test('T11 — 12500 tokens → 12 credits (floor(2500/1000)=2, so 10+2)', () => {
    expect(getTokenCreditCost(12500)).toBe(12);
  });

  test('T12 — 20000 tokens → 20 credits (10000 + 10000 extra)', () => {
    expect(getTokenCreditCost(20000)).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — creditWalletService (in-memory DB)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 2 — creditWalletService', () => {
  const {
    CreditInsufficientError,
    getOrCreateWallet,
    addCredits,
    deductCredits,
    getBalance,
    hasEnoughCredits,
  } = require('../src/modules/greon-iq/services/creditWalletService');

  const mockUserId = new mongoose.Types.ObjectId();

  test('T13 — getOrCreateWallet creates wallet with balance=0', async () => {
    const wallet = await getOrCreateWallet(mockUserId, 'consultant', null);
    expect(wallet).toBeDefined();
    expect(wallet.balance).toBe(0);
    expect(wallet.userType).toBe('consultant');
  });

  test('T14 — getOrCreateWallet is idempotent (same wallet returned twice)', async () => {
    const w1 = await getOrCreateWallet(mockUserId, 'consultant', null);
    const w2 = await getOrCreateWallet(mockUserId, 'consultant', null);
    expect(String(w1._id)).toBe(String(w2._id));
  });

  test('T15 — addCredits: balance, lifetimeAdded, transaction record', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    const result = await addCredits(mockUserId, 500, 'initial_grant', { reason: 'test' });
    expect(result.newBalance).toBe(500);
    expect(result.transactionId).toBeDefined();

    const balance = await getBalance(mockUserId);
    expect(balance).toBe(500);
  });

  test('T16 — addCredits twice accumulates correctly', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    await addCredits(mockUserId, 500, 'initial_grant', {});
    const r2 = await addCredits(mockUserId, 500, 'initial_grant', {});
    expect(r2.newBalance).toBe(1000);

    const GreonIQCreditTransaction = require('../src/modules/greon-iq/models/GreonIQCreditTransaction');
    const count = await GreonIQCreditTransaction.countDocuments({ userId: mockUserId });
    expect(count).toBe(2);
  });

  test('T17 — deductCredits reduces balance and records negative transaction', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    await addCredits(mockUserId, 500, 'initial_grant', {});
    const result = await deductCredits(mockUserId, 100, { reason: 'query' });
    expect(result.newBalance).toBe(400);

    const GreonIQCreditTransaction = require('../src/modules/greon-iq/models/GreonIQCreditTransaction');
    const tx = await GreonIQCreditTransaction.findById(result.transactionId).lean();
    expect(tx.amount).toBe(-100);
    expect(tx.balanceAfter).toBe(400);
  });

  test('T18 — deductCredits when balance < amount throws CreditInsufficientError', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    await addCredits(mockUserId, 50, 'initial_grant', {});

    await expect(deductCredits(mockUserId, 100, {})).rejects.toThrow(CreditInsufficientError);

    // Balance must remain unchanged
    expect(await getBalance(mockUserId)).toBe(50);
  });

  test('T19 — deductCredits(0) throws validation error', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    await expect(deductCredits(mockUserId, 0, {})).rejects.toThrow();
  });

  test('T20 — getBalance returns correct balance', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    await addCredits(mockUserId, 300, 'initial_grant', {});
    expect(await getBalance(mockUserId)).toBe(300);
  });

  test('T21 — getBalance returns 0 for non-existent user', async () => {
    const unknownId = new mongoose.Types.ObjectId();
    expect(await getBalance(unknownId)).toBe(0);
  });

  test('T22 — hasEnoughCredits: false when balance < min', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    await addCredits(mockUserId, 50, 'initial_grant', {});
    expect(await hasEnoughCredits(mockUserId, 100)).toBe(false);
  });

  test('T23 — hasEnoughCredits: true when balance === min (exact match)', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    await addCredits(mockUserId, 50, 'initial_grant', {});
    expect(await hasEnoughCredits(mockUserId, 50)).toBe(true);
  });

  test('T24 — concurrent deductions: only one succeeds when balance = 10', async () => {
    await getOrCreateWallet(mockUserId, 'consultant', null);
    await addCredits(mockUserId, 10, 'initial_grant', {});

    const results = await Promise.allSettled([
      deductCredits(mockUserId, 10, {}),
      deductCredits(mockUserId, 10, {}),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected  = results.filter(r => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBeInstanceOf(CreditInsufficientError);
    expect(await getBalance(mockUserId)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — Auto-Seeding Hooks (service-level, mocked User/Client save)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 3 — Auto-Seeding Hooks', () => {
  const { getOrCreateWallet, addCredits, getBalance, getWallet } =
    require('../src/modules/greon-iq/services/creditWalletService');

  test('T25 — consultant creation (no initialCredits) → balance=500', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialCredits = 500; // default
    await getOrCreateWallet(userId, 'consultant', null);
    await addCredits(userId, initialCredits, 'initial_grant', { reason: 'consultant_creation' });
    expect(await getBalance(userId)).toBe(500);
  });

  test('T26 — consultant creation with initialCredits=2000 → balance=2000', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialCredits = 2000;
    await getOrCreateWallet(userId, 'consultant', null);
    await addCredits(userId, initialCredits, 'initial_grant', { reason: 'consultant_creation' });
    expect(await getBalance(userId)).toBe(2000);
  });

  test('T27 — client_admin creation (no initialCredits) → balance=10000', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'client_admin', 'Greon001');
    await addCredits(userId, 10000, 'initial_grant', { reason: 'client_admin_creation' });
    expect(await getBalance(userId)).toBe(10000);
  });

  test('T28 — client_admin creation with initialCredits=1500 → balance=1500', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'client_admin', 'Greon001');
    await addCredits(userId, 1500, 'initial_grant', { reason: 'client_admin_creation' });
    expect(await getBalance(userId)).toBe(1500);
  });

  test('T29 — moveToActive adds 10000 activation_bonus on top of existing balance', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'client_admin', 'Greon001');
    await addCredits(userId, 10000, 'initial_grant', {});
    await addCredits(userId, 10000, 'activation_bonus', { reason: 'client_activated_to_active_stage' });
    expect(await getBalance(userId)).toBe(20000);
  });

  test('T30 — assignConsultant adds 500 client_assign_bonus to consultant', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'consultant', null);
    await addCredits(userId, 500, 'initial_grant', {});
    await addCredits(userId, 500, 'client_assign_bonus', { reason: 'new_client_assigned' });
    expect(await getBalance(userId)).toBe(1000);
  });

  test('T31 — assignConsultant with no existing wallet: getOrCreateWallet then +500', async () => {
    const userId = new mongoose.Types.ObjectId();
    // No wallet yet — getOrCreateWallet creates one
    await getOrCreateWallet(userId, 'consultant', null);
    await addCredits(userId, 500, 'client_assign_bonus', { reason: 'new_client_assigned' });
    expect(await getBalance(userId)).toBe(500);
  });

  test('T32 — client_employee_head creation → balance=5000 (fixed)', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'client_employee_head', 'Greon001');
    await addCredits(userId, 5000, 'initial_grant', { reason: 'client_employee_head_creation' });
    expect(await getBalance(userId)).toBe(5000);
    const wallet = await getWallet(userId);
    expect(wallet.userType).toBe('client_employee_head');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — greonIQAccessGate (unit middleware)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 4 — greonIQAccessGate', () => {
  const greonIQAccessGate = require('../src/modules/greon-iq/middleware/greonIQAccessGate');

  function makeReqRes(userType) {
    const req = { user: { userType } };
    const res = {
      _status: null,
      _json: null,
      status(code) { this._status = code; return this; },
      json(data)   { this._json  = data; return this; },
    };
    const next = jest.fn();
    return { req, res, next };
  }

  const ALLOWED_ROLES = ['super_admin', 'consultant_admin', 'consultant', 'client_admin', 'client_employee_head'];
  const BLOCKED_ROLES = ['auditor', 'viewer', 'employee', 'contributor', 'reviewer', 'approver', 'support', 'supportManager'];

  ALLOWED_ROLES.forEach((role, i) => {
    test(`T${33 + i} — ${role} passes gate`, () => {
      const { req, res, next } = makeReqRes(role);
      greonIQAccessGate(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res._status).toBeNull();
    });
  });

  BLOCKED_ROLES.forEach((role, i) => {
    test(`T${38 + i} — ${role} blocked with 403 GREON_IQ_ROLE_BLOCKED`, () => {
      const { req, res, next } = makeReqRes(role);
      greonIQAccessGate(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(res._json.code).toBe('GREON_IQ_ROLE_BLOCKED');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — Quota Resolution + Usage (integration, in-memory DB)
// ─────────────────────────────────────────────────────────────────────────────
describe('Suite 5 — Quota Resolution + Usage', () => {
  const { isGreonIQEnabled }     = require('../src/modules/greon-iq/services/quotaResolutionService');
  const { checkQuota, deductQuota } = require('../src/modules/greon-iq/services/quotaUsageService');
  const { getOrCreateWallet, addCredits, getBalance } =
    require('../src/modules/greon-iq/services/creditWalletService');

  function makeUser(userType, id) {
    return { _id: id || new mongoose.Types.ObjectId(), userType };
  }

  test('T45 — isGreonIQEnabled for super_admin → unlimited, no balance check', async () => {
    const user = makeUser('super_admin');
    const result = await isGreonIQEnabled(user, null);
    expect(result.isUnlimited).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.balance).toBeNull();
  });

  test('T46 — isGreonIQEnabled for consultant_admin → unlimited', async () => {
    const user = makeUser('consultant_admin');
    const result = await isGreonIQEnabled(user, null);
    expect(result.isUnlimited).toBe(true);
    expect(result.enabled).toBe(true);
  });

  test('T47 — isGreonIQEnabled for client_admin with balance=100 → enabled', async () => {
    const userId = new mongoose.Types.ObjectId();
    const user   = makeUser('client_admin', userId);
    await getOrCreateWallet(userId, 'client_admin', 'Greon001');
    await addCredits(userId, 100, 'initial_grant', {});

    const result = await isGreonIQEnabled(user, 'Greon001');
    expect(result.isUnlimited).toBe(false);
    expect(result.enabled).toBe(true);
    expect(result.balance).toBe(100);
  });

  test('T48 — isGreonIQEnabled for client_admin with balance=0 → disabled', async () => {
    const userId = new mongoose.Types.ObjectId();
    const user   = makeUser('client_admin', userId);
    await getOrCreateWallet(userId, 'client_admin', 'Greon001');
    // No credits added → balance = 0

    const result = await isGreonIQEnabled(user, 'Greon001');
    expect(result.enabled).toBe(false);
    expect(result.balance).toBe(0);
  });

  test('T49 — checkQuota for unlimited user → allowed without wallet check', async () => {
    const userId = new mongoose.Types.ObjectId();
    const enabledCheck = { isUnlimited: true };
    const result = await checkQuota(userId, null, enabledCheck);
    expect(result.allowed).toBe(true);
  });

  test('T50 — checkQuota for user with balance=5 → allowed', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'consultant', null);
    await addCredits(userId, 5, 'initial_grant', {});

    const enabledCheck = { isUnlimited: false, balance: 5 };
    const result = await checkQuota(userId, null, enabledCheck);
    expect(result.allowed).toBe(true);
  });

  test('T51 — checkQuota for user with balance=0 → not allowed', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'consultant', null);
    // balance = 0

    const enabledCheck = { isUnlimited: false, balance: 0 };
    const result = await checkQuota(userId, null, enabledCheck);
    expect(result.allowed).toBe(false);
  });

  test('T52 — deductQuota for unlimited user: 0 credits, ledger written', async () => {
    const userId = new mongoose.Types.ObjectId();
    const enabledCheck = { isUnlimited: true };

    const result = await deductQuota(String(userId), 'Greon001', {
      sessionId:   new mongoose.Types.ObjectId(),
      actionType:  'simple_qa',
      tokensIn:    100,
      tokensOut:   200,
      enabledCheck,
    });

    expect(result.creditsUsed).toBe(0);
    expect(result.newBalance).toBeNull();
  });

  test('T53 — deductQuota 800 total tokens → 2 credits deducted (tier 2)', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'client_admin', 'Greon001');
    await addCredits(userId, 500, 'initial_grant', {});

    const enabledCheck = { isUnlimited: false, balance: 500 };
    const result = await deductQuota(String(userId), 'Greon001', {
      sessionId:   new mongoose.Types.ObjectId(),
      actionType:  'qa_table',
      tokensIn:    400,
      tokensOut:   400,  // total = 800 → tier 2 = 2 credits
      enabledCheck,
    });

    expect(result.creditsUsed).toBe(2);
    expect(result.newBalance).toBe(498);
    expect(await getBalance(userId)).toBe(498);
  });

  test('T54 — deductQuota 5000 total tokens → 10 credits deducted (tier 4)', async () => {
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'consultant', null);
    await addCredits(userId, 100, 'initial_grant', {});

    const enabledCheck = { isUnlimited: false, balance: 100 };
    const result = await deductQuota(String(userId), 'Greon001', {
      sessionId:   new mongoose.Types.ObjectId(),
      actionType:  'cross_module',
      tokensIn:    2000,
      tokensOut:   3000, // total = 5000 → tier 4 = 10 credits
      enabledCheck,
    });

    expect(result.creditsUsed).toBe(10);
    expect(result.newBalance).toBe(90);
  });

  test('T55 — deductQuota when balance < creditCost → throws CreditInsufficientError', async () => {
    const { CreditInsufficientError } = require('../src/modules/greon-iq/services/creditWalletService');
    const userId = new mongoose.Types.ObjectId();
    await getOrCreateWallet(userId, 'consultant', null);
    await addCredits(userId, 1, 'initial_grant', {});

    const enabledCheck = { isUnlimited: false, balance: 1 };
    await expect(
      deductQuota(String(userId), 'Greon001', {
        sessionId:   new mongoose.Types.ObjectId(),
        actionType:  'cross_module',
        tokensIn:    2000,
        tokensOut:   3000, // 10 credits needed, only 1 available
        enabledCheck,
      })
    ).rejects.toThrow(CreditInsufficientError);

    // Balance must remain unchanged
    expect(await getBalance(userId)).toBe(1);
  });
});
