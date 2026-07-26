'use strict';

const express = require('express');
const request = require('supertest');

const mockGet = jest.fn();
const mockList = jest.fn();
const mockEvents = jest.fn();
const mockCancel = jest.fn();
const mockResolve = jest.fn();
const mockPolicyList = jest.fn();
const mockPolicySet = jest.fn();
const mockEmergency = jest.fn();
const mockPermission = jest.fn();
const mockAudit = jest.fn();

const operation = {
  id: `op_${'b'.repeat(26)}`, type: 'vm.power.start', provider: { type: 'xen', endpointId: 7 },
  resource: { kind: 'virtualMachine', id: `ddr_vm_${'a'.repeat(26)}` },
  action: 'start', state: 'running', progress: 20,
};

jest.mock('../services/provider-operations', () => ({
  get: (...args) => mockGet(...args), list: (...args) => mockList(...args),
  events: (...args) => mockEvents(...args), requestCancel: (...args) => mockCancel(...args),
  resolveUnknown: (...args) => mockResolve(...args), applyEmergencyStop: (...args) => mockEmergency(...args),
  policy: { list: (...args) => mockPolicyList(...args), set: (...args) => mockPolicySet(...args) },
}));
jest.mock('../services/host-permissions', () => ({ resolveEffectivePermission: (...args) => mockPermission(...args) }));
jest.mock('../services/audit', () => ({ log: (...args) => mockAudit(...args) }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 2, username: 'operator', role: req.headers['x-test-role'] || 'operator' };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next() : res.status(403).json({ error: 'Insufficient permissions' }),
}));

const routes = require('../routes/operations');
const app = express();
app.use(express.json());
app.use('/api/operations', routes);

describe('Provider operation Activity Center routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockReturnValue(operation);
    mockList.mockReturnValue([operation]);
    mockEvents.mockReturnValue([{ id: 1, type: 'started' }]);
    mockCancel.mockReturnValue({ ...operation, state: 'cancel_requested' });
    mockResolve.mockReturnValue({ ...operation, state: 'succeeded', resolution: { evidence: 'native console verified' } });
    mockPermission.mockReturnValue('operate');
    mockPolicyList.mockReturnValue([{ id: 1, scope_type: 'global', scope_key: '*', mode: 'active' }]);
    mockPolicySet.mockReturnValue({ id: 2, scope_type: 'provider', scope_key: 'xen', mode: 'emergency_stop', reason: 'incident' });
    mockEmergency.mockReturnValue({ cancelled: 2, cancelRequested: 1 });
  });

  it('filters activity by host access and returns bounded events', async () => {
    const listed = await request(app).get('/api/operations');
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].permissions).toEqual({ canCancel: true, canResolve: false });
    const events = await request(app).get(`/api/operations/${operation.id}/events?limit=50`);
    expect(events.status).toBe(200);
    expect(mockEvents).toHaveBeenCalledWith(operation.id, 50);
    mockPermission.mockReturnValue(null);
    expect((await request(app).get('/api/operations')).body.items).toHaveLength(0);
    expect((await request(app).get(`/api/operations/${operation.id}`)).status).toBe(403);
  });

  it('allows an operator with host operate access to request cancellation', async () => {
    const response = await request(app).post(`/api/operations/${operation.id}/cancel`);
    expect(response.status).toBe(202);
    expect(mockCancel).toHaveBeenCalledWith(operation.id);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_operation_cancel_request' }));
  });

  it('publishes action permissions without exposing operations outside the role and host grant', async () => {
    mockGet.mockReturnValueOnce({ ...operation, state: 'unknown' });
    const admin = await request(app).get(`/api/operations/${operation.id}`).set('x-test-role', 'admin');
    expect(admin.body.permissions).toEqual({ canCancel: false, canResolve: true });

    mockGet.mockReturnValueOnce({ ...operation, state: 'unknown' });
    const operator = await request(app).get(`/api/operations/${operation.id}`);
    expect(operator.body.permissions).toEqual({ canCancel: false, canResolve: false });

    mockPermission.mockReturnValue('view');
    const viewer = await request(app).get('/api/operations').set('x-test-role', 'viewer');
    expect(viewer.body.items[0].permissions.canCancel).toBe(false);
  });

  it('requires admin for manual resolution and control policies', async () => {
    expect((await request(app).post(`/api/operations/${operation.id}/resolve`).send({ resolution: 'succeeded', evidence: 'verified' })).status).toBe(403);
    const resolved = await request(app).post(`/api/operations/${operation.id}/resolve`)
      .set('x-test-role', 'admin').send({ resolution: 'succeeded', evidence: 'native console verified' });
    expect(resolved.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(operation.id, 'succeeded', 'native console verified', 2);
    expect((await request(app).get('/api/operations/policies')).status).toBe(403);
    expect((await request(app).get('/api/operations/policies').set('x-test-role', 'admin')).status).toBe(200);
  });

  it('applies and audits a provider emergency stop', async () => {
    const response = await request(app).put('/api/operations/policies/provider/xen')
      .set('x-test-role', 'admin').send({ mode: 'emergency_stop', reason: 'incident' });
    expect(response.status).toBe(200);
    expect(response.body.emergency).toEqual({ cancelled: 2, cancelRequested: 1 });
    expect(mockEmergency).toHaveBeenCalledWith(expect.objectContaining({ mode: 'emergency_stop' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_operation_policy_update' }));
  });

  it('rejects invalid list limits', async () => {
    expect((await request(app).get('/api/operations?limit=0')).status).toBe(400);
    expect((await request(app).get('/api/operations?limit=501')).status).toBe(400);
  });
});
