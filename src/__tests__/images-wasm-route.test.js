'use strict';

// v8.95.0 — GET /api/images/:id/wasm.
//
// The point of this endpoint is to answer, before the operator runs anything,
// the question that `exec format error` answers badly: is this a Wasm image, and
// can this host run it? The distinction that matters most is between "no, this
// host has no Wasm runtime" and "we could not tell" — the second must never be
// reported as the first.

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'admin', role: 'admin' }; next(); },
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
jest.mock('../services/docker', () => ({
  inspectImage: jest.fn(),
  getInfo: jest.fn(),
  listImages: jest.fn(),
  getDocker: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const dockerService = require('../services/docker');

const app = express();
app.use(express.json());
app.use('/api/images', require('../routes/images'));

const get = (id = 'sha256:abc') => request(app).get(`/api/images/${encodeURIComponent(id)}/wasm`);

const wasmImage = { Os: 'wasi', Architecture: 'wasm' };
const linuxImage = { Os: 'linux', Architecture: 'amd64' };
const infoWith = (wasm) => ({ runtimeCategories: { standard: ['runc'], sandboxed: [], wasm } });

beforeEach(() => jest.clearAllMocks());

describe('GET /:id/wasm — identification', () => {
  it('identifies a wasi/wasm image', async () => {
    dockerService.inspectImage.mockResolvedValue(wasmImage);
    dockerService.getInfo.mockResolvedValue(infoWith(['io.containerd.wasmedge.v1']));

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isWasm: true, platform: 'wasi/wasm',
      hostHasWasmRuntime: true, wasmRuntimes: ['io.containerd.wasmedge.v1'],
    });
  });

  it('does not identify an ordinary linux image', async () => {
    dockerService.inspectImage.mockResolvedValue(linuxImage);
    dockerService.getInfo.mockResolvedValue(infoWith([]));
    const res = await get();
    expect(res.body).toMatchObject({ isWasm: false, platform: 'linux/amd64' });
  });

  it('is case-insensitive about the platform strings', async () => {
    dockerService.inspectImage.mockResolvedValue({ Os: 'WASI', Architecture: 'WASM' });
    dockerService.getInfo.mockResolvedValue(infoWith([]));
    expect((await get()).body.isWasm).toBe(true);
  });

  it('reports a null platform when the image declares neither', async () => {
    dockerService.inspectImage.mockResolvedValue({});
    dockerService.getInfo.mockResolvedValue(infoWith([]));
    const res = await get();
    expect(res.body).toMatchObject({ isWasm: false, platform: null });
  });
});

describe('GET /:id/wasm — compatibility', () => {
  it('reports a Wasm image on a host with no Wasm runtime as incompatible', async () => {
    dockerService.inspectImage.mockResolvedValue(wasmImage);
    dockerService.getInfo.mockResolvedValue(infoWith([]));
    const res = await get();
    expect(res.body).toMatchObject({ isWasm: true, hostHasWasmRuntime: false, wasmRuntimes: [] });
  });

  it('reports unknown, not incompatible, when host info cannot be read', async () => {
    // The distinction the UI depends on: it warns only on an explicit false.
    dockerService.inspectImage.mockResolvedValue(wasmImage);
    dockerService.getInfo.mockRejectedValue(new Error('daemon unreachable'));
    const res = await get();
    expect(res.body.isWasm).toBe(true);
    expect(res.body.hostHasWasmRuntime).toBeNull();
    expect(res.body.wasmRuntimes).toBeNull();
  });
});

describe('GET /:id/wasm — errors', () => {
  it('maps a missing image to 404', async () => {
    const err = new Error('no such image');
    err.statusCode = 404;
    dockerService.inspectImage.mockRejectedValue(err);
    const res = await get();
    expect(res.status).toBe(404);
  });

  it('surfaces the real cause on a daemon failure', async () => {
    dockerService.inspectImage.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('connect ENOENT /var/run/docker.sock');
  });

  it('does not call getInfo when the image cannot be inspected', async () => {
    dockerService.inspectImage.mockRejectedValue(new Error('boom'));
    await get();
    expect(dockerService.getInfo).not.toHaveBeenCalled();
  });
});
