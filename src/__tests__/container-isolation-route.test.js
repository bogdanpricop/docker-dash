'use strict';

// v8.94.0 — GET /api/containers/:id/isolation.
//
// Follows the container-multi-logs.test.js harness. The error mapping is the
// reason this file exists: a smoke test against a running server showed the
// endpoint answering 500 with a generic "Internal server error" for a container
// that does not exist, which reads as "Docker Dash is broken" rather than
// "that container is gone". These pin the corrected mapping.

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 3, username: 'viewer', role: 'viewer' };
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
  inspectContainer: jest.fn(),
  getInfo: jest.fn(),
  listContainers: jest.fn(),
  getDocker: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const dockerService = require('../services/docker');

const app = express();
app.use(express.json());
app.use('/api/containers', require('../routes/containers'));

const get = (id = 'abc123') => request(app).get(`/api/containers/${id}/isolation`);

beforeEach(() => jest.clearAllMocks());

describe('GET /:id/isolation — assessment', () => {
  it('reports a shared-kernel container with reach as actionable when a sandbox exists', async () => {
    dockerService.inspectContainer.mockResolvedValue({
      isolation: { runtime: 'runc', privileged: true }, mounts: [],
    });
    dockerService.getInfo.mockResolvedValue({
      defaultRuntime: 'runc', runtimeCategories: { standard: ['runc'], sandboxed: ['runsc'], wasm: [] },
    });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runtime: 'runc', sandboxed: false, sandboxAvailable: true, actionable: true, severity: 'critical',
    });
    expect(res.body.signals.map(s => s.id)).toEqual(['privileged']);
  });

  it('resolves an empty container runtime to the daemon default', async () => {
    dockerService.inspectContainer.mockResolvedValue({ isolation: { runtime: '' }, mounts: [] });
    dockerService.getInfo.mockResolvedValue({
      defaultRuntime: 'crun', runtimeCategories: { standard: ['crun'], sandboxed: [], wasm: [] },
    });
    expect((await get()).body.runtime).toBe('crun');
  });

  it('degrades rather than failing when daemon info is unavailable', async () => {
    // The runtime list is best-effort: without it we can still report the
    // container's own runtime and reach, just not whether a sandbox exists.
    dockerService.inspectContainer.mockResolvedValue({
      isolation: { runtime: 'runc', networkMode: 'host' }, mounts: [],
    });
    dockerService.getInfo.mockRejectedValue(new Error('daemon unreachable'));

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.sandboxAvailable).toBe(false);
    expect(res.body.actionable).toBe(false);
    expect(res.body.signals).toHaveLength(1);
  });
});

describe('GET /:id/isolation — error mapping', () => {
  it('maps a missing container to 404, not 500', async () => {
    const err = new Error('no such container: abc123');
    err.statusCode = 404;
    dockerService.inspectContainer.mockRejectedValue(err);

    const res = await get();
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('no such container');
  });

  it('surfaces the real cause on a daemon failure instead of a generic message', async () => {
    dockerService.inspectContainer.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));

    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('connect ENOENT /var/run/docker.sock');
    expect(res.body.error).not.toBe('Internal server error');
  });
});
