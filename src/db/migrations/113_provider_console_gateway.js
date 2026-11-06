'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_console_access_locks (
      scope_key TEXT PRIMARY KEY,
      host_id INTEGER REFERENCES docker_hosts(id) ON DELETE CASCADE,
      resource_id TEXT,
      reason TEXT NOT NULL DEFAULT '',
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (scope_key = 'global' AND host_id IS NULL AND resource_id IS NULL)
        OR (scope_key = 'host:' || host_id AND host_id IS NOT NULL AND resource_id IS NULL)
        OR (scope_key = 'vm:' || host_id || ':' || resource_id
          AND host_id IS NOT NULL AND resource_id GLOB 'ddr_vm_[0-9a-f]*')
      )
    );

    CREATE INDEX IF NOT EXISTS idx_provider_console_locks_host
      ON provider_console_access_locks(host_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_console_locks_vm
      ON provider_console_access_locks(host_id, resource_id)
      WHERE resource_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS provider_console_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      protocol TEXT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      connected_at TEXT,
      closed_at TEXT,
      close_code TEXT,
      CHECK (resource_id GLOB 'ddr_vm_[0-9a-f]*'),
      CHECK (provider_type GLOB '[a-z]*'),
      CHECK (protocol IS NULL OR protocol IN ('rfb', 'serial'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_console_sessions_user
      ON provider_console_sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_console_sessions_scope
      ON provider_console_sessions(host_id, resource_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_console_sessions_expiry
      ON provider_console_sessions(expires_at, consumed_at);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_console_sessions;
    DROP TABLE IF EXISTS provider_console_access_locks;
  `);
};
