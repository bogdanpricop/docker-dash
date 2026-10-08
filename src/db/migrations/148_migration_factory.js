'use strict';

// v8.74.0 — V6.7 migration factory evidence and guarded orchestration plans.
const PERMISSIONS = [
  ['migration_factory.manage', 'migration_factory', 'manage', 'Create migration assessments, mappings, conversion and test-clone evidence'],
  ['migration_cutover.manage', 'migration_cutover', 'manage', 'Create approved cutover, rollback and evidence-report plans'],
];

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_factory_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_provider TEXT NOT NULL,
      target_provider TEXT NOT NULL,
      inventory_json TEXT NOT NULL,
      inventory_hash TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      assessment_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_conversion_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL REFERENCES migration_factory_assessments(id) ON DELETE CASCADE,
      input_format TEXT NOT NULL,
      output_format TEXT NOT NULL,
      tool TEXT NOT NULL CHECK(tool IN ('qemu-img','virt-v2v')),
      input_checksum_sha256 TEXT NOT NULL,
      expected_output_checksum_sha256 TEXT NOT NULL,
      request_hash TEXT NOT NULL UNIQUE,
      sandbox_policy_json TEXT NOT NULL,
      worker_response_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'planned' CHECK(state='planned'),
      out_of_process INTEGER NOT NULL CHECK(out_of_process=1),
      disk_io_started INTEGER NOT NULL DEFAULT 0 CHECK(disk_io_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_network_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL REFERENCES migration_factory_assessments(id) ON DELETE CASCADE,
      mappings_json TEXT NOT NULL,
      conflicts_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_storage_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL REFERENCES migration_factory_assessments(id) ON DELETE CASCADE,
      mappings_json TEXT NOT NULL,
      reservations_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_test_clones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL REFERENCES migration_factory_assessments(id) ON DELETE CASCADE,
      network_mapping_id INTEGER NOT NULL REFERENCES migration_network_mappings(id),
      storage_mapping_id INTEGER NOT NULL REFERENCES migration_storage_mappings(id),
      target_ref TEXT NOT NULL,
      isolation_mode TEXT NOT NULL CHECK(isolation_mode IN ('isolated','no_uplink','sandbox')),
      checks_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('validated','blocked')),
      source_cutover_started INTEGER NOT NULL DEFAULT 0 CHECK(source_cutover_started=0),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_wave_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL REFERENCES migration_factory_assessments(id) ON DELETE CASCADE,
      max_concurrent INTEGER NOT NULL,
      waves_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      plan_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_cutover_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL REFERENCES migration_factory_assessments(id) ON DELETE CASCADE,
      wave_plan_id INTEGER NOT NULL REFERENCES migration_wave_plans(id),
      test_clone_id INTEGER NOT NULL REFERENCES migration_test_clones(id),
      target_ref TEXT NOT NULL,
      approval_hash TEXT NOT NULL,
      confirmation_hash TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'ready' CHECK(state='ready'),
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_rollback_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cutover_plan_id INTEGER NOT NULL REFERENCES migration_cutover_plans(id) ON DELETE CASCADE,
      trigger_reason TEXT NOT NULL,
      preconditions_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_evidence_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER NOT NULL REFERENCES migration_factory_assessments(id) ON DELETE CASCADE,
      references_json TEXT NOT NULL,
      timings_json TEXT NOT NULL,
      tests_json TEXT NOT NULL,
      approvals_json TEXT NOT NULL,
      report_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS legacy_xen_migration_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_ref TEXT NOT NULL,
      toolstack TEXT NOT NULL CHECK(toolstack IN ('xm','xl','xend','mixed')),
      version TEXT NOT NULL,
      inventory_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      target_candidates_json TEXT NOT NULL,
      guided_steps_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      assessment_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_migration_assessment_provider ON migration_factory_assessments(source_provider,target_provider,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_migration_conversion_assessment ON migration_conversion_jobs(assessment_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_migration_cutover_assessment ON migration_cutover_plans(assessment_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_legacy_xen_host ON legacy_xen_migration_assessments(host_ref,created_at DESC);
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
