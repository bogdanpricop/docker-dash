'use strict';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/120_provider_restore_drills');

describe('provider restore-drill migration', () => {
  it('constrains policies/runs while permitting durable blocked-slot evidence', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
      CREATE TABLE provider_backup_policies (id TEXT PRIMARY KEY);
      CREATE TABLE provider_resource_identities (canonical_id TEXT PRIMARY KEY);
      CREATE TABLE provider_recovery_points (canonical_id TEXT PRIMARY KEY);
      CREATE TABLE provider_operations (id TEXT PRIMARY KEY);
      INSERT INTO docker_hosts VALUES (7);
      INSERT INTO provider_backup_policies VALUES ('pbp_aaaaaaaaaaaaaaaaaaaaaaaaaa');
      INSERT INTO provider_resource_identities VALUES ('ddr_host_aaaaaaaaaaaaaaaaaaaaaaaaaa');
      INSERT INTO provider_resource_identities VALUES ('ddr_storage_bbbbbbbbbbbbbbbbbbbbbbbbbb');`);
    migration.up(db);
    db.prepare(`INSERT INTO provider_restore_drill_policies
      (id,host_id,backup_policy_id,name,schedule_json,target_node_id,target_storage_id,assertions_json)
      VALUES ('pdrp_aaaaaaaaaaaaaaaaaaaaaaaaaa',7,'pbp_aaaaaaaaaaaaaaaaaaaaaaaaaa','Weekly drill','{}',
       'ddr_host_aaaaaaaaaaaaaaaaaaaaaaaaaa','ddr_storage_bbbbbbbbbbbbbbbbbbbbbbbbbb','{}')`).run();
    const blocked = db.prepare(`INSERT INTO provider_restore_drill_runs
      (id,policy_id,host_id,recovery_point_id,trigger_type,slot_key,state,plan_hash,request_hash,
       idempotency_key_hash,target_node_id,target_storage_id,target_vmid,assertions_json,cleanup_mode)
      VALUES ('pdrr_aaaaaaaaaaaaaaaaaaaaaaaaaa','pdrp_aaaaaaaaaaaaaaaaaaaaaaaaaa',7,NULL,'scheduled','slot-a','blocked',
       ?,?,?,'ddr_host_aaaaaaaaaaaaaaaaaaaaaaaaaa','ddr_storage_bbbbbbbbbbbbbbbbbbbbbbbbbb',NULL,'{}','never')`);
    expect(() => blocked.run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64))).not.toThrow();
    expect(() => db.prepare("UPDATE provider_restore_drill_runs SET state='invented'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE provider_restore_drill_policies SET cleanup_mode='always'").run()).toThrow(/CHECK/);
    migration.down(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_restore_drill_runs'").get()).toBeUndefined();
    db.close();
  });
});
