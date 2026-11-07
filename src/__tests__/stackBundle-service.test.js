'use strict';

/**
 * Tests for src/services/stackBundle.js — the portable stack/container bundle
 * exporter and importer that backs the v8.2.0 weekly stack archive job
 * (pCloud). Added during the post-v8.2.x audit as a gap closure: stackBundle
 * is the single code path responsible for serialising a running compose stack
 * (or a single container) into a JSON document the dashboard can later pull
 * images for, recreate volumes for, and re-instantiate on any host — and
 * before this file landed it had ZERO unit coverage. A regression here
 * silently corrupts every weekly snapshot.
 *
 * Strategy:
 *   - dockerode is mocked through services/docker.getDocker — every container,
 *     volume, network, image, and pull call is a jest.fn() so we can assert
 *     both the call shape and the data flow.
 *   - Compose export exercises managed and unmanaged files on disk.
 *   - APP_SECRET / ENCRYPTION_KEY / DB_PATH are set BEFORE require so the
 *     logger and any transitive db init don't blow up.
 *
 * Coverage target: ≥15 cases across exportStack, exportContainer,
 * importBundle, and generateCompose — matching the actual exported API on
 * src/services/stackBundle.js (NOT a hypothetical one).
 */

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// ─── Mock services/docker.getDocker ────────────────────────────────────────
const mockDocker = {
  listContainers: jest.fn(),
  getContainer: jest.fn(),
  createContainer: jest.fn(),
  createVolume: jest.fn(),
  pull: jest.fn(),
  modem: { followProgress: jest.fn() },
};

jest.mock('../services/docker', () => ({
  getDocker: jest.fn(() => mockDocker),
}));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-bundle-test-'));
const managed = path.join(fixture, 'managed');
const compose = path.join(managed, 'compose.yml');
const outside = path.join(fixture, 'outside.yml');
process.env.DD_STACKS_DIR = managed;
beforeAll(() => {
  fs.mkdirSync(managed);
  fs.writeFileSync(compose, 'services:\n  web:\n    image: nginx:1.27\n');
  fs.writeFileSync(outside, 'private fixture');
});
afterAll(() => {
  fs.unlinkSync(outside);
  fs.unlinkSync(compose);
  fs.rmdirSync(managed);
  fs.rmdirSync(fixture);
});
const dockerService = require('../services/docker');
const stackBundle = require('../services/stackBundle');

// ─── Helpers ──────────────────────────────────────────────────────────────
function makeListEntry(overrides = {}) {
  return {
    Id: 'cid-1',
    Names: ['/web'],
    Labels: {
      'com.docker.compose.project': 'demo',
      'com.docker.compose.service': 'web',
      'com.docker.compose.project.working_dir': '/srv/demo',
      'com.docker.compose.project.config_files': '/srv/demo/docker-compose.yml',
    },
    ...overrides,
  };
}

function makeInspect(overrides = {}) {
  return {
    Name: '/web',
    Config: {
      Image: 'nginx:1.27',
      Env: ['FOO=bar', 'PASSWORD=hunter2', 'API_TOKEN=abcdef', 'PRIVATE_KEY=xxx'],
      Cmd: ['nginx', '-g', 'daemon off;'],
      Entrypoint: null,
      WorkingDir: '/usr/share/nginx',
      Hostname: 'web-host',
      User: '',
      ExposedPorts: { '80/tcp': {} },
      Labels: {
        'com.docker.compose.service': 'web',
        'com.docker.compose.project': 'demo',
        'app.label.team': 'platform',
      },
      Healthcheck: {
        Test: ['CMD', 'curl', '-f', 'http://localhost/'],
        Interval: 30000000000,
        Retries: 3,
      },
    },
    Mounts: [
      { Type: 'volume', Name: 'demo_data', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/srv/demo/etc', Destination: '/etc/app', RW: false },
    ],
    NetworkSettings: {
      Networks: { 'demo_default': {}, 'bridge': {} },
      Ports: {
        '80/tcp': [{ HostPort: '8080', HostIp: '0.0.0.0' }],
      },
    },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: 268435456,
      CpuShares: 512,
    },
    State: { Status: 'running' },
    ...overrides,
  };
}

function makeContainerInstance(idSuffix = 'new') {
  return {
    id: `created-${idSuffix}`,
    start: jest.fn().mockResolvedValue(undefined),
    inspect: jest.fn(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────
describe('StackBundleService (src/services/stackBundle.js)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dockerService.getDocker.mockReturnValue(mockDocker);
  });

  // 1. exportStack: bundle envelope shape
  test('exportStack() returns bundle with correct envelope (format, version, exportedAt, exportedFrom)', async () => {
    mockDocker.listContainers.mockResolvedValue([makeListEntry()]);
    mockDocker.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue(makeInspect()) });

    const bundle = await stackBundle.exportStack('demo', 0);

    expect(bundle.format).toBe('docker-dash-stack-bundle');
    expect(bundle.version).toBe(2);
    expect(typeof bundle.exportedAt).toBe('string');
    expect(() => new Date(bundle.exportedAt).toISOString()).not.toThrow();
    expect(bundle.exportedFrom).toEqual({ hostId: 0, stackName: 'demo' });
    expect(Array.isArray(bundle.containers)).toBe(true);
    expect(Array.isArray(bundle.volumes)).toBe(true);
    expect(Array.isArray(bundle.networks)).toBe(true);
    expect(Array.isArray(bundle.images)).toBe(true);
    expect(bundle.metadata.containerCount).toBe(1);
  });

  // 2. exportStack: filters by compose project label, picks only matching containers
  test('exportStack() filters containers by compose project label', async () => {
    mockDocker.listContainers.mockResolvedValue([
      makeListEntry({ Id: 'a', Labels: { 'com.docker.compose.project': 'demo' } }),
      makeListEntry({ Id: 'b', Labels: { 'com.docker.compose.project': 'other' } }),
      makeListEntry({ Id: 'c', Labels: {} }),
    ]);
    mockDocker.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue(makeInspect()) });

    const bundle = await stackBundle.exportStack('demo', 0);

    expect(bundle.containers).toHaveLength(1);
    expect(mockDocker.getContainer).toHaveBeenCalledTimes(1);
    expect(mockDocker.getContainer).toHaveBeenCalledWith('a');
  });

  // 3. exportStack: throws when no containers match (404-equivalent)
  test('exportStack() throws when no containers match the stack name', async () => {
    mockDocker.listContainers.mockResolvedValue([
      makeListEntry({ Labels: { 'com.docker.compose.project': 'something-else' } }),
    ]);

    await expect(stackBundle.exportStack('missing-stack', 0))
      .rejects.toThrow(/No containers found for stack "missing-stack"/);
  });

  // 4. exportStack: includes compose YAML when working_dir + config_files label present
  test('exportStack() inlines composeYaml when compose project labels present', async () => {
    const entry = makeListEntry();
    entry.Labels['com.docker.compose.project.working_dir'] = managed;
    entry.Labels['com.docker.compose.project.config_files'] = compose;
    mockDocker.listContainers.mockResolvedValue([entry]);
    mockDocker.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue(makeInspect()) });

    const bundle = await stackBundle.exportStack('demo', 0);

    expect(bundle.stack.workingDir).toBe(managed);
    expect(bundle.stack.composeYaml).toContain('services:');
    entry.Labels['com.docker.compose.project.config_files'] = outside;
    expect((await stackBundle.exportStack('demo')).stack.composeYaml).toBeNull();
  });

  // 5. exportStack: composeYaml is null when compose file not on disk
  test('exportStack() leaves composeYaml null when working_dir absent or file missing', async () => {
    mockDocker.listContainers.mockResolvedValue([
      makeListEntry({ Labels: { 'com.docker.compose.project': 'demo' } }),
    ]);
    mockDocker.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue(makeInspect()) });

    const bundle = await stackBundle.exportStack('demo', 0);

    expect(bundle.stack.composeYaml).toBeNull();
  });

  // 6. exportStack: env vars are preserved verbatim (no in-place redaction).
  // NOTE: The current implementation does NOT redact secrets from env (PASSWORD/
  // TOKEN/KEY are passed through). This test pins that behaviour so a future
  // intentional change to add redaction will fail loudly here and be reviewed.
  test('exportStack() preserves env vars verbatim (current contract — no redaction)', async () => {
    mockDocker.listContainers.mockResolvedValue([makeListEntry()]);
    mockDocker.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue(makeInspect()) });

    const bundle = await stackBundle.exportStack('demo', 0);
    const env = bundle.containers[0].env;

    expect(env).toEqual(expect.arrayContaining([
      'FOO=bar',
      'PASSWORD=hunter2',
      'API_TOKEN=abcdef',
      'PRIVATE_KEY=xxx',
    ]));
  });

  // 7. exportStack: collects volumes, networks, images, filters compose labels
  test('exportStack() collects volumes/networks/images and strips compose internal labels', async () => {
    mockDocker.listContainers.mockResolvedValue([makeListEntry()]);
    mockDocker.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue(makeInspect()) });

    const bundle = await stackBundle.exportStack('demo', 0);
    const c = bundle.containers[0];

    expect(bundle.volumes).toEqual(['demo_data']);
    expect(bundle.networks).toEqual(['demo_default']); // 'bridge' filtered
    expect(bundle.images).toEqual(['nginx:1.27']);
    expect(c.labels).toEqual({ 'app.label.team': 'platform' });
    expect(c.labels['com.docker.compose.service']).toBeUndefined();
    expect(c.portBindings).toEqual([
      { host: '8080', container: '80', protocol: 'tcp', ip: '0.0.0.0' },
    ]);
    expect(c.healthcheck).toBeTruthy();
    expect(c.restartPolicy).toBe('unless-stopped');
  });

  // 8. exportContainer: single-container bundle envelope
  test('exportContainer() returns a docker-dash-container-bundle for one container', async () => {
    mockDocker.getContainer.mockReturnValue({ inspect: jest.fn().mockResolvedValue(makeInspect()) });

    const bundle = await stackBundle.exportContainer('cid-1', 0);

    expect(bundle.format).toBe('docker-dash-container-bundle');
    expect(bundle.version).toBe(2);
    expect(bundle.exportedFrom).toEqual({ hostId: 0, containerName: 'web' });
    expect(bundle.containers).toHaveLength(1);
    expect(bundle.metadata.containerCount).toBe(1);
    expect(bundle.images).toEqual(['nginx:1.27']);
    expect(bundle.volumes).toEqual(['demo_data']); // bind mount filtered out
    expect(bundle.networks).toEqual(['demo_default']); // bridge filtered out
  });

  // 9. importBundle: rejects bundles missing the docker-dash- format prefix
  test('importBundle() rejects bundles without docker-dash- format prefix', async () => {
    const evil = { format: 'evilcorp-bundle', version: 2, containers: [] };
    await expect(stackBundle.importBundle(evil, 0)).rejects.toThrow(/Invalid bundle format/);

    const noFormat = { version: 2, containers: [] };
    await expect(stackBundle.importBundle(noFormat, 0)).rejects.toThrow(/Invalid bundle format/);
  });

  // 10. importBundle: autoStart=true creates AND starts containers
  test('importBundle() with autoStart=true starts each created container', async () => {
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(null, 'stream'));
    mockDocker.modem.followProgress.mockImplementation((_s, cb) => cb(null));
    mockDocker.createVolume.mockResolvedValue({});
    const created = makeContainerInstance('a');
    mockDocker.createContainer.mockResolvedValue(created);

    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      images: ['nginx:1.27'],
      volumes: ['demo_data'],
      containers: [{
        service: 'web', name: 'web', image: 'nginx:1.27',
        env: ['FOO=bar'], cmd: ['nginx'], volumes: [], portBindings: [],
        restartPolicy: 'always',
      }],
    };

    const result = await stackBundle.importBundle(bundle, 1, { autoStart: true });

    expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);
    expect(created.start).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.containers[0].started).toBe(true);
  });

  // 11. importBundle: autoStart=false creates but does NOT start
  test('importBundle() with autoStart=false skips container.start()', async () => {
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(null, 'stream'));
    mockDocker.modem.followProgress.mockImplementation((_s, cb) => cb(null));
    const created = makeContainerInstance('b');
    mockDocker.createContainer.mockResolvedValue(created);

    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      images: [],
      volumes: [],
      containers: [{ name: 'web', image: 'nginx:1.27', volumes: [], portBindings: [] }],
    };

    const result = await stackBundle.importBundle(bundle, 0, { autoStart: false });

    expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);
    expect(created.start).not.toHaveBeenCalled();
    expect(result.containers[0].started).toBe(false);
  });

  // 12. importBundle: prefixName prepends prefix on every container name
  test('importBundle() with prefixName prepends prefix to all container names', async () => {
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(null, 'stream'));
    mockDocker.modem.followProgress.mockImplementation((_s, cb) => cb(null));
    mockDocker.createContainer.mockImplementation(async () => makeContainerInstance());

    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      images: [],
      volumes: [],
      containers: [
        { name: 'web', image: 'nginx', volumes: [], portBindings: [] },
        { name: 'db', image: 'postgres', volumes: [], portBindings: [] },
      ],
    };

    await stackBundle.importBundle(bundle, 0, { autoStart: false, prefixName: 'staging' });

    const calls = mockDocker.createContainer.mock.calls.map(c => c[0].name);
    expect(calls).toEqual(['staging-web', 'staging-db']);
  });

  // 13. importBundle: reports succeeded vs failed counts
  test('importBundle() reports succeeded vs failed counts when some creates throw', async () => {
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(null, 'stream'));
    mockDocker.modem.followProgress.mockImplementation((_s, cb) => cb(null));
    mockDocker.createContainer
      .mockResolvedValueOnce(makeContainerInstance('ok'))
      .mockRejectedValueOnce(new Error('boom: image not found'))
      .mockResolvedValueOnce(makeContainerInstance('ok2'));

    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      images: [],
      volumes: [],
      containers: [
        { name: 'a', image: 'x', volumes: [], portBindings: [] },
        { name: 'b', image: 'y', volumes: [], portBindings: [] },
        { name: 'c', image: 'z', volumes: [], portBindings: [] },
      ],
    };

    const result = await stackBundle.importBundle(bundle, 0, { autoStart: false });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.containers.find(r => r.name === 'b').error).toMatch(/boom/);
    expect(result.ok).toBe(true);
  });

  // 14. importBundle: routes to correct host via destHostId
  test('importBundle() routes to the correct host via destHostId', async () => {
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(null, 'stream'));
    mockDocker.modem.followProgress.mockImplementation((_s, cb) => cb(null));
    mockDocker.createContainer.mockResolvedValue(makeContainerInstance('h'));

    const bundle = {
      format: 'docker-dash-container-bundle',
      version: 2,
      images: [],
      volumes: [],
      containers: [{ name: 'w', image: 'nginx', volumes: [], portBindings: [] }],
    };

    await stackBundle.importBundle(bundle, 7, { autoStart: false });

    expect(dockerService.getDocker).toHaveBeenCalledWith(7);
    const result2 = await stackBundle.importBundle(bundle, 0, { autoStart: false });
    expect(result2.destHostId).toBe(0);
  });

  // 15. importBundle: appends timestamp suffix when name collides on dest host
  test('importBundle() appends a unique suffix when destination already has the name', async () => {
    mockDocker.listContainers.mockResolvedValue([
      { Names: ['/web'] },
    ]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(null, 'stream'));
    mockDocker.modem.followProgress.mockImplementation((_s, cb) => cb(null));
    mockDocker.createContainer.mockResolvedValue(makeContainerInstance('s'));

    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      images: [],
      volumes: [],
      containers: [{ name: 'web', image: 'nginx', volumes: [], portBindings: [] }],
    };

    await stackBundle.importBundle(bundle, 0, { autoStart: false });

    const usedName = mockDocker.createContainer.mock.calls[0][0].name;
    expect(usedName).toMatch(/^web-[0-9a-z]+$/);
    expect(usedName).not.toBe('web');
  });

  // 16. importBundle: preserves restart policy + healthcheck on createContainer
  test('importBundle() preserves restart policy and healthcheck on createContainer', async () => {
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(null, 'stream'));
    mockDocker.modem.followProgress.mockImplementation((_s, cb) => cb(null));
    mockDocker.createContainer.mockResolvedValue(makeContainerInstance('hc'));

    const healthcheck = { Test: ['CMD', 'curl', '-f', '/'], Interval: 30000000000, Retries: 3 };
    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      images: [],
      volumes: [],
      containers: [{
        name: 'api',
        image: 'node:20',
        volumes: [],
        portBindings: [],
        restartPolicy: 'on-failure',
        healthcheck,
        memoryLimit: 512000000,
        cpuShares: 256,
      }],
    };

    await stackBundle.importBundle(bundle, 0, { autoStart: false });

    const opts = mockDocker.createContainer.mock.calls[0][0];
    expect(opts.HostConfig.RestartPolicy).toEqual({ Name: 'on-failure' });
    expect(opts.HostConfig.Memory).toBe(512000000);
    expect(opts.HostConfig.CpuShares).toBe(256);
    expect(opts.Healthcheck).toEqual(healthcheck);
    expect(opts.Labels['docker-dash.imported-at']).toBeDefined();
  });

  // 17. generateCompose: returns embedded YAML as-is when present
  test('generateCompose() returns bundle.stack.composeYaml verbatim if present', () => {
    const yaml = 'services:\n  web:\n    image: nginx\n';
    const out = stackBundle.generateCompose({ stack: { composeYaml: yaml }, containers: [] });
    expect(out).toBe(yaml);
  });

  // 18. generateCompose: synthesises YAML from containers when no composeYaml
  test('generateCompose() builds YAML from containers when composeYaml is missing', () => {
    const bundle = {
      containers: [{
        service: 'web',
        name: 'web',
        image: 'nginx:1.27',
        env: ['FOO=bar', 'INVALID_NO_EQ'],
        portBindings: [{ host: '8080', container: '80', protocol: 'tcp' }],
        volumes: [
          { type: 'volume', source: 'data', destination: '/data', readOnly: false },
          { type: 'bind', source: '/etc', destination: '/etc/app', readOnly: true },
        ],
        restartPolicy: 'unless-stopped',
      }],
      volumes: ['data'],
    };

    const yaml = stackBundle.generateCompose(bundle);

    expect(yaml).toContain('services:');
    expect(yaml).toContain('  web:');
    expect(yaml).toContain('image: nginx:1.27');
    expect(yaml).toContain('- FOO=bar');
    expect(yaml).not.toContain('INVALID_NO_EQ'); // skipped (no '=')
    expect(yaml).toContain('"8080:80/tcp"');
    expect(yaml).toContain('- data:/data');
    expect(yaml).toContain('- /etc:/etc/app:ro');
    expect(yaml).toContain('restart: unless-stopped');
    expect(yaml).toMatch(/volumes:\n {2}data:/);
  });

  // 19. generateCompose: 'no' restart policy is omitted from YAML
  test('generateCompose() omits restart policy when set to "no"', () => {
    const yaml = stackBundle.generateCompose({
      containers: [{
        service: 'svc', name: 'svc', image: 'alpine',
        env: [], portBindings: [], volumes: [], restartPolicy: 'no',
      }],
      volumes: [],
    });
    expect(yaml).not.toMatch(/restart:/);
  });

  // 20. importBundle: continues even when image pull fails (warning, not throw)
  test('importBundle() continues after image-pull failure (logs warning, still creates)', async () => {
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(new Error('pull denied')));
    mockDocker.createContainer.mockResolvedValue(makeContainerInstance('p'));

    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      images: ['nginx:1.27'],
      volumes: [],
      containers: [{ name: 'w', image: 'nginx:1.27', volumes: [], portBindings: [] }],
    };

    const result = await stackBundle.importBundle(bundle, 0, { autoStart: false });

    expect(result.succeeded).toBe(1);
    expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);
  });

  // 21. importBundle: invokes onProgress callback for each step
  test('importBundle() forwards progress updates to onProgress callback', async () => {
    mockDocker.listContainers.mockResolvedValue([]);
    mockDocker.pull.mockImplementation((_img, cb) => cb(null, 'stream'));
    mockDocker.modem.followProgress.mockImplementation((_s, cb) => cb(null));
    mockDocker.createVolume.mockResolvedValue({});
    mockDocker.createContainer.mockResolvedValue(makeContainerInstance('p2'));

    const onProgress = jest.fn();
    const bundle = {
      format: 'docker-dash-stack-bundle',
      version: 2,
      images: ['nginx:1.27'],
      volumes: ['vol1'],
      containers: [{ name: 'w', image: 'nginx:1.27', volumes: [], portBindings: [] }],
    };

    await stackBundle.importBundle(bundle, 0, { autoStart: false, onProgress });

    expect(onProgress).toHaveBeenCalled();
    const messages = onProgress.mock.calls.map(c => c[0]).join('\n');
    expect(messages).toMatch(/Pulling nginx:1.27/);
    expect(messages).toMatch(/Creating w/);
  });
});
