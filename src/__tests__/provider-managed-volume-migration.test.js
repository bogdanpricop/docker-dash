'use strict';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/122_provider_managed_volumes');

describe('provider managed-volume migration', () => {
  it('constrains durable ownership state and retains operation/user references safely', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
      CREATE TABLE provider_resource_identities (canonical_id TEXT PRIMARY KEY);
      CREATE TABLE provider_operations (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES (9);
      INSERT INTO docker_hosts VALUES (7);
      INSERT INTO provider_resource_identities VALUES ('ddr_vm_aaaaaaaaaaaaaaaaaaaaaaaaaa');
      INSERT INTO provider_resource_identities VALUES ('ddr_storage_bbbbbbbbbbbbbbbbbbbbbbbbbb');
      INSERT INTO provider_operations VALUES ('op_cccccccccccccccccccccccccc');`);
    migration.up(db);
    db.prepare(`INSERT INTO provider_managed_volumes
      (id,host_id,vm_id,provider_type,native_ref_hash,native_ref_enc,label,storage_id,
       capacity_bytes,lifecycle_state,create_operation_id,created_by)
      VALUES ('ddv_vol_dddddddddddddddddddddddddd',7,'ddr_vm_aaaaaaaaaaaaaaaaaaaaaaaaaa',
       'xen',?,?,?,'ddr_storage_bbbbbbbbbbbbbbbbbbbbbbbbbb',1073741824,'attached',
       'op_cccccccccccccccccccccccccc',9)`).run('a'.repeat(64), 'encrypted', 'data-01');
    expect(() => db.prepare("UPDATE provider_managed_volumes SET lifecycle_state='orphan'").run()).toThrow(/CHECK/);
    expect(() => db.prepare('UPDATE provider_managed_volumes SET capacity_bytes=0').run()).toThrow(/CHECK/);
    migration.down(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='provider_managed_volumes'").get()).toBeUndefined();
    db.close();
  });
});
