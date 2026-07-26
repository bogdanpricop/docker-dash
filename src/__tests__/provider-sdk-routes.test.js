'use strict';

const express = require('express');
const request = require('supertest');

const mockCapabilities = jest.fn();
const mockResources = jest.fn();
const mockArtifacts = jest.fn();
const mockVmDetail = jest.fn();
const mockMigrationPreflight = jest.fn();
const mockMigrationExecutionPreflight = jest.fn();
const mockMigrationSubmit = jest.fn();
const mockMaintenancePreflight = jest.fn();
const mockMaintenanceSubmit = jest.fn();
const mockMaintenanceList = jest.fn();
const mockMaintenanceGet = jest.fn();
const mockMaintenancePause = jest.fn();
const mockMaintenanceResume = jest.fn();
const mockMaintenanceCancel = jest.fn();
const mockMaintenanceExit = jest.fn();
const mockMaintenanceReconcile = jest.fn();
const mockHaGet = jest.fn();
const mockHaHistory = jest.fn();
const mockPlacementAffinity = jest.fn();
const mockPlacementRecommend = jest.fn();
const mockPlacementPlan = jest.fn();
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
const mockSnapshotInventory = jest.fn();
const mockSnapshotPreflight = jest.fn();
const mockSnapshotSubmit = jest.fn();
const mockSnapshotPolicyGet = jest.fn();
const mockSnapshotPolicyRuns = jest.fn();
const mockSnapshotPolicyUpsert = jest.fn();
const mockSnapshotPolicyRemove = jest.fn();
const mockSnapshotPolicyPreview = jest.fn();
const mockSnapshotPolicyRun = jest.fn();
const mockProvisionPreflight = jest.fn();
const mockProvisionSubmit = jest.fn();
const mockHost = { id: 7, name: 'xcp-pool', daemon_type: 'xen', is_active: 1 };

jest.mock('../config', () => {
  const actual = jest.requireActual('../config');
  return { ...actual, features: { ...actual.features, providerSdkV2: true, providerHaReadiness: true } };
});

jest.mock('../db', () => ({
  getDb: () => ({ prepare: () => ({ get: id => Number(id) === 7 ? mockHost : undefined }) }),
}));
jest.mock('../services/provider-sdk/registry', () => ({
  capabilitiesForHost: (...args) => mockCapabilities(...args),
  resourcesForHost: (...args) => mockResources(...args),
  artifactsForHost: (...args) => mockArtifacts(...args),
}));
jest.mock('../services/provider-sdk/vm-detail', () => ({
  detailForHost: (...args) => mockVmDetail(...args),
}));
jest.mock('../services/provider-sdk/vm-migration-preflight', () => ({
  preflightForHost: (...args) => mockMigrationPreflight(...args),
}));
jest.mock('../services/provider-operations/vm-migration', () => ({
  preflightForHost: (...args) => mockMigrationExecutionPreflight(...args),
  submitForHost: (...args) => mockMigrationSubmit(...args),
}));
jest.mock('../services/provider-operations/host-maintenance', () => ({
  preflightForHost: (...args) => mockMaintenancePreflight(...args),
  submitForHost: (...args) => mockMaintenanceSubmit(...args),
  listForHost: (...args) => mockMaintenanceList(...args),
  get: (...args) => mockMaintenanceGet(...args),
  pause: (...args) => mockMaintenancePause(...args),
  resume: (...args) => mockMaintenanceResume(...args),
  cancel: (...args) => mockMaintenanceCancel(...args),
  exit: (...args) => mockMaintenanceExit(...args),
  reconcileUnknown: (...args) => mockMaintenanceReconcile(...args),
}));
jest.mock('../services/provider-sdk/ha-readiness', () => ({
  getForHost: (...args) => mockHaGet(...args),
  historyForHost: (...args) => mockHaHistory(...args),
}));
jest.mock('../services/provider-sdk/placement-advisory', () => ({
  affinityForHost: (...args) => mockPlacementAffinity(...args),
  recommendForVm: (...args) => mockPlacementRecommend(...args),
  rebalancePlanForHost: (...args) => mockPlacementPlan(...args),
}));
jest.mock('../services/provider-operations/vm-power', () => ({
  ACTIONS: { start: { force: false }, forceShutdown: { force: true } },
  preflightForHost: (...args) => mockPowerPreflight(...args),
  preflightManyForHost: (...args) => mockPowerPreflightBulk(...args),
  submitForHost: (...args) => mockPowerSubmit(...args),
  submitManyForHost: (...args) => mockPowerSubmitBulk(...args),
}));
jest.mock('../services/provider-operations/vm-snapshots', () => ({
  inventoryForHost: (...args) => mockSnapshotInventory(...args),
  preflightForHost: (...args) => mockSnapshotPreflight(...args),
  submitForHost: (...args) => mockSnapshotSubmit(...args),
}));
jest.mock('../services/provider-operations/snapshot-policies', () => ({
  getForVm: (...args) => mockSnapshotPolicyGet(...args),
  listRuns: (...args) => mockSnapshotPolicyRuns(...args),
  upsertForHost: (...args) => mockSnapshotPolicyUpsert(...args),
  removeForVm: (...args) => mockSnapshotPolicyRemove(...args),
  previewForHost: (...args) => mockSnapshotPolicyPreview(...args),
  runForHost: (...args) => mockSnapshotPolicyRun(...args),
}));
jest.mock('../services/provider-operations/vm-provision', () => ({
  preflightForHost: (...args) => mockProvisionPreflight(...args),
  submitForHost: (...args) => mockProvisionSubmit(...args),
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
    mockArtifacts.mockResolvedValue({ schemaVersion: '1.0', count: 0, totalObserved: 0, truncated: false, items: [] });
    mockVmDetail.mockResolvedValue({
      schemaVersion: '1.0',
      resource: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'vm-a' },
      freshness: { state: 'fresh' }, actions: [], sections: {}, activity: [],
    });
    mockMigrationPreflight.mockResolvedValue({
      schemaVersion: '1.0', generatedAt: '2026-07-26T12:00:00.000Z',
      vm: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'vm-a' },
      scope: { sameEndpointOnly: true, executionEnabled: false }, candidates: [],
      planHash: '8'.repeat(64),
    });
    mockMigrationExecutionPreflight.mockResolvedValue({
      schemaVersion: '1.0', allowed: true, mode: 'live', planHash: '7'.repeat(64),
      vm: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'vm-a' },
      target: { id: `ddr_host_${'b'.repeat(26)}`, displayName: 'xcp-b' }, targetStorage: null,
    });
    mockMigrationSubmit.mockResolvedValue({
      plan: {
        mode: 'live', vm: { id: `ddr_vm_${'a'.repeat(26)}` },
        target: { id: `ddr_host_${'b'.repeat(26)}` }, targetStorage: null,
      },
      operation: { id: `op_${'7'.repeat(26)}` },
    });
    const maintenanceRun = {
      id: `hmr_${'6'.repeat(26)}`, provider: { type: 'xen', endpointId: 7 },
      sourceHost: { id: `ddr_host_${'b'.repeat(26)}`, displayName: 'xcp-a' },
      goal: 'enter', state: 'draining', waveSize: 2, counts: { deferred: 0 }, items: [],
    };
    mockMaintenancePreflight.mockResolvedValue({
      schemaVersion: '1.0', sourceHost: maintenanceRun.sourceHost, goal: 'enter',
      waveSize: 2, itemCount: 1, deferredCount: 0, allowed: true, planHash: '6'.repeat(64),
    });
    mockMaintenanceSubmit.mockResolvedValue({ plan: { planHash: '6'.repeat(64) }, run: maintenanceRun, deduplicated: false });
    mockMaintenanceList.mockReturnValue([maintenanceRun]);
    mockMaintenanceGet.mockReturnValue(maintenanceRun);
    for (const action of [mockMaintenancePause, mockMaintenanceResume, mockMaintenanceCancel, mockMaintenanceExit, mockMaintenanceReconcile]) {
      action.mockResolvedValue(maintenanceRun);
    }
    mockHaGet.mockResolvedValue({
      schemaVersion: '1.0', provider: { type: 'xen', endpointId: 7 },
      state: 'ready', score: 90, domains: [], snapshotHash: '4'.repeat(64),
    });
    mockHaHistory.mockReturnValue([{ id: 1, state: 'ready', score: 90 }]);
    mockPlacementAffinity.mockResolvedValue({
      schemaVersion: '1.0', provider: { type: 'xen', endpointId: 7 },
      capability: { state: 'conditional' }, rules: [], nativeRecommendations: [], limitations: [],
    });
    mockPlacementRecommend.mockResolvedValue({
      schemaVersion: '1.0', vm: { id: `ddr_vm_${'a'.repeat(26)}` }, candidates: [], planHash: '3'.repeat(64),
    });
    mockPlacementPlan.mockResolvedValue({
      schemaVersion: '1.0', moves: [], skipped: [], planHash: '2'.repeat(64), expiresAt: '2026-07-26T12:05:00.000Z',
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
    mockSnapshotInventory.mockResolvedValue({
      schemaVersion: '1.0', hostId: 7, count: 0, items: [], protection: { isBackup: false },
    });
    mockSnapshotPreflight.mockResolvedValue({
      schemaVersion: '1.0', action: 'create', allowed: true, name: 'before-upgrade',
      vm: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'vm-a' }, planHash: 'b'.repeat(64),
    });
    mockSnapshotSubmit.mockResolvedValue({
      plan: {
        action: 'create', name: 'before-upgrade', consistency: 'crash',
        vm: { id: `ddr_vm_${'a'.repeat(26)}` }, snapshot: { id: `dds_snap_${'b'.repeat(26)}` },
      },
      operation: { id: `op_${'f'.repeat(26)}` },
    });
    mockProvisionPreflight.mockResolvedValue({
      schemaVersion: '1.0', allowed: true, name: 'app-01',
      artifact: { id: `dda_art_${'a'.repeat(26)}`, displayName: 'Debian Gold' },
      mode: { requested: 'auto', effective: 'linked' },
      placement: { selected: { storageId: null, targetNode: null }, candidates: [] },
      confirmation: { expected: 'app-01' }, planHash: '9'.repeat(64),
    });
    mockProvisionSubmit.mockResolvedValue({
      plan: {
        name: 'app-01', artifact: { id: `dda_art_${'a'.repeat(26)}` },
        mode: { effective: 'linked' }, placement: { selected: { storageId: null } },
      },
      operation: { id: `op_${'9'.repeat(26)}` },
    });
    mockSnapshotPolicyGet.mockReturnValue(null);
    mockSnapshotPolicyRuns.mockReturnValue([]);
    mockSnapshotPolicyUpsert.mockResolvedValue({
      created: true,
      policy: {
        id: `vmsp_${'a'.repeat(26)}`, enabled: false, mode: 'dry_run', retainCount: 3,
        maxAgeDays: 3, schedule: { frequency: 'daily' },
      },
    });
    mockSnapshotPolicyRemove.mockReturnValue({ id: `vmsp_${'a'.repeat(26)}` });
    mockSnapshotPolicyPreview.mockResolvedValue({
      policyId: `vmsp_${'a'.repeat(26)}`,
      retention: { managedCount: 2, candidates: [{ id: `dds_snap_${'b'.repeat(26)}` }] },
      protection: { isBackup: false },
    });
    mockSnapshotPolicyRun.mockResolvedValue({
      id: `vspr_${'a'.repeat(26)}`, policyId: `vmsp_${'a'.repeat(26)}`,
      state: 'previewed', currentOperationId: null,
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

  it('returns a read-only VM migration preflight to viewers', async () => {
    const id = `ddr_vm_${'a'.repeat(26)}`;
    const response = await request(app).get(`/api/providers/7/virtual-machines/${id}/migration-preflight`)
      .set('x-test-role', 'viewer').set('x-test-host-access', 'view');
    expect(response.status).toBe(200);
    expect(response.body.scope).toEqual(expect.objectContaining({ sameEndpointOnly: true, executionEnabled: false }));
    expect(mockMigrationPreflight).toHaveBeenCalledWith(mockHost, id);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('sanitizes VM migration preflight provider failures', async () => {
    const id = `ddr_vm_${'b'.repeat(26)}`;
    mockMigrationPreflight.mockRejectedValue(Object.assign(new Error('upstream secret'), {
      status: 502, code: 'PROVIDER_MIGRATION_PREFLIGHT_READ_FAILED',
    }));
    const response = await request(app).get(`/api/providers/7/virtual-machines/${id}/migration-preflight`);
    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: 'Provider VM migration preflight failed', code: 'PROVIDER_MIGRATION_PREFLIGHT_READ_FAILED',
    });
  });

  it('operator-gates, preflights and audits native VM migration submission', async () => {
    const id = `ddr_vm_${'a'.repeat(26)}`;
    const targetId = `ddr_host_${'b'.repeat(26)}`;
    expect((await request(app).post(`/api/providers/7/virtual-machines/${id}/migration/preflight`)
      .set('x-test-role', 'viewer').send({ targetId, mode: 'live' })).status).toBe(403);
    const preflight = await request(app).post(`/api/providers/7/virtual-machines/${id}/migration/preflight`)
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate').send({ targetId, mode: 'live' });
    expect(preflight.status).toBe(200);
    expect(mockMigrationExecutionPreflight).toHaveBeenCalledWith(mockHost, id,
      { targetId, mode: 'live' }, { canOperate: true });
    const submit = await request(app).post(`/api/providers/7/virtual-machines/${id}/migration`)
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate')
      .set('Idempotency-Key', 'migration-request-1')
      .send({ targetId, mode: 'live', confirm: true, confirmName: 'vm-a', planHash: '7'.repeat(64) });
    expect(submit.status).toBe(202);
    expect(mockMigrationSubmit).toHaveBeenCalledWith(mockHost, id, expect.objectContaining({
      targetId, mode: 'live', idempotencyKey: 'migration-request-1',
    }), { canOperate: true, createdBy: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_vm_migrate' }));
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

  it('admin-gates, audits and controls durable host maintenance runs', async () => {
    const sourceHostId = `ddr_host_${'b'.repeat(26)}`;
    expect((await request(app).post('/api/providers/7/host-maintenance/preflight')
      .set('x-test-role', 'operator').send({ sourceHostId, goal: 'enter', waveSize: 2 })).status).toBe(403);
    const preflight = await request(app).post('/api/providers/7/host-maintenance/preflight')
      .send({ sourceHostId, goal: 'enter', waveSize: 2 });
    expect(preflight.status).toBe(200);
    expect(mockMaintenancePreflight).toHaveBeenCalledWith(mockHost,
      { sourceHostId, goal: 'enter', waveSize: 2 }, { canOperate: true });

    const submit = await request(app).post('/api/providers/7/host-maintenance/runs')
      .set('Idempotency-Key', 'host-maintenance-one')
      .send({ sourceHostId, goal: 'enter', waveSize: 2, planHash: '6'.repeat(64), confirm: true, confirmName: 'xcp-a' });
    expect(submit.status).toBe(202);
    expect(mockMaintenanceSubmit).toHaveBeenCalledWith(mockHost, expect.objectContaining({
      idempotencyKey: 'host-maintenance-one', sourceHostId,
    }), { canOperate: true, createdBy: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_host_maintenance_start' }));

    expect((await request(app).get('/api/providers/7/host-maintenance/runs')).status).toBe(200);
    const runId = `hmr_${'6'.repeat(26)}`;
    expect((await request(app).get(`/api/providers/7/host-maintenance/runs/${runId}`)).status).toBe(200);
    const pause = await request(app).post(`/api/providers/7/host-maintenance/runs/${runId}/pause`);
    expect(pause.status).toBe(200);
    expect(mockMaintenancePause).toHaveBeenCalledWith(runId, { createdBy: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_host_maintenance_pause' }));
  });

  it('serves HA readiness/history and admin-gates audited live refresh', async () => {
    const current = await request(app).get('/api/providers/7/ha/readiness').set('x-test-role', 'viewer');
    expect(current.status).toBe(200);
    expect(current.body.state).toBe('ready');
    expect(mockHaGet).toHaveBeenCalledWith(mockHost);

    expect((await request(app).post('/api/providers/7/ha/readiness/refresh')
      .set('x-test-role', 'viewer')).status).toBe(403);
    const refreshed = await request(app).post('/api/providers/7/ha/readiness/refresh');
    expect(refreshed.status).toBe(200);
    expect(mockHaGet).toHaveBeenCalledWith(mockHost, { refresh: true });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_ha_readiness_refresh' }));

    const history = await request(app).get('/api/providers/7/ha/readiness/history?limit=12');
    expect(history.status).toBe(200);
    expect(history.body.count).toBe(1);
    expect(mockHaHistory).toHaveBeenCalledWith(7, { limit: 12 });
  });

  it('serves placement evidence and admin-gates an audited read-only rebalance plan', async () => {
    const vmId = `ddr_vm_${'a'.repeat(26)}`;
    expect((await request(app).get('/api/providers/7/placement/affinity')).status).toBe(200);
    expect(mockPlacementAffinity).toHaveBeenCalledWith(mockHost);
    expect((await request(app).get(`/api/providers/7/virtual-machines/${vmId}/placement/recommendations`)).status).toBe(200);
    expect(mockPlacementRecommend).toHaveBeenCalledWith(mockHost, vmId);
    expect((await request(app).post('/api/providers/7/placement/rebalance/plan')
      .set('x-test-role', 'operator').send({})).status).toBe(403);
    const response = await request(app).post('/api/providers/7/placement/rebalance/plan')
      .send({ sourceThresholdPercent: 85, targetThresholdPercent: 75 });
    expect(response.status).toBe(200);
    expect(mockPlacementPlan).toHaveBeenCalledWith(mockHost, { sourceThresholdPercent: 85, targetThresholdPercent: 75 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'provider_placement_rebalance_plan', targetId: '7',
      details: expect.objectContaining({ moveCount: 0, planHash: '2'.repeat(64) }),
    }));
  });

  it('redacts unexpected placement failures at the route boundary', async () => {
    mockPlacementAffinity.mockRejectedValueOnce(new Error('https://admin:secret@xapi.test token=leak'));
    const response = await request(app).get('/api/providers/7/placement/affinity');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Provider placement advisory request failed', code: 'PLACEMENT_ADVISORY_ERROR',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|token=leak/);
  });

  it('redacts untrusted HA provider errors at the route boundary', async () => {
    mockHaGet.mockRejectedValueOnce(Object.assign(
      new Error('connect https://root:secret@provider.invalid failed'),
      { status: 400, code: 'PROVIDER_RAW_ERROR' },
    ));
    const response = await request(app).get('/api/providers/7/ha/readiness');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Provider HA readiness request failed', code: 'HA_READINESS_ERROR',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
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

  it('lists, preflights and submits host-scoped common VM snapshots', async () => {
    const vmId = `ddr_vm_${'a'.repeat(26)}`;
    const inventory = await request(app).get(`/api/providers/7/virtual-machines/${vmId}/snapshots`)
      .set('x-test-role', 'viewer');
    expect(inventory.status).toBe(200);
    expect(inventory.body.protection.isBackup).toBe(false);
    expect(mockSnapshotInventory).toHaveBeenCalledWith(mockHost, vmId);

    const preflight = await request(app).post(`/api/providers/7/virtual-machines/${vmId}/snapshots/preflight`)
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate')
      .send({ name: 'before-upgrade', consistency: 'crash' });
    expect(preflight.status).toBe(200);
    expect(mockSnapshotPreflight).toHaveBeenCalledWith(mockHost, vmId, 'create',
      { name: 'before-upgrade', consistency: 'crash' }, null, { canOperate: true });

    const submit = await request(app).post(`/api/providers/7/virtual-machines/${vmId}/snapshots`)
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate')
      .set('Idempotency-Key', 'snapshot-request-1')
      .send({ name: 'before-upgrade', consistency: 'crash', planHash: 'b'.repeat(64), confirm: true });
    expect(submit.status).toBe(202);
    expect(mockSnapshotSubmit).toHaveBeenCalledWith(mockHost, vmId, 'create', expect.objectContaining({
      idempotencyKey: 'snapshot-request-1',
    }), null, { canOperate: true, createdBy: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_vm_snapshot_create' }));
  });

  it('requires operate access and audits typed snapshot revert/delete submissions', async () => {
    const vmId = `ddr_vm_${'a'.repeat(26)}`;
    const snapshotId = `dds_snap_${'b'.repeat(26)}`;
    expect((await request(app).post(`/api/providers/7/virtual-machines/${vmId}/snapshots/preflight`)
      .set('x-test-role', 'viewer').send({ name: 'blocked' })).status).toBe(403);

    mockSnapshotSubmit.mockResolvedValueOnce({
      plan: { action: 'revert', vm: { id: vmId }, snapshot: { id: snapshotId } },
      operation: { id: `op_${'1'.repeat(26)}` },
    });
    const revert = await request(app).post(`/api/providers/7/virtual-machines/${vmId}/snapshots/${snapshotId}/revert`)
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate')
      .set('Idempotency-Key', 'snapshot-revert-1')
      .send({ confirm: true, confirmName: 'vm-a', planHash: 'c'.repeat(64) });
    expect(revert.status).toBe(202);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_vm_snapshot_revert' }));

    mockSnapshotSubmit.mockResolvedValueOnce({
      plan: { action: 'delete', vm: { id: vmId }, snapshot: { id: snapshotId } },
      operation: { id: `op_${'2'.repeat(26)}` },
    });
    const deletion = await request(app).delete(`/api/providers/7/virtual-machines/${vmId}/snapshots/${snapshotId}`)
      .set('x-test-role', 'operator').set('x-test-host-access', 'operate')
      .set('Idempotency-Key', 'snapshot-delete-1')
      .send({ confirm: true, confirmName: 'before-upgrade', planHash: 'd'.repeat(64) });
    expect(deletion.status).toBe(202);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_vm_snapshot_delete' }));
  });

  it('manages and previews persistent VM snapshot policies with admin authorization', async () => {
    const vmId = `ddr_vm_${'a'.repeat(26)}`;
    const base = `/api/providers/7/virtual-machines/${vmId}/snapshot-policy`;

    expect((await request(app).put(base).set('x-test-role', 'operator').send({})).status).toBe(403);
    const created = await request(app).put(base).send({ enabled: false, mode: 'dry_run' });
    expect(created.status).toBe(201);
    expect(mockSnapshotPolicyUpsert).toHaveBeenCalledWith(mockHost, vmId,
      { enabled: false, mode: 'dry_run' }, { createdBy: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_vm_snapshot_policy_create' }));

    const preview = await request(app).post(`${base}/preview`).send({ draft: { retainCount: 3 } });
    expect(preview.status).toBe(200);
    expect(preview.body.protection.isBackup).toBe(false);
    expect(mockSnapshotPolicyPreview).toHaveBeenCalledWith(mockHost, vmId, { retainCount: 3 });

    const run = await request(app).post(`${base}/run`).send({ confirm: false });
    expect(run.status).toBe(200);
    expect(mockSnapshotPolicyRun).toHaveBeenCalledWith(mockHost, vmId, expect.objectContaining({
      trigger: 'manual', confirm: false, createdBy: 1,
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_vm_snapshot_policy_run' }));

    expect((await request(app).get(`${base}/runs?limit=201`)).status).toBe(400);
    expect((await request(app).delete(base)).status).toBe(200);
    expect(mockSnapshotPolicyRemove).toHaveBeenCalledWith(7, vmId);
  });

  it('publishes provider manifests and an evidence-backed scorecard', async () => {
    const manifests = await request(app).get('/api/providers/manifests');
    expect(manifests.status).toBe(200);
    expect(manifests.body.manifests[0].providerType).toBe('xen');
    const scorecard = await request(app).get('/api/providers/scorecard');
    expect(scorecard.status).toBe(200);
    expect(scorecard.body.providers[0].counts.shipped).toBe(7);
  });

  it('scopes and validates read-only artifact inventory', async () => {
    const response = await request(app).get('/api/providers/7/artifacts?kind=vmTemplate&q=debian&limit=25');
    expect(response.status).toBe(200);
    expect(mockArtifacts).toHaveBeenCalledWith(mockHost, { limit: 25, kind: 'vmTemplate', query: 'debian' });
    expect((await request(app).get('/api/providers/7/artifacts?limit=501')).status).toBe(400);
    expect((await request(app).get(`/api/providers/7/artifacts?q=${'a'.repeat(121)}`)).status).toBe(400);
  });

  it('admin-gates, preflights and audits durable create-from-template submission', async () => {
    const artifactId = `dda_art_${'a'.repeat(26)}`;
    expect((await request(app).post(`/api/providers/7/artifacts/${artifactId}/clone/preflight`)
      .set('x-test-role', 'operator').send({ name: 'app-01' })).status).toBe(403);
    const preflight = await request(app).post(`/api/providers/7/artifacts/${artifactId}/clone/preflight`)
      .send({ name: 'app-01', mode: 'auto' });
    expect(preflight.status).toBe(200);
    expect(mockProvisionPreflight).toHaveBeenCalledWith(mockHost, artifactId,
      { name: 'app-01', mode: 'auto' }, { canOperate: true });
    const submit = await request(app).post(`/api/providers/7/artifacts/${artifactId}/clone`)
      .set('Idempotency-Key', 'provision-app-01')
      .send({ name: 'app-01', mode: 'auto', confirm: true, confirmName: 'app-01', planHash: '9'.repeat(64) });
    expect(submit.status).toBe(202);
    expect(mockProvisionSubmit).toHaveBeenCalledWith(mockHost, artifactId, expect.objectContaining({
      idempotencyKey: 'provision-app-01', confirmName: 'app-01',
    }), { canOperate: true, createdBy: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_vm_provision_submit' }));
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
