'use strict';

const mongoose = require('mongoose');

// Mock RagReport before requiring middleware
const mockFindById = jest.fn();
jest.mock('../../../src/modules/rag/models/RagReport', () => ({
  findById: mockFindById
}));

// Mock Client model for consultant_admin / consultant branch tests
const mockClientExists = jest.fn();
jest.mock('../../../src/modules/client-management/client/Client', () => ({
  exists: mockClientExists
}));

let ragPermissions;

beforeAll(() => {
  ragPermissions = require('../../../src/modules/rag/middleware/ragPermissions').ragPermissions;
});

afterEach(() => {
  jest.clearAllMocks();
});

function makeReq(userType, clientId, params = {}) {
  return {
    user:   { userType, clientId: clientId?.toString(), id: new mongoose.Types.ObjectId().toString() },
    params: { id: params.id || new mongoose.Types.ObjectId().toString() },
    report: null
  };
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

// ─── templateAuthor ────────────────────────────────────────────────────────

describe('ragPermissions.templateAuthor', () => {
  it('calls next() for super_admin', () => {
    const req  = makeReq('super_admin', null);
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.templateAuthor(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() for consultant_admin', () => {
    const req  = makeReq('consultant_admin', new mongoose.Types.ObjectId());
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.templateAuthor(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 for client_admin', () => {
    const req  = makeReq('client_admin', new mongoose.Types.ObjectId());
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.templateAuthor(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for employee userType', () => {
    const req  = makeReq('employee', new mongoose.Types.ObjectId());
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.templateAuthor(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ─── reportOwner ──────────────────────────────────────────────────────────

describe('ragPermissions.reportOwner', () => {
  const orgId    = new mongoose.Types.ObjectId();
  const reportId = new mongoose.Types.ObjectId();

  function mockReport(report) {
    // middleware calls findById(...).select(...) — must return a chainable thenable
    mockFindById.mockReturnValueOnce({ select: jest.fn().mockResolvedValue(report) });
  }

  it('calls next() and attaches req.report when org matches', async () => {
    const fakeReport = { _id: reportId, organizationId: orgId.toString(), status: 'draft', isDeleted: false };
    mockReport(fakeReport);

    const req  = makeReq('client_admin', orgId, { id: reportId.toString() });
    const res  = makeRes();
    const next = jest.fn();

    await ragPermissions.reportOwner(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.report).toEqual(fakeReport);
  });

  it('returns 403 when org does not match', async () => {
    const otherOrg   = new mongoose.Types.ObjectId();
    const fakeReport = { _id: reportId, organizationId: otherOrg.toString(), status: 'draft', isDeleted: false };
    mockReport(fakeReport);

    const req  = makeReq('client_admin', orgId, { id: reportId.toString() });
    const res  = makeRes();
    const next = jest.fn();

    await ragPermissions.reportOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows super_admin regardless of org', async () => {
    const fakeReport = { _id: reportId, organizationId: new mongoose.Types.ObjectId().toString(), status: 'draft', isDeleted: false };
    mockReport(fakeReport);

    const req  = makeReq('super_admin', null, { id: reportId.toString() });
    const res  = makeRes();
    const next = jest.fn();

    await ragPermissions.reportOwner(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when report not found', async () => {
    mockReport(null);

    const req  = makeReq('client_admin', orgId, { id: reportId.toString() });
    const res  = makeRes();
    const next = jest.fn();

    await ragPermissions.reportOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows consultant_admin whose Client.exists returns truthy', async () => {
    const otherOrg   = new mongoose.Types.ObjectId();
    const fakeReport = { _id: reportId, organizationId: otherOrg.toString(), status: 'draft', isDeleted: false };
    mockReport(fakeReport);
    mockClientExists.mockResolvedValueOnce({ _id: new mongoose.Types.ObjectId() }); // truthy

    const req  = makeReq('consultant_admin', orgId, { id: reportId.toString() });
    const res  = makeRes();
    const next = jest.fn();

    await ragPermissions.reportOwner(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.report).toEqual(fakeReport);
  });

  it('returns 403 for consultant_admin when Client.exists returns falsy', async () => {
    const otherOrg   = new mongoose.Types.ObjectId();
    const fakeReport = { _id: reportId, organizationId: otherOrg.toString(), status: 'draft', isDeleted: false };
    mockReport(fakeReport);
    mockClientExists.mockResolvedValueOnce(null); // not assigned

    const req  = makeReq('consultant_admin', orgId, { id: reportId.toString() });
    const res  = makeRes();
    const next = jest.fn();

    await ragPermissions.reportOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows consultant whose Client.exists returns truthy', async () => {
    const otherOrg   = new mongoose.Types.ObjectId();
    const fakeReport = { _id: reportId, organizationId: otherOrg.toString(), status: 'draft', isDeleted: false };
    mockReport(fakeReport);
    mockClientExists.mockResolvedValueOnce({ _id: new mongoose.Types.ObjectId() }); // truthy

    const req  = makeReq('consultant', orgId, { id: reportId.toString() });
    const res  = makeRes();
    const next = jest.fn();

    await ragPermissions.reportOwner(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.report).toEqual(fakeReport);
  });

  it('returns 403 for consultant when Client.exists returns falsy', async () => {
    const otherOrg   = new mongoose.Types.ObjectId();
    const fakeReport = { _id: reportId, organizationId: otherOrg.toString(), status: 'draft', isDeleted: false };
    mockReport(fakeReport);
    mockClientExists.mockResolvedValueOnce(null);

    const req  = makeReq('consultant', orgId, { id: reportId.toString() });
    const res  = makeRes();
    const next = jest.fn();

    await ragPermissions.reportOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── reportEditable ───────────────────────────────────────────────────────

describe('ragPermissions.reportEditable', () => {
  it('calls next() when report status is draft', () => {
    const req  = { report: { status: 'draft' } };
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.reportEditable(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next() when report status is edited', () => {
    const req  = { report: { status: 'edited' } };
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.reportEditable(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when report is finalized', () => {
    const req  = { report: { status: 'finalized' } };
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.reportEditable(req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── auditViewer ──────────────────────────────────────────────────────────

describe('ragPermissions.auditViewer', () => {
  it('calls next() for super_admin', () => {
    const req  = makeReq('super_admin', null);
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.auditViewer(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 for consultant_admin', () => {
    const req  = makeReq('consultant_admin', new mongoose.Types.ObjectId());
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.auditViewer(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 for client_admin', () => {
    const req  = makeReq('client_admin', new mongoose.Types.ObjectId());
    const res  = makeRes();
    const next = jest.fn();
    ragPermissions.auditViewer(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
