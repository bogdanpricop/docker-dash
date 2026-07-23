'use strict';

// v8.15.0 (Onboarding — Phase 1) / v8.16.0 (Phase 2) — Provisioning service API.
//
// The engine (saga: plan/apply/resume/rollback/getRun/export) + the declaration
// validator + the module/nomenclature catalog + the template registry + the
// headless DD_ONBOARD_FILE bootstrap. One core; the REST routes, the startup
// bootstrap and (later) the CLI all call THIS.

const engine = require('./engine');
const declaration = require('./declaration');
const catalog = require('./catalog');
const templates = require('./templates');
const templateMerge = require('./template-merge');
const bootstrap = require('./bootstrap');
const seed = require('./seed');
const promotion = require('./promotion');

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
  exportRunAsTemplate: engine.exportRunAsTemplate,
  // declaration
  validateDeclaration: declaration.validateDeclaration,
  redactDeclaration: declaration.redactDeclaration,
  // templates (Phase 2)
  templates,
  mergeSpecIntoDoc: templateMerge.mergeSpecIntoDoc,
  loadBuiltinTemplates: templates.loadBuiltins,
  // headless bootstrap (Phase 2)
  bootstrap,
  maybeBootstrap: bootstrap.maybeBootstrap,
  // mock data + promotion gate (Phase 3)
  seed,
  promotion,
  assertProductionReady: promotion.assertProductionReady,
  checkProductionReady: promotion.checkProductionReady,
  setUsageMode: promotion.setUsageMode,
  // catalog
  catalog,
  DEFAULT_TENANT_ID: 1,
};
