'use strict';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/115_provider_ha_readiness');

describe('provider HA readiness migration', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
      INSERT INTO docker_hosts (id) VALUES (7);`);
  });
  afterEach(() => db.close());

  it('creates bounded endpoint snapshots and indexes', () => {
    migration.up(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_ha_snapshots'").all();
    expect(tables).toHaveLength(1);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_provider_ha_%'").all();
    expect(indexes.map(row => row.name)).toEqual(expect.arrayContaining([
      'idx_provider_ha_snapshots_host_time', 'idx_provider_ha_snapshots_state_time',
    ]));
  });

  it('enforces bucket uniqueness, state and score constraints', () => {
    migration.up(db);
    const insert = db.prepare(`INSERT INTO provider_ha_snapshots
      (host_id, provider_type, observed_at, observed_bucket, overall_state, score, snapshot_hash, snapshot_enc)
      VALUES (7, 'xen', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', ?, ?, ?, ?)`);
    insert.run('ready', 90, 'a'.repeat(64), 'encrypted-payload');
    expect(() => insert.run('ready', 90, 'b'.repeat(64), 'encrypted-payload')).toThrow(/UNIQUE/);
    expect(() => db.prepare(`INSERT INTO provider_ha_snapshots
      (host_id, provider_type, observed_at, observed_bucket, overall_state, score, snapshot_hash, snapshot_enc)
      VALUES (7, 'xen', '2026-07-26T00:05:00.000Z', '2026-07-26T00:05:00.000Z', 'healthy', 101, ?, ?)`)
      .run('c'.repeat(64), 'encrypted-payload')).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO provider_ha_snapshots
      (host_id, provider_type, observed_at, observed_bucket, overall_state, score, snapshot_hash, snapshot_enc)
      VALUES (7, 'other', '2026-07-26T00:10:00.000Z', '2026-07-26T00:10:00.000Z', 'ready', 90, ?, ?)`)
      .run('z'.repeat(64), 'encrypted-payload')).toThrow(/CHECK/);
  });

  it('drops only its additive table', () => {
    migration.up(db); migration.down(db);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='provider_ha_snapshots'").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='docker_hosts'").get().count).toBe(1);
  });
});
