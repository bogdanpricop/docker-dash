'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('discord', 'slack', 'telegram', 'ntfy', 'gotify', 'email', 'webhook')),
      config_encrypted TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
};
