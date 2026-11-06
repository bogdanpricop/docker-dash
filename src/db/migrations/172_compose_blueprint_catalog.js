'use strict';

const PERMISSIONS = [
  ['compose_blueprint.view', 'compose_blueprint', 'view', 'View published Compose blueprints and immutable versions'],
  ['compose_blueprint.manage', 'compose_blueprint', 'manage', 'Manage Compose blueprint catalog and lifecycle'],
  ['compose_blueprint.instantiate', 'compose_blueprint', 'instantiate', 'Instantiate a pinned Compose blueprint on an approved host'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compose_blueprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'application',
      owner TEXT NOT NULL,
      support_level TEXT NOT NULL DEFAULT 'supported'
        CHECK(support_level IN ('community','supported','critical')),
      lifecycle TEXT NOT NULL DEFAULT 'draft'
        CHECK(lifecycle IN ('draft','active','deprecated','retired')),
      current_version_id INTEGER,
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS compose_blueprint_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blueprint_id INTEGER NOT NULL REFERENCES compose_blueprints(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      registry_id INTEGER NOT NULL REFERENCES registries(id),
      repository TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      digest TEXT NOT NULL,
      signature_policy TEXT NOT NULL DEFAULT 'none'
        CHECK(signature_policy IN ('none','annotation','cosign')),
      signer_pattern TEXT,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      parameter_schema_json TEXT NOT NULL DEFAULT '{"parameters":[]}',
      override_template_yaml TEXT NOT NULL DEFAULT '',
      compatibility_json TEXT NOT NULL DEFAULT '{}',
      operational_profile_json TEXT NOT NULL DEFAULT '{}',
      changelog TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'draft'
        CHECK(state IN ('draft','published','deprecated','retired')),
      version_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT,
      UNIQUE(blueprint_id, version)
    );

    CREATE TABLE IF NOT EXISTS compose_blueprint_instantiations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blueprint_version_id INTEGER NOT NULL REFERENCES compose_blueprint_versions(id),
      artifact_id INTEGER REFERENCES oci_compose_artifacts(id) ON DELETE SET NULL,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id),
      instance_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      environment TEXT NOT NULL,
      parameters_hash TEXT NOT NULL,
      rendered_override_hash TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'creating'
        CHECK(state IN ('creating','succeeded','failed')),
      error_code TEXT,
      error_message TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_compose_blueprint_versions_blueprint
      ON compose_blueprint_versions(blueprint_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compose_blueprint_versions_state
      ON compose_blueprint_versions(state, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compose_blueprint_instantiations_version
      ON compose_blueprint_instantiations(blueprint_version_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compose_blueprint_instantiations_host
      ON compose_blueprint_instantiations(host_id, created_at DESC);
  `);

  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS compose_blueprint_instantiations;
    DROP TABLE IF EXISTS compose_blueprint_versions;
    DROP TABLE IF EXISTS compose_blueprints;
  `);
  const remove = db.prepare('DELETE FROM governance_permissions WHERE permission_key=?');
  for (const [permissionKey] of PERMISSIONS) remove.run(permissionKey);
};

exports._PERMISSIONS = PERMISSIONS;
