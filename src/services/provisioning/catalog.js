'use strict';

// v8.15.0 (Onboarding — Phase 1) — Module catalog (code constant).
//
// The enable-able modules a tenant can switch on. Deliberately a CODE constant
// (like src/services/ai/features/audit-actions-list.js), NOT a CHECK-constrained
// column — the catalog grows in code and SQLite can't ALTER a CHECK. The
// `enable_modules` step upserts tenant_modules rows for the dependency closure;
// the service (not the DB) rejects unknown module keys.
//
// See plans/onboarding-architecture.md §4.1.

const MODULE_CATALOG = [
  { key: 'hosts',      label: 'Hosts & Daemons',  requires: [],        core: true },
  { key: 'firewall',   label: 'Firewall',         requires: ['hosts'] },
  { key: 'posture',    label: 'Security Posture',  requires: ['hosts'] },
  { key: 'reconciler', label: 'Reconciler',       requires: ['hosts'] },
  { key: 'registries', label: 'Registries',       requires: [] },
  { key: 'git',        label: 'Git Ops',          requires: [] },
  { key: 'teams',      label: 'Teams & Access',    requires: [] },
  { key: 'copilot',    label: 'Ops Copilot',      requires: [], feature: 'ai' },
];

const _BY_KEY = new Map(MODULE_CATALOG.map((m) => [m.key, m]));

/** All modules in the catalog (shallow copies — callers never mutate the source). */
function listModules() {
  return MODULE_CATALOG.map((m) => ({ ...m, requires: [...m.requires] }));
}

/** True if `key` is a known module. */
function isModule(key) {
  return _BY_KEY.has(key);
}

/**
 * Assert `key` is a known module; throw with context otherwise.
 * @returns {string} the same key (for chaining)
 */
function validateModuleKey(key) {
  if (typeof key !== 'string' || !_BY_KEY.has(key)) {
    throw new Error(`unknown module key: ${JSON.stringify(key)}`);
  }
  return key;
}

/**
 * Resolve the full dependency closure for a set of requested module keys.
 * Enabling `firewall` auto-enables `hosts`. Deterministic order: catalog order.
 * Throws on any unknown key.
 * @param {string[]} keys
 * @returns {string[]} the closure, in catalog order, de-duplicated
 */
function resolveDependencies(keys) {
  if (!Array.isArray(keys)) throw new Error('resolveDependencies expects an array of module keys');
  const wanted = new Set();
  const visit = (key) => {
    validateModuleKey(key);
    if (wanted.has(key)) return;
    wanted.add(key);
    for (const dep of _BY_KEY.get(key).requires) visit(dep);
  };
  for (const k of keys) visit(k);
  // Emit in stable catalog order so the closure is deterministic.
  return MODULE_CATALOG.filter((m) => wanted.has(m.key)).map((m) => m.key);
}

// ── Nomenclature kinds (v8.16.0, Phase 2) ───────────────────────────────────
//
// `nomenclatures.kind` is free-text at the DB level (091 deliberately has no
// CHECK — same rationale as tenant_modules.module_key: the domain grows in code
// and SQLite cannot ALTER a CHECK). The known set is validated HERE, in-service,
// on every write (declaration ingest + template spec validation).
const NOMENCLATURE_KINDS = [
  'region',        // geographic regions
  'currency',      // ISO-4217-ish currency lookups
  'unit',          // units of measure
  'industry',      // industry classification
  'plant_type',    // manufacturing: assembly / press / packaging / …
  'line',          // manufacturing: production lines
  'shift',         // manufacturing: shift patterns
  'site',          // physical sites / locations
  'department',    // org departments
  'environment',   // dev / staging / production / …
  'service_tier',  // MSP: bronze / silver / gold
  'severity',      // incident severities
  'priority',      // ticket / task priorities
];

const _KIND_SET = new Set(NOMENCLATURE_KINDS);

/** True if `kind` is a known nomenclature kind. */
function isNomenclatureKind(kind) {
  return _KIND_SET.has(kind);
}

/**
 * Assert `kind` is a known nomenclature kind; throw with context otherwise.
 * @returns {string} the same kind (for chaining)
 */
function validateNomenclatureKind(kind) {
  if (typeof kind !== 'string' || !_KIND_SET.has(kind)) {
    throw new Error(`unknown nomenclature kind: ${JSON.stringify(kind)}`);
  }
  return kind;
}

module.exports = {
  MODULE_CATALOG, listModules, isModule, validateModuleKey, resolveDependencies,
  NOMENCLATURE_KINDS, isNomenclatureKind, validateNomenclatureKind,
};
