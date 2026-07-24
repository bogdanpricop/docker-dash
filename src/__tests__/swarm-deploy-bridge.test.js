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
const { deriveServiceSpecFromInspect, sanitizeName, mapRestartPolicy, deriveComposeFromStackServices } = require('../services/swarm-derive');

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

  // ── List routes must humanize daemon errors, not leak a raw 503 ──
  // Regression: the Stacks tab hit GET /stacks on a host that isn't a swarm
  // manager; listServices threw the daemon's "not a swarm manager" (HTTP 503)
  // and, with no try/catch, it bubbled up as a generic 503 "Internal server
  // error". The list routes now catch and return a humanized 400.
  it('GET /stacks returns a humanized 400 (not a raw 503) when host is not a swarm manager', async () => {
    const notManager = new Error('(HTTP code 503) service unavailable - This node is not a swarm manager. Use "docker swarm init" or "docker swarm join" to connect this node to swarm and try again. ');
    notManager.statusCode = 503;
    dockerService.getDocker.mockReturnValue({
      listServices: async () => { throw notManager; },
      listTasks: async () => [],
    });
    const res = await request(app)
      .get('/api/swarm/stacks')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/swarm manager/i);
    expect(res.body.error).not.toMatch(/HTTP code/i);
  });

  it.each([
    ['/api/swarm/services', 'listServices'],
    ['/api/swarm/nodes', 'listNodes'],
    ['/api/swarm/tasks', 'listTasks'],
  ])('GET %s humanizes daemon errors instead of leaking a 503', async (path, method) => {
    const notManager = new Error('This node is not a swarm manager.');
    notManager.statusCode = 503;
    dockerService.getDocker.mockReturnValue({
      [method]: async () => { throw notManager; },
    });
    const res = await request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/swarm manager/i);
    expect(res.body.error).not.toMatch(/HTTP code/i);
  });

  // ── Stack → compose export (v8.21.0) ──
  it('GET /stacks/:name/compose exports a compose YAML for the stack', async () => {
    dockerService.getDocker.mockReturnValue({
      listServices: async () => [{
        ID: 'a',
        Spec: {
          Name: 'demo_web',
          Labels: { 'com.docker.stack.namespace': 'demo' },
          TaskTemplate: { ContainerSpec: { Image: 'nginx:1.25', Env: ['K=V'] } },
          Mode: { Replicated: { Replicas: 2 } },
        },
        Endpoint: { Ports: [{ Protocol: 'tcp', PublishedPort: 8080, TargetPort: 80 }] },
      }],
    });
    const res = await request(app).get('/api/swarm/stacks/demo/compose').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('demo');
    expect(res.body.serviceCount).toBe(1);
    expect(res.body.compose).toMatch(/services:/);
    expect(res.body.compose).toMatch(/\bweb:/);      // stack prefix stripped
    expect(res.body.compose).toMatch(/nginx:1\.25/);
    expect(Array.isArray(res.body.notes)).toBe(true);
  });

  it('GET /stacks/:name/compose 404s when no services match the stack', async () => {
    dockerService.getDocker.mockReturnValue({ listServices: async () => [] });
    const res = await request(app).get('/api/swarm/stacks/ghost/compose').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('GET /stacks/:name/compose humanizes daemon errors (not a raw 503)', async () => {
    const e = new Error('This node is not a swarm manager.'); e.statusCode = 503;
    dockerService.getDocker.mockReturnValue({ listServices: async () => { throw e; } });
    const res = await request(app).get('/api/swarm/stacks/demo/compose').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/swarm manager/i);
  });

  it('GET /stacks/:name/compose rejects unauthenticated callers (401)', async () => {
    await request(app).get('/api/swarm/stacks/demo/compose').expect(401);
  });
});

// ════════════════════════════════════════════════════════════════
// 3. Pure reverse derivation: swarm stack → compose object
// ════════════════════════════════════════════════════════════════
describe('deriveComposeFromStackServices', () => {
  function mockSwarmService(over = {}) {
    return Object.assign({
      ID: 'svc1',
      Spec: {
        Name: 'demo_web',
        Labels: { 'com.docker.stack.namespace': 'demo', 'com.example.team': 'payments' },
        TaskTemplate: {
          ContainerSpec: {
            Image: 'nginx:1.25@sha256:' + 'a'.repeat(64),
            Args: ['nginx', '-g', 'daemon off;'],
            Env: ['FOO=bar'],
            Labels: { 'com.docker.stack.namespace': 'demo' },
          },
          RestartPolicy: { Condition: 'on-failure', Delay: 10e9, MaxAttempts: 3 },
          Placement: { Constraints: ['node.role==worker'] },
        },
        Mode: { Replicated: { Replicas: 3 } },
      },
      Endpoint: { Ports: [{ Protocol: 'tcp', PublishedPort: 8080, TargetPort: 80 }] },
    }, over);
  }

  it('reconstructs a compose object, stripping the stack prefix + image digest', () => {
    const { services, notes } = deriveComposeFromStackServices([mockSwarmService()], 'demo');
    expect(Object.keys(services)).toEqual(['web']);
    const web = services.web;
    expect(web.image).toBe('nginx:1.25');
    expect(web.command).toEqual(['nginx', '-g', 'daemon off;']);
    expect(web.environment).toEqual(['FOO=bar']);
    expect(web.ports).toEqual(['8080:80']);
    expect(web.labels).toEqual({ 'com.example.team': 'payments' });
    expect(web.deploy.replicas).toBe(3);
    expect(web.deploy.restart_policy).toEqual({ condition: 'on-failure', delay: '10s', max_attempts: 3 });
    expect(web.deploy.placement).toEqual({ constraints: ['node.role==worker'] });
    expect(notes).toEqual([]);
  });

  it('emits global mode without replicas', () => {
    const svc = mockSwarmService();
    svc.Spec.Mode = { Global: {} };
    const { services } = deriveComposeFromStackServices([svc], 'demo');
    expect(services.web.deploy.mode).toBe('global');
    expect(services.web.deploy.replicas).toBeUndefined();
  });

  it('omits restart_policy when it matches the deploy default (any / 5s / 0)', () => {
    const svc = mockSwarmService();
    svc.Spec.TaskTemplate.RestartPolicy = { Condition: 'any', Delay: 5e9, MaxAttempts: 0 };
    const { services } = deriveComposeFromStackServices([svc], 'demo');
    expect(services.web.deploy.restart_policy).toBeUndefined();
  });

  it('notes mounts / networks / secrets / configs / healthcheck (not round-tripped)', () => {
    const svc = mockSwarmService();
    svc.Spec.TaskTemplate.ContainerSpec.Mounts = [{ Type: 'volume', Source: 'data', Target: '/data' }];
    svc.Spec.TaskTemplate.Networks = [{ Target: 'netid' }];
    svc.Spec.TaskTemplate.ContainerSpec.Secrets = [{ SecretName: 's' }];
    svc.Spec.TaskTemplate.ContainerSpec.Configs = [{ ConfigName: 'c' }];
    svc.Spec.TaskTemplate.ContainerSpec.Healthcheck = { Test: ['CMD', 'x'] };
    const { notes } = deriveComposeFromStackServices([svc], 'demo');
    expect(notes.some(n => /mount/i.test(n))).toBe(true);
    expect(notes.some(n => /network/i.test(n))).toBe(true);
    expect(notes.some(n => /secret/i.test(n))).toBe(true);
    expect(notes.some(n => /config/i.test(n))).toBe(true);
    expect(notes.some(n => /healthcheck/i.test(n))).toBe(true);
  });

  it('falls back to Command when Args is absent; keeps full name when no stack prefix', () => {
    const svc = mockSwarmService();
    delete svc.Spec.TaskTemplate.ContainerSpec.Args;
    svc.Spec.TaskTemplate.ContainerSpec.Command = ['/entry.sh'];
    svc.Spec.Name = 'loner';
    const { services } = deriveComposeFromStackServices([svc], 'demo');
    expect(services.loner.command).toEqual(['/entry.sh']);
  });

  it('produces YAML-serializable output with a services map', () => {
    const YAML = require('yaml');
    const { services } = deriveComposeFromStackServices([mockSwarmService()], 'demo');
    const parsed = YAML.parse(YAML.stringify({ services }));
    expect(parsed.services.web.image).toBe('nginx:1.25');
    expect(parsed.services.web.ports).toEqual(['8080:80']);
  });

  it('throws on non-array input', () => {
    expect(() => deriveComposeFromStackServices(null, 'x')).toThrow();
  });
});
