'use strict';

jest.mock('../config', () => ({ security: { encryptionKey: 'snapshot-risk-test-key-32-bytes' } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/snapshot-provider', () => ({}));

const Database = require('better-sqlite3');
const identitiesMigration = require('../db/migrations/106_provider_resource_identities');
const resourcesMigration = require('../db/migrations/109_provider_resource_snapshots');
const snapshotsMigration = require('../db/migrations/110_provider_vm_snapshots');
const riskMigration = require('../db/migrations/154_provider_snapshot_risk');
const identityStore = require('../services/provider-sdk/identity-store');
const snapshotStore = require('../services/provider-sdk/vm-snapshot-store');
const { SnapshotRiskService } = require('../services/provider-sdk/snapshot-risk');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    INSERT INTO users (id,username) VALUES (1,'admin');
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT, daemon_type TEXT, is_active INTEGER);
    INSERT INTO docker_hosts (id,name,daemon_type,is_active) VALUES
      (7,'vcenter-a','vsphere',1),(8,'pve-a','proxmox',1)`);
  identitiesMigration.up(db);
  resourcesMigration.up(db);
  snapshotsMigration.up(db);
  riskMigration.up(db);
  return db;
}

function rememberVm(db, { hostId = 7, providerType = 'vsphere', name = 'payments', consolidationNeeded = false } = {}) {
  const identity = identityStore.remember({
    hostId, providerType, kind: 'virtualMachine', uuid: `${providerType}-vm-${hostId}-${name}`,
    nativeRef: `native-${hostId}-${name}`, stability: 'stable',
  }, db);
  const resource = {
    schemaVersion: '1.0', id: identity.id, kind: 'virtualMachine', displayName: name,
    provider: { type: providerType, endpointId: hostId }, identity,
    spec: {}, status: { powerState: 'running' }, relationships: {}, labels: {}, actions: [],
    extensions: { consolidationNeeded }, observedAt: '2026-07-30T00:00:00.000Z',
  };
  db.prepare(`INSERT INTO provider_resource_snapshots
    (canonical_id,host_id,provider_type,resource_kind,display_name,power_state,resource_json,observed_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(identity.id, hostId, providerType, 'virtualMachine', name, 'running',
    JSON.stringify(resource), resource.observedAt);
  return identity;
}

function service(db, extras = {}) {
  return new SnapshotRiskService({ dbProvider: () => db, ...extras });
}

describe('provider stale snapshot growth monitor', () => {
  let db;
  beforeEach(() => { db = database(); });
  afterEach(() => db.close());

  test('assesses age, proven chain depth, reported bytes and consolidation evidence', () => {
    const vm = rememberVm(db, { consolidationNeeded: true });
    snapshotStore.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [
      { nativeRef: 'root', name: 'root', createdAt: '2026-06-01T00:00:00Z', sizeBytes: 100 },
      { nativeRef: 'middle', name: 'middle', parentRef: 'root', createdAt: '2026-07-01T00:00:00Z', sizeBytes: 200 },
      { nativeRef: 'leaf', name: 'leaf', parentRef: 'middle', createdAt: '2026-07-29T00:00:00Z' },
    ], db);

    const result = service(db).assessHost({ id: 7, name: 'vcenter-a', daemon_type: 'vsphere' }, {
      now: '2026-07-30T00:00:00Z', database: db,
    });
    expect(result.summary).toEqual(expect.objectContaining({
      state: 'critical', snapshotCount: 3, maxChainDepth: 3,
      totalEstimatedBytes: 300, estimatedBytesKnownCount: 2, consolidationVmCount: 1,
    }));
    expect(result.items[0]).not.toHaveProperty('nativeRef');
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'root', ageDays: 59, estimatedBytes: 100, state: 'critical' }),
      expect.objectContaining({ name: 'leaf', chainDepth: 3, estimatedBytes: null }),
    ]));
  });

  test('calculates growth only from an earlier daily provider-byte observation', () => {
    const vm = rememberVm(db, { consolidationNeeded: false });
    const [snapshot] = snapshotStore.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [
      { nativeRef: 'growing', name: 'growing', createdAt: '2026-07-29T00:00:00Z', sizeBytes: 160 },
    ], db);
    db.prepare(`INSERT INTO provider_snapshot_risk_observations
      (host_id,observation_day,observed_at,summary_json,items_json,evidence_hash)
      VALUES (7,'2026-07-29','2026-07-29T23:00:00Z','{}',?,'previous')`)
      .run(JSON.stringify([{ snapshotId: snapshot.id, sizeBytes: 100, state: 'healthy' }]));

    const result = service(db).assessHost({ id: 7, daemon_type: 'vsphere' }, {
      now: '2026-07-30T00:00:00Z', database: db,
    });
    expect(result.items[0]).toEqual(expect.objectContaining({
      growthBytes: 60, growthPercent: 60, state: 'critical',
    }));
    expect(result.items[0].reasons).toContainEqual({ code: 'GROWTH_CRITICAL', severity: 'critical' });
  });

  test('does not represent missing snapshot byte evidence as zero bytes', () => {
    const vm = rememberVm(db, { consolidationNeeded: false });
    snapshotStore.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [
      { nativeRef: 'unknown-size', name: 'unknown-size', createdAt: '2026-07-30T00:00:00Z' },
    ], db);
    const result = service(db).assessHost({ id: 7, daemon_type: 'vsphere' }, {
      now: '2026-07-30T01:00:00Z', database: db,
    });
    expect(result.summary.totalEstimatedBytes).toBeNull();
    expect(result.summary.estimatedBytesKnownCount).toBe(0);
  });

  test('versions host threshold overrides and rejects stale or inverted policy writes', () => {
    const monitor = service(db);
    const host = { id: 7, daemon_type: 'vsphere' };
    expect(monitor.policy(host, db)).toEqual(expect.objectContaining({ source: 'default', version: 0, warningAgeDays: 3 }));
    const saved = monitor.updatePolicy(host, {
      warningAgeDays: 5, criticalAgeDays: 20, warningChainDepth: 4, criticalChainDepth: 9,
      warningGrowthPercent: 25, criticalGrowthPercent: 60, version: 0,
    }, { id: 1 }, db);
    expect(saved).toEqual(expect.objectContaining({ source: 'custom', version: 1, warningAgeDays: 5 }));
    const savedInput = { ...saved };
    delete savedInput.source;
    expect(() => monitor.updatePolicy(host, { ...savedInput, version: 0 }, { id: 1 }, db)).toThrow(/changed since it was loaded/);
    expect(() => monitor.updatePolicy(host, {
      warningAgeDays: 20, criticalAgeDays: 5, warningChainDepth: 4, criticalChainDepth: 9,
      warningGrowthPercent: 25, criticalGrowthPercent: 60, version: 1,
    }, { id: 1 }, db)).toThrow(/critical threshold/);
  });

  test('alerts only after a previously observed snapshot worsens', () => {
    const vm = rememberVm(db, { consolidationNeeded: false });
    snapshotStore.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [
      { nativeRef: 'ageing', name: 'ageing', createdAt: '2026-07-28T00:00:00Z' },
    ], db);
    const notifications = { create: jest.fn() };
    const audit = { log: jest.fn() };
    const monitor = service(db, { notifications, audit });
    const host = { id: 7, name: 'vcenter-a', daemon_type: 'vsphere' };

    const baseline = monitor.assessHost(host, { now: '2026-07-30T00:00:00Z', database: db });
    expect(monitor.recordObservation(host, baseline, null, db).transitions).toEqual([]);
    expect(notifications.create).not.toHaveBeenCalled();

    const warning = monitor.assessHost(host, { now: '2026-08-02T00:00:00Z', database: db });
    expect(monitor.recordObservation(host, warning, null, db).transitions).toEqual([
      expect.objectContaining({ from: 'healthy', to: 'warning' }),
    ]);
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider_snapshot_risk_regression' }));

    const unchanged = monitor.assessHost(host, { now: '2026-08-03T00:00:00Z', database: db });
    expect(monitor.recordObservation(host, unchanged, null, db).transitions).toEqual([]);
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  test('refreshes a bounded host inventory through one provider session', async () => {
    const first = rememberVm(db, { name: 'one' });
    const second = rememberVm(db, { name: 'two' });
    const registry = { resourcesForHost: jest.fn().mockResolvedValue({ items: [
      { id: first.id, identity: first }, { id: second.id, identity: second },
    ] }) };
    const session = { host: { id: 7, daemon_type: 'vsphere' }, rows: [] };
    const bridge = {
      openHost: jest.fn().mockResolvedValue(session),
      targetFromSession: jest.fn((_session, vmId) => ({ vmId })),
      list: jest.fn().mockResolvedValue([]), close: jest.fn().mockResolvedValue(undefined),
    };
    const store = { rememberMany: jest.fn() };
    const monitor = service(db, { registry, bridge, snapshotStore: store });
    const result = await monitor.refreshHost({ id: 7, name: 'vcenter-a', daemon_type: 'vsphere' }, { database: db, now: '2026-07-30T00:00:00Z' });
    expect(bridge.openHost).toHaveBeenCalledTimes(1);
    expect(bridge.targetFromSession).toHaveBeenCalledTimes(2);
    expect(store.rememberMany).toHaveBeenCalledTimes(2);
    expect(bridge.close).toHaveBeenCalledWith(session);
    expect(result.coverage.collection).toEqual(expect.objectContaining({ attemptedVms: 2, succeededVms: 2, failedVms: 0 }));
  });
});
