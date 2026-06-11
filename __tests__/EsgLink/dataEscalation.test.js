'use strict';

// Must be set BEFORE any model that uses the field-encryption plugin
// (EsgLinkBoundary) is required, otherwise getKey() throws.
process.env.FIELD_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;

let EsgLinkBoundary;
let EsgDataEntry;
let EsgWorkflowAction;
let Notification;
let Client;
let User;
let workflowService;
let escalationChecker;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  EsgLinkBoundary   = require('../../src/modules/esg-link/esgLink_core/boundary/models/EsgLinkBoundary');
  EsgDataEntry      = require('../../src/modules/esg-link/esgLink_core/data-collection/models/EsgDataEntry');
  EsgWorkflowAction = require('../../src/modules/esg-link/esgLink_core/data-collection/models/EsgWorkflowAction');
  Notification      = require('../../src/common/models/Notification/Notification');
  Client            = require('../../src/modules/client-management/client/Client');
  User              = require('../../src/common/models/User');
  workflowService   = require('../../src/modules/esg-link/esgLink_core/data-collection/services/workflowService');
  escalationChecker = require('../../src/modules/esg-link/esgLink_core/workflow/jobs/esgReviewerApproverEscalationChecker');
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Promise.all([
    EsgLinkBoundary.deleteMany({}),
    EsgDataEntry.deleteMany({}),
    EsgWorkflowAction.deleteMany({}),
    Notification.deleteMany({}),
    Client.deleteMany({}),
    User.deleteMany({}),
  ]);
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

let userCounter = 0;
function makeUserDoc(overrides = {}) {
  userCounter += 1;
  return {
    email:         `escal-user-${userCounter}@example.com`,
    contactNumber: `90000000${String(userCounter).padStart(2, '0')}`,
    userName:      `escalUser${userCounter}`,
    password:      'password123',
    address:       'Test Address',
    isActive:      true,
    ...overrides,
  };
}

async function makeBoundary({ clientId, nodeId, mappingId, reviewers = [], approvers = [], contributors = [], slaConfig = {} }) {
  const boundary = await EsgLinkBoundary.create({
    clientId,
    setupMethod: 'manual',
    isActive: true,
    isDeleted: false,
    nodes: [
      {
        id: nodeId,
        label: 'Test Node',
        type: 'entity',
        metricsDetails: [
          {
            _id: mappingId,
            metricId: new mongoose.Types.ObjectId(),
            metricCode: 'TEST-001',
            metricName: 'Test Metric',
            metricType: 'raw',
            reviewers,
            approvers,
            contributors,
          },
        ],
      },
    ],
    slaConfig,
  });
  return boundary;
}

function makeEntry({ clientId, boundaryDocId, nodeId, mappingId, workflowStatus, submittedAt = null, underReviewAt = null, isEscalated = false, escalatedAt = null, escalationStage = null, approvalDecisions = [] }) {
  return EsgDataEntry.create({
    clientId,
    boundaryDocId,
    nodeId,
    mappingId,
    metricId: new mongoose.Types.ObjectId(),
    period: { year: 2026, periodLabel: '2026-05', frequency: 'monthly' },
    workflowStatus,
    submittedAt,
    underReviewAt,
    isEscalated,
    escalatedAt,
    escalationStage,
    approvalDecisions,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Model defaults', () => {
  test('EsgLinkBoundary.slaConfig defaults to reviewDeadlineDays=3, approvalDeadlineDays=3, escalationEnabled=true', async () => {
    const boundary = await EsgLinkBoundary.create({
      clientId: 'CLIENT-DEFAULTS',
      setupMethod: 'manual',
      nodes: [],
    });

    expect(boundary.slaConfig.reviewDeadlineDays).toBe(3);
    expect(boundary.slaConfig.approvalDeadlineDays).toBe(3);
    expect(boundary.slaConfig.escalationEnabled).toBe(true);
  });

  test('EsgDataEntry escalation fields default to null/false', async () => {
    const entry = await EsgDataEntry.create({
      clientId: 'CLIENT-DEFAULTS',
      boundaryDocId: new mongoose.Types.ObjectId(),
      nodeId: 'node-1',
      mappingId: new mongoose.Types.ObjectId().toString(),
      period: { year: 2026, periodLabel: '2026-05' },
      workflowStatus: 'draft',
    });

    expect(entry.underReviewAt).toBeNull();
    expect(entry.isEscalated).toBe(false);
    expect(entry.escalatedAt).toBeNull();
    expect(entry.escalationStage).toBeNull();
  });
});

describe('workflowService.transition()', () => {
  test('transitioning submitted -> under_review sets underReviewAt and resets escalation flags', async () => {
    const clientId = 'CLIENT-TRANSITION';
    const nodeId = 'node-1';
    const mappingId = new mongoose.Types.ObjectId().toString();

    const reviewer = await User.create(makeUserDoc({ userType: 'reviewer', clientId }));
    const approver = await User.create(makeUserDoc({ userType: 'approver', clientId }));

    const boundary = await makeBoundary({
      clientId, nodeId, mappingId,
      reviewers: [reviewer._id],
      approvers: [approver._id],
    });

    const entry = await makeEntry({
      clientId,
      boundaryDocId: boundary._id,
      nodeId,
      mappingId,
      workflowStatus: 'submitted',
      submittedAt: new Date(Date.now() - 1 * MS_PER_DAY),
      isEscalated: true,
      escalatedAt: new Date(),
      escalationStage: 'review',
    });

    const actor = { _id: new mongoose.Types.ObjectId(), userType: 'super_admin', userName: 'Admin' };

    const result = await workflowService.transition(entry._id, 'under_review', actor, { clientId });

    expect(result.error).toBeUndefined();
    expect(result.toStatus).toBe('under_review');

    const updated = await EsgDataEntry.findById(entry._id);
    expect(updated.workflowStatus).toBe('under_review');
    expect(updated.underReviewAt).not.toBeNull();
    expect(updated.isEscalated).toBe(false);
    expect(updated.escalatedAt).toBeNull();
    expect(updated.escalationStage).toBeNull();
  });
});

describe('workflowService.recordApproverDecision()', () => {
  test('approving an under_review submission resets escalation flags', async () => {
    const clientId = 'CLIENT-APPROVE';
    const nodeId = 'node-1';
    const mappingId = new mongoose.Types.ObjectId().toString();

    const approver = await User.create(makeUserDoc({ userType: 'approver', clientId }));

    const boundary = await makeBoundary({
      clientId, nodeId, mappingId,
      approvers: [approver._id],
    });

    const entry = await makeEntry({
      clientId,
      boundaryDocId: boundary._id,
      nodeId,
      mappingId,
      workflowStatus: 'under_review',
      submittedAt: new Date(Date.now() - 5 * MS_PER_DAY),
      underReviewAt: new Date(Date.now() - 4 * MS_PER_DAY),
      isEscalated: true,
      escalatedAt: new Date(),
      escalationStage: 'approval',
      approvalDecisions: [
        { approverId: approver._id, approverType: 'approver', decision: 'pending' },
      ],
    });

    const actor = { _id: approver._id, userType: 'super_admin', userName: 'Admin' };

    const result = await workflowService.recordApproverDecision(
      entry._id, approver._id, 'approved', null, { clientId, actor }
    );

    expect(result.error).toBeUndefined();

    const updated = await EsgDataEntry.findById(entry._id);
    expect(updated.workflowStatus).toBe('approved');
    expect(updated.isEscalated).toBe(false);
    expect(updated.escalatedAt).toBeNull();
    expect(updated.escalationStage).toBeNull();
  });
});

describe('checkEsgReviewerApproverEscalations()', () => {
  test('escalates a submitted entry past reviewDeadlineDays -> stage=review, logs action + notifies reviewers/consultant/client_admin', async () => {
    const clientId = 'CLIENT-REVIEW-ESC';
    const nodeId = 'node-1';
    const mappingId = new mongoose.Types.ObjectId().toString();

    const reviewer   = await User.create(makeUserDoc({ userType: 'reviewer', clientId }));
    const consultant = await User.create(makeUserDoc({ userType: 'consultant' }));
    const clientAdmin = await User.create(makeUserDoc({ userType: 'client_admin', clientId, isActive: true }));

    await Client.create({
      clientId,
      stage: 'active',
      leadInfo: {
        companyName: 'Test Co',
        contactPersonName: 'Test Contact',
        email: 'lead@example.com',
        mobileNumber: '9000000000',
        createdBy: new mongoose.Types.ObjectId(),
      },
      workflowTracking: { assignedConsultantId: consultant._id },
    });

    const boundary = await makeBoundary({
      clientId, nodeId, mappingId,
      reviewers: [reviewer._id],
      slaConfig: { reviewDeadlineDays: 3, approvalDeadlineDays: 3, escalationEnabled: true },
    });

    const entry = await makeEntry({
      clientId,
      boundaryDocId: boundary._id,
      nodeId,
      mappingId,
      workflowStatus: 'submitted',
      submittedAt: new Date(Date.now() - 5 * MS_PER_DAY),
    });

    const result = await escalationChecker.checkEsgReviewerApproverEscalations({ clientId });

    expect(result.checked).toBe(1);
    expect(result.escalated).toBe(1);

    const updated = await EsgDataEntry.findById(entry._id);
    expect(updated.isEscalated).toBe(true);
    expect(updated.escalatedAt).not.toBeNull();
    expect(updated.escalationStage).toBe('review');

    const action = await EsgWorkflowAction.findOne({ submissionId: entry._id, action: 'escalated' });
    expect(action).not.toBeNull();
    expect(action.metadata.stage).toBe('review');

    const notif = await Notification.findOne({ systemAction: 'esg_submission_escalated', 'relatedEntity.id': entry._id });
    expect(notif).not.toBeNull();
    const targetIds = notif.targetUsers.map((id) => id.toString());
    expect(targetIds).toEqual(expect.arrayContaining([
      reviewer._id.toString(),
      consultant._id.toString(),
      clientAdmin._id.toString(),
    ]));
  });

  test('escalates an under_review entry past approvalDeadlineDays -> stage=approval, notifies approvers', async () => {
    const clientId = 'CLIENT-APPROVAL-ESC';
    const nodeId = 'node-1';
    const mappingId = new mongoose.Types.ObjectId().toString();

    const approver    = await User.create(makeUserDoc({ userType: 'approver', clientId }));
    const consultant  = await User.create(makeUserDoc({ userType: 'consultant' }));
    const clientAdmin = await User.create(makeUserDoc({ userType: 'client_admin', clientId, isActive: true }));

    await Client.create({
      clientId,
      stage: 'active',
      leadInfo: {
        companyName: 'Test Co',
        contactPersonName: 'Test Contact',
        email: 'lead@example.com',
        mobileNumber: '9000000000',
        createdBy: new mongoose.Types.ObjectId(),
      },
      workflowTracking: { assignedConsultantId: consultant._id },
    });

    const boundary = await makeBoundary({
      clientId, nodeId, mappingId,
      approvers: [approver._id],
      slaConfig: { reviewDeadlineDays: 3, approvalDeadlineDays: 3, escalationEnabled: true },
    });

    const entry = await makeEntry({
      clientId,
      boundaryDocId: boundary._id,
      nodeId,
      mappingId,
      workflowStatus: 'under_review',
      submittedAt: new Date(Date.now() - 10 * MS_PER_DAY),
      underReviewAt: new Date(Date.now() - 5 * MS_PER_DAY),
    });

    const result = await escalationChecker.checkEsgReviewerApproverEscalations({ clientId });

    expect(result.checked).toBe(1);
    expect(result.escalated).toBe(1);

    const updated = await EsgDataEntry.findById(entry._id);
    expect(updated.isEscalated).toBe(true);
    expect(updated.escalationStage).toBe('approval');

    const action = await EsgWorkflowAction.findOne({ submissionId: entry._id, action: 'escalated' });
    expect(action).not.toBeNull();
    expect(action.metadata.stage).toBe('approval');

    const notif = await Notification.findOne({ systemAction: 'esg_submission_escalated', 'relatedEntity.id': entry._id });
    expect(notif).not.toBeNull();
    const targetIds = notif.targetUsers.map((id) => id.toString());
    expect(targetIds).toEqual(expect.arrayContaining([
      approver._id.toString(),
      consultant._id.toString(),
      clientAdmin._id.toString(),
    ]));
  });

  test('skips escalation when boundary.slaConfig.escalationEnabled is false', async () => {
    const clientId = 'CLIENT-ESC-DISABLED';
    const nodeId = 'node-1';
    const mappingId = new mongoose.Types.ObjectId().toString();

    const reviewer = await User.create(makeUserDoc({ userType: 'reviewer', clientId }));

    const boundary = await makeBoundary({
      clientId, nodeId, mappingId,
      reviewers: [reviewer._id],
      slaConfig: { reviewDeadlineDays: 3, approvalDeadlineDays: 3, escalationEnabled: false },
    });

    const entry = await makeEntry({
      clientId,
      boundaryDocId: boundary._id,
      nodeId,
      mappingId,
      workflowStatus: 'submitted',
      submittedAt: new Date(Date.now() - 5 * MS_PER_DAY),
    });

    const result = await escalationChecker.checkEsgReviewerApproverEscalations({ clientId });

    expect(result.checked).toBe(1);
    expect(result.escalated).toBe(0);

    const updated = await EsgDataEntry.findById(entry._id);
    expect(updated.isEscalated).toBe(false);
    expect(updated.escalationStage).toBeNull();

    const action = await EsgWorkflowAction.findOne({ submissionId: entry._id, action: 'escalated' });
    expect(action).toBeNull();
  });

  test('does not re-escalate an entry that is already isEscalated=true', async () => {
    const clientId = 'CLIENT-ALREADY-ESC';
    const nodeId = 'node-1';
    const mappingId = new mongoose.Types.ObjectId().toString();

    const reviewer = await User.create(makeUserDoc({ userType: 'reviewer', clientId }));

    const boundary = await makeBoundary({
      clientId, nodeId, mappingId,
      reviewers: [reviewer._id],
      slaConfig: { reviewDeadlineDays: 3, approvalDeadlineDays: 3, escalationEnabled: true },
    });

    const previousEscalatedAt = new Date(Date.now() - 2 * MS_PER_DAY);
    const entry = await makeEntry({
      clientId,
      boundaryDocId: boundary._id,
      nodeId,
      mappingId,
      workflowStatus: 'submitted',
      submittedAt: new Date(Date.now() - 5 * MS_PER_DAY),
      isEscalated: true,
      escalatedAt: previousEscalatedAt,
      escalationStage: 'review',
    });

    const result = await escalationChecker.checkEsgReviewerApproverEscalations({ clientId });

    expect(result.checked).toBe(0);
    expect(result.escalated).toBe(0);

    const updated = await EsgDataEntry.findById(entry._id);
    expect(updated.escalatedAt.getTime()).toBe(previousEscalatedAt.getTime());
  });

  test('does not escalate a submitted entry still within reviewDeadlineDays', async () => {
    const clientId = 'CLIENT-WITHIN-SLA';
    const nodeId = 'node-1';
    const mappingId = new mongoose.Types.ObjectId().toString();

    const reviewer = await User.create(makeUserDoc({ userType: 'reviewer', clientId }));

    const boundary = await makeBoundary({
      clientId, nodeId, mappingId,
      reviewers: [reviewer._id],
      slaConfig: { reviewDeadlineDays: 3, approvalDeadlineDays: 3, escalationEnabled: true },
    });

    const entry = await makeEntry({
      clientId,
      boundaryDocId: boundary._id,
      nodeId,
      mappingId,
      workflowStatus: 'submitted',
      submittedAt: new Date(Date.now() - 1 * MS_PER_DAY),
    });

    const result = await escalationChecker.checkEsgReviewerApproverEscalations({ clientId });

    expect(result.checked).toBe(1);
    expect(result.escalated).toBe(0);

    const updated = await EsgDataEntry.findById(entry._id);
    expect(updated.isEscalated).toBe(false);
  });
});
