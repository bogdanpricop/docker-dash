'use strict';

process.env.ENCRYPTION_KEY = 'provider-ha-readiness-test-key-32-chars';

jest.mock('../config', () => ({
  app: { env: 'test' },
  security: { encryptionKey: 'provider-ha-readiness-test-key-32-chars' },
  features: { providerHaReadiness: true },
  providerHaReadiness: { freshnessMs: 60_000, historyLimit: 12, endpointConcurrency: 2 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const haMigration = require('../db/migrations/115_provider_ha_readiness');
const readiness = require('../services/provider-sdk/ha-readiness');

const host = { id: 7, name: 'pve-a', daemon_type: 'proxmox', is_active: 1 };

function database() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT, daemon_type TEXT, is_active INTEGER);
    INSERT INTO docker_hosts VALUES (7, 'pve-a', 'proxmox', 1);`);
  identityMigration.up(db); haMigration.up(db);
  return db;
}

function evidence(overrides = {}) {
  return {
    provider: { type: 'proxmox', variant: 'pve' }, limitations: ['Memory is not full compatibility'],
    domains: [{
      nativeRef: 'cluster:prod', name: 'Production', configured: true,
      quorum: true, heartbeat: true, fencing: true, admissionControl: null,
      sharedStorageCount: 1, nativePlanDepth: null, configuredFailureTolerance: 1, overcommitted: false,
      hosts: [
        { nativeRef: 'node-a', name: 'node-a', online: true, memoryBytes: 16e9, memoryFreeBytes: 8e9 },
        { nativeRef: 'node-b', name: 'node-b', online: true, memoryBytes: 16e9, memoryFreeBytes: 8e9 },
        { nativeRef: 'node-c', name: 'node-c', online: true, memoryBytes: 16e9, memoryFreeBytes: 8e9 },
      ],
      workloads: [
        { nativeRef: 'qemu/101', name: 'db-a', hostRef: 'node-a', poweredOn: true, protected: true, priority: 'highest', memoryBytes: 4e9 },
        { nativeRef: 'qemu/102', name: 'api-b', hostRef: 'node-b', poweredOn: true, protected: true, priority: 'medium', memoryBytes: 2e9 },
      ], warnings: [], ...overrides,
    }],
  };
}

const registry = {
  capabilitiesForHost: jest.fn(async () => ({ provider: { variant: 'pve' }, features: {
    'cluster.ha.read': { state: 'conditional', reason: 'Read-only HA evidence', constraints: { readOnly: true } },
  } })),
};

describe('provider HA readiness', () => {
  let db;
  beforeEach(() => { db = database(); registry.capabilitiesForHost.mockClear(); });
  afterEach(() => db.close());

  it('persists an encrypted deterministic ready snapshot and serves a fresh cache hit', async () => {
    const collector = jest.fn(async () => evidence());
    const first = await readiness.captureForHost(host, { database: db, registry, collector, enabled: true });
    expect(first).toEqual(expect.objectContaining({
      schemaVersion: '1.0', state: 'ready', score: 100, domainCount: 1,
      snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(first.domains[0]).toEqual(expect.objectContaining({
      hostCount: 3, onlineHostCount: 3, poweredOnVmCount: 2, protectedVmCount: 2,
    }));
    expect(first.domains[0].scenarios.map(item => item.state)).toEqual(['pass', 'pass']);
    const stored = db.prepare('SELECT snapshot_enc FROM provider_ha_snapshots').get().snapshot_enc;
    expect(stored).not.toContain('cluster:prod');
    expect(stored).not.toContain('node-a');

    const cached = await readiness.getForHost(host, { database: db, registry, collector, enabled: true });
    expect(cached.cache).toEqual({ hit: true, stale: false });
    expect(collector).toHaveBeenCalledTimes(1);
    expect(readiness.historyForHost(7, { database: db, limit: 1 })[0]).toEqual(expect.objectContaining({
      state: 'ready', score: 100, domainCount: 1,
    }));
  });

  it('keeps not-configured, unknown and degraded evidence distinct', () => {
    const base = evidence().domains[0];
    const notConfigured = readiness._internals._snapshot(db, host,
      { provider: { variant: 'pve' }, domains: [{ ...base, configured: false }] }, { state: 'conditional' });
    expect(notConfigured.state).toBe('not_configured');

    const degraded = readiness._internals._snapshot(db, host,
      { provider: { variant: 'pve' }, domains: [{ ...base, workloads: [
        { ...base.workloads[0], protected: false }, base.workloads[1],
      ] }] }, { state: 'conditional' });
    expect(degraded.state).toBe('degraded');
    expect(degraded.domains[0].signals.find(item => item.key === 'workload.coverage').state).toBe('warning');

    const unknown = readiness._internals._snapshot(db, host,
      { provider: { variant: 'pve' }, domains: [{ ...base, fencing: null }] }, { state: 'conditional' });
    expect(unknown.state).toBe('unknown');
  });

  it('returns an opaque unsupported envelope without invoking the collector', async () => {
    const unsupportedRegistry = { capabilitiesForHost: jest.fn(async () => ({ provider: { variant: 'esxi' }, features: {
      'cluster.ha.read': { state: 'unsupported', reason: 'Standalone endpoint', constraints: {} },
    } })) };
    const collector = jest.fn();
    const snapshot = await readiness.captureForHost({ ...host, daemon_type: 'vsphere' }, {
      database: db, registry: unsupportedRegistry, collector, enabled: true,
    });
    expect(snapshot.state).toBe('unsupported');
    expect(snapshot.domains[0].id).toMatch(/^ddr_cluster_[a-f0-9]{26}$/);
    expect(JSON.stringify(snapshot)).not.toContain('endpoint:7:ha');
    expect(collector).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent refreshes and rejects unsafe history bounds', async () => {
    let release;
    const gate = new Promise(resolve => { release = () => resolve(evidence()); });
    const collector = jest.fn(() => gate);
    const first = readiness.captureForHost(host, { database: db, registry, collector, enabled: true });
    const second = readiness.captureForHost(host, { database: db, registry, collector, enabled: true });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(collector).toHaveBeenCalledTimes(1);
    expect(() => readiness.historyForHost(7, { database: db, limit: 13 })).toThrow(expect.objectContaining({ code: 'INVALID_HA_HISTORY_LIMIT' }));
  });

  it('returns encrypted stale evidence after a background refresh failure', async () => {
    const collector = jest.fn(async () => evidence());
    await readiness.captureForHost(host, { database: db, registry, collector, enabled: true });
    db.prepare("UPDATE provider_ha_snapshots SET observed_at = '2020-01-01T00:00:00.000Z'").run();
    collector.mockRejectedValueOnce(new Error('https://secret@provider.invalid failed'));
    const stale = await readiness.getForHost(host, {
      database: db, registry, collector, enabled: true, freshnessMs: 1,
    });
    expect(stale.cache).toEqual({ hit: true, stale: true, refreshError: 'Provider refresh failed' });
    expect(JSON.stringify(stale)).not.toContain('provider.invalid');
  });

  it('sanitizes live provider failures into a typed gateway error', async () => {
    const collector = jest.fn(async () => { throw new Error('https://root:secret@provider.invalid failed'); });
    await expect(readiness.captureForHost(host, { database: db, registry, collector, enabled: true }))
      .rejects.toMatchObject({
        name: 'HaReadinessError', code: 'HA_PROVIDER_READ_FAILED', status: 502,
        message: 'Provider HA evidence could not be read',
      });
  });

  it('retains the configured bounded history and isolates scheduled endpoint failures', async () => {
    const snapshot = readiness._internals._snapshot(db, host, evidence(), { state: 'conditional' });
    for (let index = 0; index < 13; index++) {
      readiness._internals._persist(db, host, {
        ...snapshot, observedAt: new Date(Date.UTC(2026, 0, 1, 0, index * 5)).toISOString(),
      });
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_ha_snapshots').get().count).toBe(12);

    db.prepare("INSERT INTO docker_hosts VALUES (8, 'pve-b', 'proxmox', 1)").run();
    const collector = jest.fn(async endpoint => {
      if (endpoint.id === 8) throw new Error('offline');
      return evidence();
    });
    await expect(readiness.captureAll({ database: db, registry, collector, enabled: true }))
      .resolves.toEqual({ attempted: 2, captured: 1, failed: 1 });
  });

  it('retries only bounded SQLite busy failures', () => {
    const busy = Object.assign(new Error('locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
    const write = jest.fn().mockImplementationOnce(() => { throw busy; }).mockReturnValue('saved');
    expect(readiness._internals._retrySqliteBusy(write)).toBe('saved');
    expect(write).toHaveBeenCalledTimes(2);
    const constraint = Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT' });
    expect(() => readiness._internals._retrySqliteBusy(() => { throw constraint; })).toThrow(constraint);
  });
});
