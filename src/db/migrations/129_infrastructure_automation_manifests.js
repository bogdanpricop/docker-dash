'use strict';

const PERMISSIONS = [
  ['infrastructure_automation.manage', 'infrastructure_automation', 'manage', 'Manage infrastructure manifests, plans, workflow DAGs and job links'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS infrastructure_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_kind TEXT NOT NULL CHECK(manifest_kind IN ('vm','host','fabric')),
      name TEXT NOT NULL,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      resource_id TEXT,
      schema_version TEXT NOT NULL DEFAULT 'docker-dash.io/v1alpha1',
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      authoritative INTEGER NOT NULL DEFAULT 0,
      document_json TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      resource_versions_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(manifest_kind,provider_host_id,name)
    );
    CREATE INDEX IF NOT EXISTS idx_infrastructure_manifests_target
      ON infrastructure_manifests(provider_host_id,manifest_kind,resource_id);

    CREATE TABLE IF NOT EXISTS infrastructure_change_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_id INTEGER NOT NULL REFERENCES infrastructure_manifests(id) ON DELETE CASCADE,
      manifest_revision INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      versions_hash TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','stale','accepted','superseded')),
      actions_json TEXT NOT NULL,
      blocked_json TEXT NOT NULL DEFAULT '[]',
      summary_json TEXT NOT NULL,
      resource_versions_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL,
      accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_infrastructure_change_plans_manifest
      ON infrastructure_change_plans(manifest_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS infrastructure_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name,version)
    );

    CREATE TABLE IF NOT EXISTS infrastructure_plan_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES infrastructure_change_plans(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL REFERENCES provider_operations(id) ON DELETE CASCADE,
      step_id TEXT,
      relation TEXT NOT NULL DEFAULT 'executes' CHECK(relation IN ('executes','verifies','compensates')),
      linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(plan_id,operation_id,relation)
    );
  `);

  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)')
    .run(siteAdmin.id, PERMISSIONS[0][0]);
};

exports._PERMISSIONS = PERMISSIONS;
