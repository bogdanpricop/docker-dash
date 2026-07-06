'use strict';

// v8.9.8-alpha.1 — Portainer G06 closure: per-container webhook trigger URLs.
// A CI job / Docker Hub webhook / manual curl POSTs to a random-token URL
// and docker-dash pulls the image + recreates the container.
// Unauthenticated by design (CI systems can't easily present a bearer
// token); the 32-byte random token IS the auth. Rate-limited.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS container_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      container_id TEXT NOT NULL,
      container_name TEXT,
      token TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL DEFAULT 'recreate' CHECK(action IN ('recreate', 'restart', 'pull-only')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_triggered_at TEXT,
      last_triggered_ip TEXT,
      trigger_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_container_webhooks_host_ct
      ON container_webhooks(host_id, container_id);
    CREATE INDEX IF NOT EXISTS idx_container_webhooks_token
      ON container_webhooks(token);
  `);
};
