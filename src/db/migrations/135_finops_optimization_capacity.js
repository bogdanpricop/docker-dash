'use strict';

const PERMISSIONS = [
  ['finops_alerts.manage', 'finops_alert', 'manage', 'Manage budget threshold and cost anomaly evidence'],
  ['finops_optimization.manage', 'finops_optimization', 'manage', 'Manage advisory optimization assessments and gated savings schedules'],
  ['finops_capacity.manage', 'finops_capacity', 'manage', 'Manage reservation, consolidation, forecast and placement scenarios'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finops_budget_alert_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      budget_id INTEGER REFERENCES finops_budgets(id) ON DELETE CASCADE,
      thresholds_json TEXT NOT NULL,
      forecast_enabled INTEGER NOT NULL DEFAULT 1 CHECK(forecast_enabled IN (0,1)),
      channels_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      policy_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finops_budget_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES finops_budget_alert_policies(id) ON DELETE CASCADE,
      budget_id INTEGER NOT NULL REFERENCES finops_budgets(id) ON DELETE CASCADE,
      rating_run_id INTEGER NOT NULL REFERENCES finops_rating_runs(id) ON DELETE CASCADE,
      signal TEXT NOT NULL CHECK(signal IN ('actual','forecast')),
      threshold_percent REAL NOT NULL,
      observed_percent REAL NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
      notification_state TEXT NOT NULL DEFAULT 'queued' CHECK(notification_state IN ('queued','acknowledged','resolved')),
      evidence_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS finops_cost_anomaly_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('global','category','cost_center')),
      scope_value TEXT,
      baseline_runs INTEGER NOT NULL CHECK(baseline_runs BETWEEN 2 AND 24),
      minimum_deviation_percent REAL NOT NULL CHECK(minimum_deviation_percent > 0),
      minimum_amount REAL NOT NULL DEFAULT 0 CHECK(minimum_amount >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      policy_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finops_cost_anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES finops_cost_anomaly_policies(id) ON DELETE CASCADE,
      rating_run_id INTEGER NOT NULL REFERENCES finops_rating_runs(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('increase','decrease')),
      current_amount REAL NOT NULL,
      baseline_amount REAL NOT NULL,
      deviation_percent REAL NOT NULL,
      confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
      evidence_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS finops_optimization_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_type TEXT NOT NULL CHECK(assessment_type IN ('idle_vm','oversized_vm','zombie_resource')),
      ledger_entry_id INTEGER REFERENCES finops_resource_ledger(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_ref TEXT NOT NULL,
      state TEXT NOT NULL,
      owner TEXT,
      criticality TEXT,
      confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high','unknown')),
      evidence_json TEXT NOT NULL,
      recommendation_json TEXT NOT NULL,
      assessment_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS finops_savings_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      resource_ref TEXT NOT NULL,
      timezone TEXT NOT NULL,
      weekdays_json TEXT NOT NULL,
      off_hours_start TEXT NOT NULL,
      off_hours_end TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('recommend','automate')),
      adapter_key TEXT NOT NULL,
      owner TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      schedule_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finops_savings_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL REFERENCES finops_savings_schedules(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('stop','start')),
      scheduled_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('recommended','unsupported','succeeded','failed')),
      operation_id TEXT,
      approval_id INTEGER,
      evidence_json TEXT NOT NULL,
      execution_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS finops_reserved_capacity_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_ref TEXT NOT NULL,
      recommendation_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finops_consolidation_scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      removed_host_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('safe','blocked','unknown')),
      result_json TEXT NOT NULL,
      scenario_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finops_capacity_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_ref TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      forecast_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finops_placement_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workload_ref TEXT NOT NULL,
      selected_target_ref TEXT,
      ranking_json TEXT NOT NULL,
      weights_json TEXT NOT NULL,
      score_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
