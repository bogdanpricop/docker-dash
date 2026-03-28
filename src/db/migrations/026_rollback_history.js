'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS container_image_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_name TEXT NOT NULL,
      container_id TEXT NOT NULL,
      host_id INTEGER NOT NULL DEFAULT 0,
      image_name TEXT NOT NULL,
      image_id TEXT NOT NULL,
      image_digest TEXT,
      action TEXT NOT NULL DEFAULT 'update',
      deployed_by TEXT,
      deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
      was_running INTEGER NOT NULL DEFAULT 1,
      config_snapshot TEXT
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_container_image_history_name ON container_image_history(container_name, host_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_container_image_history_deployed ON container_image_history(deployed_at)`);
};
