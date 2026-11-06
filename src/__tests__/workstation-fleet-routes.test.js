'use strict';

process.env.APP_SECRET = 'workstation-routes-test-secret';
process.env.ENCRYPTION_KEY = 'workstation-routes-encryption-key';

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-test-user-id']) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: Number(req.headers['x-test-user-id']), username: 'route-user', role: req.headers['x-test-role'] || 'viewer' };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next() : res.status(403).json({ error: 'Insufficient permissions' }),
  writeable: (_req, _res, next) => next(),
}));

jest.mock('../services/workstation-fleet', () => ({
  overview: jest.fn(() => ({ summary: { workstations: 1 }, contract: { foremanSync: 'read_only' } })),
  devices: jest.fn(() => [{ id: 1, name: 'ws-1' }]),
  connections: jest.fn(() => []), mappings: jest.fn(() => []), artifacts: jest.fn(() => []), plans: jest.fn(() => []),
  artifactPromotions: jest.fn(() => ({ artifactId: 10, total: 1, limit: 100, offset: 0,
    promotions: [{ id: 1, fromChannel: 'held', toChannel: 'canary', reason: 'approved' }] })),
  saveConnection: jest.fn(() => ({ id: 7, name: 'Foreman', baseUrl: 'https://foreman.example.test',
    authType: 'token', tlsVerify: true, hasCustomCa: false, hasSecret: true, enabled: true })),
  removeConnection: jest.fn(() => ({ id: 7, removed: true })),
  removeMapping: jest.fn(() => ({ id: 9, connectionId: 7, removed: true })),
  testConnection: jest.fn(async () => ({ ok: true, status: 'available', version: '3.16' })),
  syncConnection: jest.fn(async () => ({ run: { id: 8, connectionId: 7, state: 'success', counts: { workstations: 1 }, sourceHash: 'a'.repeat(64) }, warnings: [] })),
  saveMapping: jest.fn(() => ({ id: 9, sourceKind: 'location', sourceRef: 'Bucharest', edgeSiteId: 1, scopeRef: 'site/bucharest' })),
  inspectRegistryArtifact: jest.fn(async () => ({ id: 10, registryId: 2, repository: 'eu-os/image', digest: `sha256:${'b'.repeat(64)}`,
    bootcDetected: true, signaturePolicy: 'cosign', signatureState: 'verified', sbomRefs: [], channel: 'held' })),
  promoteArtifact: jest.fn(() => ({ id: 10, digest: `sha256:${'b'.repeat(64)}`, channel: 'canary', promotionEvidenceHash: 'c'.repeat(64) })),
  createUpdatePlan: jest.fn(() => ({ id: 11, deviceId: 1, artifactId: 10, action: 'update', targetDigest: `sha256:${'b'.repeat(64)}`,
    previousDigest: `sha256:${'a'.repeat(64)}`, channel: 'canary', remoteJobTemplateId: '101',
    maintenanceWindowRef: 'MW-1', approvalRef: 'CHG-1', planHash: 'd'.repeat(64), duplicate: false })),
  planPreflight: jest.fn(() => ({ plan: { id: 11 }, ready: false,
    checks: [{ key: 'mutation_flag', state: 'block', code: 'WORKSTATION_MUTATIONS_DISABLED', message: 'disabled' }],
    blockers: [{ key: 'mutation_flag', code: 'WORKSTATION_MUTATIONS_DISABLED', message: 'disabled' }],
    networkCallsStarted: 0, credentialsReturned: false })),
  cancelPlan: jest.fn(() => ({ id: 11, deviceId: 1, action: 'update', state: 'cancelled',
    errorMessage: 'Approval withdrawn', duplicate: false, networkCallsStarted: 0 })),
  executePlan: jest.fn(async () => ({ id: 11, deviceId: 1, action: 'update', targetDigest: `sha256:${'b'.repeat(64)}`,
    channel: 'canary', taskRef: 'job-1', state: 'running', planHash: 'd'.repeat(64) })),
  reconcilePlan: jest.fn(async () => ({ id: 11, deviceId: 1, action: 'update', targetDigest: `sha256:${'b'.repeat(64)}`,
    postReadDigest: `sha256:${'b'.repeat(64)}`, state: 'succeeded', postReadVerified: true })),
}));

jest.mock('../services/audit', () => ({ log: jest.fn() }));

const express = require('express');
const request = require('supertest');
const audit = require('../services/audit');
const fleet = require('../services/workstation-fleet');

const app = express();
app.use(express.json());
app.use('/api/workstation-fleet', require('../routes/workstation-fleet'));
const auth = role => ({ 'x-test-user-id': '41', 'x-test-role': role || 'admin' });

describe('workstation fleet HTTP API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('requires authentication and administrator access', async () => {
    await request(app).get('/api/workstation-fleet/overview').expect(401);
    await request(app).get('/api/workstation-fleet/overview').set(auth('operator')).expect(403);
  });

  test('returns read-only overview and saves connection without auditing secret material', async () => {
    await request(app).get('/api/workstation-fleet/overview').set(auth()).expect(200)
      .expect(response => expect(response.body.summary.workstations).toBe(1));
    await request(app).post('/api/workstation-fleet/connections').set(auth())
      .send({ name: 'Foreman', baseUrl: 'https://foreman.example.test', secret: 'never-audit-me' }).expect(201);
    expect(fleet.saveConnection).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workstation_foreman_connection_save',
      details: expect.objectContaining({ secretReturned: false }),
    }));
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('never-audit-me');
  });

  test('sync, artifact and guarded plan routes expose safe audit metadata', async () => {
    await request(app).post('/api/workstation-fleet/connections/7/sync').set(auth()).send({}).expect(201);
    await request(app).post('/api/workstation-fleet/artifacts/inspect').set(auth())
      .send({ registryId: 2, repository: 'eu-os/image', signaturePolicy: 'cosign' }).expect(201);
    await request(app).get('/api/workstation-fleet/artifacts/10/promotions?limit=100').set(auth()).expect(200)
      .expect(response => expect(response.body).toMatchObject({ artifactId: 10, total: 1 }));
    await request(app).post('/api/workstation-fleet/devices/1/plans').set(auth())
      .send({ artifactId: 10 }).expect(201);
    await request(app).get('/api/workstation-fleet/plans/11/preflight').set(auth()).expect(200)
      .expect(response => expect(response.body).toMatchObject({ ready: false, networkCallsStarted: 0 }));
    await request(app).post('/api/workstation-fleet/plans/11/cancel').set(auth())
      .send({ reason: 'Approval withdrawn' }).expect(200);
    await request(app).post('/api/workstation-fleet/plans/11/execute').set(auth())
      .send({ planHash: 'd'.repeat(64), confirmation: 'ws-1' }).expect(200);
    await request(app).delete('/api/workstation-fleet/mappings/9').set(auth()).expect(200);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'workstation_bootc_plan_execute',
      details: expect.objectContaining({ remoteOutputStored: false, credentialsReturned: false }) }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'workstation_bootc_plan_preflight',
      details: expect.objectContaining({ networkCallsStarted: 0 }) }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'workstation_bootc_plan_cancel',
      details: expect.objectContaining({ externalMutationCount: 0, reason: 'Approval withdrawn' }) }));
  });
});
