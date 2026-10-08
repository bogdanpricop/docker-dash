'use strict';

const mockList = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockRemove = jest.fn();
const mockProbe = jest.fn();
const mockWriteTest = jest.fn();
const mockAudit = jest.fn();

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    const role = req.get('x-test-role');
    if (!role) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: role === 'admin' ? 1 : 2, username: role, role };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user?.role)
    ? next() : res.status(403).json({ error: 'Insufficient permissions' }),
  writeable: (_req, _res, next) => next(),
}));
jest.mock('../services/storage-repository-health', () => ({
  list: (...args) => mockList(...args), create: (...args) => mockCreate(...args),
  update: (...args) => mockUpdate(...args), remove: (...args) => mockRemove(...args),
  probe: (...args) => mockProbe(...args), writeTest: (...args) => mockWriteTest(...args),
}));
jest.mock('../services/audit', () => ({ log: (...args) => mockAudit(...args) }));

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/api/storage-repositories', require('../routes/storage-repositories'));
app.use((error, _req, res, _next) => res.status(500).json({ error: 'Internal server error', seen: error.name }));

describe('storage repository routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockReturnValue({ repositories: [], summary: { total: 0 } });
    mockCreate.mockReturnValue({ id: 4, name: 'NAS', protocol: 'nfs' });
    mockUpdate.mockReturnValue({ id: 4, name: 'NAS', protocol: 'nfs', version: 2 });
    mockRemove.mockReturnValue({ id: 4, name: 'NAS', protocol: 'nfs' });
    mockProbe.mockResolvedValue({ repositoryId: 4, state: 'unknown', evidenceHash: 'abc' });
    mockWriteTest.mockResolvedValue({ repositoryId: 4, state: 'healthy', evidenceHash: 'def', cleanupProven: true });
  });

  test('allows authenticated viewers to read sanitized repository health', async () => {
    await request(app).get('/api/storage-repositories?historyLimit=10').set('x-test-role', 'viewer').expect(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ role: 'viewer' }), { historyLimit: '10' });
  });

  test('keeps registry mutations admin-only and audited', async () => {
    await request(app).post('/api/storage-repositories').set('x-test-role', 'viewer').send({}).expect(403);
    await request(app).post('/api/storage-repositories').set('x-test-role', 'admin').send({ name: 'NAS' }).expect(201);
    expect(mockCreate).toHaveBeenCalledWith({ name: 'NAS' }, expect.objectContaining({ role: 'admin' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'storage_repository_create', targetId: '4' }));
  });

  test('audits manual probes and write cleanup evidence without request secrets', async () => {
    await request(app).post('/api/storage-repositories/4/probe').set('x-test-role', 'admin').send({}).expect(200);
    await request(app).post('/api/storage-repositories/4/write-test').set('x-test-role', 'admin')
      .send({ confirmation: 'WRITE NAS' }).expect(200);
    expect(mockProbe).toHaveBeenCalledWith('4', expect.objectContaining({ role: 'admin' }));
    expect(mockWriteTest).toHaveBeenCalledWith('4', { confirmation: 'WRITE NAS' }, expect.objectContaining({ role: 'admin' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'storage_repository_write_test',
      details: expect.objectContaining({ cleanupProven: true }) }));
  });

  test('returns typed service errors but never leaks raw failures', async () => {
    mockProbe.mockRejectedValueOnce(Object.assign(new Error('invalid endpoint'), {
      name: 'StorageRepositoryHealthError', status: 409, code: 'PROBE_BLOCKED',
    }));
    await request(app).post('/api/storage-repositories/4/probe').set('x-test-role', 'admin').expect(409, {
      error: 'invalid endpoint', code: 'PROBE_BLOCKED',
    });
    mockProbe.mockRejectedValueOnce(new Error('connect smb://user:secret@nas'));
    const response = await request(app).post('/api/storage-repositories/4/probe').set('x-test-role', 'admin').expect(500);
    expect(response.body.error).toBe('Internal server error');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
});
