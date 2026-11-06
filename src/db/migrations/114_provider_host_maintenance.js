'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_host_maintenance_runs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'hmr_[0-9a-f]*'),
      schema_version TEXT NOT NULL DEFAULT '1.0',
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      source_host_id TEXT NOT NULL,
      source_host_name TEXT NOT NULL,
      goal TEXT NOT NULL CHECK(goal IN ('drain', 'enter')),
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN (
        'queued', 'preparing', 'draining', 'paused', 'entering',
        'drained', 'maintenance', 'exiting', 'completed',
        'failed', 'cancelled', 'unknown'
      )),
      phase TEXT,
      wave_size INTEGER NOT NULL CHECK(wave_size BETWEEN 1 AND 10),
      non_migratable_policy TEXT NOT NULL CHECK(non_migratable_policy IN ('block', 'defer')),
      plan_hash TEXT NOT NULL,
      plan_enc TEXT NOT NULL,
      idempotency_key_hash TEXT NOT NULL,
      native_task_ref_hash TEXT,
      native_task_ref_enc TEXT,
      native_task_state TEXT,
      pause_requested_at TEXT,
      cancel_requested_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      error_code TEXT,
      error_message TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_host_maintenance_idempotency
      ON provider_host_maintenance_runs(host_id, idempotency_key_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_host_maintenance_active_source
      ON provider_host_maintenance_runs(host_id, source_host_id)
      WHERE state IN (
        'queued', 'preparing', 'draining', 'paused', 'entering',
        'drained', 'maintenance', 'exiting', 'unknown'
      );
    CREATE INDEX IF NOT EXISTS idx_provider_host_maintenance_due
      ON provider_host_maintenance_runs(state, updated_at, created_at);

    CREATE TABLE IF NOT EXISTS provider_host_maintenance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES provider_host_maintenance_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 199),
      wave_number INTEGER NOT NULL CHECK(wave_number BETWEEN 1 AND 200),
      vm_id TEXT NOT NULL,
      vm_name TEXT NOT NULL,
      source_host_id TEXT NOT NULL,
      target_host_id TEXT,
      target_host_name TEXT,
      mode TEXT CHECK(mode IN ('live', 'cold', 'storage')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN (
        'pending', 'submitted', 'succeeded', 'deferred',
        'failed', 'cancelled', 'unknown'
      )),
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      error_code TEXT,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, vm_id)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_host_maintenance_items_run
      ON provider_host_maintenance_items(run_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_provider_host_maintenance_items_operation
      ON provider_host_maintenance_items(operation_id);

    CREATE TABLE IF NOT EXISTS provider_host_maintenance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES provider_host_maintenance_runs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      state TEXT,
      phase TEXT,
      message TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_host_maintenance_events_run
      ON provider_host_maintenance_events(run_id, id);
  `);
};
exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_host_maintenance_events;
    DROP TABLE IF EXISTS provider_host_maintenance_items;
    DROP TABLE IF EXISTS provider_host_maintenance_runs;
  `);
};
