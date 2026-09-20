'use strict';

// B015 — personal saved provider inventory views.
exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_inventory_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('virtual-machines')),
      provider_host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL,
      filters_json TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      sort_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_inventory_views_user_name
      ON provider_inventory_views(user_id, resource_type, name COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_inventory_views_default
      ON provider_inventory_views(user_id, resource_type) WHERE is_default = 1;
    CREATE INDEX IF NOT EXISTS idx_provider_inventory_views_user_resource
      ON provider_inventory_views(user_id, resource_type, updated_at DESC);
  `);
};

exports.down = function down() {};
