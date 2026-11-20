'use strict';

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  requireAuth: (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Authentication required' }),
  writeable: (_req, _res, next) => next(),
}));
jest.mock('../services/ai-compute', () => ({ hosts: jest.fn(), inventory: jest.fn(), getJob: jest.fn(), monitoring: jest.fn(), prepare: jest.fn(), execute: jest.fn() }));
jest.mock('../services/ai-compute-metrics', () => ({ sample: jest.fn() }));
jest.mock('../services/provider-operations/policy', () => ({ assertAllowed: jest.fn() }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');
const service = require('../services/ai-compute');
const policy = require('../services/provider-operations/policy');
let app, host, vm;
beforeAll(() => {
  const db = getDb();
  host = db.prepare("INSERT INTO docker_hosts(name,connection_type,daemon_type) VALUES ('Compute','socket','docker')").run().lastInsertRowid;
  vm = db.prepare("INSERT INTO docker_hosts(name,connection_type,daemon_type) VALUES ('VM host','tcp','vsphere')").run().lastInsertRowid;
  app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-test-role']) req.user = { id: 42, role: req.headers['x-test-role'] }; next(); });
  app.use('/api/ai-compute', require('../routes/ai-compute'));
});
afterAll(() => closeDb());
beforeEach(() => { jest.clearAllMocks(); service.hosts.mockReturnValue([{ id: host, name: 'Compute', recommended: true }]); service.inventory.mockResolvedValue({ containers: [], hostId: host }); policy.assertAllowed.mockReset(); });
test('AI host discovery is admin-only and independent of the sidebar provider', async () => {
  expect((await request(app).get('/api/ai-compute/hosts')).status).toBe(401);
  expect((await request(app).get('/api/ai-compute/hosts').set('x-test-role','viewer')).status).toBe(403);
  const response = await request(app).get(`/api/ai-compute/hosts?hostId=${vm}`).set('x-test-role','admin');
  expect(response.status).toBe(200); expect(response.body[0].id).toBe(host);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(service.inventory).not.toHaveBeenCalled();
});
test('anonymous and non-admin users cannot inspect AI workloads', async () => {
  expect((await request(app).get(`/api/ai-compute/inventory?hostId=${host}`)).status).toBe(401);
  expect((await request(app).get(`/api/ai-compute/inventory?hostId=${host}`).set('x-test-role', 'operator')).status).toBe(403);
  expect(service.inventory).not.toHaveBeenCalled();
});
test('admin reads are scoped to validated Docker host and prohibit response caching', async () => {
  const response = await request(app).get(`/api/ai-compute/inventory?hostId=${host}`).set('x-test-role', 'admin');
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(service.inventory).toHaveBeenCalledWith(host);
  expect(response.body.hostName).toBe('Compute');
});
test('malformed, conflicting and non-Docker host selections are rejected before service access', async () => {
  for (const suffix of ['hostId=NaN', `hostId=${vm}`, 'hostId=999999']) {
    expect((await request(app).get('/api/ai-compute/inventory?' + suffix).set('x-test-role', 'admin')).status).toBeGreaterThanOrEqual(400);
  }
  expect((await request(app).get(`/api/ai-compute/inventory?hostId=${host}`).set('x-test-role', 'admin').set('x-docker-host', String(vm))).status).toBe(400);
  expect(service.inventory).not.toHaveBeenCalled();
});
test('metadata changes respect host emergency policy', async () => {
  policy.assertAllowed.mockImplementation(() => { throw Object.assign(new Error('Emergency stop'), { status: 423 }); });
  const response = await request(app).post(`/api/ai-compute/monitoring?hostId=${host}`).set('x-test-role', 'admin').send({ enabled: true });
  expect(response.status).toBe(423); expect(service.monitoring).not.toHaveBeenCalled();
});
test('plans always use the server-validated host, not a host in the request body', async () => {
  service.prepare.mockResolvedValue({ id: 'preview' });
  const response = await request(app).post(`/api/ai-compute/plans?hostId=${host}`).set('x-test-role', 'admin').send({ action: 'stop', hostId: vm });
  expect(response.status).toBe(200);
  expect(service.prepare.mock.calls[0][0]).toBe(host);
});

test('single operation status is admin-only, host-scoped and independent of metrics and inventory', async () => {
  service.getJob.mockReturnValue({ id: 'operation', status: 'running' });
  expect((await request(app).get(`/api/ai-compute/jobs/operation?hostId=${host}`)).status).toBe(401);
  expect((await request(app).get(`/api/ai-compute/jobs/operation?hostId=${host}`).set('x-test-role', 'operator')).status).toBe(403);
  const response = await request(app).get(`/api/ai-compute/jobs/operation?hostId=${host}`).set('x-test-role', 'admin');
  expect(response.status).toBe(200); expect(response.body.status).toBe('running');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(service.getJob).toHaveBeenCalledWith(host, 'operation');
  expect(service.inventory).not.toHaveBeenCalled();
  expect(require('../services/ai-compute-metrics').sample).not.toHaveBeenCalled();
});

test('a missing operation on the selected host returns 404 without exposing another host', async () => {
  service.getJob.mockImplementation(() => { throw Object.assign(new Error('Operation not found'), { status: 404 }); });
  const response = await request(app).get(`/api/ai-compute/jobs/other-host-operation?hostId=${host}`).set('x-test-role', 'admin');
  expect(response.status).toBe(404);
  expect(service.getJob).toHaveBeenCalledWith(host, 'other-host-operation');
});
