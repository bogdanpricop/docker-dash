'use strict';

jest.mock('../config', () => ({ security: { encryptionKey: 'provider-resource-test-key-32-bytes' } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/106_provider_resource_identities');
const { decrypt } = require('../utils/crypto');
const { remember, resolveCanonical } = require('../services/provider-sdk/identity-store');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO docker_hosts (id, name) VALUES (7, 'pool-a')`);
  migration.up(db);
  return db;
}

describe('Provider resource identity store', () => {
  let db;
  beforeEach(() => { db = database(); });
  afterEach(() => db.close());

  it('creates deterministic opaque IDs and encrypted native references', () => {
    const input = { hostId: 7, providerType: 'xen', kind: 'virtualMachine', uuid: 'vm-uuid-1', nativeRef: 'OpaqueRef:secret-ref', stability: 'stable' };
    const first = remember(input, db);
    const second = remember(input, db);
    expect(first).toEqual(second);
    expect(first.id).toMatch(/^ddr_vm_[a-f0-9]{26}$/);
    expect(first.id).not.toContain('secret-ref');
    const row = db.prepare('SELECT * FROM provider_resource_identities').get();
    expect(row.native_ref_enc).not.toContain('OpaqueRef:secret-ref');
    expect(decrypt(row.native_ref_enc)).toBe('OpaqueRef:secret-ref');
    expect(resolveCanonical(first.id, { hostId: 7, kind: 'virtualMachine' }, db).nativeRef).toBe('OpaqueRef:secret-ref');
    expect(resolveCanonical(first.id, { hostId: 8, kind: 'virtualMachine' }, db)).toBeNull();
  });

  it('keeps the canonical ID when a stable UUID receives a new native ref', () => {
    const first = remember({ hostId: 7, providerType: 'vsphere', kind: 'host', uuid: 'host-uuid', nativeRef: 'host-11', stability: 'stable' }, db);
    const second = remember({ hostId: 7, providerType: 'vsphere', kind: 'host', uuid: 'host-uuid', nativeRef: 'host-44', stability: 'stable' }, db);
    expect(second.id).toBe(first.id);
    expect(resolveCanonical(first.id, { hostId: 7, kind: 'host' }, db).nativeRef).toBe('host-44');
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_resource_identities').get().count).toBe(1);
  });

  it('marks transient identities without persisting their apparent UUID', () => {
    const identity = remember({ hostId: 7, providerType: 'xen', kind: 'virtualMachine', uuid: '12', nativeRef: '12', stability: 'transient' }, db);
    expect(identity).toEqual(expect.objectContaining({ uuid: null, stability: 'transient' }));
    expect(db.prepare('SELECT provider_uuid FROM provider_resource_identities').get().provider_uuid).toBeNull();
  });

  it('cascades identity mappings when an endpoint is removed', () => {
    remember({ hostId: 7, providerType: 'xen', kind: 'host', nativeRef: 'node-a', stability: 'derived' }, db);
    db.prepare('DELETE FROM docker_hosts WHERE id = 7').run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_resource_identities').get().count).toBe(0);
  });
});
