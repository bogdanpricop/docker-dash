'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-fleet-'));
process.env.APP_SECRET = 'fleet-operations-test-secret';
process.env.ENCRYPTION_KEY = 'fleet-operations-test-key-32-chars';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

const { getDb, closeDb } = require('../db');
const dockerService = require('../services/docker');
const fleet = require('../services/fleet-operations');

const HOST_A = 6301;
const HOST_B = 6302;
const HOST_K8S = 6303;

beforeAll(() => {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO docker_hosts
      (id, name, connection_type, host, port, daemon_type, is_active, conn_state)
    VALUES (?, ?, 'tcp', '127.0.0.1', ?, ?, 1, ?)
  `);
  insert.run(HOST_A, 'Fleet A', 26301, 'docker', 'ok');
  insert.run(HOST_B, 'Fleet B', 26302, 'podman', 'unreachable');
  insert.run(HOST_K8S, 'Fleet K8s', 26303, 'kubernetes', 'ok');
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  closeDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe('fleet operation validation and preview', () => {
  it('rejects malformed, unknown, and incompatible targets', async () => {
    await expect(fleet.preview('remove', [HOST_A])).rejects.toThrow('restart or prune');
    await expect(fleet.preview('restart', ['6301x'])).rejects.toThrow('positive integer');
    await expect(fleet.preview('restart', [999999])).rejects.toThrow('do not exist');
    await expect(fleet.preview('restart', [HOST_K8S])).rejects.toThrow('not an active Docker/Podman');
  });

  it('previews restart without system, stopped, or self containers', async () => {
    jest.spyOn(dockerService, 'listContainers').mockResolvedValue([
      { id: 'a', name: 'api', state: 'running', isSelf: false },
      { id: 'b', name: 'docker-dash', state: 'running', isSelf: false },
      { id: 'c', name: 'worker', state: 'exited', isSelf: false },
      { id: 'd', name: 'self', state: 'running', isSelf: true },
    ]);
    const result = await fleet.preview('restart', [HOST_A]);
    expect(result.hosts[0]).toMatchObject({ status: 'ready', affected: 1, containers: ['api'] });
  });

  it('previews safe prune while preserving volumes', async () => {
    jest.spyOn(dockerService, 'listContainers').mockResolvedValue([
      { id: 'a', name: 'old', state: 'exited' },
    ]);
    jest.spyOn(dockerService, 'getDiskUsage').mockResolvedValue({ BuildCache: [{ Size: 2048 }] });
    const result = await fleet.preview('prune', [HOST_A]);
    expect(result.hosts[0].detail).toContain('volumes are preserved');
    expect(result.hosts[0].reclaimable_bytes).toBe(2048);
  });
});

describe('fleet execution and health history', () => {
  it('aggregates per-container restart failures without aborting the host', async () => {
    jest.spyOn(dockerService, 'listContainers').mockResolvedValue([
      { id: 'a', name: 'api', state: 'running', isSelf: false },
      { id: 'b', name: 'worker', state: 'running', isSelf: false },
    ]);
    jest.spyOn(dockerService, 'containerAction')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('restart failed'));
    const result = await fleet.run('restart', [HOST_A]);
    expect(result.status).toBe('partial');
    expect(result.hosts[0]).toMatchObject({ status: 'partial', affected: 1, failures: 1 });
  });

  it('runs prune with destructive volume removal disabled', async () => {
    const prune = jest.spyOn(dockerService, 'prune').mockResolvedValue({ SpaceReclaimed: 4096 });
    const result = await fleet.run('prune', [HOST_A]);
    expect(prune).toHaveBeenCalledWith({
      containers: true, images: true, networks: true, buildCache: true, volumes: false,
    }, HOST_A);
    expect(result.hosts[0].reclaimed_bytes).toBe(4096);
  });

  it('records five-minute fleet health snapshots and returns history', () => {
    jest.spyOn(dockerService, 'getHostStatus').mockImplementation(hostId => ({
      healthy: hostId === HOST_A ? true : false,
    }));
    const result = fleet.fleetHealth(24);
    // The initial migration seeds the default local Docker host as well.
    expect(result.current).toEqual({ total_hosts: 3, connected: 1, degraded: 0, disconnected: 2 });
    expect(result.history).toHaveLength(1);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM fleet_health_snapshots').get().count).toBe(1);
  });
});
