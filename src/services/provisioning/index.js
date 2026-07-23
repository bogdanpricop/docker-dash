'use strict';

// v8.15.0 (Onboarding — Phase 1) — Provisioning service public API.
//
// The engine (saga: plan/apply/resume/rollback/getRun/export) + the declaration
// validator + the module catalog. One core; the routes, and later the headless
// bootstrap + CLI, all call THIS.

const engine = require('./engine');
const declaration = require('./declaration');
const catalog = require('./catalog');

module.exports = {
  // saga
  plan: engine.plan,
  apply: engine.apply,
  resume: engine.resume,
  rollback: engine.rollback,
  getRun: engine.getRun,
  getActiveRun: engine.getActiveRun,
  listRuns: engine.listRuns,
  exportRun: engine.exportRun,
  // declaration
  validateDeclaration: declaration.validateDeclaration,
  redactDeclaration: declaration.redactDeclaration,
  // catalog
  catalog,
  DEFAULT_TENANT_ID: 1,
};
