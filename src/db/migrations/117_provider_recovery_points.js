'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_backup_repositories (
      canonical_id TEXT PRIMARY KEY,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      native_ref_hash TEXT NOT NULL,
      native_ref_enc TEXT NOT NULL,
      display_name TEXT NOT NULL,
      repository_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, native_ref_hash)
    );

    CREATE TABLE IF NOT EXISTS provider_recovery_points (
      canonical_id TEXT PRIMARY KEY,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      repository_id TEXT REFERENCES provider_backup_repositories(canonical_id) ON DELETE SET NULL,
      native_ref_hash TEXT NOT NULL,
      native_ref_enc TEXT NOT NULL,
      workload_id TEXT,
      workload_ref_hash TEXT,
      workload_ref_enc TEXT,
      recovery_point_json TEXT NOT NULL,
      created_at TEXT,
      observed_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, native_ref_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_backup_repository_host
      ON provider_backup_repositories(host_id, display_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_provider_backup_repository_last_seen
      ON provider_backup_repositories(host_id, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_recovery_point_host_created
      ON provider_recovery_points(host_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_recovery_point_repository
      ON provider_recovery_points(repository_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_recovery_point_workload
      ON provider_recovery_points(host_id, workload_id, created_at DESC);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_recovery_points;
    DROP TABLE IF EXISTS provider_backup_repositories;
  `);
};
