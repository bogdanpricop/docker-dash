'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_vm_snapshot_policies (
      id TEXT PRIMARY KEY CHECK(id GLOB 'vmsp_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      vm_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      mode TEXT NOT NULL DEFAULT 'dry_run' CHECK(mode IN ('dry_run', 'execute')),
      frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('hourly', 'daily', 'weekly')),
      minute INTEGER NOT NULL DEFAULT 15 CHECK(minute IN (0, 15, 30, 45)),
      hour INTEGER NOT NULL DEFAULT 2 CHECK(hour BETWEEN 0 AND 23),
      weekday INTEGER NOT NULL DEFAULT 0 CHECK(weekday BETWEEN 0 AND 6),
      consistency TEXT NOT NULL DEFAULT 'crash' CHECK(consistency IN ('crash', 'quiesced')),
      name_prefix TEXT NOT NULL DEFAULT 'dd-auto',
      description TEXT,
      retain_count INTEGER NOT NULL DEFAULT 3 CHECK(retain_count BETWEEN 1 AND 32),
      max_age_days INTEGER CHECK(max_age_days BETWEEN 1 AND 3650),
      max_deletes_per_run INTEGER NOT NULL DEFAULT 2 CHECK(max_deletes_per_run BETWEEN 1 AND 20),
      last_slot_key TEXT,
      last_run_at TEXT,
      last_run_status TEXT,
      last_run_summary_json TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      UNIQUE(host_id, vm_id)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_vm_snapshot_policies_due
      ON provider_vm_snapshot_policies(enabled, deleted_at, frequency, minute, hour, weekday);

    CREATE TABLE IF NOT EXISTS provider_vm_snapshot_policy_runs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'vspr_[0-9a-f]*'),
      policy_id TEXT NOT NULL REFERENCES provider_vm_snapshot_policies(id) ON DELETE CASCADE,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('scheduled', 'manual', 'preview')),
      slot_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'previewed', 'create_pending', 'retention_pending',
        'succeeded', 'blocked', 'failed', 'unknown'
      )),
      current_operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      delete_count INTEGER NOT NULL DEFAULT 0 CHECK(delete_count BETWEEN 0 AND 20),
      plan_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(policy_id, slot_key)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_vm_snapshot_policy_runs_state
      ON provider_vm_snapshot_policy_runs(state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_provider_vm_snapshot_policy_runs_policy
      ON provider_vm_snapshot_policy_runs(policy_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_vm_snapshot_policy_runs_active
      ON provider_vm_snapshot_policy_runs(policy_id)
      WHERE state IN ('create_pending', 'retention_pending');
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_vm_snapshot_policy_runs;
    DROP TABLE IF EXISTS provider_vm_snapshot_policies;
  `);
};
