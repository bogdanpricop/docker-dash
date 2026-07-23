'use strict';

// v8.17.0 (Onboarding & Provisioning Wizard — Phase 3) — Demo/Trial seed subsystem.
//
// Three new tables + one guarded, uniform `seed_run_id` tag column on the
// SEED_TABLES allow-list. See plans/onboarding-mockdata.md §3/§4 and
// plans/onboarding-architecture.md §1.6/§1.7.
//
//   seed_datasets        — one row per generated batch (profile/scenario/seed/status)
//   seed_dataset_tables  — the PURGE MANIFEST: which tables the batch touched,
//                          with the insert order so purge can walk it in reverse
//   seed_containers      — the synthetic container ROSTER. docker-dash has no
//                          container-inventory table (identity lives in the live
//                          Docker API); demo mode has no daemon, so this roster is
//                          the single source of truth that anchors every container
//                          FK (stats/events/meta/groups) AND is what the mock
//                          docker adapter serves for GET /containers.
//
// ── The tag column ──────────────────────────────────────────────────────────
// `seed_run_id` is a NULLABLE INTEGER on every allow-listed table. REAL ROWS ARE
// NULL. Purge is `DELETE ... WHERE seed_run_id = ?` and in SQL `NULL = <anything>`
// is never true — so a real row is STRUCTURALLY unreachable by a purge, without
// relying on application correctness. That property (not referential integrity)
// is the safety guarantee.
//
// Deliberately NO `REFERENCES seed_datasets(id)` clause on the ALTERed columns:
//   * `seed_datasets.tenant_id` cascades from `tenants`, so a tenant delete would
//     cascade into `seed_datasets`; a RESTRICT-ing FK from docker_hosts/audit_log
//     would then turn every tenant deletion (incl. a provisioning rollback) into a
//     hard failure, and `ON DELETE SET NULL` would silently UNTAG synthetic rows —
//     the one outcome we must never allow (untagged synthetic == indistinguishable
//     from real).
//   * The seed-OWNED table (`seed_containers`) does keep a real NOT NULL + CASCADE
//     FK, so the tenant cascade unwinds the roster cleanly.
// The tag's integrity is instead enforced by the static SEED_TABLES allow-list +
// the `seed_dataset_tables` manifest (src/services/provisioning/seed/tables.js) —
// table names never come from user input, so purge never interpolates data into SQL.
//
// The partial indexes (`WHERE seed_run_id IS NOT NULL`) index ONLY synthetic rows,
// so they stay empty (zero cost) on a real production install.

// The allow-list of EXISTING tables that receive the tag. Kept in sync with
// src/services/provisioning/seed/tables.js SEED_TABLES (minus seed_containers,
// which is created here with the column built in). Order below is the INSERT
// (FK-dependency) order; purge walks it in reverse.
const TAGGED_TABLES = [
  'nomenclatures',
  'users',
  'user_tenants',
  'docker_hosts',
  'host_groups',
  'host_group_members',
  'teams',
  'team_members',
  'host_permissions',
  'registries',
  'container_meta',
  'container_groups',
  'container_group_members',
  'container_stats',
  'container_stats_1m',
  'container_stats_1h',
  'container_stats_1d',
  'docker_events',
  'health_events',
  'firewall_snapshots',
  'firewall_rules',
  'posture_snapshots',
  'posture_mutes',
  'blueprints',
  'blueprint_runs',
  'audit_log',           // tag is NOT part of the hash payload → chain-transparent
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed_datasets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id     INTEGER REFERENCES provisioning_runs(id) ON DELETE SET NULL,
      profile    TEXT    NOT NULL DEFAULT 'small'
                          CHECK(profile IN ('small','medium','large')),
      scenario   TEXT    NOT NULL DEFAULT 'healthy-shop',
      seed       TEXT    NOT NULL,              -- stored as TEXT; PRNG folds it to uint32
      locale     TEXT    NOT NULL DEFAULT 'en',
      status     TEXT    NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active','purged')),
      row_count  INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      purged_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_seed_datasets_tenant ON seed_datasets(tenant_id, status);

    -- Purge manifest. purge_order ASC == insert order; purge walks DESC so
    -- children always go before parents. table_name is asserted against the
    -- static SEED_TABLES allow-list before it is ever used in SQL.
    CREATE TABLE IF NOT EXISTS seed_dataset_tables (
      dataset_id  INTEGER NOT NULL REFERENCES seed_datasets(id) ON DELETE CASCADE,
      table_name  TEXT    NOT NULL,
      row_count   INTEGER NOT NULL DEFAULT 0,
      purge_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (dataset_id, table_name)
    );

    -- The synthetic container roster (the FK anchor for demo container identity).
    CREATE TABLE IF NOT EXISTS seed_containers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      seed_run_id     INTEGER NOT NULL REFERENCES seed_datasets(id) ON DELETE CASCADE,
      tenant_id       INTEGER NOT NULL,
      host_id         INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      container_id    TEXT    NOT NULL,          -- 64-hex, PRNG-derived (never a real id)
      name            TEXT    NOT NULL,
      image           TEXT    NOT NULL,
      state           TEXT    NOT NULL,          -- running|exited|created|paused
      status          TEXT,                      -- "Up 3 days" style label
      compose_project TEXT,
      ports_json      TEXT,
      labels_json     TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, container_id)
    );
    CREATE INDEX IF NOT EXISTS idx_seed_containers_run ON seed_containers(seed_run_id);
    CREATE INDEX IF NOT EXISTS idx_seed_containers_host ON seed_containers(host_id);
  `);

  // Guarded ADD COLUMN per allow-listed table (PRAGMA table_info like 069/084/086).
  // A table that does not exist on this install is silently skipped — the
  // generator's allow-list intersects with what the DB actually has.
  for (const table of TAGGED_TABLES) {
    const exists = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!exists) continue;

    const cols = db.prepare(`PRAGMA table_info(${table})`).all(); // table from the code constant only
    if (!cols.some((c) => c.name === 'seed_run_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN seed_run_id INTEGER;`);
    }
    // Partial index: indexes ONLY synthetic rows, so it costs nothing on a real
    // install (every real row is NULL and therefore absent from the index).
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${table}_seed_run ON ${table}(seed_run_id) WHERE seed_run_id IS NOT NULL;`,
    );
  }
};

exports.TAGGED_TABLES = TAGGED_TABLES;
