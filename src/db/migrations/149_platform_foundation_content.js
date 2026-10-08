'use strict';

// v8.75.0 — B011/B012/B016/B017/B019/B020/B023/B034/B036/B038/B039/B040.
const PERMISSIONS = [
  ['platform_inventory.manage', 'platform_inventory', 'manage', 'Manage normalized events, delta inventory, collections, graphs and hygiene evidence'],
  ['platform_metadata.manage', 'platform_metadata', 'manage', 'Manage typed resource metadata schemas and values'],
  ['platform_content.manage', 'platform_content', 'manage', 'Manage clone, customization, flavor and image control-plane plans'],
];

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS normalized_provider_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL,
      provider_type TEXT NOT NULL,
      cursor TEXT NOT NULL,
      native_event_id TEXT,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('debug','info','warning','error','critical')),
      resource_key TEXT,
      occurred_at TEXT NOT NULL,
      message TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id,cursor)
    );
    CREATE TABLE IF NOT EXISTS inventory_delta_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL,
      previous_cursor TEXT,
      cursor TEXT NOT NULL,
      added_json TEXT NOT NULL,
      updated_json TEXT NOT NULL,
      removed_json TEXT NOT NULL,
      delta_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id,resource_type,cursor)
    );
    CREATE TABLE IF NOT EXISTS dynamic_resource_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      selectors_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      definition_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS custom_metadata_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK(value_type IN ('string','integer','boolean','enum','url','date')),
      resource_types_json TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
      enum_values_json TEXT NOT NULL DEFAULT '[]',
      sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public','internal','confidential')),
      version INTEGER NOT NULL DEFAULT 1,
      schema_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS custom_metadata_values (
      resource_key TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      schema_key TEXT NOT NULL REFERENCES custom_metadata_schemas(schema_key) ON DELETE RESTRICT,
      value_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      value_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(resource_key,schema_key)
    );
    CREATE TABLE IF NOT EXISTS resource_relationship_graphs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      edges_json TEXT NOT NULL,
      graph_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS resource_hygiene_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      scan_hash TEXT NOT NULL UNIQUE,
      cleanup_started INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS provider_rate_limit_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL,
      endpoint_key TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('available','degraded','exhausted')),
      recommended_concurrency INTEGER NOT NULL,
      budget_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS linked_clone_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_type TEXT NOT NULL,
      source_artifact_key TEXT NOT NULL,
      target_name TEXT NOT NULL,
      target_storage TEXT NOT NULL,
      backing_depth INTEGER NOT NULL,
      blockers_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS guest_customization_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      os_family TEXT NOT NULL CHECK(os_family IN ('linux','windows')),
      settings_json TEXT NOT NULL,
      secret_refs_json TEXT NOT NULL,
      profile_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name,version)
    );
    CREATE TABLE IF NOT EXISTS flavor_offering_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_key TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      requirements_json TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      selected_offering_key TEXT,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      mapping_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS image_library_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL,
      provider_type TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      image_kind TEXT NOT NULL,
      name TEXT NOT NULL,
      digest_sha256 TEXT,
      size_bytes INTEGER,
      format TEXT,
      provenance_json TEXT NOT NULL,
      observation_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS image_upload_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      total_bytes INTEGER NOT NULL,
      chunk_size INTEGER NOT NULL,
      expected_sha256 TEXT NOT NULL,
      observed_sha256 TEXT,
      input_format TEXT NOT NULL,
      target_format TEXT NOT NULL,
      destination_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('uploading','ready','blocked')),
      plan_hash TEXT,
      data_bytes_stored INTEGER NOT NULL DEFAULT 0 CHECK(data_bytes_stored=0),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS image_upload_chunk_receipts (
      session_id INTEGER NOT NULL REFERENCES image_upload_sessions(id) ON DELETE CASCADE,
      offset_bytes INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      chunk_sha256 TEXT NOT NULL,
      receipt_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(session_id,offset_bytes)
    );
    CREATE INDEX IF NOT EXISTS idx_common_events_provider_cursor ON normalized_provider_events(provider_host_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_delta_sync_provider_type ON inventory_delta_syncs(provider_host_id,resource_type,id DESC);
    CREATE INDEX IF NOT EXISTS idx_metadata_values_resource ON custom_metadata_values(resource_key,resource_type);
    CREATE INDEX IF NOT EXISTS idx_rate_budget_endpoint ON provider_rate_limit_budgets(provider_host_id,endpoint_key,id DESC);
    CREATE INDEX IF NOT EXISTS idx_image_library_provider ON image_library_observations(provider_host_id,image_kind,observed_at DESC);
  `);
  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
};

exports.down = function down() {};
