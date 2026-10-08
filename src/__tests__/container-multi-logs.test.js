'use strict';

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 7, username: 'log-reader', role: 'operator' };
    next();
  },
  requireRole: () => (_req, _res, next) => next(),
  writeable: (_req, _res, next) => next(),
  requireFeature: () => (_req, _res, next) => next(),
}));

jest.mock('../middleware/hostId', () => ({
  extractHostId: (req, _res, next) => { req.hostId = 0; next(); },
}));
jest.mock('../middleware/hostAccess', () => ({
  requireHostAccessForMethod: () => (_req, _res, next) => next(),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/permissions', () => ({
  filterContainers: value => value,
  getEffectiveRole: jest.fn(() => 'operate'),
  hasPermission: jest.fn(() => true),
}));
jest.mock('../services/docker', () => ({
  listContainers: jest.fn(),
  getDocker: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const dockerService = require('../services/docker');

const app = express();
app.use(express.json());
app.use('/api/containers', require('../routes/containers'));

describe('bounded multi-container log history', () => {
  let logs;

  beforeEach(() => {
    jest.clearAllMocks();
    logs = jest.fn(async () => Buffer.from('2026-07-26T12:00:00.000000000Z value [literal match\n'));
    dockerService.getDocker.mockReturnValue({
      listContainers: jest.fn(async () => []),
      getContainer: jest.fn(id => ({
        inspect: jest.fn(async () => ({
          Name: `/${id}`,
          Config: { Labels: { 'com.docker.compose.project': 'demo' } },
        })),
        logs,
      })),
    });
  });

  it('rejects explicit fan-out above 25 containers', async () => {
    const ids = Array.from({ length: 26 }, (_, index) => `container-${index}`).join(',');
    const response = await request(app)
      .get(`/api/containers/logs/multi?containers=${encodeURIComponent(ids)}`)
      .expect(400);
    expect(response.body.error).toMatch(/at most 25/);
    expect(logs).not.toHaveBeenCalled();
  });

  it('deduplicates IDs, caps tail, and treats search as literal text', async () => {
    const response = await request(app)
      .get('/api/containers/logs/multi?containers=demo-web,demo-web&tail=99999&search=%5B')
      .expect(200);

    expect(response.body).toMatchObject({ count: 1 });
    expect(response.body.logs[0]).toMatchObject({ container: 'demo-web', severity: 'info' });
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ tail: 2_000, timestamps: true }));
  });
});
