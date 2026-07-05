'use strict';

// v8.9.7-alpha.1 — Gap Closure Portainer G03 + Komodo G02.
// Host groups: bulk-apply tags + filter for fleet operators. Different from
// container_groups (per-user, per-container). host_groups are global.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT DEFAULT '#6366f1',
      icon TEXT DEFAULT 'fa-server',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS host_group_members (
      group_id INTEGER NOT NULL REFERENCES host_groups(id) ON DELETE CASCADE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, host_id)
    );

    CREATE INDEX IF NOT EXISTS idx_host_group_members_host ON host_group_members(host_id);
  `);
};
