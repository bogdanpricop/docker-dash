'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_resource_snapshots (
      canonical_id TEXT PRIMARY KEY
        REFERENCES provider_resource_identities(canonical_id) ON DELETE CASCADE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind IN (
        'virtualMachine', 'host', 'cluster', 'storage', 'network', 'task'
      )),
      display_name TEXT NOT NULL,
      power_state TEXT,
      resource_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_resource_snapshots_host_kind_name
      ON provider_resource_snapshots(host_id, resource_kind, display_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_provider_resource_snapshots_observed
      ON provider_resource_snapshots(observed_at DESC);
  `);
};

exports.down = function (db) {
  db.exec('DROP TABLE IF EXISTS provider_resource_snapshots');
};
