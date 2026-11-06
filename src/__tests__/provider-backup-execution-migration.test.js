'use strict';

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const operationMigration = require('../db/migrations/107_provider_operations');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const policyMigration = require('../db/migrations/118_provider_backup_policies');
const migration = require('../db/migrations/119_provider_backup_execution');

describe('provider backup execution migration', () => {
  it('defaults authorization closed and constrains durable parent and item state', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES (9); INSERT INTO docker_hosts VALUES (7);`);
    identityMigration.up(db); operationMigration.up(db); recoveryMigration.up(db); policyMigration.up(db); migration.up(db);
    db.prepare(`INSERT INTO provider_backup_repositories
      (canonical_id,host_id,provider_type,native_ref_hash,native_ref_enc,display_name,repository_json,observed_at)
      VALUES ('ddr_repo_aaaaaaaaaaaaaaaaaaaaaaaaaa',7,'proxmox',?,'enc','PBS','{}','2026-01-01T00:00:00Z')`).run('a'.repeat(64));
    db.prepare(`INSERT INTO provider_backup_policies
      (id,host_id,repository_id,name,schedule_json,scope_json,consistency_json,retention_json,protection_json,controls_json,verification_json,policy_hash)
      VALUES ('pbp_aaaaaaaaaaaaaaaaaaaaaaaaaa',7,'ddr_repo_aaaaaaaaaaaaaaaaaaaaaaaaaa','GFS','{}','{}','{}','{}','{}','{}','{}',?)`).run('b'.repeat(64));
    const policy = db.prepare('SELECT execution_mode,execution_authorized_at FROM provider_backup_policies').get();
    expect(policy).toEqual({ execution_mode: 'disabled', execution_authorized_at: null });
    expect(() => db.prepare("UPDATE provider_backup_policies SET execution_mode='execute'").run()).toThrow(/CHECK/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_backup_executions'").get()).toBeTruthy();
    migration.down(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_backup_executions'").get()).toBeUndefined();
    db.close();
  });
});
