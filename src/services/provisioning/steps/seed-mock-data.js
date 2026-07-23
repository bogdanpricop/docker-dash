'use strict';

// Step 8 — seed_mock_data (kind: db). v8.17.0, Phase 3.
//
// Runs the synthetic-data generator for a demo/trial tenant and records the batch
// + its purge manifest. Slotted AFTER grant_permissions (so users/teams/hosts the
// declaration itself created already exist and the synthetic estate lands on top
// of a fully-configured tenant) and BEFORE finalize (so the tenant only flips to
// `active` once it is actually populated).
//
// The step is only BUILT for demo/trial runs (steps/index.js filters it out for
// production), and it ALSO refuses defensively at run() time — the second of the
// three independent production guards:
//   1. the wizard hides/blocks step 7 in production;
//   2. THIS step throws if `mode === 'production'`;
//   3. `seed.generate()` throws SeedBlockedError on a production tenant.
//
// Compensation is a batch purge. Because the generator is pure-DB and wholly
// transactional, a FAILED generate leaves nothing behind at all — compensation
// only matters for unwinding a SUCCESSFUL seed during a rollback.

const seed = require('../seed');

module.exports = {
  key: 'seed_mock_data',
  kind: 'db',

  run(ctx) {
    const { db, decl, tenantId } = ctx;
    if (decl.mode === 'production') {
      throw new Error('seed_mock_data refuses to run in production mode (synthetic data is never written to production)');
    }
    const mock = decl.mockData || {};

    // Idempotent re-run: purge any batch this RUN already produced before
    // generating, so a resumed/retried step can never double the volume.
    const runId = ctx.run && ctx.run.id;
    if (runId) {
      const stale = db.prepare(
        "SELECT id FROM seed_datasets WHERE run_id = ? AND status = 'active'",
      ).all(runId);
      for (const s of stale) seed.purge(s.id, { db });
    }

    const result = seed.generate({
      db,
      tenantId,
      runId: runId || null,
      profile: mock.profile || (decl.mode === 'trial' ? 'small' : 'medium'),
      scenario: mock.scenario || 'healthy-shop',
      locale: (decl.regional && decl.regional.locale) || 'en',
      seed: mock.seed,
      createdBy: (ctx.user && ctx.user.username) || 'system',
    });

    ctx.audit('seed_dataset_create', 'seed_dataset', String(result.datasetId), {
      profile: result.profile, scenario: result.scenario, rows: result.total, tables: result.tables.length,
    });
    return {
      datasetId: result.datasetId,
      profile: result.profile,
      scenario: result.scenario,
      rows: result.total,
      tables: result.tables,
    };
  },

  compensate(ctx, cp) {
    const id = cp && cp.datasetId;
    if (!id) return;
    try {
      const r = seed.purge(id, { db: ctx.db });
      ctx.audit('seed_dataset_purge', 'seed_dataset', String(id), { rows: r.total, skipped: r.skipped });
    } catch (err) {
      ctx.log.warn('seed_mock_data compensate: purge failed', { datasetId: id, error: err.message });
    }
  },

  estimate(ctx) {
    const decl = ctx.decl || {};
    if (decl.mode === 'production') return {};
    const mock = decl.mockData || {};
    const est = seed.estimate({
      profile: mock.profile || (decl.mode === 'trial' ? 'small' : 'medium'),
      scenario: mock.scenario || 'healthy-shop',
    });
    return { syntheticRows: est.total, syntheticTables: est.tables.length };
  },
};
