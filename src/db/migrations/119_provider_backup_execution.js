'use strict';

exports.up = function (db) {
  db.exec(`
    ALTER TABLE provider_backup_policies ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'disabled'
      CHECK(execution_mode IN ('disabled', 'manual', 'scheduled'));
    ALTER TABLE provider_backup_policies ADD COLUMN execution_authorized_by INTEGER
      REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE provider_backup_policies ADD COLUMN execution_authorized_at TEXT;

    CREATE TABLE IF NOT EXISTS provider_backup_executions (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pbex_[0-9a-f]*'),
      policy_id TEXT NOT NULL REFERENCES provider_backup_policies(id) ON DELETE RESTRICT,
      plan_run_id TEXT NOT NULL REFERENCES provider_backup_policy_runs(id) ON DELETE RESTRICT,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual', 'scheduled')),
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK(state IN ('queued', 'running', 'verification_pending', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown')),
      plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
      idempotency_key_hash TEXT NOT NULL CHECK(length(idempotency_key_hash) = 64),
      request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(policy_id, idempotency_key_hash),
      UNIQUE(plan_run_id)
    );

    CREATE TABLE IF NOT EXISTS provider_backup_execution_items (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pbei_[0-9a-f]*'),
      execution_id TEXT NOT NULL REFERENCES provider_backup_executions(id) ON DELETE CASCADE,
      workload_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE RESTRICT,
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE RESTRICT,
      baseline_point_ids_json TEXT NOT NULL DEFAULT '[]',
      baseline_hash TEXT NOT NULL CHECK(length(baseline_hash) = 64),
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK(state IN ('queued', 'running', 'verification_pending', 'succeeded', 'failed', 'cancelled', 'unknown')),
      recovery_point_id TEXT REFERENCES provider_recovery_points(canonical_id) ON DELETE RESTRICT,
      verification_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK(verification_state IN ('verified', 'failed', 'stale', 'unverified', 'unknown')),
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(execution_id, workload_id),
      UNIQUE(operation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_backup_execution_policy
      ON provider_backup_executions(policy_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_backup_execution_state
      ON provider_backup_executions(state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_provider_backup_execution_item_dispatch
      ON provider_backup_execution_items(execution_id, state, created_at);
    CREATE INDEX IF NOT EXISTS idx_provider_backup_execution_item_operation
      ON provider_backup_execution_items(operation_id);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_backup_execution_items;
    DROP TABLE IF EXISTS provider_backup_executions;
  `);
  // SQLite cannot safely remove the additive policy columns without rebuilding
  // the policy table. They are intentionally retained during a development
  // downgrade and remain inert with their fail-closed defaults.
};
