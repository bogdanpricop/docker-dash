'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_recovery_file_catalogs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'prfc_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      recovery_point_id TEXT NOT NULL REFERENCES provider_recovery_points(canonical_id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('complete', 'partial', 'stale')),
      source TEXT NOT NULL CHECK(source IN ('provider', 'imported_evidence')),
      entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
      manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
      observed_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, recovery_point_id)
    );

    CREATE TABLE IF NOT EXISTS provider_recovery_file_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id TEXT NOT NULL REFERENCES provider_recovery_file_catalogs(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      parent_path TEXT NOT NULL,
      name TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('file', 'directory', 'symlink')),
      size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
      modified_at TEXT,
      checksum TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(catalog_id, path)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_recovery_file_catalog_point
      ON provider_recovery_file_catalogs(recovery_point_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_recovery_file_entry_parent
      ON provider_recovery_file_entries(catalog_id, parent_path, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS provider_restore_depth_plans (
      id TEXT PRIMARY KEY CHECK(id GLOB 'prdp_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      recovery_point_id TEXT NOT NULL REFERENCES provider_recovery_points(canonical_id) ON DELETE CASCADE,
      restore_kind TEXT NOT NULL CHECK(restore_kind IN
        ('file_download', 'file_restore', 'instant', 'differential', 'cross_site_copy')),
      request_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
      allowed INTEGER NOT NULL CHECK(allowed IN (0, 1)),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_provider_restore_depth_plan_point
      ON provider_restore_depth_plans(recovery_point_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_replication_policies (
      id TEXT PRIMARY KEY CHECK(id GLOB 'prpl_[0-9a-f]*'),
      schema_version TEXT NOT NULL DEFAULT '1.0',
      source_host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      target_host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('async', 'near_sync', 'sync')),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      rpo_target_seconds INTEGER NOT NULL CHECK(rpo_target_seconds BETWEEN 5 AND 31536000),
      schedule TEXT,
      bandwidth_limit_mbps INTEGER CHECK(bandwidth_limit_mbps IS NULL OR bandwidth_limit_mbps BETWEEN 1 AND 1000000),
      workload_ids_json TEXT NOT NULL DEFAULT '[]',
      storage_mappings_json TEXT NOT NULL DEFAULT '[]',
      capability_json TEXT NOT NULL DEFAULT '{}',
      policy_hash TEXT NOT NULL CHECK(length(policy_hash) = 64),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_replication_policy_name
      ON provider_replication_policies(source_host_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_replication_policy_hosts
      ON provider_replication_policies(source_host_id, target_host_id, deleted_at);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_replication_policies;
    DROP TABLE IF EXISTS provider_restore_depth_plans;
    DROP TABLE IF EXISTS provider_recovery_file_entries;
    DROP TABLE IF EXISTS provider_recovery_file_catalogs;
  `);
};
