'use strict';

// Tests for the deploy-to-swarm bridges (v deploy-to-swarm):
//   (a) container → swarm service derivation + the derive route
//       (RBAC / validation / swarm precondition).
//   The derivation is a pure function so most assertions need no Docker.
//   The route tests mock dockerService.getDocker().

process.env.APP_SECRET = 'test-secret-swarm-bridge';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'SwarmBridge123!';
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';

// Mock the docker service BEFORE requiring the router so the route picks up
// the stub. Each test sets getDocker's return value.
jest.mock('../services/docker', () => ({
  getDocker: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const dockerService = require('../services/docker');
const { deriveServiceSpecFromInspect, sanitizeName, mapRestartPolicy } = require('../services/swarm-derive');

// ── Shared inspect fixture ──────────────────────────────────────
function mockInspect(overrides = {}) {
  return Object.assign({
    Name: '/my-app',
    Config: {
      Image: 'nginx:1.25',
      Env: ['FOO=bar', 'BAZ=qux'],
      Cmd: ['nginx', '-g', 'daemon off;'],
      Entrypoint: null,
      Tty: false,
      OpenStdin: false,
      Labels: {
        'com.docker.compose.project': 'demo',
        'com.docker.compose.service': 'web',
        'com.docker.stack.namespace': 'legacy',
        'com.example.team': 'payments',
      },
    },
    HostConfig: {
      PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      Binds: ['/srv/data:/data'],
      NetworkMode: 'bridge',
    },
    Mounts: [{ Type: 'bind', Source: '/srv/data', Destination: '/data', RW: true }],
    NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } },
  }, overrides);
}

// ════════════════════════════════════════════════════════════════
// 1. Pure derivation
// ════════════════════════════════════════════════════════════════
describe('deriveServiceSpecFromInspect', () => {
  it('derives the core service fields from a container inspect', () => {
    const { spec } = deriveServiceSpecFromInspect(mockInspect());
    expect(spec.name).toBe('my-app');
    expect(spec.image).toBe('nginx:1.25');
    expect(spec.env).toEqual(['FOO=bar', 'BAZ=qux']);
    expect(spec.command).toEqual(['nginx', '-g', 'daemon off;']);
    expect(spec.replicas).toBe(1);
    expect(spec.ports).toEqual([{ published: 8080, target: 80, protocol: 'tcp' }]);
    expect(spec.restartPolicy).toEqual({ condition: 'any' });
  });

  it('strips docker-compose / docker-stack internal labels, keeps user labels', () => {
    const { spec } = deriveServiceSpecFromInspect(mockInspect());
    expect(spec.labels).toEqual({ 'com.example.team': 'payments' });
    expect(Object.keys(spec.labels).some(k => k.startsWith('com.docker.compose.'))).toBe(false);
    expect(Object.keys(spec.labels).some(k => k.startsWith('com.docker.stack.'))).toBe(false);
  });

  it('warns about bind mounts (paths must exist on all nodes)', () => {
    const { warnings } = deriveServiceSpecFromInspect(mockInspect());
    const w = warnings.find(x => /bind mounts/i.test(x));
    expect(w).toBeTruthy();
    expect(w).toContain('/srv/data');
    expect(w).toMatch(/all/i);
  });

  it('warns that published ports become ingress / routing mesh', () => {
    const { warnings } = deriveServiceSpecFromInspect(mockInspect());
    expect(warnings.some(x => /ingress|routing mesh/i.test(x))).toBe(true);
  });

  it('warns about interactive tty / stdin containers', () => {
    const inspect = mockInspect();
    inspect.Config.Tty = true;
    inspect.Config.OpenStdin = true;
    const { warnings } = deriveServiceSpecFromInspect(inspect);
    expect(warnings.some(x => /interactive/i.test(x))).toBe(true);
  });

  it('warns about network_mode host, privileged, devices and links', () => {
    const inspect = mockInspect();
    inspect.HostConfig.NetworkMode = 'host';
    inspect.HostConfig.Privileged = true;
    inspect.HostConfig.Devices = [{ PathOnHost: '/dev/snd' }];
    inspect.HostConfig.Links = ['db:db'];
    const { warnings } = deriveServiceSpecFromInspect(inspect);
    expect(warnings.some(x => /network_mode/i.test(x))).toBe(true);
    expect(warnings.some(x => /privileged/i.test(x))).toBe(true);
    expect(warnings.some(x => /device/i.test(x))).toBe(true);
    expect(warnings.some(x => /link/i.test(x))).toBe(true);
  });

  it('notes an ENTRYPOINT override in warnings', () => {
    const inspect = mockInspect();
    inspect.Config.Entrypoint = ['/entry.sh'];
    const { warnings } = deriveServiceSpecFromInspect(inspect);
    expect(warnings.some(x => /entrypoint/i.test(x))).toBe(true);
  });

  it('leaves command null when the container has no CMD', () => {
    const inspect = mockInspect();
    inspect.Config.Cmd = null;
    const { spec } = deriveServiceSpecFromInspect(inspect);
    expect(spec.command).toBeNull();
  });

  it('throws on a non-object inspect', () => {
    expect(() => deriveServiceSpecFromInspect(null)).toThrow();
  });
});

describe('sanitizeName / mapRestartPolicy helpers', () => {
  it('sanitizes container names into valid service names', () => {
    expect(sanitizeName('/My App!')).toBe('My_App_');
    expect(sanitizeName('/1abc')).toBe('1abc');
    expect(sanitizeName('/.hidden')).toBe('svc_.hidden');
    expect(sanitizeName('')).toBe('service');
  });
  it('maps docker restart policies to swarm conditions', () => {
    expect(mapRestartPolicy({ Name: 'always' })).toEqual({ condition: 'any' });
    expect(mapRestartPolicy({ Name: 'unless-stopped' })).toEqual({ condition: 'any' });
    expect(mapRestartPolicy({ Name: 'on-failure', MaximumRetryCount: 3 })).toEqual({ condition: 'on-failure', maxAttempts: 3 });
    expect(mapRestartPolicy({ Name: 'no' })).toEqual({ condition: 'none' });
    expect(mapRestartPolicy(undefined)).toEqual({ condition: 'none' });
  });
});

// ════════════════════════════════════════════════════════════════
// 2. Route: GET /api/swarm/services/from-container
// ════════════════════════════════════════════════════════════════
describe('GET /api/swarm/services/from-container', () => {
  let app, adminToken;

  beforeAll(async () => {
    const { getDb } = require('../db');
    getDb();
    const authService = require('../services/auth');
    authService.seedAdmin();
    require('./helpers/seedTestAdmin').clearMustChange('admin');

    app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(cookieParser());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/swarm', require('../routes/swarm'));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'SwarmBridge123!' });
    adminToken = res.body.token;
  });

  afterAll(() => {
    const { closeDb } = require('../db');
    closeDb();
  });

  beforeEach(() => {
    dockerService.getDocker.mockReset();
  });

  it('rejects unauthenticated callers (401)', async () => {
    await request(app).get('/api/swarm/services/from-container?containerId=abc').expect(401);
  });

  it('returns 400 when containerId is missing', async () => {
    const res = await request(app)
      .get('/api/swarm/services/from-container')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/containerId/i);
  });

  it('returns a humanized error when the host is not a swarm manager', async () => {
    dockerService.getDocker.mockReturnValue({
      info: async () => ({ Swarm: { LocalNodeState: 'inactive' } }),
      getContainer: () => ({ inspect: async () => mockInspect() }),
    });
    const res = await request(app)
      .get('/api/swarm/services/from-container?containerId=abc')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    // humanizeDockerError maps "not a swarm manager" to a friendly sentence.
    expect(res.body.error).toMatch(/swarm manager/i);
    expect(res.body.error).not.toMatch(/HTTP code/i);
  });

  it('derives + returns { spec, warnings } for a container on an active manager', async () => {
    dockerService.getDocker.mockReturnValue({
      info: async () => ({ Swarm: { LocalNodeState: 'active', ControlAvailable: true } }),
      getContainer: (id) => ({ inspect: async () => { expect(id).toBe('abc123'); return mockInspect(); } }),
    });
    const res = await request(app)
      .get('/api/swarm/services/from-container?containerId=abc123')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.spec).toBeTruthy();
    expect(res.body.spec.image).toBe('nginx:1.25');
    expect(res.body.spec.name).toBe('my-app');
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.warnings.length).toBeGreaterThan(0);
    // internal compose/stack labels are not leaked into the derived spec
    expect(res.body.spec.labels).toEqual({ 'com.example.team': 'payments' });
  });

  it('surfaces a 404 when the container no longer exists', async () => {
    const notFound = new Error('no such container: abc');
    notFound.statusCode = 404;
    dockerService.getDocker.mockReturnValue({
      info: async () => ({ Swarm: { LocalNodeState: 'active', ControlAvailable: true } }),
      getContainer: () => ({ inspect: async () => { throw notFound; } }),
    });
    const res = await request(app)
      .get('/api/swarm/services/from-container?containerId=abc')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});
