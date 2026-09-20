'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_vm_action_schedules (
      id TEXT PRIMARY KEY,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      vm_id TEXT NOT NULL,
      vm_display_name TEXT NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('start','stop','reboot','snapshot')),
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      dst_policy TEXT NOT NULL DEFAULT 'first' CHECK(dst_policy IN ('first','second','skip')),
      mode TEXT NOT NULL DEFAULT 'dry_run' CHECK(mode IN ('dry_run','execute')),
      enabled INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      holidays_json TEXT NOT NULL DEFAULT '[]',
      blackout_windows_json TEXT NOT NULL DEFAULT '[]',
      environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production','nonproduction')),
      scope_id INTEGER REFERENCES governance_scopes(id) ON DELETE SET NULL,
      version INTEGER NOT NULL DEFAULT 1,
      failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK(failure_threshold BETWEEN 1 AND 20),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      execute_confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      execute_confirmed_at TEXT,
      last_evaluated_at TEXT,
      last_slot_key TEXT,
      last_run_at TEXT,
      last_run_status TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_action_schedule_name
      ON provider_vm_action_schedules(host_id, vm_id, name)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_vm_action_schedule_due
      ON provider_vm_action_schedules(enabled, deleted_at, host_id);

    CREATE TABLE IF NOT EXISTS provider_vm_action_schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES provider_vm_action_schedules(id) ON DELETE CASCADE,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('scheduled','manual')),
      slot_key TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      local_time TEXT NOT NULL,
      dst_occurrence INTEGER,
      state TEXT NOT NULL CHECK(state IN (
        'previewed','skipped','queued','running','succeeded','failed','blocked','unknown'
      )),
      decision TEXT NOT NULL,
      reason_code TEXT,
      reason_message TEXT,
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      plan_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(schedule_id, slot_key)
    );

    CREATE INDEX IF NOT EXISTS idx_vm_action_schedule_runs_history
      ON provider_vm_action_schedule_runs(schedule_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_action_schedule_active_run
      ON provider_vm_action_schedule_runs(schedule_id)
      WHERE state IN ('queued','running','unknown');
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_vm_action_schedule_runs;
    DROP TABLE IF EXISTS provider_vm_action_schedules;
  `);
};
