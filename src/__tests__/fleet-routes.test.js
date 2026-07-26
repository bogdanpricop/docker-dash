'use strict';

process.env.APP_SECRET = 'fleet-routes-test-secret';
process.env.ENCRYPTION_KEY = 'fleet-routes-test-key-32-chars';

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-test-user-id']) return res.status(401).json({ error: 'Authentication required' });
    req.user = {
      id: Number(req.headers['x-test-user-id']),
      username: req.headers['x-test-username'] || 'test-user',
      role: req.headers['x-test-role'] || 'viewer',
    };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'Insufficient permissions' }),
  writeable: (_req, _res, next) => next(),
}));

jest.mock('../services/fleet-operations', () => ({
  fleetHealth: jest.fn(() => ({
    current: { total_hosts: 3, connected: 2, degraded: 1, disconnected: 0 },
    history: [], interval_minutes: 5,
  })),
  preview: jest.fn(async (action, hostIds) => ({ action, hosts: hostIds, ready: hostIds.length })),
  run: jest.fn(async (action, hostIds) => ({
    action, status: 'success',
    hosts: hostIds.map(hostId => ({ host_id: hostId, status: 'success' })),
  })),
}));

jest.mock('../services/audit', () => ({ log: jest.fn() }));

const express = require('express');
const request = require('supertest');
const fleet = require('../services/fleet-operations');
const audit = require('../services/audit');

const app = express();
app.use(express.json());
app.use('/api/fleet', require('../routes/fleet'));

const auth = (role = 'admin') => ({
  'x-test-user-id': '41',
  'x-test-role': role,
  'x-test-username': `fleet-${role}`,
});

describe('fleet HTTP API', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requires authentication and administrator access', async () => {
    await request(app).get('/api/fleet/health').expect(401);
    await request(app).post('/api/fleet/bulk/preview')
      .set(auth('operator')).send({ action: 'restart', host_ids: [1] }).expect(403);
  });

  it('returns fleet health history to administrators', async () => {
    const response = await request(app).get('/api/fleet/health?hours=48')
      .set(auth()).expect(200);
    expect(fleet.fleetHealth).toHaveBeenCalledWith('48');
    expect(response.body.current.connected).toBe(2);
  });

  it('previews and audits a bulk restart', async () => {
    const preview = await request(app).post('/api/fleet/bulk/preview')
      .set(auth()).send({ action: 'restart', host_ids: [11, 12] }).expect(200);
    expect(preview.body.ready).toBe(2);

    const result = await request(app).post('/api/fleet/bulk/run')
      .set(auth()).send({ action: 'restart', host_ids: [11, 12] }).expect(200);
    expect(result.body.status).toBe('success');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fleet_bulk_restart', targetType: 'fleet',
    }));
  });
});
