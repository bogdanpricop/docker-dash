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
  finalize,          // 8  db
];

const STEP_REGISTRY = Object.freeze(
  ORDERED.reduce((acc, s) => { acc[s.key] = s; return acc; }, {}),
);

/**
 * Return the ordered step list with 1-based ordinals attached. Deterministic —
 * rebuilt identically on plan/apply/resume so the ordinal↔step_key mapping is
 * stable across a run's lifetime.
 * @returns {Array<{key,kind,ordinal,run,compensate?,estimate?}>}
 */
function buildSteps(/* ctx */) {
  return ORDERED.map((s, i) => ({ ...s, ordinal: i + 1 }));
}

module.exports = { buildSteps, STEP_REGISTRY, ORDERED };
