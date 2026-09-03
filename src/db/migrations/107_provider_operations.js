'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_operations (
      id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL DEFAULT '1.0',
      operation_type TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      action TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN (
        'queued', 'running', 'waiting_retry', 'reconciling',
        'cancel_requested', 'succeeded', 'failed', 'cancelled', 'unknown'
      )),
      phase TEXT,
      progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      request_hash TEXT NOT NULL,
      request_enc TEXT NOT NULL,
      idempotency_key_hash TEXT,
      lock_scopes_json TEXT NOT NULL DEFAULT '[]',
      retry_policy TEXT NOT NULL DEFAULT 'none' CHECK(retry_policy IN ('none', 'transient', 'resilient')),
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1 CHECK(max_attempts BETWEEN 1 AND 10),
      timeout_seconds INTEGER NOT NULL DEFAULT 300 CHECK(timeout_seconds BETWEEN 1 AND 86400),
      available_at TEXT NOT NULL DEFAULT (datetime('now')),
      lease_owner TEXT,
      lease_expires_at TEXT,
      native_task_ref_hash TEXT,
      native_task_ref_enc TEXT,
      native_task_state TEXT,
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      resolution TEXT CHECK(resolution IN ('succeeded', 'failed', 'cancelled')),
      resolution_evidence TEXT,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      cancel_requested_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_operations_idempotency
      ON provider_operations(host_id, operation_type, idempotency_key_hash)
      WHERE idempotency_key_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_operations_due
      ON provider_operations(state, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_provider_operations_host
      ON provider_operations(host_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_operations_resource
      ON provider_operations(resource_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_operation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL REFERENCES provider_operations(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      state TEXT,
      phase TEXT,
      progress INTEGER CHECK(progress BETWEEN 0 AND 100),
      message TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_operation_events_operation
      ON provider_operation_events(operation_id, id);

    CREATE TABLE IF NOT EXISTS provider_operation_locks (
      scope_key TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES provider_operations(id) ON DELETE CASCADE,
      lease_owner TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_operation_locks_operation
      ON provider_operation_locks(operation_id);
    CREATE INDEX IF NOT EXISTS idx_provider_operation_locks_expiry
      ON provider_operation_locks(lease_expires_at);

    CREATE TABLE IF NOT EXISTS provider_operation_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('global', 'provider', 'host')),
      scope_key TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'active' CHECK(mode IN ('active', 'read_only', 'emergency_stop', 'frozen')),
      reason TEXT,
      freeze_starts_at TEXT,
      freeze_ends_at TEXT,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scope_type, scope_key)
    );

    INSERT OR IGNORE INTO provider_operation_policies (scope_type, scope_key, mode)
      VALUES ('global', '*', 'active');
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_operation_locks;
    DROP TABLE IF EXISTS provider_operation_events;
    DROP TABLE IF EXISTS provider_operations;
    DROP TABLE IF EXISTS provider_operation_policies;
  `);
};
