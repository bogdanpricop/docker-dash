'use strict';

// Ordered Phase-1 saga (pivot first) + step registry.
//
// Order is fixed and deterministic; buildSteps() assigns 1-based ordinals. The
// registry is keyed by step_key for rollback (which looks up compensations by
// the persisted provisioning_steps.step_key). Later phases insert additional
// steps (seed_nomenclatures, seed_entities, generate_mock_data) into this list.

const createTenant = require('./create-tenant');
const setRegional = require('./set-regional');
const enableModules = require('./enable-modules');
const createHosts = require('./create-hosts');
const createUsers = require('./create-users');
const grantPermissions = require('./grant-permissions');
const finalize = require('./finalize');

// The canonical Phase-1 order.
const ORDERED = [
  createTenant,     // 1  pivot — db
  setRegional,      // 2  db
  enableModules,    // 3  db
  createHosts,      // 4  external
  createUsers,      // 5  external
  grantPermissions, // 6  db
  finalize,         // 7  db
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
