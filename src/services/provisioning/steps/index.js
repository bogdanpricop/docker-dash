'use strict';

// Ordered Phase-1 saga (pivot first) + step registry.
//
// Order is fixed and deterministic; buildSteps() assigns 1-based ordinals. The
// registry is keyed by step_key for rollback (which looks up compensations by
// the persisted provisioning_steps.step_key). Later phases insert additional
// steps (seed_nomenclatures, seed_entities, generate_mock_data) into this list.

const createTenant = require('./create-tenant');
const setRegional = require('./set-regional');
const seedNomenclatures = require('./seed-nomenclatures');
const enableModules = require('./enable-modules');
const createHosts = require('./create-hosts');
const createUsers = require('./create-users');
const grantPermissions = require('./grant-permissions');
const seedMockData = require('./seed-mock-data');
const finalize = require('./finalize');

// The canonical order. v8.16.0 (Phase 2) inserted seed_nomenclatures right after
// set_regional — both are pure tenant-config writes and neither depends on the
// other, so slotting it there keeps the "configure the tenant, then populate it"
// reading order. Ordinals shift for everything after it; that is safe because
// buildSteps() is rebuilt deterministically on every plan/apply/resume and the
// engine resumes on `step_key`, not on a hard-coded ordinal.
const ORDERED = [
  createTenant,      // 1  pivot — db
  setRegional,       // 2  db
  seedNomenclatures, // 3  db
  enableModules,     // 4  db
  createHosts,       // 5  external
  createUsers,       // 6  external
  grantPermissions,  // 7  db
  seedMockData,      // 8  db   — demo/trial ONLY (see isActive below)
  finalize,          // 9  db
];

const STEP_REGISTRY = Object.freeze(
  ORDERED.reduce((acc, s) => { acc[s.key] = s; return acc; }, {}),
);

// v8.17.0 (Phase 3) — the first CONDITIONAL step. `seed_mock_data` is built only
// for demo/trial runs; a production run never even has the step in its plan (the
// step itself and the generator refuse independently — three guards).
//
// Conditionality is safe because a run's `mode` is fixed at creation and stored in
// input_json, so buildSteps() is still deterministic FOR A GIVEN RUN: the same
// declaration always yields the same list, and the engine resumes on `step_key`
// rather than a hard-coded ordinal.
const STEP_PREDICATES = {
  seed_mock_data: (ctx) => {
    const mode = (ctx && ctx.decl && ctx.decl.mode) || 'production';
    return mode === 'demo' || mode === 'trial';
  },
};

/**
 * Return the ordered step list with 1-based ordinals attached. Deterministic for
 * a given ctx — rebuilt identically on plan/apply/resume so the ordinal↔step_key
 * mapping is stable across a run's lifetime.
 * @returns {Array<{key,kind,ordinal,run,compensate?,estimate?}>}
 */
function buildSteps(ctx) {
  return ORDERED
    .filter((s) => (STEP_PREDICATES[s.key] ? STEP_PREDICATES[s.key](ctx) : true))
    .map((s, i) => ({ ...s, ordinal: i + 1 }));
}

module.exports = { buildSteps, STEP_REGISTRY, ORDERED, STEP_PREDICATES };
