'use strict';

process.env.APP_SECRET = 'system-stacks-stream-test-secret';
process.env.ENCRYPTION_KEY = 'system-stacks-stream-key-32-chars';
process.env.DB_PATH = ':memory:';

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-test-user-id']) return res.status(401).json({ error: 'Authentication required' });
    req.user = {
      id: Number(req.headers['x-test-user-id']),
      username: req.headers['x-test-username'] || 'compose-user',
      role: req.headers['x-test-role'] || 'operator',
    };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'Insufficient permissions' }),
  writeable: (_req, _res, next) => next(),
}));

jest.mock('../services/docker', () => ({
  listContainers: jest.fn(),
  getDocker: jest.fn(),
}));
jest.mock('../services/compose-runner', () => ({
  runCompose: jest.fn(),
  auditTail: jest.fn(result => result?.output || result?.stderr || ''),
  parseComposePlan: jest.fn(() => ({
    steps: [{ kind: 'container', operation: 'start', resource: 'demo-web-1', text: 'Starting', status: 'planned' }],
    summary: { start: 1 }, rawOutput: 'demo-web-1 Starting', truncated: false,
  })),
}));
jest.mock('../services/stacks-fs', () => ({
  discover: jest.fn(() => []),
  _isInsideRoots: jest.fn(() => true),
  COMPOSE_FILES: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));

const mockCliCleanup = jest.fn();
jest.mock('../services/git', () => ({
  _dockerCliEnvForHost: jest.fn(() => ({ env: { DD_TEST_DOCKER_ENV: '1' }, cleanup: mockCliCleanup })),
}));

const express = require('express');
const request = require('supertest');
const dockerService = require('../services/docker');
const composeRunner = require('../services/compose-runner');
const stacksFs = require('../services/stacks-fs');
const audit = require('../services/audit');

const app = express();
app.use(express.json());
app.use('/api/system', require('../routes/system-stacks'));

const auth = (id = 51, role = 'operator') => ({
  'x-test-user-id': String(id), 'x-test-role': role, 'x-test-username': `compose-${id}`,
});

function runningStack() {
  dockerService.listContainers.mockResolvedValue([{
    id: 'container-1', stack: 'demo',
    labels: { 'com.docker.compose.project': 'demo' },
  }]);
  dockerService.getDocker.mockReturnValue({
    getContainer: () => ({
      inspect: async () => ({
        Config: { Labels: { 'com.docker.compose.project.working_dir': '/srv/demo' } },
      }),
    }),
  });
}

describe('Compose action streaming API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stacksFs.discover.mockReturnValue([]);
    runningStack();
    composeRunner.runCompose.mockImplementation(async (_args, options) => {
      options.onOutput?.({ stream: 'stdout', data: 'Creating demo\n', truncated: false });
      return {
        stdout: 'Creating demo\n', stderr: '', output: 'Creating demo\n',
        exitCode: 0, durationMs: 12, truncated: false,
      };
    });
  });

  it('requires authentication and an operating role', async () => {
    await request(app).post('/api/system/compose/demo/up/stream').expect(401);
    await request(app).post('/api/system/compose/demo/up/stream')
      .set(auth(52, 'viewer')).expect(403);
  });

  it('streams start, output, and completion events and audits the result', async () => {
    const response = await request(app).post('/api/system/compose/demo/up/stream')
      .set(auth()).send({}).expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('event: start');
    expect(response.text).toContain('event: output');
    expect(response.text).toContain('Creating demo');
    expect(response.text).toContain('event: done');
    expect(composeRunner.runCompose).toHaveBeenCalledWith(['up', '-d'], expect.objectContaining({
      cwd: '/srv/demo', env: { DD_TEST_DOCKER_ENV: '1' },
    }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'compose_up' }));
    expect(mockCliCleanup).toHaveBeenCalledTimes(1);
  });

  it('returns a read-only deployment plan before an action', async () => {
    const response = await request(app).post('/api/system/compose/demo/up/plan')
      .set(auth()).send({}).expect(200);
    expect(composeRunner.runCompose).toHaveBeenCalledWith(
      ['--progress', 'json', '--dry-run', 'up', '-d'],
      expect.objectContaining({ cwd: '/srv/demo', maxBytes: 1024 * 1024 })
    );
    expect(response.body).toMatchObject({
      ok: true, stack: 'demo', action: 'up', summary: { start: 1 },
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'compose_up_plan' }));
    expect(mockCliCleanup).toHaveBeenCalledTimes(1);
  });

  it('reports unsupported dry-run capability without executing the real action', async () => {
    composeRunner.runCompose.mockRejectedValueOnce(Object.assign(new Error('unsupported'), {
      stderr: 'unknown flag: --dry-run', output: 'unknown flag: --dry-run',
    }));
    const response = await request(app).post('/api/system/compose/demo/pull/plan')
      .set(auth(88)).send({}).expect(501);
    expect(response.body.code).toBe('compose_dry_run_unsupported');
    expect(composeRunner.runCompose).toHaveBeenCalledTimes(1);
    expect(composeRunner.runCompose).not.toHaveBeenCalledWith(['pull'], expect.anything());
  });

  it('keeps the legacy JSON endpoint non-blocking and reports failures', async () => {
    composeRunner.runCompose.mockRejectedValue(Object.assign(new Error('compose failed'), {
      stderr: 'registry unavailable', output: 'registry unavailable', exitCode: 17, durationMs: 8,
    }));
    const response = await request(app).post('/api/system/compose/demo/pull')
      .set(auth()).send({}).expect(500);
    expect(response.body.error).toBe('registry unavailable');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'compose_pull' }));
    expect(mockCliCleanup).toHaveBeenCalledTimes(1);
  });

  it('can bring up a filesystem-discovered stack with no running containers', async () => {
    dockerService.listContainers.mockResolvedValue([]);
    stacksFs.discover.mockReturnValue([{ name: 'offline', path: '/opt/stacks/offline' }]);
    await request(app).post('/api/system/compose/offline/up')
      .set(auth()).send({}).expect(200);
    expect(composeRunner.runCompose).toHaveBeenCalledWith(['up', '-d'], expect.objectContaining({
      cwd: '/opt/stacks/offline',
    }));
  });

  it('lists and opens a filesystem-discovered stack with no running containers', async () => {
    dockerService.listContainers.mockResolvedValue([]);
    stacksFs.discover.mockReturnValue([{
      name: 'offline', path: '/opt/stacks/offline',
      composeFile: '/opt/stacks/offline/compose.yml',
      services: ['web', 'worker'], serviceCount: 2,
    }]);

    const list = await request(app).get('/api/system/stacks').set(auth()).expect(200);
    expect(list.body).toEqual([expect.objectContaining({
      name: 'offline', status: 'stopped', diskOnly: true,
      services: ['web', 'worker'], serviceCount: 2,
    })]);

    const detail = await request(app).get('/api/system/stacks/offline').set(auth()).expect(200);
    expect(detail.body).toMatchObject({
      name: 'offline', source: 'filesystem', status: 'stopped', diskOnly: true,
      services: ['web', 'worker'], serviceCount: 2,
    });
  });

  it('limits each user to three concurrent Compose operations', async () => {
    const resolvers = [];
    composeRunner.runCompose.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    const pending = [0, 1, 2].map(() => request(app)
      .post('/api/system/compose/demo/up').set(auth(77)).send({}).then(response => response));

    for (let attempt = 0; attempt < 20 && resolvers.length < 3; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(resolvers).toHaveLength(3);
    await request(app).post('/api/system/compose/demo/up')
      .set(auth(77)).send({}).expect(429);

    for (const resolve of resolvers) {
      resolve({ stdout: '', stderr: '', output: '', exitCode: 0, durationMs: 1 });
    }
    const responses = await Promise.all(pending);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
  });
});
