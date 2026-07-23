'use strict';

// v8.16.0 (Onboarding — Phase 2) — Template → declaration merge.
//
// A template supplies DEFAULTS; the user's explicit values always win. The merge
// runs INSIDE validateDeclaration(), before any sub-block is validated, so the
// MERGED document is what gets validated, fingerprinted, stored in
// provisioning_runs.input_json and replayed on resume/rollback. There is exactly
// one merged truth.
//
// Merged (per plans/feature-spec-onboarding-wizard.md §I Phase 2):
//   - tenant.kind   — template fills it only when the user left it unset
//   - regional      — per-key: { ...template, ...user }
//   - modules       — per module key: template list first, user entries override
//                     the `enabled` flag / append new keys
//   - nomenclatures — per (kind, code): template entries first, user entries
//                     override the label/sort/meta or append new codes
//
// NOT merged, deliberately: `roles` and `users`. A template must never mint an
// account — that would let a shipped/imported preset create real principals on a
// headless apply (plans/onboarding-security.md T3/T9). They stay in the spec as a
// suggested shape the wizard renders, nothing more.
//
// Unknown template key → hard error, EXCEPT the reserved no-op keys below (the
// wizard sends `custom` when the user picked "Custom / blank"). Silently
// ignoring a typo'd key would provision a bare tenant and look like it worked.

const RESERVED_NOOP_KEYS = new Set(['', 'custom', 'none', 'blank']);

function _normalizeModuleEntry(m) {
  if (typeof m === 'string') return { key: m, enabled: true };
  if (m && typeof m === 'object' && typeof m.key === 'string') {
    return { key: m.key, enabled: m.enabled === false ? false : true };
  }
  return null; // leave malformed entries alone — validateDeclaration reports them
}

function _mergeModules(templateModules, userModules) {
  if (!Array.isArray(templateModules) || !templateModules.length) return userModules;
  const order = [];
  const byKey = new Map();
  const put = (entry) => {
    if (!entry) return;
    if (!byKey.has(entry.key)) order.push(entry.key);
    byKey.set(entry.key, entry);
  };
  for (const m of templateModules) put(_normalizeModuleEntry(m));

  const passthrough = [];
  if (Array.isArray(userModules)) {
    for (const m of userModules) {
      const norm = _normalizeModuleEntry(m);
      if (norm) put(norm); else passthrough.push(m); // malformed → keep for the validator
    }
  } else if (userModules !== undefined && userModules !== null) {
    return userModules; // not an array → let validateDeclaration reject it
  }
  return order.map((k) => byKey.get(k)).concat(passthrough);
}

function _nomKey(n) {
  return `${n && n.kind}\u0000${String((n && n.code) || '').toLowerCase()}`;
}

function _mergeNomenclatures(templateNoms, userNoms) {
  if (!Array.isArray(templateNoms) || !templateNoms.length) return userNoms;
  const order = [];
  const byKey = new Map();
  const put = (n) => {
    const k = _nomKey(n);
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, n);
  };
  for (const n of templateNoms) put(n);

  const passthrough = [];
  if (Array.isArray(userNoms)) {
    for (const n of userNoms) {
      if (n && typeof n === 'object' && typeof n.kind === 'string' && typeof n.code === 'string') put(n);
      else passthrough.push(n); // malformed → keep for the validator
    }
  } else if (userNoms !== undefined && userNoms !== null) {
    return userNoms; // not an array → let validateDeclaration reject it
  }
  return order.map((k) => byKey.get(k)).concat(passthrough);
}

/**
 * Pure merge: apply `spec` as defaults UNDER `doc`. Returns a shallow copy of
 * `doc` with the merged blocks replaced; `doc` itself is never mutated.
 * @param {object} doc  raw declaration document
 * @param {object} spec validated template spec
 */
function mergeSpecIntoDoc(doc, spec) {
  if (!spec || typeof spec !== 'object') return doc;
  const out = { ...doc };

  if (spec.tenant && spec.tenant.kind) {
    const userTenant = (doc.tenant && typeof doc.tenant === 'object' && !Array.isArray(doc.tenant)) ? doc.tenant : null;
    if (userTenant) {
      const k = userTenant.kind;
      if (k === undefined || k === null || k === '') out.tenant = { ...userTenant, kind: spec.tenant.kind };
    }
  }

  if (spec.regional) {
    const userRegional = (doc.regional && typeof doc.regional === 'object' && !Array.isArray(doc.regional)) ? doc.regional : null;
    if (userRegional) out.regional = { ...spec.regional, ...userRegional };
    else if (doc.regional === undefined || doc.regional === null) out.regional = { ...spec.regional };
    // a non-object regional stays as-is so validateDeclaration reports it
  }

  const modules = _mergeModules(spec.modules, doc.modules);
  if (modules !== doc.modules) out.modules = modules;

  const noms = _mergeNomenclatures(spec.nomenclatures, doc.nomenclatures);
  if (noms !== doc.nomenclatures) out.nomenclatures = noms;

  return out;
}

/**
 * Resolve `doc.template` and merge its spec in as defaults.
 * Returns `doc` untouched when there is no (or a reserved no-op) template key.
 * Throws when a named template does not exist.
 *
 * The templates module is required LAZILY so declaration.js stays loadable (and
 * unit-testable) without touching the DB when no template is named.
 */
function applyTemplateDefaults(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const key = doc.template;
  if (key === undefined || key === null) return doc;
  if (typeof key !== 'string') throw new Error('template must be a string');
  if (RESERVED_NOOP_KEYS.has(key)) return doc;

  let spec;
  try {
    spec = require('./templates').getSpec(key);
  } catch (err) {
    // The registry is unreachable (table missing on a partially migrated DB).
    // Fail closed on the merge but do NOT block a declaration that would be
    // valid on its own — the miss is loud in the logs.
    require('../../utils/logger')('onboarding-templates')
      .warn('template lookup failed; continuing without template defaults', { key, error: err.message });
    return doc;
  }
  if (!spec) throw new Error(`unknown template '${key}'`);
  return mergeSpecIntoDoc(doc, spec);
}

module.exports = { applyTemplateDefaults, mergeSpecIntoDoc, RESERVED_NOOP_KEYS };
