'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-stack-routes-'));
const stacksRoot = path.join(sandbox, 'stacks');
fs.mkdirSync(stacksRoot);

process.env.APP_SECRET = 'filesystem-stack-route-test';
process.env.ENCRYPTION_KEY = 'filesystem-stack-route-key-32chars';
process.env.DB_PATH = ':memory:';
process.env.DD_STACKS_DIR = stacksRoot;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 9, username: 'admin', role: 'admin' };
    next();
  },
  requireRole: () => (_req, _res, next) => next(),
  writeable: (_req, _res, next) => next(),
}));
jest.mock('../services/docker', () => ({
  listContainers: jest.fn(async () => []),
  listImages: jest.fn(async () => []),
  getDocker: jest.fn(),
}));
jest.mock('../services/compose-runner', () => ({
  runCompose: jest.fn(async () => ({
    stdout: '', stderr: '', output: '', exitCode: 0, durationMs: 4,
  })),
  auditTail: jest.fn(() => ''),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/git', () => ({
  _dockerCliEnvForHost: jest.fn(() => ({ env: {}, cleanup: jest.fn() })),
}));

const express = require('express');
const request = require('supertest');
const composeRunner = require('../services/compose-runner');
const stacksFs = require('../services/stacks-fs');
const dockerService = require('../services/docker');

const app = express();
app.use(express.json());
app.use('/api/system', require('../routes/system-stacks'));

describe('filesystem-backed stack routes', () => {
  beforeAll(() => {
    const offline = path.join(stacksRoot, 'offline');
    fs.mkdirSync(offline);
    fs.writeFileSync(path.join(offline, 'compose.yml'), [
      'services:',
      '  web:',
      '    image: nginx:alpine',
    ].join('\n'));
  });

  beforeEach(() => {
    dockerService.listContainers.mockReset().mockResolvedValue([]);
    dockerService.listImages.mockReset().mockResolvedValue([]);
  });

  afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  test('lists and opens a stack with no containers', async () => {
    const list = await request(app).get('/api/system/stacks').expect(200);
    expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'offline', source: 'filesystem', diskOnly: true,
      running: 0, total: 0, services: ['web'],
    })]));

    const detail = await request(app).get('/api/system/stacks/offline').expect(200);
    expect(detail.body).toEqual(expect.objectContaining({
      name: 'offline', source: 'filesystem', diskOnly: true,
      services: ['web'], status: 'stopped',
    }));
    expect(detail.body.config).toContain('nginx:alpine');
  });

  test('opens a running stack with deduplicated image and container sizes', async () => {
    const imageId = 'sha256:shared-image';
    const workingDir = path.join(stacksRoot, 'measured');
    dockerService.listContainers.mockResolvedValue([
      {
        id: 'container-a', name: 'web-a', state: 'running', image: 'demo/web:1',
        imageIdFull: imageId, sizeRw: 10, sizeRootFs: 1010, stack: 'measured',
        labels: {
          'com.docker.compose.project': 'measured',
          'com.docker.compose.project.working_dir': workingDir,
        },
      },
      {
        id: 'container-b', name: 'web-b', state: 'running', image: 'demo/web:1',
        imageIdFull: imageId, sizeRw: 20, sizeRootFs: 1020, stack: 'measured',
        labels: {
          'com.docker.compose.project': 'measured',
          'com.docker.compose.project.working_dir': workingDir,
        },
      },
    ]);
    dockerService.listImages.mockResolvedValue([
      { id: imageId, repoTags: ['demo/web:1'], size: 1000 },
    ]);

    const detail = await request(app).get('/api/system/stacks/measured').expect(200);

    expect(dockerService.listContainers).toHaveBeenCalledWith(0, { includeSize: true });
    expect(detail.body.storage).toEqual(expect.objectContaining({
      available: true,
      uniqueImages: 1,
      measuredImages: 1,
      measuredContainers: 2,
      imageBytes: 1000,
      writableBytes: 30,
      rootFsBytes: 2030,
      approximateFootprintBytes: 1030,
      imageMeasurementComplete: true,
      containerMeasurementComplete: true,
      excludes: ['volumes', 'logs', 'build_cache'],
    }));
    expect(detail.body.containers).toEqual([
      expect.objectContaining({ imageSizeBytes: 1000, writableSizeBytes: 10, rootFsSizeBytes: 1010 }),
      expect.objectContaining({ imageSizeBytes: 1000, writableSizeBytes: 20, rootFsSizeBytes: 1020 }),
    ]);
  });

  test('runs Compose Up from the discovered working directory', async () => {
    await request(app).post('/api/system/compose/offline/up').send({}).expect(200);
    expect(composeRunner.runCompose).toHaveBeenCalledWith(['up', '-d'], expect.objectContaining({
      cwd: stacksFs._canonical(path.join(stacksRoot, 'offline')),
    }));
  });

  test('creates a config under the default root and rejects paths outside it', async () => {
    const created = await request(app).put('/api/system/stacks/new-stack/config')
      .send({ config: 'services:\n  db:\n    image: postgres:16\n' }).expect(200);
    expect(created.body.workingDir).toBe(stacksFs._canonical(path.join(stacksRoot, 'new-stack')));
    expect(fs.existsSync(path.join(created.body.workingDir, 'docker-compose.yml'))).toBe(true);

    await request(app).put('/api/system/stacks/escape/config').send({
      config: 'services: {}',
      workingDir: path.join(sandbox, 'outside'),
    }).expect(400);
  });
});
