'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS container_groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      color       TEXT DEFAULT '#388bfd',
      icon        TEXT DEFAULT 'fas fa-folder',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      scope       TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'user')),
      user_id     INTEGER REFERENCES users(id),
      created_by  INTEGER NOT NULL REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS container_group_members (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id      INTEGER NOT NULL REFERENCES container_groups(id) ON DELETE CASCADE,
      container_id  TEXT NOT NULL,
      added_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, container_id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_cgm_group ON container_group_members(group_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cgm_container ON container_group_members(container_id)`);
};
