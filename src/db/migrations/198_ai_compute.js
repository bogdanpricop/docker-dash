'use strict';

exports.up = db => db.exec(`
  CREATE TABLE ai_compute_hosts (
    host_id INTEGER PRIMARY KEY REFERENCES docker_hosts(id) ON DELETE CASCADE,
    monitoring INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_compute_samples (
    host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
    bucket INTEGER NOT NULL, sampled_at TEXT NOT NULL, sample_json TEXT NOT NULL,
    PRIMARY KEY(host_id, bucket)
  );
  CREATE TABLE ai_compute_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
    container_id TEXT NOT NULL, name TEXT NOT NULL, engine TEXT NOT NULL, model TEXT,
    memory_bytes INTEGER NOT NULL, ready_port INTEGER, restart_policy TEXT NOT NULL,
    exclusive INTEGER NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL, UNIQUE(host_id, container_id)
  );
  CREATE TABLE ai_compute_jobs (
    id TEXT PRIMARY KEY, host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
    status TEXT NOT NULL, plan_json TEXT NOT NULL, stopped_json TEXT NOT NULL DEFAULT '[]',
    created_container TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX ai_compute_host_job ON ai_compute_jobs(host_id) WHERE status IN ('queued','running','needs_review');
  CREATE INDEX ai_compute_job_history ON ai_compute_jobs(host_id, created_at DESC);
`);
