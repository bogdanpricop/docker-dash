'use strict';

/**
 * Tests for src/services/docker.js — the dashboard's core integration with the
 * Docker daemon (dockerode). Added during the post-v8.2.0 audit as a gap closure:
 * docker.js orchestrates every container/image/volume/network call the dashboard
 * makes, drives the multi-host registry (socket / TCP / SSH), and is the single
 * place where a regression silently breaks the entire UI. Until now it had ZERO
 * unit coverage — every change shipped on hope.
 *
 * Strategy:
 *   - dockerode is mocked entirely at the module level (no real daemon).
 *   - The DB is :memory: so multi-host tests can write/read real rows through
 *     the same code path the production service uses.
 *   - Each docker method on the mocked client is a jest.fn(), so we can assert
 *     both that the right method was called AND that arguments match.
 *
 * Coverage target: ≥15 cases across listing, parsing, actions, host management,
 * connection routing, and timeout handling.
 */

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// ─── Mock dockerode at module level ───────────────────────────────────────
// Each test gets a fresh mock instance (see beforeEach below). The factory
// returns a constructor whose calls are tracked, so we can assert the correct
// connection options were used.
const mockDockerInstance = {
  listContainers: jest.fn(),
  listImages: jest.fn(),
  listVolumes: jest.fn(),
  listNetworks: jest.fn(),
  getContainer: jest.fn(),
  getImage: jest.fn(),
  getVolume: jest.fn(),
  getNetwork: jest.fn(),
  info: jest.fn(),
  version: jest.fn(),
  ping: jest.fn(),
  df: jest.fn(),
};

const dockerCtorCalls = [];
jest.mock('dockerode', () => {
  return jest.fn().mockImplementation((opts) => {
    dockerCtorCalls.push(opts);
    return mockDockerInstance;
  });
});

// Mock the SSH tunnel service so we don't try to open real connections.
jest.mock('../services/ssh-tunnel', () => ({
  getTunnel: jest.fn(),
  createTunnel: jest.fn().mockResolvedValue({ localPort: 22222 }),
}), { virtual: false });

describe('DockerService (src/services/docker.js)', () => {
  let dockerService;
  let db;

  beforeAll(() => {
    const { getDb } = require('../db');
    db = getDb();
    dockerService = require('../services/docker');
  });

  afterAll(() => {
    const { closeDb } = require('../db');
    try { closeDb(); } catch { /* ignore */ }
  });

  beforeEach(() => {
    // Reset mock state on dockerode methods between tests
    Object.values(mockDockerInstance).forEach((fn) => {
      if (typeof fn === 'function' && fn.mockReset) fn.mockReset();
    });
    dockerCtorCalls.length = 0;
    // Drop all cached connections so each test rebuilds from scratch
    if (dockerService.connections) dockerService.connections.clear();
  });

  // ─── listContainers ────────────────────────────────────────────────────

  it('listContainers returns parsed list with normalized fields', async () => {
    mockDockerInstance.listContainers.mockResolvedValue([
      {
        Id: 'abc123def4567890aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        Names: ['/web'],
        Image: 'nginx:latest',
        ImageID: 'sha256:1234567890abcdef',
        State: 'running',
        Status: 'Up 10 minutes',
        Created: 1700000000,
        Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }],
        NetworkSettings: { Networks: { bridge: {} } },
        Mounts: [{ Type: 'volume', Source: '/data', Destination: '/var/lib/data', RW: true }],
        Labels: { 'com.docker.compose.project': 'mystack', foo: 'bar' },
      },
    ]);

    const result = await dockerService.listContainers();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'web',
      image: 'nginx:latest',
      state: 'running',
      stack: 'mystack',
      hostId: 0,
    });
    expect(result[0].shortId).toHaveLength(12);
    expect(result[0].ports[0]).toEqual({ private: 80, public: 8080, type: 'tcp', ip: '0.0.0.0' });
    expect(result[0].networks).toEqual(['bridge']);
    expect(result[0].labels.foo).toBe('bar');
  });

  it('listContainers handles empty list (returns [])', async () => {
    mockDockerInstance.listContainers.mockResolvedValue([]);
    const result = await dockerService.listContainers();
    expect(result).toEqual([]);
  });

  it('listContainers propagates errors (rejects, does not swallow)', async () => {
    mockDockerInstance.listContainers.mockRejectedValue(new Error('Docker daemon offline'));
    await expect(dockerService.listContainers()).rejects.toThrow('Docker daemon offline');
  });

  // ─── containerAction ───────────────────────────────────────────────────

  it.each([
    ['start',   'start'],
    ['stop',    'stop'],
    ['restart', 'restart'],
    ['pause',   'pause'],
    ['unpause', 'unpause'],
    ['kill',    'kill'],
  ])('containerAction(%s) calls correct dockerode method', async (action, method) => {
    const containerMethods = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      restart: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn().mockResolvedValue(undefined),
      unpause: jest.fn().mockResolvedValue(undefined),
      kill: jest.fn().mockResolvedValue(undefined),
    };
    mockDockerInstance.getContainer.mockReturnValue(containerMethods);

    await dockerService.containerAction('cid', action);

    expect(mockDockerInstance.getContainer).toHaveBeenCalledWith('cid');
    expect(containerMethods[method]).toHaveBeenCalledTimes(1);
  });

  it('containerAction with invalid action rejects', async () => {
    mockDockerInstance.getContainer.mockReturnValue({});
    await expect(dockerService.containerAction('cid', 'nuke')).rejects.toThrow(/Unknown action/);
  });

  // ─── inspectContainer ──────────────────────────────────────────────────

  it('inspectContainer returns parsed inspect data', async () => {
    mockDockerInstance.getContainer.mockReturnValue({
      inspect: jest.fn().mockResolvedValue({
        Id: 'fullid123',
        Name: '/myweb',
        Config: { Image: 'nginx', Env: ['PATH=/usr/bin'], Cmd: ['nginx'], Labels: { a: '1' } },
        Created: '2026-01-01T00:00:00Z',
        State: { Status: 'running', Health: null },
        RestartCount: 0,
        Platform: 'linux',
        NetworkSettings: { Ports: {}, Networks: {} },
        Mounts: [],
        SizeRw: 1024,
        SizeRootFs: 2048,
        HostConfig: { Memory: 1000000, RestartPolicy: { Name: 'always' } },
      }),
    });

    const data = await dockerService.inspectContainer('fullid123');
    expect(data.name).toBe('myweb');
    expect(data.image).toBe('nginx');
    expect(data.env).toEqual(['PATH=/usr/bin']);
    expect(data.labels).toEqual({ a: '1' });
    expect(data.sizeRw).toBe(1024);
    expect(data.resources.memory).toBe(1000000);
    expect(data.restartPolicy).toEqual({ Name: 'always' });
  });

  // ─── listImages ────────────────────────────────────────────────────────

  it('listImages returns parsed list', async () => {
    mockDockerInstance.listImages.mockResolvedValue([
      {
        Id: 'sha256:abcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        RepoTags: ['nginx:1.25'],
        RepoDigests: [],
        Size: 50000000,
        VirtualSize: 50000000,
        Created: 1700000000,
        Labels: { foo: 'bar' },
        Containers: 2,
      },
    ]);
    const images = await dockerService.listImages();
    expect(images).toHaveLength(1);
    expect(images[0].repoTags).toEqual(['nginx:1.25']);
    expect(images[0].shortId).toBe('abcdef012345');
    expect(images[0].size).toBe(50000000);
    expect(images[0].containers).toBe(2);
    expect(images[0].hostId).toBe(0);
  });

  // ─── listVolumes ───────────────────────────────────────────────────────

  it('listVolumes returns parsed list', async () => {
    mockDockerInstance.listVolumes.mockResolvedValue({
      Volumes: [
        {
          Name: 'pgdata',
          Driver: 'local',
          Mountpoint: '/var/lib/docker/volumes/pgdata/_data',
          Scope: 'local',
          Labels: { app: 'db' },
          Options: {},
          CreatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockDockerInstance.df.mockResolvedValue({
      Volumes: [{ Name: 'pgdata', UsageData: { Size: 12345 } }],
    });

    const vols = await dockerService.listVolumes();
    expect(vols).toHaveLength(1);
    expect(vols[0].name).toBe('pgdata');
    expect(vols[0].driver).toBe('local');
    expect(vols[0].size).toBe(12345);
    expect(vols[0].labels.app).toBe('db');
  });

  it('listVolumes tolerates df() failure (size = -1)', async () => {
    mockDockerInstance.listVolumes.mockResolvedValue({
      Volumes: [{ Name: 'cache', Driver: 'local', Scope: 'local' }],
    });
    mockDockerInstance.df.mockRejectedValue(new Error('df not supported'));

    const vols = await dockerService.listVolumes();
    expect(vols[0].size).toBe(-1);
  });

  // ─── listNetworks ──────────────────────────────────────────────────────

  it('listNetworks returns parsed list with subnet + containers', async () => {
    mockDockerInstance.listNetworks.mockResolvedValue([
      {
        Id: 'net0123456789abcdef',
        Name: 'bridge',
        Driver: 'bridge',
        Scope: 'local',
        Internal: false,
        IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] },
        Labels: {},
        Created: '2026-01-01T00:00:00Z',
      },
    ]);
    mockDockerInstance.getNetwork.mockReturnValue({
      inspect: jest.fn().mockResolvedValue({ Containers: { abc: { Name: 'web' } } }),
    });

    const nets = await dockerService.listNetworks();
    expect(nets).toHaveLength(1);
    expect(nets[0].name).toBe('bridge');
    expect(nets[0].subnet).toBe('172.17.0.0/16');
    expect(nets[0].containers).toEqual({ abc: { Name: 'web' } });
  });

  // ─── getActiveHosts ────────────────────────────────────────────────────

  it('getActiveHosts returns the seeded Local host (single-host default)', () => {
    // Migration 006 seeds a single 'Local' row with id=1, is_default=1, is_active=1
    const hosts = dockerService.getActiveHosts();
    expect(Array.isArray(hosts)).toBe(true);
    expect(hosts.length).toBeGreaterThanOrEqual(1);
    const local = hosts.find(h => h.name === 'Local');
    expect(local).toBeDefined();
    expect(local.connectionType).toBe('socket');
  });

  it('getActiveHosts returns multiple hosts and applies _parseHostRow to each', () => {
    db.prepare(`
      INSERT INTO docker_hosts (name, connection_type, host, port, is_active, is_default)
      VALUES ('Remote-1', 'tcp', '10.0.0.5', 2376, 1, 0)
    `).run();

    const hosts = dockerService.getActiveHosts();
    const remote = hosts.find(h => h.name === 'Remote-1');
    expect(remote).toBeDefined();
    expect(remote.connectionType).toBe('tcp');
    expect(remote.host).toBe('10.0.0.5');
    expect(remote.port).toBe(2376);
    // _parseHostRow normalizes snake_case → camelCase
    expect(remote.isActive).toBe(1);
  });

  // ─── dropConnection ────────────────────────────────────────────────────

  it('dropConnection clears the cache for a hostId', () => {
    // Force a connection to be cached
    dockerService.getDocker(0);
    expect(dockerService.connections.has(0)).toBe(true);

    dockerService.dropConnection(0);
    expect(dockerService.connections.has(0)).toBe(false);
  });

  // ─── testConnection ────────────────────────────────────────────────────

  it('testConnection succeeds within timeout', async () => {
    mockDockerInstance.info.mockResolvedValue({
      Name: 'docker-host',
      ServerVersion: '24.0.6',
      OperatingSystem: 'Ubuntu 22.04',
      Architecture: 'x86_64',
      Containers: 5,
      Images: 12,
      NCPU: 4,
      MemTotal: 8000000000,
    });

    const res = await dockerService.testConnection({
      connectionType: 'socket',
      socketPath: '/var/run/docker.sock',
    });
    expect(res.ok).toBe(true);
    expect(res.hostname).toBe('docker-host');
    expect(res.dockerVersion).toBe('24.0.6');
    expect(res.cpus).toBe(4);
  });

  it('testConnection rejects on timeout (10s simulated)', async () => {
    jest.useFakeTimers();
    mockDockerInstance.info.mockImplementation(() => new Promise(() => { /* never resolves */ }));

    const promise = dockerService.testConnection({
      connectionType: 'socket',
      socketPath: '/var/run/docker.sock',
    });

    // Advance past the 10s timeout
    jest.advanceTimersByTime(10001);

    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timeout/i);
    jest.useRealTimers();
  });

  // ─── _createConnection routing ─────────────────────────────────────────

  it('_createConnection routes "socket" to socketPath with the request timeout (v8.7.12)', () => {
    dockerService._createConnection({
      connectionType: 'socket',
      socketPath: '/custom/docker.sock',
    });
    const last = dockerCtorCalls[dockerCtorCalls.length - 1];
    expect(last.socketPath).toBe('/custom/docker.sock');
    // v8.7.12 — all three connection types now pass the same dockerode
    // request-timeout (was previously TCP-only); a hung remote daemon used
    // to freeze SSH-tunneled and socket connections forever.
    expect(last.timeout).toBe(30_000);
  });

  it('_createConnection applies the timeout consistently across connection types (v8.7.12)', () => {
    // tcp
    dockerService._createConnection({ connectionType: 'tcp', host: '10.0.0.1', port: 2376, tlsConfig: { ca: 'X', cert: 'X', key: 'X' } });
    expect(dockerCtorCalls[dockerCtorCalls.length - 1].timeout).toBe(30_000);
    // socket (default fallback path)
    dockerService._createConnection({ connectionType: 'unknown-or-missing' });
    expect(dockerCtorCalls[dockerCtorCalls.length - 1].timeout).toBe(30_000);
  });

  it('_createConnection routes "tcp" with TLS config to https', () => {
    dockerService._createConnection({
      connectionType: 'tcp',
      host: '192.168.1.10',
      port: 2376,
      tlsConfig: { ca: 'CA', cert: 'CERT', key: 'KEY' },
    });
    const last = dockerCtorCalls[dockerCtorCalls.length - 1];
    expect(last.host).toBe('192.168.1.10');
    expect(last.port).toBe(2376);
    expect(last.protocol).toBe('https');
    expect(last.ca).toBe('CA');
  });

  it('_createConnection routes plain TCP on 2375 to http (Docker Desktop mode)', () => {
    dockerService._createConnection({
      connectionType: 'tcp',
      host: '127.0.0.1',
      port: 2375,
    });
    const last = dockerCtorCalls[dockerCtorCalls.length - 1];
    expect(last.host).toBe('127.0.0.1');
    expect(last.port).toBe(2375);
    expect(last.protocol).toBe('http');
  });

  it('_createConnection "ssh" without an existing tunnel throws (and triggers async tunnel creation)', () => {
    // ssh-tunnel is mocked; getTunnel returns undefined → service throws
    expect(() => dockerService._createConnection({
      connectionType: 'ssh',
      id: 999,
      name: 'remote-ssh',
      sshConfig: { host: 'h', user: 'u' },
    })).toThrow(/SSH tunnel.*starting/);
  });

  // v8.7.44 — Podman detection contract.
  describe('_detectDaemonType (Podman certification)', () => {
    // dockerService is set in the outer beforeAll(); read the helper lazily
    // inside each it() so the module-load order doesn't matter.
    const detect = (v) => dockerService._daemon._detectDaemonType(v);

    it('returns "podman" when Components has a Name containing "Podman"', () => {
      const version = {
        Platform: { Name: '' },
        Components: [
          { Name: 'Podman Engine', Version: '4.9.3', Details: {} },
        ],
      };
      expect(detect(version)).toBe('podman');
    });

    it('returns "podman" when case differs (matches case-insensitively)', () => {
      const version = { Components: [{ Name: 'PODMAN engine', Version: '5.0.0' }] };
      expect(detect(version)).toBe('podman');
    });

    it('returns "docker" for Docker CE Components shape', () => {
      const version = {
        Platform: { Name: 'Docker Engine - Community' },
        Components: [
          { Name: 'Engine', Version: '24.0.7' },
          { Name: 'containerd', Version: '1.7.11' },
          { Name: 'runc', Version: '1.1.11' },
        ],
      };
      expect(detect(version)).toBe('docker');
    });

    it('falls back to Platform.Name when Components is empty or missing', () => {
      expect(detect({ Platform: { Name: 'Podman' } })).toBe('podman');
      expect(detect({ Platform: { Name: 'Docker Engine' }, Components: [] })).toBe('docker');
    });

    it('returns "docker" for undefined / null / malformed input (never throws)', () => {
      expect(detect(undefined)).toBe('docker');
      expect(detect(null)).toBe('docker');
      expect(detect({})).toBe('docker');
      expect(detect({ Components: [null, {}, { Name: null }] })).toBe('docker');
    });
  });

  // v8.7.44 — capability matrix and daemon fields end-to-end in getInfo().
  describe('getInfo — daemon + capabilities (Podman certification)', () => {
    it('reports daemonType/daemonName + full capabilities on Docker', async () => {
      mockDockerInstance.info.mockResolvedValue({
        Name: 'host-1', OperatingSystem: 'Ubuntu 22.04',
        Architecture: 'x86_64', KernelVersion: '5.15',
        Containers: 3, ContainersRunning: 2, ContainersPaused: 0, ContainersStopped: 1,
        Images: 5, MemTotal: 8589934592, NCPU: 4,
        Driver: 'overlay2', DockerRootDir: '/var/lib/docker',
      });
      mockDockerInstance.version.mockResolvedValue({
        Version: '24.0.7', ApiVersion: '1.43',
        Platform: { Name: 'Docker Engine - Community' },
        Components: [{ Name: 'Engine', Version: '24.0.7' }],
      });
      const info = await dockerService.getInfo(0);
      expect(info.daemonType).toBe('docker');
      expect(info.daemonName).toBe('Docker Engine');
      expect(info.capabilities).toEqual({
        containers: true, images: true, networks: true, volumes: true,
        compose: true, swarm: true, buildkit: true, plugins: true,
      });
    });

    it('reports daemonType=podman and gates swarm/buildkit/plugins off on Podman', async () => {
      mockDockerInstance.info.mockResolvedValue({
        Name: 'pod-host', OperatingSystem: 'Fedora Linux',
        Architecture: 'x86_64', KernelVersion: '6.6',
        Containers: 1, ContainersRunning: 1, ContainersPaused: 0, ContainersStopped: 0,
        Images: 2, MemTotal: 4294967296, NCPU: 2,
        Driver: 'overlay', DockerRootDir: '/var/lib/containers/storage',
      });
      mockDockerInstance.version.mockResolvedValue({
        Version: '4.9.3', ApiVersion: '1.40',
        Platform: { Name: '' },
        Components: [{ Name: 'Podman Engine', Version: '4.9.3' }],
      });
      const info = await dockerService.getInfo(0);
      expect(info.daemonType).toBe('podman');
      expect(info.daemonName).toBe('Podman');
      // These MUST be gated off — Podman doesn't have Swarm, plugins, or
      // Docker BuildKit endpoints. If the frontend surfaces these menu
      // items on a Podman host the user gets confusing 404s.
      expect(info.capabilities.swarm).toBe(false);
      expect(info.capabilities.buildkit).toBe(false);
      expect(info.capabilities.plugins).toBe(false);
      // These remain available — Podman implements them.
      expect(info.capabilities.containers).toBe(true);
      expect(info.capabilities.images).toBe(true);
      expect(info.capabilities.networks).toBe(true);
      expect(info.capabilities.volumes).toBe(true);
      expect(info.capabilities.compose).toBe(true);
    });
  });
});
