'use strict';

const PERMISSIONS = [
  ['finops_sustainability.manage', 'finops_sustainability', 'manage', 'Manage power, energy and carbon evidence'],
  ['finops_tco.manage', 'finops_tco', 'manage', 'Create explanatory TCO comparison scenarios'],
  ['kubernetes_virtualization.manage', 'kubernetes_virtualization', 'manage', 'Inspect virtualization CRDs and run non-persistent VM YAML validation'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finops_power_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_ref TEXT NOT NULL,
      site_ref TEXT NOT NULL,
      interval_start TEXT NOT NULL,
      interval_end TEXT NOT NULL,
      average_watts REAL NOT NULL CHECK(average_watts >= 0),
      peak_watts REAL NOT NULL CHECK(peak_watts >= average_watts),
      energy_kwh REAL NOT NULL CHECK(energy_kwh >= 0),
      cpu_utilization_percent REAL,
      vm_count INTEGER NOT NULL DEFAULT 0 CHECK(vm_count >= 0),
      workload_count INTEGER NOT NULL DEFAULT 0 CHECK(workload_count >= 0),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('bmc','vendor','meter','manual','import')),
      provenance_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      sample_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS finops_carbon_factors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_ref TEXT NOT NULL,
      region TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      grams_co2e_per_kwh REAL NOT NULL CHECK(grams_co2e_per_kwh >= 0),
      source_url TEXT NOT NULL,
      methodology TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      factor_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS finops_carbon_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workload_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('recommended','blocked','unknown')),
      current_json TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      selected_json TEXT,
      constraints_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      recommendation_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS finops_tco_scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      horizon_months INTEGER NOT NULL CHECK(horizon_months BETWEEN 1 AND 120),
      currency TEXT NOT NULL,
      assumptions_json TEXT NOT NULL,
      ranking_json TEXT NOT NULL,
      selected_option TEXT,
      scenario_hash TEXT NOT NULL UNIQUE,
      billing_transactions_created INTEGER NOT NULL DEFAULT 0 CHECK(billing_transactions_created = 0),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_virtualization_capability_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_virtualization_inventory_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      namespace_scope TEXT,
      vm_count INTEGER NOT NULL,
      vmi_count INTEGER NOT NULL,
      migration_count INTEGER NOT NULL,
      inventory_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_virtualization_dry_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      vm_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('valid','rejected')),
      original_hash TEXT NOT NULL,
      desired_hash TEXT NOT NULL,
      diff_text TEXT NOT NULL,
      server_response_json TEXT NOT NULL,
      validation_hash TEXT NOT NULL UNIQUE,
      applied INTEGER NOT NULL DEFAULT 0 CHECK(applied = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_finops_power_host_time ON finops_power_telemetry(host_ref,interval_end);
    CREATE INDEX IF NOT EXISTS idx_finops_carbon_site_time ON finops_carbon_factors(site_ref,effective_from);
    CREATE INDEX IF NOT EXISTS idx_kubevirt_capability_host ON kubernetes_virtualization_capability_snapshots(host_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_kubevirt_inventory_host ON kubernetes_virtualization_inventory_snapshots(host_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_kubevirt_dry_run_vm ON kubernetes_virtualization_dry_runs(host_id,namespace,vm_name,created_at);
  `);

  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(siteAdmin.id, permission[0]);
  }
};

exports._PERMISSIONS = PERMISSIONS;
