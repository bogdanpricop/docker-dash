'use strict';
exports.up = db => db.exec(`CREATE TABLE IF NOT EXISTS provider_network_drift_baselines (
  host_id INTEGER PRIMARY KEY REFERENCES docker_hosts(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL, baseline_hash TEXT NOT NULL, network_count INTEGER NOT NULL,
  baseline_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
exports.down = db => db.exec('DROP TABLE IF EXISTS provider_network_drift_baselines');
