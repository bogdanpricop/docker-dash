'use strict';

jest.mock('../config', () => ({ security: { encryptionKey: 'provider-snapshot-test-key-32-bytes' } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const identitiesMigration = require('../db/migrations/106_provider_resource_identities');
const snapshotsMigration = require('../db/migrations/110_provider_vm_snapshots');
const riskMigration = require('../db/migrations/154_provider_snapshot_risk');
const identityStore = require('../services/provider-sdk/identity-store');
const snapshots = require('../services/provider-sdk/vm-snapshot-store');
const { decrypt } = require('../utils/crypto');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO docker_hosts (id, name) VALUES (7, 'pool-a'), (8, 'pool-b')`);
  identitiesMigration.up(db);
  snapshotsMigration.up(db);
  riskMigration.up(db);
  return db;
}

function rememberVm(db, hostId = 7) {
  return identityStore.remember({
    hostId, providerType: 'vsphere', kind: 'virtualMachine', uuid: `vm-uuid-${hostId}`,
    nativeRef: `vm-${hostId}`, stability: 'stable',
  }, db);
}

describe('common provider VM snapshot store', () => {
  let db;
  beforeEach(() => { db = database(); });
  afterEach(() => db.close());

  it('persists encrypted provider references and a child-first tree', () => {
    const vm = rememberVm(db);
    const items = snapshots.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [
      { nativeRef: 'snapshot-secret-child', name: 'child', parentRef: 'snapshot-secret-root', createdAt: '2026-07-02T00:00:00Z' },
      { nativeRef: 'snapshot-secret-root', name: 'root', createdAt: '2026-07-01T00:00:00Z', consistency: 'crash', sizeBytes: 4096 },
    ], db);
    const root = items.find(item => item.name === 'root');
    const child = items.find(item => item.name === 'child');
    expect(child.parentId).toBe(root.id);
    expect(root.childCount).toBe(1);
    expect(root.sizeBytes).toBe(4096);
    expect(items.every(item => item.integrity.state === 'valid')).toBe(true);
    const rows = db.prepare('SELECT native_ref_enc FROM provider_vm_snapshots').all();
    expect(JSON.stringify(rows)).not.toContain('snapshot-secret');
    expect(rows.map(row => decrypt(row.native_ref_enc))).toEqual(expect.arrayContaining([
      'snapshot-secret-child', 'snapshot-secret-root',
    ]));
    expect(snapshots.resolve(child.id, { hostId: 7, vmId: vm.id }, db).nativeRef).toBe('snapshot-secret-child');
  });

  it('marks missing inventory entries absent and enforces host/VM scope', () => {
    const vm = rememberVm(db);
    const first = snapshots.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [
      { nativeRef: 'snap-a', name: 'a' }, { nativeRef: 'snap-b', name: 'b' },
    ], db);
    snapshots.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [{ nativeRef: 'snap-b', name: 'b' }], db);
    expect(snapshots.list(7, vm.id, db).map(item => item.name)).toEqual(['b']);
    expect(snapshots.resolve(first.find(item => item.name === 'a').id, { hostId: 7, vmId: vm.id }, db)).toBeNull();
    expect(snapshots.resolve(first[0].id, { hostId: 8, vmId: vm.id }, db)).toBeNull();
  });

  it('flags orphan and cyclic parent graphs without exposing native references', () => {
    const vm = rememberVm(db);
    const orphan = snapshots.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [
      { nativeRef: 'snap-orphan', name: 'orphan', parentRef: 'missing-parent' },
    ], db);
    expect(orphan[0]).toEqual(expect.objectContaining({
      integrity: { state: 'orphan_parent' }, parentId: null,
    }));
    expect(orphan[0]).not.toHaveProperty('nativeRef');

    const cyclic = snapshots.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' }, [
      { nativeRef: 'snap-one', name: 'one', parentRef: 'snap-two' },
      { nativeRef: 'snap-two', name: 'two', parentRef: 'snap-one' },
    ], db);
    expect(cyclic.map(item => item.integrity.state)).toEqual(['cycle', 'cycle']);
  });

  it('rejects oversized inventories and invalid contexts', () => {
    const vm = rememberVm(db);
    expect(() => snapshots.rememberMany({ hostId: 7, vmId: vm.id, providerType: 'vsphere' },
      Array.from({ length: 501 }, (_, index) => ({ nativeRef: `snap-${index}`, name: `snap-${index}` })), db)).toThrow(/at most 500/);
    expect(() => snapshots.rememberMany({ hostId: 0, vmId: vm.id, providerType: 'vsphere' }, [], db)).toThrow(/context/);
  });
});
