'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/122_provider_managed_volumes');
const store = require('../services/provider-sdk/managed-volume-store');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const STORAGE_ID = `ddr_storage_${'b'.repeat(26)}`;
const DISK_ID = `ddh_disk_${'c'.repeat(26)}`;

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
    CREATE TABLE provider_resource_identities (canonical_id TEXT PRIMARY KEY);
    CREATE TABLE provider_operations (id TEXT PRIMARY KEY);
    INSERT INTO users VALUES (9); INSERT INTO docker_hosts VALUES (7);
    INSERT INTO provider_resource_identities VALUES ('${VM_ID}');
    INSERT INTO provider_resource_identities VALUES ('${STORAGE_ID}');`);
  migration.up(db); return db;
}

describe('managed volume ownership store', () => {
  it('encrypts native backing identity and returns only the portable projection', () => {
    const db = database();
    const created = store.create({
      hostId: 7, vmId: VM_ID, providerType: 'xen', nativeRef: 'OpaqueRef:secret-vdi',
      diskId: DISK_ID, label: 'payments-data', storageId: STORAGE_ID,
      bus: 'xen-vbd', unit: 2, capacityBytes: 1024 ** 3, state: 'attached', createdBy: 9,
    }, db);
    expect(created).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^ddv_vol_[a-f0-9]{26}$/), diskId: DISK_ID,
      state: 'attached', ownership: { managed: true, scope: 'docker_dash_created' },
    }));
    expect(JSON.stringify(created)).not.toContain('OpaqueRef');
    const row = db.prepare('SELECT native_ref_enc FROM provider_managed_volumes WHERE id=?').get(created.id);
    expect(row.native_ref_enc).not.toContain('OpaqueRef');
    expect(store.resolve(created.id, { hostId: 7 }, db).nativeRef).toBe('OpaqueRef:secret-vdi');
    expect(store.findForDisk(7, VM_ID, DISK_ID, db)?.id).toBe(created.id);
    expect(store.transition(created.id, { hostId: 7 }, 'detached', { diskId: null }, db))
      .toEqual(expect.objectContaining({ state: 'detached', diskId: null, detachedAt: expect.any(String) }));
    db.close();
  });
});
