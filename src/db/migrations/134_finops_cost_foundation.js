'use strict';

const PERMISSIONS = [
  ['finops_ledger.manage', 'finops_ledger', 'manage', 'Manage immutable allocation and usage observations'],
  ['finops_cost.manage', 'finops_cost_model', 'manage', 'Manage versioned infrastructure cost models and allocation rules'],
  ['finops_reporting.manage', 'finops_report', 'manage', 'Create showback ratings and chargeback exports'],
  ['finops_budget.manage', 'finops_budget', 'manage', 'Manage scoped monthly and quarterly budgets'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finops_resource_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_type TEXT NOT NULL,
      resource_ref TEXT NOT NULL,
      provider_ref TEXT,
      site_ref TEXT,
      interval_start TEXT NOT NULL,
      interval_end TEXT NOT NULL,
      allocation_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      evidence_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_finops_ledger_interval
      ON finops_resource_ledger(interval_start,interval_end);
    CREATE INDEX IF NOT EXISTS idx_finops_ledger_resource
      ON finops_resource_ledger(resource_type,resource_ref);

    CREATE TABLE IF NOT EXISTS finops_cost_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('private_cloud','provider_license','storage','network','gpu')),
      scope_ref TEXT NOT NULL DEFAULT '*',
      currency TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK(confidence IN ('actual','contracted','estimated','allocated')),
      parameters_json TEXT NOT NULL,
      source_url TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      model_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name,version)
    );
    CREATE INDEX IF NOT EXISTS idx_finops_cost_models_window
      ON finops_cost_models(kind,effective_from,effective_to);

    CREATE TABLE IF NOT EXISTS finops_allocation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      priority INTEGER NOT NULL DEFAULT 100,
      match_tags_json TEXT NOT NULL,
      dimensions_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      rule_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finops_resource_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_entry_id INTEGER NOT NULL UNIQUE REFERENCES finops_resource_ledger(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('allocated','partial','unallocated')),
      matched_rule_ids_json TEXT NOT NULL,
      dimensions_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS finops_rating_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      currency TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('completed','empty')),
      input_hash TEXT NOT NULL UNIQUE,
      total_cost REAL NOT NULL DEFAULT 0 CHECK(total_cost >= 0),
      summary_json TEXT NOT NULL,
      billing_transaction_created INTEGER NOT NULL DEFAULT 0 CHECK(billing_transaction_created = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finops_rated_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rating_run_id INTEGER NOT NULL REFERENCES finops_rating_runs(id) ON DELETE CASCADE,
      ledger_entry_id INTEGER NOT NULL REFERENCES finops_resource_ledger(id) ON DELETE RESTRICT,
      cost_model_id INTEGER NOT NULL REFERENCES finops_cost_models(id) ON DELETE RESTRICT,
      category TEXT NOT NULL,
      quantity REAL NOT NULL CHECK(quantity >= 0),
      unit TEXT NOT NULL,
      rate REAL NOT NULL CHECK(rate >= 0),
      amount REAL NOT NULL CHECK(amount >= 0),
      currency TEXT NOT NULL,
      confidence TEXT NOT NULL,
      dimensions_json TEXT NOT NULL,
      formula_json TEXT NOT NULL,
      provenance_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(rating_run_id,ledger_entry_id,cost_model_id,category)
    );
    CREATE INDEX IF NOT EXISTS idx_finops_rated_usage_run ON finops_rated_usage(rating_run_id);

    CREATE TABLE IF NOT EXISTS finops_chargeback_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rating_run_id INTEGER NOT NULL REFERENCES finops_rating_runs(id) ON DELETE RESTRICT,
      format TEXT NOT NULL CHECK(format IN ('csv','json')),
      state TEXT NOT NULL DEFAULT 'generated' CHECK(state = 'generated'),
      export_hash TEXT NOT NULL UNIQUE,
      row_count INTEGER NOT NULL CHECK(row_count >= 0),
      total_cost REAL NOT NULL CHECK(total_cost >= 0),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      billing_transaction_created INTEGER NOT NULL DEFAULT 0 CHECK(billing_transaction_created = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(rating_run_id,format)
    );

    CREATE TABLE IF NOT EXISTS finops_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cadence TEXT NOT NULL CHECK(cadence IN ('monthly','quarterly')),
      scope_type TEXT NOT NULL CHECK(scope_type IN ('global','cost_center','business_unit','application','environment','project','site')),
      scope_value TEXT,
      amount REAL NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      budget_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name,effective_from)
    );
    CREATE INDEX IF NOT EXISTS idx_finops_budgets_scope
      ON finops_budgets(scope_type,scope_value,effective_from,effective_to);
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
