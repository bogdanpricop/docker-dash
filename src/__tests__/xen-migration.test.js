'use strict';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/105_docker_hosts_add_xen');

describe('migration 105 — Xen daemon type', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE docker_hosts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      daemon_type TEXT NOT NULL DEFAULT 'docker'
        CHECK(daemon_type IN ('docker', 'podman', 'incus', 'proxmox', 'kubernetes', 'lxd', 'nomad', 'vsphere'))
    )`);
  });
  afterEach(() => db.close());

  it('widens the constraint without rebuilding or losing rows', () => {
    db.prepare('INSERT INTO docker_hosts (id, name, daemon_type) VALUES (?, ?, ?)').run(1, 'existing', 'docker');
    migration.up(db);
    expect(() => db.prepare('INSERT INTO docker_hosts (id, name, daemon_type) VALUES (?, ?, ?)').run(2, 'xcp', 'xen')).not.toThrow();
    expect(db.prepare('SELECT name, daemon_type FROM docker_hosts ORDER BY id').all()).toEqual([
      { name: 'existing', daemon_type: 'docker' }, { name: 'xcp', daemon_type: 'xen' },
    ]);
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  });
});
