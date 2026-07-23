'use strict';

// v8.17.0 (Onboarding & Provisioning Wizard — Phase 3) — the mock-data generator.
//
// Public contract (plans/onboarding-architecture.md §3.1):
//   generate({tenantId, runId, profile, scenario, locale, seed, createdBy})
//   purge(datasetId)
//   reset(tenantId, opts)          — purge every live batch, then regenerate one
//   regenerate({tenantId, ...})    — purge the tenant's live batches + generate anew
//   estimate({profile, scenario})  — pure, no writes
//
// ── The four invariants this module exists to guarantee ────────────────────
// 1. SYNTHETIC-ONLY. Every value comes from the embedded word lists + the seeded
//    PRNG. The generator NEVER reads a real table to derive a value (that is the
//    "masked-real data" trap). Addresses are RFC1918/TEST-NET, hostnames `.test`,
//    emails `.example`, broken sync URLs `.invalid`.
// 2. PRODUCTION IS BLOCKED. generate() throws SeedBlockedError BEFORE opening the
//    transaction if the tenant's usage_mode is 'production'. This is the
//    innermost of three independent guards (wizard step / provisioning step /
//    here) and the promotion gate is the matching outbound lock.
// 3. PURGE CANNOT TOUCH A REAL ROW. Real rows have `seed_run_id IS NULL`; purge is
//    `DELETE ... WHERE seed_run_id = ?` and `NULL = x` is never true in SQL. Table
//    names come only from the static SEED_TABLES allow-list, never from data.
// 4. BOUNDED VOLUME. Hard row caps asserted BEFORE COMMIT; violating them
//    ROLLBACKs the whole batch (see profiles.js for the docker_events rationale).
//
// Everything happens inside ONE transaction, so a failure leaves NO partial
// batch — which is also why the provisioning step's compensation is free.
//
// ── Determinism, stated precisely ──────────────────────────────────────────
// For a fixed (seed, profile, scenario, locale, nowMs) the dataset is identical
// in every business column AND in every decrypted secret. The ONE thing that
// legitimately differs between two runs is the CIPHERTEXT of the encrypted
// columns (ssh_config / daemon_config.apiTokenEnc / registries.password_encrypted
// / blueprints.source_token_enc): AES-256-GCM uses a fresh random IV per
// encryption, and making that deterministic would be a security defect. The
// determinism test therefore hashes the structure with ciphertext columns
// excluded and separately asserts the DECRYPTED plaintexts are byte-identical.

const { getDb } = require('../../../db');
const log = require('../../../utils/logger')('seed');
const { Prng, deriveSeed, toSqlTime, toIso } = require('./prng');
const { poolFor, slugify, ORG_PREFIXES, ORG_SUFFIXES } = require('./words');
const { getProfile, estimate, MAX_TOTAL_ROWS, MAX_STATS_ROWS, PROFILE_KEYS } = require('./profiles');
const { getScenario, SCENARIO_KEYS, listScenarios } = require('./scenarios');
const { SEED_TABLES, PURGE_ORDER, INSERT_ORDER, assertSeedTable, CHAINED_TABLE } = require('./tables');

const nomenclatures = require('./nomenclatures');
const users = require('./users');
const hosts = require('./hosts');
const teams = require('./teams');
const registries = require('./registries');
const containers = require('./containers');
const stats = require('./stats');
const events = require('./events');
const firewall = require('./firewall');
const posture = require('./posture');
const blueprints = require('./blueprints');
const auditSeed = require('./audit');

/** Thrown when seeding is attempted against a production tenant. */
class SeedBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedBlockedError';
    this.status = 409;
    this.code = 'SEED_BLOCKED';
  }
}

const DEFAULT_PROFILE = 'medium';
const DEFAULT_SCENARIO = 'healthy-shop';

function _tenant(db, tenantId) {
  const t = db.prepare('SELECT id, slug, name, usage_mode FROM tenants WHERE id = ?').get(tenantId);
  if (!t) { const e = new Error(`tenant ${tenantId} not found`); e.status = 404; throw e; }
  return t;
}

/**
 * The mode guard. Called BEFORE any write, from generate() and (independently)
 * from the provisioning step and the REST routes.
 */
function assertSeedable(db, tenantId) {
  const t = _tenant(db, tenantId);
  if (t.usage_mode === 'production') {
    throw new SeedBlockedError(
      `refusing to seed synthetic data into tenant "${t.slug}" (usage_mode=production). `
      + 'Synthetic records are never written to a production environment.',
    );
  }
  return t;
}

/** Deterministic fictional org identity derived from the PRNG (never from real data). */
function _org(rng) {
  const name = `${rng.pick(ORG_PREFIXES)} ${rng.pick(ORG_SUFFIXES)}`;
  return { name, slug: slugify(name) };
}

// ── generate ────────────────────────────────────────────────────────────────
/**
 * Generate one synthetic dataset. ONE transaction; a failure rolls the whole
 * batch back leaving nothing behind.
 * @returns {{datasetId:number, profile:string, scenario:string, seed:string, total:number, tables:{name:string,count:number}[]}}
 */
function generate({
  tenantId, runId = null, profile = DEFAULT_PROFILE, scenario = DEFAULT_SCENARIO,
  locale = 'en', seed, createdBy = 'system', db: dbOverride, nowMs,
} = {}) {
  const db = dbOverride || getDb();
  if (!PROFILE_KEYS.includes(profile)) throw new Error(`unknown seed profile ${JSON.stringify(profile)}`);
  if (!SCENARIO_KEYS.includes(scenario)) throw new Error(`unknown seed scenario ${JSON.stringify(scenario)}`);

  // GUARD #3 (innermost): production can never be seeded. Before the txn opens.
  const tenant = assertSeedable(db, tenantId);

  const profileMatrix = getProfile(profile);
  const scenarioOverlay = getScenario(scenario);
  const seedValue = seed === undefined || seed === null || seed === ''
    ? deriveSeed({ slug: tenant.slug, profile, scenario, locale })
    : seed;

  const run = db.transaction(() => {
    const rng = new Prng(seedValue);
    const dsId = Number(db.prepare(`
      INSERT INTO seed_datasets (tenant_id, run_id, profile, scenario, seed, locale, status, row_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?)
    `).run(tenantId, runId, profile, scenario, String(seedValue), locale, createdBy).lastInsertRowid);

    const tally = Object.create(null);
    const ctx = {
      db,
      rng,
      datasetId: dsId,
      tenantId,
      runId,
      profile: profileMatrix,
      scenario: scenarioOverlay,
      locale,
      pool: poolFor(locale),
      org: _org(rng),
      // ONE frozen clock for the whole batch, so every backdated series shares a
      // consistent relative shape. It is the only non-PRNG input to the dataset:
      // with `nowMs` supplied the output is BYTE-identical for a fixed
      // (seed, profile, scenario, locale); without it, everything except the
      // wall-clock anchor of the timestamps is still identical. The determinism
      // test pins it to prove the stronger property.
      nowMs: nowMs === undefined ? Date.now() : Number(nowMs),
      toSqlTime,
      toIso,
      budget: { stats: MAX_STATS_ROWS, total: MAX_TOTAL_ROWS },
      refs: { hosts: [], users: [], teams: [], hostGroups: [], containers: [], running: [] },
      count(table, n) {
        assertSeedTable(table);
        if (!n) return;
        tally[table] = (tally[table] || 0) + n;
      },
      // A DATASET-SCOPED deterministic uuid. Used where a column is globally
      // UNIQUE (firewall_rules.rule_uuid): a pure-PRNG value would collide when
      // two batches share a seed, while this is unique per batch by construction
      // and still replays identically for a given (datasetId, kind, index).
      uuidFor(kind, index) {
        const h = require('crypto').createHash('sha256')
          .update(`seed:${dsId}:${kind}:${index}`).digest('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
      },
    };

    // ── FK-dependency order: parents strictly before children ───────────────
    nomenclatures.generate(ctx);      // tenant-owned lookups
    users.generate(ctx);              // users + user_tenants (viewer-only)
    hosts.generate(ctx);              // docker_hosts
    hosts.generateGroups(ctx);        // host_groups + members
    teams.generate(ctx);              // teams + team_members
    teams.generatePermissions(ctx);   // host_permissions
    registries.generate(ctx);
    containers.generate(ctx);         // seed_containers roster (the FK anchor)
    containers.generateEnrichment(ctx); // container_meta + groups + members
    stats.generate(ctx);              // BUDGET-GUARDED metric tiers
    events.generate(ctx);             // lifecycle events (never exec_*) + health
    firewall.generate(ctx);
    posture.generate(ctx);
    blueprints.generate(ctx);
    auditSeed.generate(ctx);          // LAST — the chain tail (see audit.js)

    // ── the volume tripwire (assert BEFORE commit; violation ⇒ ROLLBACK) ────
    const total = Object.values(tally).reduce((s, n) => s + n, 0);
    const statsRows = ['container_stats', 'container_stats_1m', 'container_stats_1h', 'container_stats_1d']
      .reduce((s, t) => s + (tally[t] || 0), 0);
    if (total > MAX_TOTAL_ROWS) {
      throw new Error(`seed volume guard: ${total} rows exceeds MAX_TOTAL_ROWS=${MAX_TOTAL_ROWS} — rolling back`);
    }
    if (statsRows > MAX_STATS_ROWS) {
      throw new Error(`seed volume guard: ${statsRows} stats rows exceeds MAX_STATS_ROWS=${MAX_STATS_ROWS} — rolling back`);
    }

    // ── the purge manifest ─────────────────────────────────────────────────
    const insManifest = db.prepare(
      'INSERT INTO seed_dataset_tables (dataset_id, table_name, row_count, purge_order) VALUES (?, ?, ?, ?)',
    );
    const tables = [];
    for (const table of SEED_TABLES) {
      const n = tally[table] || 0;
      if (!n) continue;
      insManifest.run(dsId, assertSeedTable(table), n, INSERT_ORDER[table]);
      tables.push({ name: table, count: n });
    }
    db.prepare('UPDATE seed_datasets SET row_count = ? WHERE id = ?').run(total, dsId);

    return { datasetId: dsId, profile, scenario, seed: String(seedValue), locale, total, tables, org: ctx.org };
  }).immediate();

  log.info('seed dataset generated', {
    datasetId: run.datasetId, tenantId, profile, scenario, rows: run.total, tables: run.tables.length,
  });
  return run;
}

// ── purge ───────────────────────────────────────────────────────────────────
/**
 * Delete ONLY this batch's tagged rows, children first, then flip the dataset to
 * `purged`. The dataset row itself is retained (status/purged_at) so the trail of
 * "what was seeded and when it was removed" survives.
 *
 * `audit_log` is TAIL-GUARDED: its rows are deleted only while the synthetic block
 * is still the chain tail; otherwise it is SKIPPED and the skip is recorded in the
 * manifest (row_count kept, so the operator can see what remains).
 *
 * @returns {{datasetId:number, deleted:object, total:number, skipped:string[]}}
 */
function purge(datasetId, { db: dbOverride } = {}) {
  const db = dbOverride || getDb();
  const exists = db.prepare('SELECT id FROM seed_datasets WHERE id = ?').get(datasetId);
  if (!exists) { const e = new Error(`seed dataset ${datasetId} not found`); e.status = 404; throw e; }

  return db.transaction(() => {
    const deleted = Object.create(null);
    const skipped = [];
    let total = 0;

    for (const table of PURGE_ORDER) {
      // The ONLY source of table names is the static allow-list — never data.
      const name = assertSeedTable(table);

      if (name === CHAINED_TABLE && !auditSeed.isChainTail(db, datasetId)) {
        // Real activity was appended after seeding: deleting mid-chain rows would
        // dangle the next real row's prev_hash. Never break the chain.
        skipped.push(name);
        continue;
      }
      let stmt;
      try {
        stmt = db.prepare(`DELETE FROM ${name} WHERE seed_run_id = ?`);
      } catch {
        continue; // table absent on this install (guarded ALTER skipped it)
      }
      const r = stmt.run(datasetId);
      if (r.changes) { deleted[name] = r.changes; total += r.changes; }
    }

    // Manifest bookkeeping: drop the rows we actually purged, KEEP the rows for
    // any skipped table so the operator can still see exactly what survives and
    // where. (Retaining the audit_log manifest row is also what keeps the batch
    // re-purgeable once the chain tail condition is satisfied again.)
    if (skipped.length) {
      const delOne = db.prepare('DELETE FROM seed_dataset_tables WHERE dataset_id = ? AND table_name = ?');
      for (const name of SEED_TABLES) {
        if (!skipped.includes(name)) delOne.run(datasetId, name);
      }
      log.warn('seed purge skipped chained table(s) — batch is no longer the audit chain tail', {
        datasetId, skipped,
      });
    } else {
      db.prepare('DELETE FROM seed_dataset_tables WHERE dataset_id = ?').run(datasetId);
    }

    const remaining = db.prepare(
      'SELECT COALESCE(SUM(row_count), 0) AS c FROM seed_dataset_tables WHERE dataset_id = ?',
    ).get(datasetId).c;
    db.prepare("UPDATE seed_datasets SET status = 'purged', purged_at = datetime('now'), row_count = ? WHERE id = ?")
      .run(remaining, datasetId);

    return { datasetId, deleted, total, skipped };
  }).immediate();
}

/** Every live (status='active') dataset for a tenant. */
function listDatasets(tenantId, { db: dbOverride, includePurged = false } = {}) {
  const db = dbOverride || getDb();
  const sql = includePurged
    ? 'SELECT * FROM seed_datasets WHERE tenant_id = ? ORDER BY id DESC'
    : "SELECT * FROM seed_datasets WHERE tenant_id = ? AND status = 'active' ORDER BY id DESC";
  const rows = db.prepare(sql).all(tenantId);
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    runId: r.run_id,
    profile: r.profile,
    scenario: r.scenario,
    seed: r.seed,
    locale: r.locale,
    status: r.status,
    rowCount: r.row_count,
    createdBy: r.created_by,
    createdAt: r.created_at,
    purgedAt: r.purged_at,
    tables: db.prepare(
      'SELECT table_name AS name, row_count AS count FROM seed_dataset_tables WHERE dataset_id = ? ORDER BY purge_order ASC',
    ).all(r.id),
  }));
}

/** Purge every live batch for a tenant. Used by reset/regenerate + the gate's remediation. */
function purgeAll(tenantId, { db: dbOverride } = {}) {
  const db = dbOverride || getDb();
  const live = db.prepare("SELECT id FROM seed_datasets WHERE tenant_id = ? AND status = 'active'").all(tenantId);
  const results = live.map((r) => purge(r.id, { db }));
  return { purged: results.length, total: results.reduce((s, r) => s + r.total, 0), results };
}

// ── regenerate / reset ──────────────────────────────────────────────────────
/**
 * Purge every live batch for the tenant, then generate a fresh one. This is the
 * ONLY "replace" path, so a regenerate can never accumulate duplicates.
 */
function regenerate(opts = {}) {
  const db = opts.db || getDb();
  assertSeedable(db, opts.tenantId);   // fail before destroying anything
  const purged = purgeAll(opts.tenantId, { db });
  const created = generate({ ...opts, db });
  return { ...created, purged: purged.purged, purgedRows: purged.total };
}

/**
 * "Reset" is the wizard-facing verb: regenerate with the SAME inputs as the live
 * batch (so the demo returns to its canonical clean starting state). Falls back to
 * the supplied/default inputs when nothing is live.
 */
function reset(opts = {}) {
  const db = opts.db || getDb();
  const [live] = listDatasets(opts.tenantId, { db });
  const inputs = live
    ? { profile: live.profile, scenario: live.scenario, locale: live.locale, seed: live.seed, runId: live.runId }
    : {};
  // An explicit `undefined` in opts must NOT clobber the live batch's inputs.
  const overrides = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  return regenerate({ ...inputs, ...overrides, db });
}

module.exports = {
  generate, purge, purgeAll, reset, regenerate, estimate, listDatasets,
  assertSeedable, SeedBlockedError,
  SEED_TABLES, PURGE_ORDER, PROFILE_KEYS, SCENARIO_KEYS, listScenarios,
  MAX_TOTAL_ROWS, MAX_STATS_ROWS,
};
