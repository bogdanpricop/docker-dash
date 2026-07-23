'use strict';

// v8.16.0 (Onboarding — Phase 2) — Onboarding template registry.
//
// Two provenances, one table (`onboarding_templates`, migration 092):
//
//   BUILT-IN  (is_builtin=1) — authored as JSON files under
//     src/db/onboarding-templates/<key>.json and UPSERTed at startup by
//     loadBuiltins(), called from src/server.js right after howto-loader.
//     Exactly the how-to precedence rule (CLAUDE.md "How-To content
//     precedence"): **the FILE overrides the DB row** on every boot. Authoring a
//     preset = drop a file; never edit a migration.
//
//   CUSTOM    (is_builtin=0) — created through POST /api/onboarding/templates
//     ("save as template" from a declaration). A custom key may NEVER collide
//     with a built-in key, so a user cannot shadow a shipped preset.
//
// SECURITY (plans/onboarding-security.md §C6 / T8): a template is INPUT, file
// authored or not. Every spec goes through validateTemplateSpec() which
//   - whitelists keys (unknown keys are dropped, never passed through),
//   - rejects __proto__ / constructor / prototype anywhere (proto-pollution),
//   - rejects any secret-shaped key anywhere (a template must never carry a
//     credential — not even an encrypted one),
//   - bounds every list + string (anti-DoS),
//   - validates module keys and nomenclature kinds against the code catalogs.
// A malformed built-in FILE logs + is skipped; it never crashes boot.

const fs = require('fs');
const path = require('path');
const { getDb } = require('../../db');
const log = require('../../utils/logger')('onboarding-templates');
const catalog = require('./catalog');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'db', 'onboarding-templates');

// ── field domains + volume caps ──────────────────────────────────────────────
// KEY_RE doubles as the path-traversal guard: a key can never contain `/`,
// `\` or `..`, so `<key>.json` is always a plain filename.
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const KINDS = new Set(['client', 'plant', 'internal']);
const ROLES = new Set(['viewer', 'operator', 'admin']);
const UNIT_SYSTEMS = new Set(['metric', 'imperial']);
// Mirrors declaration.js REGIONAL_KEYS. Duplicated deliberately: declaration.js
// depends on template-merge.js which depends on THIS module — importing back the
// other way would close a require cycle.
const REGIONAL_KEYS = ['locale', 'timezone', 'currency', 'unitSystem', 'dateFormat', 'numberFormat'];

const MAX_SPEC_BYTES = 128 * 1024;   // serialized spec_json cap
const MAX_MODULES = 32;
const MAX_NOMENCLATURES = 500;
const MAX_ENTITIES = 1000;    // v8.18.0 (Phase 4)
const MAX_RELATIONS = 2000;
const MAX_ROLES = 16;
const MAX_USERS = 50;
const MAX_NOTES = 4000;
const MAX_STR = 512;
const MAX_FILE_BYTES = 256 * 1024;

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// A template must never carry a credential — not plaintext, not ciphertext.
const SECRET_KEY_RE = /(password|passphrase|secret|token|credential|privatekey|private_key|apikey|api_key|tlskey|tls_key|_enc)/i;

function _parse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function _assertSafeKeys(obj, pathStr) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (PROTO_KEYS.has(key)) throw new Error(`forbidden key "${key}" at ${pathStr || '<spec>'}`);
    if (SECRET_KEY_RE.test(key)) throw new Error(`secret-shaped key "${key}" is not allowed in a template (at ${pathStr || '<spec>'})`);
    const v = obj[key];
    if (v && typeof v === 'object') _assertSafeKeys(v, `${pathStr || ''}.${key}`);
  }
}

function _str(v, field, { max = MAX_STR, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  if (v.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return v;
}

function _int(v, field, { min = -1e9, max = 1e9, dflt = 0 } = {}) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${field} must be an integer`);
  if (n < min || n > max) throw new Error(`${field} out of range`);
  return n;
}

// ── spec validation ──────────────────────────────────────────────────────────

function _validateRegional(r) {
  if (r === undefined || r === null) return undefined;
  if (typeof r !== 'object' || Array.isArray(r)) throw new Error('spec.regional must be an object');
  const out = {};
  for (const key of REGIONAL_KEYS) {
    if (r[key] === undefined) continue;
    if (key === 'unitSystem') {
      const us = _str(r[key], 'spec.regional.unitSystem', { max: 16 });
      if (us !== undefined && !UNIT_SYSTEMS.has(us)) throw new Error("spec.regional.unitSystem must be 'metric' or 'imperial'");
      if (us !== undefined) out.unitSystem = us;
    } else {
      const val = _str(r[key], `spec.regional.${key}`, { max: 64 });
      if (val !== undefined) out[key] = val;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function _validateModules(mods) {
  if (mods === undefined || mods === null) return undefined;
  if (!Array.isArray(mods)) throw new Error('spec.modules must be an array');
  if (mods.length > MAX_MODULES) throw new Error(`spec.modules: too many entries (max ${MAX_MODULES})`);
  const seen = new Set();
  const out = [];
  mods.forEach((m, i) => {
    const key = typeof m === 'string' ? m : (m && m.key);
    const k = _str(key, `spec.modules[${i}].key`, { required: true, max: 64 });
    catalog.validateModuleKey(k); // unknown module key → throw
    if (seen.has(k)) return;
    seen.add(k);
    const enabled = typeof m === 'object' && m !== null && m.enabled === false ? false : true;
    out.push({ key: k, enabled });
  });
  return out.length ? out : undefined;
}

function _validateNomenclatures(list) {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new Error('spec.nomenclatures must be an array');
  if (list.length > MAX_NOMENCLATURES) throw new Error(`spec.nomenclatures: too many entries (max ${MAX_NOMENCLATURES})`);
  const seen = new Set();
  const out = [];
  list.forEach((n, i) => {
    if (!n || typeof n !== 'object') throw new Error(`spec.nomenclatures[${i}] must be an object`);
    const kind = _str(n.kind, `spec.nomenclatures[${i}].kind`, { required: true, max: 64 });
    catalog.validateNomenclatureKind(kind);
    const code = _str(n.code, `spec.nomenclatures[${i}].code`, { required: true, max: 64 });
    if (!CODE_RE.test(code)) throw new Error(`spec.nomenclatures[${i}].code has invalid characters`);
    const label = _str(n.label, `spec.nomenclatures[${i}].label`, { required: true, max: 200 });
    const dedupe = `${kind}\u0000${code.toLowerCase()}`;
    if (seen.has(dedupe)) throw new Error(`spec.nomenclatures[${i}]: duplicate ${kind}/${code}`);
    seen.add(dedupe);
    const entry = { kind, code, label, sort: _int(n.sort, `spec.nomenclatures[${i}].sort`, { min: -100000, max: 100000 }) };
    if (n.meta !== undefined && n.meta !== null) {
      if (typeof n.meta !== 'object' || Array.isArray(n.meta)) throw new Error(`spec.nomenclatures[${i}].meta must be an object`);
      const metaJson = JSON.stringify(n.meta);
      if (metaJson.length > 2048) throw new Error(`spec.nomenclatures[${i}].meta is too large`);
      entry.meta = JSON.parse(metaJson);
    }
    out.push(entry);
  });
  return out.length ? out : undefined;
}

// v8.18.0 (Phase 4) — templates MAY define entities/relations (unlike users —
// an entity mints no principal; template-merge.js explains why merging them is
// safe). Same shape as the declaration's blocks.
function _validateEntities(list) {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new Error('spec.entities must be an array');
  if (list.length > MAX_ENTITIES) throw new Error(`spec.entities: too many entries (max ${MAX_ENTITIES})`);
  const seen = new Set();
  const out = [];
  list.forEach((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`spec.entities[${i}] must be an object`);
    const entityType = _str(e.entityType, `spec.entities[${i}].entityType`, { required: true, max: 64 });
    catalog.validateEntityType(entityType);
    const code = _str(e.code, `spec.entities[${i}].code`, { required: true, max: 64 });
    if (!CODE_RE.test(code)) throw new Error(`spec.entities[${i}].code has invalid characters`);
    const name = _str(e.name, `spec.entities[${i}].name`, { required: true, max: 200 });
    const dedupe = `${entityType} ${code.toLowerCase()}`;
    if (seen.has(dedupe)) throw new Error(`spec.entities[${i}]: duplicate ${entityType}/${code}`);
    seen.add(dedupe);
    const entry = { entityType, code, name };
    if (e.meta !== undefined && e.meta !== null) {
      if (typeof e.meta !== 'object' || Array.isArray(e.meta)) throw new Error(`spec.entities[${i}].meta must be an object`);
      const metaJson = JSON.stringify(e.meta);
      if (metaJson.length > 2048) throw new Error(`spec.entities[${i}].meta is too large`);
      entry.meta = JSON.parse(metaJson);
    }
    out.push(entry);
  });
  return out.length ? out : undefined;
}

function _validateRelations(list, entities) {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new Error('spec.relations must be an array');
  if (list.length > MAX_RELATIONS) throw new Error(`spec.relations: too many entries (max ${MAX_RELATIONS})`);
  const known = new Set((entities || []).map((e) => `${e.entityType} ${e.code.toLowerCase()}`));
  const seen = new Set();
  const out = [];
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`spec.relations[${i}] must be an object`);
    const fromType = _str(r.fromType, `spec.relations[${i}].fromType`, { required: true, max: 64 });
    catalog.validateEntityType(fromType);
    const fromCode = _str(r.fromCode, `spec.relations[${i}].fromCode`, { required: true, max: 64 });
    const toType = _str(r.toType, `spec.relations[${i}].toType`, { required: true, max: 64 });
    catalog.validateEntityType(toType);
    const toCode = _str(r.toCode, `spec.relations[${i}].toCode`, { required: true, max: 64 });
    const relationType = _str(r.relationType, `spec.relations[${i}].relationType`, { required: true, max: 64 });
    catalog.validateRelationType(relationType);
    const fromKey = `${fromType} ${fromCode.toLowerCase()}`;
    const toKey = `${toType} ${toCode.toLowerCase()}`;
    if (known.size) {
      if (!known.has(fromKey)) throw new Error(`spec.relations[${i}]: from-entity ${fromType}/${fromCode} is not in spec.entities`);
      if (!known.has(toKey)) throw new Error(`spec.relations[${i}]: to-entity ${toType}/${toCode} is not in spec.entities`);
    }
    if (fromKey === toKey) throw new Error(`spec.relations[${i}]: an entity cannot relate to itself`);
    const dedupe = `${fromKey} ${toKey} ${relationType}`;
    if (seen.has(dedupe)) throw new Error(`spec.relations[${i}]: duplicate relation`);
    seen.add(dedupe);
    out.push({ fromType, fromCode, toType, toCode, relationType });
  });
  return out.length ? out : undefined;
}

function _validateRoles(roles) {
  if (roles === undefined || roles === null) return undefined;
  if (!Array.isArray(roles)) throw new Error('spec.roles must be an array');
  if (roles.length > MAX_ROLES) throw new Error(`spec.roles: too many entries (max ${MAX_ROLES})`);
  const out = [];
  roles.forEach((r, i) => {
    const role = _str(typeof r === 'string' ? r : (r && r.role), `spec.roles[${i}].role`, { required: true, max: 16 });
    if (!ROLES.has(role)) throw new Error(`spec.roles[${i}].role must be one of ${[...ROLES].join(', ')}`);
    const entry = { role };
    if (typeof r === 'object' && r !== null && r.isOwner === true) entry.isOwner = true;
    if (typeof r === 'object' && r !== null) {
      const label = _str(r.label, `spec.roles[${i}].label`, { max: 128 });
      if (label) entry.label = label;
    }
    out.push(entry);
  });
  return out.length ? out : undefined;
}

function _validateUsers(users) {
  if (users === undefined || users === null) return undefined;
  if (!Array.isArray(users)) throw new Error('spec.users must be an array');
  if (users.length > MAX_USERS) throw new Error(`spec.users: too many entries (max ${MAX_USERS})`);
  const out = [];
  users.forEach((u, i) => {
    if (!u || typeof u !== 'object') throw new Error(`spec.users[${i}] must be an object`);
    const username = _str(u.username, `spec.users[${i}].username`, { required: true, max: 64 });
    if (!USERNAME_RE.test(username)) throw new Error(`spec.users[${i}].username has invalid characters`);
    const role = u.role === undefined ? 'viewer' : _str(u.role, `spec.users[${i}].role`, { max: 16 });
    if (!ROLES.has(role)) throw new Error(`spec.users[${i}].role must be one of ${[...ROLES].join(', ')}`);
    const entry = { username, role };
    if (u.isOwner === true) entry.isOwner = true;
    const displayName = _str(u.displayName, `spec.users[${i}].displayName`, { max: 128 });
    if (displayName) entry.displayName = displayName;
    out.push(entry);
  });
  return out.length ? out : undefined;
}

/**
 * Validate + normalize a template `spec`. Returns a FRESH whitelisted object
 * (unknown keys dropped, never passed through). Throws with per-field context.
 *
 * Accepted shape:
 *   { tenant:{kind}, regional:{...}, modules:[{key,enabled}],
 *     nomenclatures:[{kind,code,label,sort,meta}], roles:[{role,isOwner}],
 *     users:[{username,role,isOwner,displayName}], notes:'…' }
 *
 * `roles` / `users` are a SUGGESTED SHAPE surfaced by the UI only — they are
 * deliberately NOT merged into a declaration (a template must never mint an
 * account; see template-merge.js).
 */
function validateTemplateSpec(spec) {
  if (spec === undefined || spec === null) throw new Error('spec is required');
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec must be an object');
  _assertSafeKeys(spec, 'spec');

  const out = {};

  if (spec.tenant !== undefined && spec.tenant !== null) {
    if (typeof spec.tenant !== 'object' || Array.isArray(spec.tenant)) throw new Error('spec.tenant must be an object');
    const kind = _str(spec.tenant.kind, 'spec.tenant.kind', { max: 32 });
    if (kind !== undefined) {
      if (!KINDS.has(kind)) throw new Error(`spec.tenant.kind must be one of ${[...KINDS].join(', ')}`);
      out.tenant = { kind };
    }
  }

  const regional = _validateRegional(spec.regional);
  if (regional) out.regional = regional;
  const modules = _validateModules(spec.modules);
  if (modules) out.modules = modules;
  // Accept the architecture doc's legacy field name `nomenclators` as an alias.
  const nomenclatures = _validateNomenclatures(
    spec.nomenclatures !== undefined ? spec.nomenclatures : spec.nomenclators,
  );
  if (nomenclatures) out.nomenclatures = nomenclatures;
  const entities = _validateEntities(spec.entities);
  if (entities) out.entities = entities;
  const relations = _validateRelations(spec.relations, entities);
  if (relations) out.relations = relations;
  const roles = _validateRoles(spec.roles);
  if (roles) out.roles = roles;
  const users = _validateUsers(spec.users);
  if (users) out.users = users;
  const notes = _str(spec.notes, 'spec.notes', { max: MAX_NOTES });
  if (notes) out.notes = notes;

  const serialized = JSON.stringify(out);
  if (serialized.length > MAX_SPEC_BYTES) throw new Error(`spec exceeds ${MAX_SPEC_BYTES} bytes`);
  return out;
}

/**
 * Validate + normalize a full template record (metadata + spec).
 * @returns {{key,name,description,industry,version,spec}}
 */
function validateTemplateRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('template must be an object');
  _assertSafeKeys({ key: rec.key, name: rec.name, description: rec.description, industry: rec.industry, version: rec.version }, 'template');

  const key = _str(rec.key, 'template.key', { required: true, max: 64 });
  if (!KEY_RE.test(key)) throw new Error('template.key must match ^[a-z0-9][a-z0-9-]{1,62}$');
  const name = _str(rec.name, 'template.name', { required: true, max: 200 });
  const description = _str(rec.description, 'template.description', { max: 1000 });
  const industry = _str(rec.industry, 'template.industry', { max: 64 });
  const version = rec.version === undefined || rec.version === null || rec.version === ''
    ? '1.0.0'
    : _str(rec.version, 'template.version', { max: 32 });
  if (!SEMVER_RE.test(version)) throw new Error('template.version must be semver (e.g. 1.0.0)');

  return { key, name, description, industry, version, spec: validateTemplateSpec(rec.spec) };
}

// ── DB read models ───────────────────────────────────────────────────────────

function _shape(row) {
  if (!row) return null;
  return {
    key: row.key,
    name: row.name,
    description: row.description || null,
    industry: row.industry || null,
    version: row.version,
    isBuiltin: !!row.is_builtin,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    spec: _parse(row.spec_json) || {},
  };
}

/** All templates, built-ins first, then custom — both alphabetical by key. */
function list() {
  const rows = getDb().prepare(
    'SELECT * FROM onboarding_templates ORDER BY is_builtin DESC, key ASC',
  ).all();
  return rows.map(_shape);
}

/** One template by key, or null. */
function get(key) {
  if (typeof key !== 'string' || !key) return null;
  return _shape(getDb().prepare('SELECT * FROM onboarding_templates WHERE key = ?').get(key));
}

/** Just the validated spec for a key (used by the declaration merge), or null. */
function getSpec(key) {
  const t = get(key);
  return t ? t.spec : null;
}

const _UPSERT_SQL = `
  INSERT INTO onboarding_templates (key, name, description, industry, version, spec_json, is_builtin, created_by, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    name        = excluded.name,
    description = excluded.description,
    industry    = excluded.industry,
    version     = excluded.version,
    spec_json   = excluded.spec_json,
    is_builtin  = excluded.is_builtin,
    updated_at  = datetime('now')
`;

/**
 * Create / update a CUSTOM template (is_builtin=0).
 * A built-in key can never be shadowed — that is a 409.
 */
function saveCustom(rec, user) {
  const db = getDb();
  const norm = validateTemplateRecord(rec);
  const existing = db.prepare('SELECT is_builtin FROM onboarding_templates WHERE key = ?').get(norm.key);
  if (existing && existing.is_builtin) {
    const err = new Error(`'${norm.key}' is a built-in template key and cannot be overwritten`);
    err.status = 409;
    throw err;
  }
  db.prepare(_UPSERT_SQL).run(
    norm.key, norm.name, norm.description || null, norm.industry || null, norm.version,
    JSON.stringify(norm.spec), 0, (user && user.username) || 'system',
  );
  return get(norm.key);
}

/** Delete a CUSTOM template. Built-ins are file-owned and cannot be deleted. */
function remove(key) {
  const db = getDb();
  const row = db.prepare('SELECT is_builtin FROM onboarding_templates WHERE key = ?').get(key);
  if (!row) { const e = new Error('template not found'); e.status = 404; throw e; }
  if (row.is_builtin) {
    const e = new Error(`'${key}' is a built-in template and cannot be deleted`);
    e.status = 400;
    throw e;
  }
  db.prepare('DELETE FROM onboarding_templates WHERE key = ?').run(key);
  return true;
}

/**
 * Build a template spec out of a declaration (the "save as template" path).
 * Strips EVERY secret by construction: `hosts` are dropped wholesale (they carry
 * credentials + real addresses), `users[].password` is never copied, and the
 * result goes through validateTemplateSpec() which throws on any secret-shaped
 * key that survived.
 */
function specFromDeclaration(decl) {
  const d = decl && typeof decl === 'object' ? decl : {};
  const spec = {};
  if (d.tenant && d.tenant.kind) spec.tenant = { kind: d.tenant.kind };
  if (d.regional && typeof d.regional === 'object') spec.regional = { ...d.regional };
  if (Array.isArray(d.modules) && d.modules.length) {
    spec.modules = d.modules.map((m) => (typeof m === 'string' ? { key: m, enabled: true } : { key: m.key, enabled: m.enabled !== false }));
  }
  if (Array.isArray(d.nomenclatures) && d.nomenclatures.length) {
    spec.nomenclatures = d.nomenclatures.map((n) => ({ kind: n.kind, code: n.code, label: n.label, sort: n.sort, meta: n.meta }));
  }
  // Entities/relations are inert structural data (no credential, no principal) —
  // safe to capture into a reusable template. validateTemplateSpec re-checks them.
  if (Array.isArray(d.entities) && d.entities.length) {
    spec.entities = d.entities.map((e) => ({ entityType: e.entityType, code: e.code, name: e.name, meta: e.meta }));
  }
  if (Array.isArray(d.relations) && d.relations.length) {
    spec.relations = d.relations.map((r) => ({
      fromType: r.fromType, fromCode: r.fromCode, toType: r.toType, toCode: r.toCode, relationType: r.relationType,
    }));
  }
  if (Array.isArray(d.users) && d.users.length) {
    // Shape only — username/role/owner. No password, ever.
    spec.users = d.users.map((u) => ({ username: u.username, role: u.role, isOwner: !!u.isOwner, displayName: u.displayName }));
  }
  return validateTemplateSpec(spec);
}

// ── built-in loader (howto-loader pattern; file overrides DB) ────────────────

/**
 * Walk src/db/onboarding-templates/*.json and UPSERT each as is_builtin=1.
 * Idempotent: re-running converges to the same rows (only updated_at moves).
 * The FILE is the source of truth — it overwrites the DB row for its key.
 * A malformed file is logged + skipped; the loader never throws.
 * @returns {{loaded:number, skipped:number, errors:Array<{file:string,error:string}>}}
 */
function loadBuiltins(dbArg) {
  const db = dbArg || getDb();
  const result = { loaded: 0, skipped: 0, errors: [] };
  if (!fs.existsSync(TEMPLATES_DIR)) return result;

  let files;
  try {
    files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  } catch (err) {
    result.errors.push({ file: '<dir>', error: err.message });
    return result;
  }
  if (!files.length) return result;

  const upsert = db.prepare(_UPSERT_SQL);
  for (const file of files) {
    try {
      const full = path.join(TEMPLATES_DIR, file);
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      const norm = validateTemplateRecord(raw);
      // The key must match the filename so a preset's identity is greppable and
      // a file can never claim another file's key.
      const base = file.slice(0, -'.json'.length);
      if (norm.key !== base) throw new Error(`key "${norm.key}" does not match filename "${base}"`);
      upsert.run(
        norm.key, norm.name, norm.description || null, norm.industry || null, norm.version,
        JSON.stringify(norm.spec), 1, 'system',
      );
      result.loaded += 1;
    } catch (err) {
      result.skipped += 1;
      result.errors.push({ file, error: err.message });
    }
  }

  if (result.loaded > 0 || result.errors.length > 0) {
    log.info('Onboarding templates loaded', { loaded: result.loaded, skipped: result.skipped, errorCount: result.errors.length });
    for (const e of result.errors) log.warn('Onboarding template skipped', e);
  }
  return result;
}

module.exports = {
  TEMPLATES_DIR,
  validateTemplateSpec,
  validateTemplateRecord,
  specFromDeclaration,
  loadBuiltins,
  list,
  get,
  getSpec,
  saveCustom,
  remove,
};
