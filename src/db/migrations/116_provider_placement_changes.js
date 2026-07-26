'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_placement_changes (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pcr_[0-9a-f]*'),
      schema_version TEXT NOT NULL DEFAULT '1.0',
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      change_kind TEXT NOT NULL CHECK(change_kind IN ('ha_policy', 'affinity_rule', 'rebalance_apply')),
      action TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete', 'apply', 'rollback')),
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending_approval' CHECK(state IN (
        'pending_approval', 'approved', 'applying', 'paused', 'verifying',
        'succeeded', 'rejected', 'cancelled', 'failed', 'unknown',
        'rolling_back', 'rolled_back', 'rollback_failed'
      )),
      plan_hash TEXT NOT NULL,
      plan_enc TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_enc TEXT NOT NULL,
      before_enc TEXT,
      rollback_enc TEXT,
      idempotency_key_hash TEXT NOT NULL,
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      rejected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approval_comment TEXT,
      rejection_reason TEXT,
      pause_requested_at TEXT,
      cancel_requested_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      error_code TEXT,
      error_message TEXT,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_placement_change_idempotency
      ON provider_placement_changes(host_id, idempotency_key_hash);
    CREATE INDEX IF NOT EXISTS idx_provider_placement_change_host
      ON provider_placement_changes(host_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_placement_change_due
      ON provider_placement_changes(state, lease_expires_at, updated_at);

    CREATE TABLE IF NOT EXISTS provider_placement_change_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL REFERENCES provider_placement_changes(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 19),
      wave_number INTEGER NOT NULL CHECK(wave_number BETWEEN 1 AND 20),
      vm_id TEXT NOT NULL,
      vm_name TEXT NOT NULL,
      source_host_id TEXT NOT NULL,
      target_host_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('live', 'cold', 'storage')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN (
        'pending', 'submitted', 'succeeded', 'deferred', 'failed', 'cancelled', 'unknown'
      )),
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      error_code TEXT,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(change_id, vm_id)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_placement_change_items
      ON provider_placement_change_items(change_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_provider_placement_change_item_operation
      ON provider_placement_change_items(operation_id);

    CREATE TABLE IF NOT EXISTS provider_placement_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL REFERENCES provider_placement_changes(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      state TEXT,
      phase TEXT,
      message TEXT,
      details_json TEXT,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_placement_change_events
      ON provider_placement_change_events(change_id, id);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_placement_change_events;
    DROP TABLE IF EXISTS provider_placement_change_items;
    DROP TABLE IF EXISTS provider_placement_changes;
  `);
};
