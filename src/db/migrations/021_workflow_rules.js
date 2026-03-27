'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('cpu_high', 'mem_high', 'container_exit', 'container_unhealthy', 'container_restart_loop', 'image_vulnerable')),
      trigger_config TEXT NOT NULL DEFAULT '{}',
      action_type TEXT NOT NULL CHECK(action_type IN ('notify', 'restart', 'stop', 'pull_update', 'webhook', 'exec_command')),
      action_config TEXT NOT NULL DEFAULT '{}',
      target TEXT NOT NULL DEFAULT '*',
      cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_triggered_at TEXT,
      trigger_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_active ON workflow_rules(is_active)`);
};
