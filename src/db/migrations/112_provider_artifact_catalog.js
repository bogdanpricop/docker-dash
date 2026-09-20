'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_artifact_catalog (
      canonical_id TEXT PRIMARY KEY,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      artifact_kind TEXT NOT NULL CHECK(artifact_kind IN (
        'vmTemplate', 'iso', 'containerTemplate', 'diskImage', 'contentLibraryItem'
      )),
      provider_uuid TEXT,
      native_ref_hash TEXT NOT NULL,
      native_ref_enc TEXT NOT NULL,
      display_name TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, artifact_kind, native_ref_hash)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_artifact_uuid
      ON provider_artifact_catalog(host_id, artifact_kind, provider_uuid)
      WHERE provider_uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_artifact_host_kind_name
      ON provider_artifact_catalog(host_id, artifact_kind, display_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_provider_artifact_last_seen
      ON provider_artifact_catalog(last_seen_at DESC);
  `);
};

exports.down = function (db) {
  db.exec('DROP TABLE IF EXISTS provider_artifact_catalog');
};
