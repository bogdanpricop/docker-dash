'use strict';

const express = require('express');
const request = require('supertest');

const mockCapabilities = jest.fn();
const mockResources = jest.fn();
const mockAudit = jest.fn();
const mockHost = { id: 7, name: 'xcp-pool', daemon_type: 'xen', is_active: 1 };

jest.mock('../db', () => ({
  getDb: () => ({ prepare: () => ({ get: id => Number(id) === 7 ? mockHost : undefined }) }),
}));
jest.mock('../services/provider-sdk/registry', () => ({
  capabilitiesForHost: (...args) => mockCapabilities(...args),
  resourcesForHost: (...args) => mockResources(...args),
}));
jest.mock('../services/audit', () => ({ log: (...args) => mockAudit(...args) }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 1, username: 'tester', role: req.headers['x-test-role'] || 'admin' };
    next();
  },
}));
jest.mock('../middleware/hostAccess', () => ({
  requireHostAccess: () => (_req, _res, next) => next(),
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
});
