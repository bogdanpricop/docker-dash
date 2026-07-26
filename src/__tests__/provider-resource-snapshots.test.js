'use strict';

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const snapshotMigration = require('../db/migrations/109_provider_resource_snapshots');
const snapshots = require('../services/provider-sdk/resource-snapshots');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;

function resource(overrides = {}) {
  return {
    schemaVersion: '1.0', kind: 'virtualMachine', id: VM_ID,
    displayName: 'control-plane', observedAt: new Date().toISOString(),
    provider: { type: 'xen', endpointId: 7 },
    identity: { uuid: null, stability: 'derived' }, labels: {}, relationships: {},
    spec: { cpuCount: 4, memoryBytes: 8192, guestOS: 'Linux' },
    status: { powerState: 'running', health: 'green' }, actions: ['shutdown'], extensions: {},
    ...overrides,
  };
}

describe('provider resource snapshot store', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (7, 'xcp-pool')`);
    identityMigration.up(db);
    snapshotMigration.up(db);
    db.prepare(`INSERT INTO provider_resource_identities
      (canonical_id, host_id, provider_type, resource_kind, native_ref_hash, native_ref_enc, identity_stability)
      VALUES (?, 7, 'xen', 'virtualMachine', 'hash', 'encrypted', 'derived')`).run(VM_ID);
  });
  afterEach(() => db.close());

  it('persists and upserts only the normalized public resource', () => {
    expect(snapshots.rememberMany([resource()], db)).toBe(1);
    snapshots.rememberMany([resource({ displayName: 'control-plane-renamed' })], db);
    expect(snapshots.get(VM_ID, 7, 'virtualMachine', db)).toEqual(expect.objectContaining({
      id: VM_ID, displayName: 'control-plane-renamed',
    }));
    const row = db.prepare('SELECT * FROM provider_resource_snapshots').get();
    expect(row.resource_json).not.toContain('native_ref');
    expect(row.display_name).toBe('control-plane-renamed');
  });

  it('searches bounded visible host snapshots and escapes LIKE wildcards', () => {
    snapshots.rememberMany([resource()], db);
    expect(snapshots.search('control', [7], 10, db)).toEqual([expect.objectContaining({
      id: VM_ID, hostId: 7, providerType: 'xen', powerState: 'running',
    })]);
    expect(snapshots.search('%_', [7], 10, db)).toEqual([]);
    expect(snapshots.search('control', [8], 10, db)).toEqual([]);
  });

  it('ignores corrupt or cross-host cache entries', () => {
    snapshots.rememberMany([resource()], db);
    db.prepare('UPDATE provider_resource_snapshots SET resource_json = ? WHERE canonical_id = ?').run('{bad', VM_ID);
    expect(snapshots.get(VM_ID, 7, 'virtualMachine', db)).toBeNull();
    expect(snapshots.get(VM_ID, 8, 'virtualMachine', db)).toBeNull();
  });

  it('rejects oversized public snapshots', () => {
    expect(() => snapshots.rememberMany([resource({ labels: { note: 'x'.repeat(70 * 1024) } })], db))
      .toThrow(/exceeds 65536 bytes/);
  });

  it('rolls back cleanly', () => {
    expect(() => snapshotMigration.up(db)).not.toThrow();
    snapshotMigration.down(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_resource_snapshots'").get()).toBeUndefined();
  });
});
