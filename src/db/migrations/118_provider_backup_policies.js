'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_backup_policies (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pbp_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES provider_backup_repositories(canonical_id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      mode TEXT NOT NULL DEFAULT 'plan_only' CHECK(mode = 'plan_only'),
      schedule_json TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      consistency_json TEXT NOT NULL,
      retention_json TEXT NOT NULL,
      protection_json TEXT NOT NULL,
      controls_json TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      policy_hash TEXT NOT NULL CHECK(length(policy_hash) = 64),
      last_slot_key TEXT,
      last_plan_at TEXT,
      last_plan_status TEXT CHECK(last_plan_status IS NULL OR last_plan_status IN ('planned', 'blocked')),
      last_plan_summary_json TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_backup_policy_active_name
      ON provider_backup_policies(host_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_backup_policy_due
      ON provider_backup_policies(enabled, deleted_at, host_id);
    CREATE INDEX IF NOT EXISTS idx_provider_backup_policy_repository
      ON provider_backup_policies(repository_id, deleted_at);

    CREATE TABLE IF NOT EXISTS provider_backup_policy_runs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pbpr_[0-9a-f]*'),
      policy_id TEXT NOT NULL REFERENCES provider_backup_policies(id) ON DELETE CASCADE,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('scheduled', 'manual', 'preview')),
      slot_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('planned', 'blocked', 'superseded')),
      policy_hash TEXT NOT NULL CHECK(length(policy_hash) = 64),
      plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
      plan_json TEXT NOT NULL,
      findings_json TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(policy_id, slot_key)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_backup_policy_runs_policy
      ON provider_backup_policy_runs(policy_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_backup_policy_runs_state
      ON provider_backup_policy_runs(state, created_at DESC);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_backup_policy_runs;
    DROP TABLE IF EXISTS provider_backup_policies;
  `);
};
