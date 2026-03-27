'use strict';

exports.up = function (db) {
  // Maintenance windows — scheduled update/scan/restart operations
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('container', 'stack', 'all')),
      target_names TEXT,
      actions TEXT NOT NULL DEFAULT '["pull","scan","update"]',
      block_on_critical INTEGER NOT NULL DEFAULT 1,
      notify_channels TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_result TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  // Status page — which containers to expose publicly
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_page_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_name TEXT NOT NULL,
      display_name TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      show_uptime INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Status page settings
  try { db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('status_page_enabled', 'false')`); } catch {}
  try { db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('status_page_title', 'Service Status')`); } catch {}
};
