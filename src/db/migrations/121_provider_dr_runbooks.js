'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_dr_protection_groups (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pdrg_[0-9a-f]*'),
      schema_version TEXT NOT NULL DEFAULT '1.0',
      primary_host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      recovery_host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      strategy TEXT NOT NULL CHECK(strategy IN ('provider_replication', 'backup_restore', 'hybrid')),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      rpo_target_seconds INTEGER NOT NULL CHECK(rpo_target_seconds BETWEEN 60 AND 31536000),
      rto_target_seconds INTEGER NOT NULL CHECK(rto_target_seconds BETWEEN 30 AND 86400),
      placement_json TEXT NOT NULL DEFAULT '{}',
      network_mappings_json TEXT NOT NULL DEFAULT '[]',
      contacts_json TEXT NOT NULL DEFAULT '{}',
      authorization_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_dr_group_name
      ON provider_dr_protection_groups(primary_host_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_dr_group_hosts
      ON provider_dr_protection_groups(primary_host_id, recovery_host_id, deleted_at);

    CREATE TABLE IF NOT EXISTS provider_dr_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL REFERENCES provider_dr_protection_groups(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 63),
      vm_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE RESTRICT,
      vm_name TEXT NOT NULL,
      boot_stage INTEGER NOT NULL CHECK(boot_stage BETWEEN 1 AND 20),
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      recovery_source TEXT NOT NULL CHECK(recovery_source IN ('replication', 'backup')),
      backup_policy_id TEXT REFERENCES provider_backup_policies(id) ON DELETE SET NULL,
      drill_policy_id TEXT REFERENCES provider_restore_drill_policies(id) ON DELETE SET NULL,
      recovery_target_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, vm_id),
      UNIQUE(group_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_dr_group_member_vm
      ON provider_dr_group_members(vm_id, group_id);

    CREATE TABLE IF NOT EXISTS provider_dr_runs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pdrun_[0-9a-f]*'),
      group_id TEXT NOT NULL REFERENCES provider_dr_protection_groups(id) ON DELETE RESTRICT,
      primary_host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      group_revision INTEGER NOT NULL CHECK(group_revision > 0),
      execution_type TEXT NOT NULL DEFAULT 'rehearsal' CHECK(execution_type = 'rehearsal'),
      runbook_mode TEXT NOT NULL CHECK(runbook_mode IN ('planned_failover', 'unplanned_failover', 'failback', 'test')),
      state TEXT NOT NULL CHECK(state IN ('blocked', 'succeeded')),
      plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
      evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
      compliance TEXT NOT NULL CHECK(compliance IN ('met', 'breached', 'failed', 'unknown', 'never_tested')),
      rpo_max_seconds INTEGER,
      rto_max_seconds INTEGER,
      blocker_count INTEGER NOT NULL DEFAULT 0 CHECK(blocker_count >= 0),
      warning_count INTEGER NOT NULL DEFAULT 0 CHECK(warning_count >= 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_dr_runs_group
      ON provider_dr_runs(group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_dr_runs_host
      ON provider_dr_runs(primary_host_id, created_at DESC);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_dr_runs;
    DROP TABLE IF EXISTS provider_dr_group_members;
    DROP TABLE IF EXISTS provider_dr_protection_groups;
  `);
};
