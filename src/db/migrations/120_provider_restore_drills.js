'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_restore_drill_policies (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pdrp_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      backup_policy_id TEXT NOT NULL REFERENCES provider_backup_policies(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      schedule_json TEXT NOT NULL,
      target_node_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE RESTRICT,
      target_storage_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE RESTRICT,
      assertions_json TEXT NOT NULL,
      cleanup_mode TEXT NOT NULL DEFAULT 'on_success' CHECK(cleanup_mode IN ('on_success', 'never')),
      authorization_json TEXT NOT NULL DEFAULT '{}',
      rpo_target_seconds INTEGER CHECK(rpo_target_seconds IS NULL OR rpo_target_seconds BETWEEN 60 AND 31536000),
      rto_target_seconds INTEGER CHECK(rto_target_seconds IS NULL OR rto_target_seconds BETWEEN 30 AND 86400),
      last_slot_key TEXT,
      last_run_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_restore_drill_policy_name
      ON provider_restore_drill_policies(host_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_restore_drill_policy_due
      ON provider_restore_drill_policies(enabled, deleted_at, host_id);

    CREATE TABLE IF NOT EXISTS provider_restore_drill_runs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pdrr_[0-9a-f]*'),
      policy_id TEXT REFERENCES provider_restore_drill_policies(id) ON DELETE SET NULL,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      recovery_point_id TEXT REFERENCES provider_recovery_points(canonical_id) ON DELETE RESTRICT,
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE RESTRICT,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual', 'scheduled')),
      slot_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK(state IN ('blocked', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),
      plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
      request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
      idempotency_key_hash TEXT NOT NULL CHECK(length(idempotency_key_hash) = 64),
      target_node_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE RESTRICT,
      target_storage_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE RESTRICT,
      target_vmid INTEGER CHECK(target_vmid IS NULL OR target_vmid BETWEEN 100 AND 999999999),
      assertions_json TEXT NOT NULL,
      cleanup_mode TEXT NOT NULL CHECK(cleanup_mode IN ('on_success', 'never')),
      rpo_target_seconds INTEGER,
      rto_target_seconds INTEGER,
      rpo_age_seconds INTEGER,
      rto_seconds INTEGER,
      cleanup_seconds INTEGER,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      evidence_hash TEXT,
      error_code TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(policy_id, slot_key),
      UNIQUE(operation_id),
      UNIQUE(host_id, idempotency_key_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_restore_drill_runs_host
      ON provider_restore_drill_runs(host_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_restore_drill_runs_policy
      ON provider_restore_drill_runs(policy_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_restore_drill_runs_state
      ON provider_restore_drill_runs(state, updated_at);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_restore_drill_runs;
    DROP TABLE IF EXISTS provider_restore_drill_policies;
  `);
};
