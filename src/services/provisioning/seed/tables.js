'use strict';

// v8.17.0 (Onboarding — Phase 3) — the STATIC seed-table allow-list.
//
// This is the ONLY set of tables the generator may write and the ONLY set purge
// may delete from. Table names therefore never originate from data: the purge
// manifest (`seed_dataset_tables`) is validated against this constant before a
// name is ever interpolated into SQL, which is what makes the manifest-driven
// purge injection-proof (plans/onboarding-architecture.md §1.7 point 3).
//
// Order below is the INSERT (FK-dependency) order — parents before children.
// PURGE_ORDER is its exact reverse, so children always go before parents.

const SEED_TABLES = Object.freeze([
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
  'seed_containers',
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
  'audit_log',
]);

const _SET = new Set(SEED_TABLES);

/** Reverse-FK deletion order (children first). */
const PURGE_ORDER = Object.freeze(SEED_TABLES.slice().reverse());

/** 1-based insert position, used as `seed_dataset_tables.purge_order`. */
const INSERT_ORDER = Object.freeze(
  SEED_TABLES.reduce((acc, t, i) => { acc[t] = i + 1; return acc; }, Object.create(null)),
);

/** True if `name` is an allow-listed seed table. */
function isSeedTable(name) { return _SET.has(name); }

/**
 * Assert `name` is allow-listed before it may appear in SQL.
 * @returns {string} the same name (for chaining into a template literal)
 */
function assertSeedTable(name) {
  if (!_SET.has(name)) throw new Error(`refusing to touch non-seed table ${JSON.stringify(name)}`);
  return name;
}

/**
 * `audit_log` is hash-chained and append-only — its purge is TAIL-GUARDED
 * (plans/onboarding-mockdata.md §5.5), so it is handled separately from the
 * plain `DELETE ... WHERE seed_run_id = ?` loop.
 */
const CHAINED_TABLE = 'audit_log';

module.exports = { SEED_TABLES, PURGE_ORDER, INSERT_ORDER, isSeedTable, assertSeedTable, CHAINED_TABLE };
