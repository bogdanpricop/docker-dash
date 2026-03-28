'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployment_pipelines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id TEXT NOT NULL,
      container_name TEXT NOT NULL,
      host_id INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      stages_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      started_by TEXT,
      rollback_of INTEGER,
      image_before TEXT,
      image_after TEXT,
      error TEXT
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_deployment_pipelines_container ON deployment_pipelines(container_name, host_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deployment_pipelines_started ON deployment_pipelines(started_at)`);
};
