'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_access_locks (
      scope_key TEXT PRIMARY KEY,
      host_id INTEGER UNIQUE REFERENCES docker_hosts(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT '',
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (scope_key = 'global' AND host_id IS NULL)
        OR (scope_key = 'host:' || host_id AND host_id IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_terminal_access_locks_host
      ON terminal_access_locks(host_id);
  `);
};

exports.down = function (db) {
  db.exec('DROP TABLE IF EXISTS terminal_access_locks');
};
