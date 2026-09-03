'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_resource_identities (
      canonical_id TEXT PRIMARY KEY,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind IN (
        'virtualMachine', 'host', 'cluster', 'storage', 'network', 'task'
      )),
      provider_uuid TEXT,
      native_ref_hash TEXT NOT NULL,
      native_ref_enc TEXT NOT NULL,
      identity_stability TEXT NOT NULL CHECK(identity_stability IN ('stable', 'derived', 'transient')),
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, resource_kind, native_ref_hash)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_resource_identity_uuid
      ON provider_resource_identities(host_id, resource_kind, provider_uuid)
      WHERE provider_uuid IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_provider_resource_identity_last_seen
      ON provider_resource_identities(host_id, resource_kind, last_seen_at);
  `);
};

exports.down = function (db) {
  db.exec('DROP TABLE IF EXISTS provider_resource_identities');
};
