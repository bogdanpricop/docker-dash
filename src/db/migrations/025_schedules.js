'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_actions (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      container_name TEXT NOT NULL DEFAULT '',
      host_id INTEGER NOT NULL DEFAULT 0,
      action TEXT NOT NULL,
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      description TEXT DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_run_at TEXT,
      last_run_status TEXT,
      last_run_error TEXT,
      run_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      container_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      duration_ms INTEGER,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_schedule_history_schedule_id ON schedule_history(schedule_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_schedule_history_executed_at ON schedule_history(executed_at)`);

  // Migrate existing JSON schedules if they exist
  const fs = require('fs');
  const schedulesFile = '/data/schedules.json';
  try {
    if (fs.existsSync(schedulesFile)) {
      const schedules = JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
      const insert = db.prepare(`
        INSERT OR IGNORE INTO scheduled_actions (id, container_id, container_name, action, cron, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of schedules) {
        insert.run(s.id, s.containerId, s.containerName || '', s.action, s.cron, s.enabled ? 1 : 0, s.createdAt || new Date().toISOString());
      }
    }
  } catch { /* ignore migration errors */ }
};
