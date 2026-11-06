'use strict';

const express = require('express');
const request = require('supertest');

const mockXenClient = {
  provider: 'xapi',
  info: jest.fn(), capabilities: jest.fn(), listPools: jest.fn(), listHosts: jest.fn(),
  listVMs: jest.fn(), listStorages: jest.fn(), listNetworks: jest.fn(), listTasks: jest.fn(),
  getTask: jest.fn(), listSnapshots: jest.fn(), vmAction: jest.fn(),
  createSnapshot: jest.fn(), revertSnapshot: jest.fn(), deleteSnapshot: jest.fn(),
};
const mockHost = { id: 7, name: 'xcp-pool', daemon_type: 'xen', is_active: 1 };
const mockAudit = jest.fn();

jest.mock('../db', () => ({
  getDb: () => ({ prepare: () => ({ get: () => mockHost }) }),
}));
jest.mock('../services/xen', () => ({
  clientForHost: () => mockXenClient,
  invalidateHost: jest.fn(),
}));
jest.mock('../services/audit', () => ({ log: (...args) => mockAudit(...args) }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'tester', role: req.headers['x-test-role'] || 'admin' }; next(); },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }),
  writeable: (_req, _res, next) => next(),
}));
jest.mock('../middleware/hostAccess', () => ({ requireHostAccessForMethod: () => (_req, _res, next) => next() }));
jest.mock('../middleware/hostId', () => ({ extractHostId: (req, _res, next) => { req.hostId = Number(req.query.hostId || 7); next(); } }));

const xenRoutes = require('../routes/xen');

const app = express();
app.use(express.json());
app.use('/api/xen', xenRoutes);

describe('Xen routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockXenClient.capabilities.mockReturnValue({ provider: 'xapi', vms: true });
    mockXenClient.listVMs.mockResolvedValue([{ id: 'vm-1', name: 'web' }]);
    mockXenClient.vmAction.mockResolvedValue({ taskRef: 'OpaqueRef:task' });
    mockXenClient.createSnapshot.mockResolvedValue({ taskRef: 'OpaqueRef:snapshot-task' });
  });

  it('returns normalized inventory for a Xen host', async () => {
    const response = await request(app).get('/api/xen/vms?hostId=7');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 'vm-1', name: 'web' }]);
  });

  it('requires admin for state-changing VM operations', async () => {
    const response = await request(app).post('/api/xen/vms/vm-1/actions/shutdown?hostId=7')
      .set('x-test-role', 'viewer').send({});
    expect(response.status).toBe(403);
    expect(mockXenClient.vmAction).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation for force actions', async () => {
    const response = await request(app).post('/api/xen/vms/vm-1/actions/forceShutdown?hostId=7').send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/confirm=true/);
    expect(mockXenClient.vmAction).not.toHaveBeenCalled();
  });

  it('submits and audits an allowed action', async () => {
    const response = await request(app).post('/api/xen/vms/vm-1/actions/shutdown?hostId=7').send({});
    expect(response.status).toBe(200);
    expect(response.body.result.taskRef).toBe('OpaqueRef:task');
    expect(mockXenClient.vmAction).toHaveBeenCalledWith('vm-1', 'shutdown', {});
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'xen_vm_shutdown', targetId: 'vm-1' }));
  });

  it('validates snapshot names before contacting Xen', async () => {
    const response = await request(app).post('/api/xen/vms/vm-1/snapshots?hostId=7').send({ name: '../../unsafe' });
    expect(response.status).toBe(400);
    expect(mockXenClient.createSnapshot).not.toHaveBeenCalled();
  });
});
