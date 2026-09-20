'use strict';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/121_provider_dr_runbooks');

describe('provider DR runbook migration', () => {
  it('constrains protection groups, dependency members and immutable rehearsal modes', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
      CREATE TABLE provider_resource_identities (canonical_id TEXT PRIMARY KEY);
      CREATE TABLE provider_backup_policies (id TEXT PRIMARY KEY);
      CREATE TABLE provider_restore_drill_policies (id TEXT PRIMARY KEY);
      INSERT INTO docker_hosts VALUES (7);
      INSERT INTO provider_resource_identities VALUES ('ddr_vm_aaaaaaaaaaaaaaaaaaaaaaaaaa');`);
    migration.up(db);
    db.prepare(`INSERT INTO provider_dr_protection_groups
      (id,primary_host_id,recovery_host_id,name,strategy,rpo_target_seconds,rto_target_seconds)
      VALUES ('pdrg_aaaaaaaaaaaaaaaaaaaaaaaaaa',7,7,'Payments','backup_restore',3600,900)`).run();
    db.prepare(`INSERT INTO provider_dr_group_members
      (group_id,sequence,vm_id,vm_name,boot_stage,recovery_source)
      VALUES ('pdrg_aaaaaaaaaaaaaaaaaaaaaaaaaa',0,'ddr_vm_aaaaaaaaaaaaaaaaaaaaaaaaaa','db',1,'backup')`).run();
    db.prepare(`INSERT INTO provider_dr_runs
      (id,group_id,primary_host_id,group_revision,runbook_mode,state,plan_hash,evidence_json,
       evidence_hash,compliance)
      VALUES ('pdrun_aaaaaaaaaaaaaaaaaaaaaaaaaa','pdrg_aaaaaaaaaaaaaaaaaaaaaaaaaa',7,1,
       'test','blocked',?,'{}',?,'never_tested')`).run('a'.repeat(64), 'b'.repeat(64));
    expect(() => db.prepare("UPDATE provider_dr_runs SET runbook_mode='invented'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE provider_dr_protection_groups SET strategy='snapshot'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE provider_dr_group_members SET boot_stage=0").run()).toThrow(/CHECK/);
    migration.down(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='provider_dr_runs'").get()).toBeUndefined();
    db.close();
  });
});
