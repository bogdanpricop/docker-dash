'use strict';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/118_provider_backup_policies');

describe('provider backup policy migration', () => {
  it('enforces plan-only modes, canonical repositories and unique active names', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
      CREATE TABLE provider_backup_repositories (canonical_id TEXT PRIMARY KEY);
      INSERT INTO docker_hosts VALUES (7);
      INSERT INTO provider_backup_repositories VALUES ('ddr_repo_aaaaaaaaaaaaaaaaaaaaaaaaaa');`);
    migration.up(database);
    const insert = database.prepare(`INSERT INTO provider_backup_policies
      (id, host_id, repository_id, name, mode, schedule_json, scope_json, consistency_json,
       retention_json, protection_json, controls_json, verification_json, policy_hash)
      VALUES (?, 7, 'ddr_repo_aaaaaaaaaaaaaaaaaaaaaaaaaa', ?, ?, '{}', '{}', '{}', '{}', '{}', '{}', '{}', ?)`);
    insert.run('pbp_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'GFS A', 'plan_only', 'a'.repeat(64));
    expect(() => insert.run('pbp_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'gfs a', 'plan_only', 'b'.repeat(64))).toThrow(/UNIQUE/);
    expect(() => insert.run('pbp_cccccccccccccccccccccccccc', 'GFS C', 'execute', 'c'.repeat(64))).toThrow(/CHECK/);
    database.prepare("UPDATE provider_backup_policies SET deleted_at=datetime('now') WHERE id=?")
      .run('pbp_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(() => insert.run('pbp_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'gfs a', 'plan_only', 'b'.repeat(64))).not.toThrow();
    migration.down(database);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_backup_policies'").get()).toBeUndefined();
    database.close();
  });
});
