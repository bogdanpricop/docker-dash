'use strict';

const express = require('express');
const request = require('supertest');

const mockCapabilities = jest.fn();
const mockAudit = jest.fn();
const mockHost = { id: 7, name: 'xcp-pool', daemon_type: 'xen', is_active: 1 };

jest.mock('../db', () => ({
  getDb: () => ({ prepare: () => ({ get: id => Number(id) === 7 ? mockHost : undefined }) }),
}));
jest.mock('../services/provider-sdk/registry', () => ({
  capabilitiesForHost: (...args) => mockCapabilities(...args),
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
});
