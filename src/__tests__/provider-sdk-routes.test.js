'use strict';

const express = require('express');
const request = require('supertest');

const mockCapabilities = jest.fn();
const mockResources = jest.fn();
const mockVmDetail = jest.fn();
const mockAudit = jest.fn();
const mockConformanceRun = jest.fn();
const mockConformanceGet = jest.fn();
const mockConformanceList = jest.fn();
const mockScorecard = jest.fn();
const mockExport = jest.fn();
const mockPowerPreflight = jest.fn();
const mockPowerPreflightBulk = jest.fn();
const mockPowerSubmit = jest.fn();
const mockPowerSubmitBulk = jest.fn();
const mockHost = { id: 7, name: 'xcp-pool', daemon_type: 'xen', is_active: 1 };

jest.mock('../db', () => ({
  getDb: () => ({ prepare: () => ({ get: id => Number(id) === 7 ? mockHost : undefined }) }),
}));
jest.mock('../services/provider-sdk/registry', () => ({
  capabilitiesForHost: (...args) => mockCapabilities(...args),
  resourcesForHost: (...args) => mockResources(...args),
}));
jest.mock('../services/provider-sdk/vm-detail', () => ({
  detailForHost: (...args) => mockVmDetail(...args),
}));
jest.mock('../services/provider-operations/vm-power', () => ({
  ACTIONS: { start: { force: false }, forceShutdown: { force: true } },
  preflightForHost: (...args) => mockPowerPreflight(...args),
  preflightManyForHost: (...args) => mockPowerPreflightBulk(...args),
  submitForHost: (...args) => mockPowerSubmit(...args),
  submitManyForHost: (...args) => mockPowerSubmitBulk(...args),
}));
jest.mock('../services/provider-conformance', () => ({
  runForHost: (...args) => mockConformanceRun(...args),
  get: (...args) => mockConformanceGet(...args),
  listForHost: (...args) => mockConformanceList(...args),
  scorecard: (...args) => mockScorecard(...args),
  exportEvidence: (...args) => mockExport(...args),
  manifests: { listManifests: () => [{ providerType: 'xen', manifestHash: 'abc' }] },
}));
jest.mock('../services/audit', () => ({ log: (...args) => mockAudit(...args) }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 1, username: 'tester', role: req.headers['x-test-role'] || 'admin' };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next() : res.status(403).json({ error: 'Insufficient permissions' }),
  writeable: (req, _res, next) => next(),
}));
jest.mock('../middleware/hostAccess', () => ({
  requireHostAccess: () => (req, _res, next) => {
    req.hostAccess = req.headers['x-test-host-access'] || 'admin';
    next();
  },
}));

const routes = require('../routes/providers');
const app = express();
app.use(express.json());
app.use('/api/providers', routes);

describe('Provider SDK routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCapabilities.mockResolvedValue({
      schemaVersion: '1.0', provider: { type: 'xen', endpointId: 7 },
      probe: { status: 'reachable', durationMs: 10 }, features: {},
    });
    mockResources.mockResolvedValue({
      schemaVersion: '1.0', kind: 'virtualMachine', provider: { type: 'xen', endpointId: 7 },
      count: 0, totalObserved: 0, truncated: false, items: [],
    });
    mockVmDetail.mockResolvedValue({
      schemaVersion: '1.0',
      resource: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'vm-a' },
      freshness: { state: 'fresh' }, actions: [], sections: {}, activity: [],
    });
    mockPowerPreflight.mockResolvedValue({
      schemaVersion: '1.0', hostId: 7, action: 'start', allowed: true,
      resource: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'vm-a' }, planHash: 'a'.repeat(64),
    });
    mockPowerPreflightBulk.mockResolvedValue({
      schemaVersion: '1.0', hostId: 7, action: 'start', count: 1, allowed: true, plans: [],
    });
    mockPowerSubmit.mockResolvedValue({
      plan: { action: 'start', planHash: 'a'.repeat(64), resource: { id: `ddr_vm_${'a'.repeat(26)}` } },
      operation: { id: `op_${'d'.repeat(26)}` },
    });
    mockPowerSubmitBulk.mockResolvedValue({
      preflight: { action: 'start', plans: [] }, operations: [{ id: `op_${'e'.repeat(26)}` }],
    });
    mockConformanceList.mockReturnValue([]);
    mockScorecard.mockReturnValue([{ providerType: 'xen', counts: { shipped: 7, partial: 1, planned: 21 } }]);
    mockExport.mockReturnValue({ schemaVersion: '1.0', format: 'docker-dash-provider-conformance', integrityHash: 'e'.repeat(64), runs: [] });
    mockConformanceRun.mockResolvedValue({
      schemaVersion: '1.0', id: `pcr_${'a'.repeat(26)}`, hostId: 7,
      providerType: 'xen', mode: 'live_readonly', grade: 'certified', score: 100, maxScore: 100,
      evidenceHash: 'f'.repeat(64), checks: [],
    });
    mockConformanceGet.mockReturnValue(null);
  });

  it('returns host-scoped capabilities', async () => {
    const response = await request(app).get('/api/providers/7/capabilities');
    expect(response.status).toBe(200);
    expect(response.body.schemaVersion).toBe('1.0');
    expect(mockCapabilities).toHaveBeenCalledWith(mockHost, { refresh: false });
  });

  it('requires admin for a live refresh', async () => {
    const response = await request(app).get('/api/providers/7/capabilities?refresh=true')
      .set('x-test-role', 'viewer');
    expect(response.status).toBe(403);
    expect(mockCapabilities).not.toHaveBeenCalled();
  });

  it('audits an admin refresh without credential details', async () => {
    const response = await request(app).get('/api/providers/7/capabilities?refresh=true');
    expect(response.status).toBe(200);
    expect(mockCapabilities).toHaveBeenCalledWith(mockHost, { refresh: true });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'provider_capability_refresh', targetId: '7',
      details: { provider: 'xen', status: 'reachable', durationMs: 10 },
    }));
  });

  it('rejects invalid and missing provider hosts', async () => {
    expect((await request(app).get('/api/providers/0/capabilities')).status).toBe(400);
    expect((await request(app).get('/api/providers/8/capabilities')).status).toBe(404);
  });

  it('returns a host-scoped resource inventory with a bounded limit', async () => {
    const response = await request(app).get('/api/providers/7/resources/virtual-machines?limit=25');
    expect(response.status).toBe(200);
    expect(response.body.kind).toBe('virtualMachine');
    expect(mockResources).toHaveBeenCalledWith(mockHost, 'virtual-machines', { limit: 25 });
  });

  it('rejects malformed inventory limits before provider access', async () => {
    expect((await request(app).get('/api/providers/7/resources/virtual-machines?limit=2x')).status).toBe(400);
    expect((await request(app).get('/api/providers/7/resources/virtual-machines?limit=501')).status).toBe(400);
    expect(mockResources).not.toHaveBeenCalled();
  });

  it('returns safe resource errors', async () => {
    mockResources.mockRejectedValue(Object.assign(new Error('upstream secret'), {
      status: 502, code: 'PROVIDER_RESOURCE_READ_FAILED',
    }));
    const response = await request(app).get('/api/providers/7/resources/virtual-machines');
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Provider resource inventory failed', code: 'PROVIDER_RESOURCE_READ_FAILED' });
  });

  it('returns canonical common VM detail and passes effective operate access', async () => {
    const id = `ddr_vm_${'a'.repeat(26)}`;
    const response = await request(app).get(`/api/providers/7/virtual-machines/${id}`)
      .set('x-test-role', 'viewer').set('x-test-host-access', 'operate');
    expect(response.status).toBe(200);
    expect(response.body.resource.id).toBe(id);
    expect(mockVmDetail).toHaveBeenCalledWith(mockHost, id, { refresh: false, canOperate: true });
  });

  it('requires admin for VM detail refresh and validates refresh values', async () => {
    const id = `ddr_vm_${'a'.repeat(26)}`;
    expect((await request(app).get(`/api/providers/7/virtual-machines/${id}?refresh=yes`)).status).toBe(400);
    expect((await request(app).get(`/api/providers/7/virtual-machines/${id}?refresh=true`)
      .set('x-test-role', 'viewer')).status).toBe(403);
    const refreshed = await request(app).get(`/api/providers/7/virtual-machines/${id}?refresh=true`);
    expect(refreshed.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'provider_vm_detail_refresh', targetId: id,
    }));
  });

  it('returns safe common VM detail errors', async () => {
    const id = `ddr_vm_${'b'.repeat(26)}`;
    mockVmDetail.mockRejectedValue(Object.assign(new Error('upstream secret'), {
      status: 502, code: 'PROVIDER_RESOURCE_READ_FAILED',
    }));
    const response = await request(app).get(`/api/providers/7/virtual-machines/${id}`);
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Provider VM detail failed', code: 'PROVIDER_RESOURCE_READ_FAILED' });
  });

  it('preflights and submits host-scoped VM power with operate access', async () => {
    const id = `ddr_vm_${'a'.repeat(26)}`;
    const preflight = await request(app).post(`/api/providers/7/virtual-machines/${id}/power/preflight`)
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate').send({ action: 'start' });
    expect(preflight.status).toBe(200);
    expect(mockPowerPreflight).toHaveBeenCalledWith(mockHost, id, 'start', { canOperate: true });

    const submit = await request(app).post(`/api/providers/7/virtual-machines/${id}/power`)
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate')
      .set('Idempotency-Key', 'power-request-123').send({ action: 'start', confirm: true, planHash: 'a'.repeat(64) });
    expect(submit.status).toBe(202);
    expect(mockPowerSubmit).toHaveBeenCalledWith(mockHost, id, expect.objectContaining({
      action: 'start', idempotencyKey: 'power-request-123',
    }), { canOperate: true, createdBy: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_vm_power_submit' }));
  });

  it('preflights and submits an atomic bulk VM power request', async () => {
    const id = `ddr_vm_${'a'.repeat(26)}`;
    expect((await request(app).post('/api/providers/7/virtual-machines/power/preflight')
      .set('x-test-role', 'viewer').send({ action: 'start', resourceIds: [id] })).status).toBe(403);
    const submit = await request(app).post('/api/providers/7/virtual-machines/power')
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate')
      .set('Idempotency-Key', 'bulk-power-request').send({ action: 'start', resourceIds: [id], confirm: true });
    expect(submit.status).toBe(202);
    expect(submit.body.count).toBe(1);
    expect(mockPowerSubmitBulk).toHaveBeenCalledWith(mockHost, [id], expect.objectContaining({
      idempotencyKey: 'bulk-power-request',
    }), { canOperate: true, createdBy: 1 });
  });

  it('publishes provider manifests and an evidence-backed scorecard', async () => {
    const manifests = await request(app).get('/api/providers/manifests');
    expect(manifests.status).toBe(200);
    expect(manifests.body.manifests[0].providerType).toBe('xen');
    const scorecard = await request(app).get('/api/providers/scorecard');
    expect(scorecard.status).toBe(200);
    expect(scorecard.body.providers[0].counts.shipped).toBe(7);
  });

  it('exports portable conformance evidence only for admins', async () => {
    expect((await request(app).get('/api/providers/conformance/export').set('x-test-role', 'viewer')).status).toBe(403);
    const response = await request(app).get('/api/providers/conformance/export?limit=25');
    expect(response.status).toBe(200);
    expect(response.body.integrityHash).toHaveLength(64);
    expect(mockExport).toHaveBeenCalledWith(undefined, { limit: 25 });
  });

  it('requires admin and only accepts live_readonly conformance', async () => {
    expect((await request(app).post('/api/providers/7/conformance').set('x-test-role', 'viewer')).status).toBe(403);
    expect((await request(app).post('/api/providers/7/conformance').send({ mode: 'mutation' })).status).toBe(400);
    const response = await request(app).post('/api/providers/7/conformance').send({ mode: 'live_readonly' });
    expect(response.status).toBe(201);
    expect(mockConformanceRun).toHaveBeenCalledWith(mockHost, { createdBy: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'provider_conformance_run', targetId: '7',
    }));
  });

  it('keeps conformance results host scoped', async () => {
    const run = { id: `pcr_${'b'.repeat(26)}`, hostId: 7, checks: [] };
    mockConformanceGet.mockReturnValue(run);
    expect((await request(app).get(`/api/providers/7/conformance/${run.id}`)).status).toBe(200);
    mockConformanceGet.mockReturnValue({ ...run, hostId: 8 });
    expect((await request(app).get(`/api/providers/7/conformance/${run.id}`)).status).toBe(404);
  });
});
