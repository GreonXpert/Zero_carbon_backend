'use strict';

const mongoose = require('mongoose');

// Mock RagAuditLog.create before requiring the service
const mockCreate = jest.fn().mockResolvedValue({ _id: new mongoose.Types.ObjectId() });

jest.mock('../../../src/modules/rag/models/RagAuditLog', () => ({
  create: mockCreate
}));

let ragAuditService;

beforeAll(() => {
  ({ ragAuditService } = require('../../../src/modules/rag/services/ragAuditService'));
});

afterEach(() => {
  jest.clearAllMocks();
});

// service maps actor.id → entry.actor.userId (not actor.userId)
const actorId = new mongoose.Types.ObjectId().toString();
const actor = {
  id:       actorId,
  email:    'user@example.com',
  userType: 'consultant_admin',
  clientId: new mongoose.Types.ObjectId().toString()
};

const resource = {
  type: 'RagTemplate',
  id:   new mongoose.Types.ObjectId().toString()
};

describe('ragAuditService.log', () => {
  it('calls RagAuditLog.create with a correctly shaped entry', async () => {
    await ragAuditService.log({ action: 'TEMPLATE_CREATED', actor, resource });

    // Fire-and-forget — allow microtask queue to flush
    await new Promise(r => setTimeout(r, 10));
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const [arg] = mockCreate.mock.calls[0];
    expect(arg.action).toBe('TEMPLATE_CREATED');
    expect(arg.actor.userId).toBe(actorId);   // service maps actor.id → entry.actor.userId
    expect(arg.resource.type).toBe('RagTemplate');
  });

  it('strips sensitive fields from before/after', async () => {
    const before = { password: 'secret123', name: 'Old Name', token: 'abc', apiKey: 'key1', embedding: [0.1, 0.2] };
    const after  = { password: 'newpwd',    name: 'New Name', secret: 'x',  embedding: [0.3] };

    await ragAuditService.log({ action: 'REPORT_UPDATED', actor, resource, before, after });
    await new Promise(r => setTimeout(r, 10));

    const [arg] = mockCreate.mock.calls[0];
    expect(arg.before.password).toBeUndefined();
    expect(arg.before.token).toBeUndefined();
    expect(arg.before.apiKey).toBeUndefined();
    expect(arg.before.embedding).toBeUndefined();
    expect(arg.before.name).toBe('Old Name');
    expect(arg.after.password).toBeUndefined();
    expect(arg.after.secret).toBeUndefined();
    expect(arg.after.name).toBe('New Name');
  });

  it('does NOT throw even when RagAuditLog.create fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('DB write error'));

    // log() is fire-and-forget and returns undefined — must not throw synchronously
    expect(() => ragAuditService.log({ action: 'TEMPLATE_PUBLISHED', actor, resource })).not.toThrow();
    // Allow the async rejection to be handled before the test ends
    await new Promise(r => setTimeout(r, 20));
  });
});
