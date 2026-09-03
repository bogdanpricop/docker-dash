'use strict';

// v8.95.1 — per-stack permissions on container lifecycle routes.
//
// The regression: these routes read `inspect.Config?.Labels`, which is Docker's
// raw wire shape. `dockerService.inspectContainer` returns a NORMALIZED object
// exposing `labels`, so the optional chain always yielded undefined and every
// container resolved to the '_standalone' bucket. Per-stack permission grants
// were silently ignored for start/stop/restart/kill/pause/unpause and remove.
//
// Global admins were unaffected either way (getEffectiveRole returns early for
// them), so the fix only changes behaviour for non-admins holding an explicit
// grant — which is exactly the configuration that was being disregarded.

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 42, username: 'op', role: 'operator' }; next(); },
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
  filterContainers: v => v,
  getEffectiveRole: jest.fn(() => 'operate'),
  hasPermission: jest.fn(() => true),
}));
jest.mock('../services/docker', () => ({
  inspectContainer: jest.fn(),
  containerAction: jest.fn(async () => ({})),
  removeContainer: jest.fn(async () => ({})),
  getInfo: jest.fn(async () => ({})),
  listContainers: jest.fn(),
  getDocker: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const dockerService = require('../services/docker');
const permService = require('../services/permissions');

const app = express();
app.use(express.json());
app.use('/api/containers', require('../routes/containers'));

// The shape inspectContainer actually returns: `labels`, no `Config`.
const normalized = (labels) => ({
  id: 'abc', name: 'web', labels, mounts: [], isolation: { runtime: 'runc' },
});

beforeEach(() => jest.clearAllMocks());

describe('per-stack permissions — container action', () => {
  it('resolves the stack from the normalized labels, not the wire shape', async () => {
    dockerService.inspectContainer.mockResolvedValue(
      normalized({ 'com.docker.compose.project': 'blog' })
    );

    await request(app).post('/api/containers/abc/stop').send();

    expect(permService.getEffectiveRole).toHaveBeenCalledWith(42, 'blog', 'operator');
    expect(permService.getEffectiveRole).not.toHaveBeenCalledWith(42, '_standalone', 'operator');
  });

  it('falls back to _standalone for a container that belongs to no stack', async () => {
    dockerService.inspectContainer.mockResolvedValue(normalized({}));
    await request(app).post('/api/containers/abc/restart').send();
    expect(permService.getEffectiveRole).toHaveBeenCalledWith(42, '_standalone', 'operator');
  });

  it('denies the action when the stack role lacks the permission', async () => {
    dockerService.inspectContainer.mockResolvedValue(
      normalized({ 'com.docker.compose.project': 'blog' })
    );
    permService.hasPermission.mockReturnValue(false);

    const res = await request(app).post('/api/containers/abc/stop').send();
    expect(res.status).toBe(403);
    expect(dockerService.containerAction).not.toHaveBeenCalled();
  });
});

describe('per-stack permissions — container remove', () => {
  it('resolves the stack from the normalized labels', async () => {
    dockerService.inspectContainer.mockResolvedValue(
      normalized({ 'com.docker.compose.project': 'shop' })
    );

    await request(app).delete('/api/containers/abc');

    expect(permService.getEffectiveRole).toHaveBeenCalledWith(42, 'shop', 'operator');
  });

  it('denies removal when the stack role lacks admin on that stack', async () => {
    dockerService.inspectContainer.mockResolvedValue(
      normalized({ 'com.docker.compose.project': 'shop' })
    );
    permService.hasPermission.mockReturnValue(false);

    const res = await request(app).delete('/api/containers/abc');
    expect(res.status).toBe(403);
    expect(dockerService.removeContainer).not.toHaveBeenCalled();
  });
});
