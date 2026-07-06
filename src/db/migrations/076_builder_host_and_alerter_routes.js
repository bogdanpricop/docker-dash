'use strict';

// v8.9.9-alpha.1 — Multiple small gap closures rolled into one migration:
// - Komodo G05 (builder host) — add is_builder + default_registry_id columns
//   to docker_hosts.
// - Komodo G09 (alerter routing) — add alert_channel_routes table.

exports.up = function (db) {
  // Komodo G05: builder host columns.
  const cols = db.prepare('PRAGMA table_info(docker_hosts)').all();
  const has = (name) => cols.some(c => c.name === name);
  if (!has('is_builder')) {
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN is_builder INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!has('default_registry_id')) {
    // Registry FK is soft (no REFERENCES constraint) because container_registries
    // may have a different name in some deployments; the app enforces it.
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN default_registry_id INTEGER;`);
  }

  // Komodo G09: alerter routing table. scope_type: 'all' | 'host' | 'host_group'
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_channel_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('all', 'host', 'host_group')),
      scope_id INTEGER,
      channel_id INTEGER NOT NULL,
      severity_min TEXT DEFAULT 'info' CHECK(severity_min IN ('info', 'warning', 'critical')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_alert_channel_routes_scope
      ON alert_channel_routes(scope_type, scope_id);
  `);
};
