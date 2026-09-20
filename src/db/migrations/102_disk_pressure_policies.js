'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS disk_pressure_policies (
      host_id INTEGER PRIMARY KEY REFERENCES docker_hosts(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      dry_run_only INTEGER NOT NULL DEFAULT 1,
      threshold_percent INTEGER NOT NULL DEFAULT 85,
      max_docker_bytes INTEGER,
      min_age_hours INTEGER NOT NULL DEFAULT 168,
      prune_containers INTEGER NOT NULL DEFAULT 1,
      prune_images INTEGER NOT NULL DEFAULT 1,
      prune_networks INTEGER NOT NULL DEFAULT 0,
      prune_build_cache INTEGER NOT NULL DEFAULT 0,
      protected_label TEXT NOT NULL DEFAULT 'docker-dash.protect',
      cooldown_minutes INTEGER NOT NULL DEFAULT 360,
      last_run_at TEXT,
      last_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS disk_pressure_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      trigger_type TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 1,
      threshold_met INTEGER NOT NULL DEFAULT 0,
      docker_bytes INTEGER NOT NULL DEFAULT 0,
      candidates_json TEXT NOT NULL DEFAULT '{}',
      reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_disk_pressure_runs_host
      ON disk_pressure_runs(host_id, created_at DESC);
  `);
};

