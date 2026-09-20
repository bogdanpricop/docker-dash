'use strict';

// v8.73.0 — V5.8b signed connector marketplace and integration contracts.
const PERMISSIONS = [
  ['connector_marketplace.manage', 'connector_marketplace', 'manage', 'Register and inspect signed connector marketplace metadata'],
  ['connector_integrations.manage', 'connector_integration', 'manage', 'Manage secret-free connector policies, plans and normalized evidence'],
];

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_marketplace_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      publisher TEXT NOT NULL,
      support_level TEXT NOT NULL CHECK(support_level IN ('official','partner','community')),
      domains_json TEXT NOT NULL,
      products_json TEXT NOT NULL,
      allowed_hosts_json TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      signature_base64 TEXT NOT NULL,
      manifest_hash TEXT NOT NULL UNIQUE,
      signature_state TEXT NOT NULL CHECK(signature_state='verified'),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cmdb_connector_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('import','export','bidirectional')),
      resource_type TEXT NOT NULL,
      resource_ref TEXT NOT NULL,
      ownership_rules_json TEXT NOT NULL,
      changes_json TEXT NOT NULL,
      conflicts_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      plan_hash TEXT NOT NULL UNIQUE,
      external_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(external_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS itsm_connector_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      ticket_ref TEXT NOT NULL,
      ticket_url TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      approval_state TEXT NOT NULL CHECK(approval_state IN ('pending','approved','rejected')),
      evidence_links_json TEXT NOT NULL,
      gate_state TEXT NOT NULL CHECK(gate_state IN ('ready','outside_window','approval_required','rejected')),
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS siem_connector_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      destination_kind TEXT NOT NULL,
      schema_ref TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','high','critical')),
      envelope_json TEXT NOT NULL,
      envelope_hash TEXT NOT NULL UNIQUE,
      raw_payload_stored INTEGER NOT NULL DEFAULT 0 CHECK(raw_payload_stored=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS secret_manager_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      provider_kind TEXT NOT NULL,
      reference_uri TEXT NOT NULL,
      purpose TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      reference_hash TEXT NOT NULL UNIQUE,
      secret_material_stored INTEGER NOT NULL DEFAULT 0 CHECK(secret_material_stored=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ipam_dns_connector_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      provider_kind TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('allocate','reserve','release','create','update','delete')),
      resource_ref TEXT NOT NULL,
      record_type TEXT CHECK(record_type IN ('A','AAAA','PTR')),
      address TEXT,
      fqdn TEXT,
      ownership_token TEXT NOT NULL,
      expected_version TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      external_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(external_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS backup_connector_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      provider_kind TEXT NOT NULL,
      job_ref TEXT NOT NULL,
      workload_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','warning','failed','running','unknown')),
      last_run_at TEXT NOT NULL,
      recovery_points_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS monitoring_connector_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      provider_kind TEXT NOT NULL,
      endpoint_origin TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('pull','push','dashboard')),
      metric_allowlist_json TEXT NOT NULL,
      label_allowlist_json TEXT NOT NULL,
      secret_reference_id INTEGER REFERENCES secret_manager_references(id) ON DELETE SET NULL,
      target_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_bus_connector_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      provider_kind TEXT NOT NULL,
      channel TEXT NOT NULL,
      schema_ref TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      envelope_json TEXT NOT NULL,
      envelope_hash TEXT NOT NULL UNIQUE,
      delivery_state TEXT NOT NULL DEFAULT 'planned' CHECK(delivery_state='planned'),
      external_publishes_started INTEGER NOT NULL DEFAULT 0 CHECK(external_publishes_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS openapi_connector_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id INTEGER NOT NULL REFERENCES connector_marketplace_entries(id) ON DELETE CASCADE,
      operation_key TEXT NOT NULL,
      endpoint_origin TEXT NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('GET','POST','PUT','PATCH','DELETE')),
      path TEXT NOT NULL,
      risk TEXT NOT NULL CHECK(risk IN ('read','action')),
      allowed_query_json TEXT NOT NULL,
      allowed_body_json TEXT NOT NULL,
      response_schema_hash TEXT NOT NULL,
      operation_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(connector_id,operation_key)
    );
    CREATE INDEX IF NOT EXISTS idx_connector_marketplace_support ON connector_marketplace_entries(support_level,connector_key);
    CREATE INDEX IF NOT EXISTS idx_cmdb_connector_resource ON cmdb_connector_syncs(resource_type,resource_ref,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_backup_connector_workload ON backup_connector_observations(workload_ref,last_run_at DESC);
    CREATE INDEX IF NOT EXISTS idx_event_bus_connector_channel ON event_bus_connector_publications(channel,created_at DESC);
  `);
  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
  const role = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (role) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(role.id, permission[0]);
  }
};

exports._PERMISSIONS = PERMISSIONS;
