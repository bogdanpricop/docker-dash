'use strict';

process.env.ENCRYPTION_KEY = 'provider-sdk-registry-test-key-32-chars';

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const snapshotMigration = require('../db/migrations/109_provider_resource_snapshots');
const artifactMigration = require('../db/migrations/112_provider_artifact_catalog');

const mockVersion = jest.fn();
const mockDestroy = jest.fn();
const mockListVMs = jest.fn();
const mockListArtifacts = jest.fn();
const mockVSphereLogin = jest.fn();
const mockVSphereInfo = jest.fn();
const mockXenInfo = jest.fn();
const mockXenCaps = jest.fn();

jest.mock('../services/proxmox', () => ({
  fromHostRow: () => ({ version: mockVersion, listVMs: mockListVMs, listArtifacts: mockListArtifacts, _agent: { destroy: mockDestroy } }),
}));
jest.mock('../services/vsphere', () => ({
  fromHostRow: () => ({
    login: mockVSphereLogin, retrieveServiceContent: mockVSphereInfo,
    _agent: { destroy: mockDestroy },
  }),
}));
jest.mock('../services/xen', () => ({
  clientForHost: () => ({ provider: 'xapi', info: mockXenInfo, capabilities: mockXenCaps }),
}));

const registry = require('../services/provider-sdk/registry');
const metrics = require('../services/metrics');

const pveHost = { id: 3, name: 'pve-a', daemon_type: 'proxmox', is_active: 1 };

describe('Provider SDK registry', () => {
  let database;
  beforeEach(() => {
    jest.clearAllMocks();
    registry._internals.clear();
    metrics._reset();
    mockVersion.mockResolvedValue({ version: '9.0', repoid: 'pve-manager' });
    mockListVMs.mockResolvedValue([]);
    mockListArtifacts.mockResolvedValue([]);
    mockVSphereLogin.mockResolvedValue({});
    mockVSphereInfo.mockResolvedValue({ productFullName: 'VMware vCenter Server 9.0', version: '9.0', apiVersion: '9.0' });
    mockXenCaps.mockReturnValue({
      vms: true, hosts: true, pools: true, storages: true, networks: true,
      tasks: true, snapshots: true, taskCleanup: true, vmActions: ['start', 'shutdown'],
    });
    mockXenInfo.mockResolvedValue({ product: 'XCP-ng', version: '8.3', apiVersion: 'xapi' });
    database = new Database(':memory:');
    database.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (3, 'pve-a')`);
    identityMigration.up(database);
    snapshotMigration.up(database);
    artifactMigration.up(database);
  });

  afterEach(() => database.close());

  it('probes and caches a provider envelope', async () => {
    const first = await registry.capabilitiesForHost(pveHost);
    const second = await registry.capabilitiesForHost(pveHost);
    expect(first.probe).toEqual(expect.objectContaining({ status: 'reachable', cached: false }));
    expect(first.provider).toEqual(expect.objectContaining({ type: 'proxmox', version: '9.0' }));
    expect(second.probe.cached).toBe(true);
    expect(mockVersion).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().providerCapabilityCacheTotal).toEqual(expect.objectContaining({ miss: 1, hit: 1 }));
  });

  it('deduplicates concurrent probes', async () => {
    let resolveVersion;
    mockVersion.mockReturnValue(new Promise(resolve => { resolveVersion = resolve; }));
    const a = registry.capabilitiesForHost(pveHost);
    const b = registry.capabilitiesForHost(pveHost);
    resolveVersion({ version: '9.1', repoid: 'pve' });
    const [first, second] = await Promise.all([a, b]);
    expect(first.provider.version).toBe('9.1');
    expect(second.provider.version).toBe('9.1');
    expect(mockVersion).toHaveBeenCalledTimes(1);
  });

  it('returns sanitized unreachable evidence without leaking provider errors', async () => {
    mockVersion.mockRejectedValue(new Error('connect https://root:secret-token@pve.internal failed'));
    const envelope = await registry.capabilitiesForHost(pveHost, { refresh: true });
    expect(envelope.probe.status).toBe('unreachable');
    expect(envelope.probe.error.message).toBe('Provider endpoint could not be reached');
    expect(JSON.stringify(envelope)).not.toContain('secret-token');
    expect(envelope.features['inventory.vm'].state).toBe('supported');
  });

  it('invalidates cached evidence', async () => {
    await registry.capabilitiesForHost(pveHost);
    registry.invalidateHost(pveHost.id);
    await registry.capabilitiesForHost(pveHost);
    expect(mockVersion).toHaveBeenCalledTimes(2);
  });

  it('rejects daemon types outside the registered v2 slice', async () => {
    await expect(registry.capabilitiesForHost({ id: 9, name: 'k8s', daemon_type: 'kubernetes' }))
      .rejects.toMatchObject({ code: 'PROVIDER_ADAPTER_UNAVAILABLE', status: 400 });
  });

  it('returns a bounded common resource inventory with opaque IDs', async () => {
    mockListVMs.mockResolvedValue([
      { vmid: 102, id: 'qemu/102', name: 'worker', status: 'stopped', maxcpu: 2, maxmem: 2048 },
      { vmid: 101, id: 'qemu/101', name: 'control', status: 'running', maxcpu: 4, maxmem: 4096 },
    ]);
    const envelope = await registry.resourcesForHost(pveHost, 'virtual-machines', { limit: 1, database });
    expect(envelope).toEqual(expect.objectContaining({
      schemaVersion: '1.0', kind: 'virtualMachine', count: 1, totalObserved: 2, truncated: true,
    }));
    expect(envelope.items[0].id).toMatch(/^ddr_vm_/);
    expect(JSON.stringify(envelope)).not.toContain('qemu/101');
    expect(database.prepare('SELECT COUNT(*) AS count FROM provider_resource_snapshots').get().count).toBe(1);
    expect(mockListVMs).toHaveBeenCalledTimes(1);
  });

  it('gates unsupported resource kinds before calling the provider', async () => {
    await expect(registry.resourcesForHost(pveHost, 'clusters', { database }))
      .rejects.toMatchObject({ code: 'PROVIDER_RESOURCE_UNAVAILABLE', status: 400 });
    expect(mockListVMs).not.toHaveBeenCalled();
  });

  it('returns a searchable artifact catalog without native references', async () => {
    mockListArtifacts.mockResolvedValue([
      { kind: 'iso', nativeRef: 'local:iso/debian.iso', name: 'Debian installer', storage: 'local', sizeBytes: 1024 },
      { kind: 'vmTemplate', nativeRef: 'qemu/9000', name: 'Ubuntu gold', cpuCount: 2 },
    ]);
    const envelope = await registry.artifactsForHost(pveHost, { query: 'debian', limit: 10, database });
    expect(envelope).toEqual(expect.objectContaining({ count: 1, totalObserved: 1, truncated: false }));
    expect(envelope.items[0]).toEqual(expect.objectContaining({ kind: 'iso', displayName: 'Debian installer' }));
    expect(envelope.items[0].id).toMatch(/^dda_art_/);
    expect(JSON.stringify(envelope)).not.toContain('local:iso');
    expect(database.prepare('SELECT COUNT(*) AS count FROM provider_artifact_catalog').get().count).toBe(2);
  });

  it('sanitizes provider read failures', async () => {
    mockListVMs.mockRejectedValue(new Error('https://root:secret@pve.internal failed'));
    await expect(registry.resourcesForHost(pveHost, 'virtual-machines', { database }))
      .rejects.toMatchObject({ message: 'Provider resource inventory could not be read', code: 'PROVIDER_RESOURCE_READ_FAILED', status: 502 });
  });

  it('validates kind and limit before probing', async () => {
    await expect(registry.resourcesForHost(pveHost, 'volumes', { database }))
      .rejects.toMatchObject({ code: 'INVALID_RESOURCE_KIND' });
    await expect(registry.resourcesForHost(pveHost, 'virtual-machines', { limit: 501, database }))
      .rejects.toMatchObject({ code: 'INVALID_RESOURCE_LIMIT' });
  });

  it('restarts a bounded artifact transaction after SQLITE_BUSY_SNAPSHOT', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
    const write = jest.fn().mockImplementationOnce(() => { throw busy; }).mockReturnValue(['saved']);
    expect(registry._internals._retrySqliteBusy(write)).toEqual(['saved']);
    expect(write).toHaveBeenCalledTimes(2);
    const constraint = Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    expect(() => registry._internals._retrySqliteBusy(() => { throw constraint; })).toThrow(constraint);
  });
});
