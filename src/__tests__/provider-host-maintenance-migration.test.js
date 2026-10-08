'use strict';

const Database = require('better-sqlite3');
const operations = require('../db/migrations/107_provider_operations');
const migration = require('../db/migrations/114_provider_host_maintenance');

describe('migration 114 — provider host maintenance', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, daemon_type TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
      INSERT INTO docker_hosts (id, daemon_type, is_active) VALUES (7, 'xen', 1);
    `);
    operations.up(db); migration.up(db);
  });
  afterEach(() => db.close());

  function insert(id, source, state = 'queued', key = id) {
    db.prepare(`INSERT INTO provider_host_maintenance_runs
      (id, host_id, provider_type, source_host_id, source_host_name, goal, state,
       wave_size, non_migratable_policy, plan_hash, plan_enc, idempotency_key_hash)
      VALUES (?, 7, 'xen', ?, 'xcp-a', 'enter', ?, 2, 'block', ?, 'encrypted', ?)`)
      .run(id, source, state, 'a'.repeat(64), key);
  }

  it('creates additive run, item and event tables with integrity intact', () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'provider_host_maintenance_%' ORDER BY name").all())
      .toEqual([
        { name: 'provider_host_maintenance_events' },
        { name: 'provider_host_maintenance_items' },
        { name: 'provider_host_maintenance_runs' },
      ]);
    expect(db.pragma('integrity_check')[0].integrity_check).toBe('ok');
  });

  it('permits only one active reservation per endpoint/source while retaining history', () => {
    const source = `ddr_host_${'a'.repeat(26)}`;
    insert(`hmr_${'1'.repeat(26)}`, source, 'queued', 'key-1');
    expect(() => insert(`hmr_${'2'.repeat(26)}`, source, 'draining', 'key-2')).toThrow(/UNIQUE/);
    db.prepare("UPDATE provider_host_maintenance_runs SET state = 'completed' WHERE id = ?").run(`hmr_${'1'.repeat(26)}`);
    expect(() => insert(`hmr_${'2'.repeat(26)}`, source, 'queued', 'key-2')).not.toThrow();
  });

  it('rolls back only the new additive tables', () => {
    migration.down(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'provider_host_maintenance_%'").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='provider_operations'").get().count).toBe(1);
  });
});
