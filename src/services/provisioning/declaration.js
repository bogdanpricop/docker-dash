'use strict';

// v8.15.0 (Onboarding — Phase 1) — Declaration validator (onboarding-declaration v1).
//
// Mirrors reconciler.validateDoc: validate → return a fresh WHITELISTED canonical
// object (unknown keys dropped, not passed through), throwing with per-field
// context on the first problem. Every field is schema-validated.
//
// Security contract (plans/onboarding-security.md §C6, §C2, TC-02/08/09):
//   - REJECT any wire-supplied tenant_id / org_id — the tenant is derived
//     server-side; the declaration format has no such field.
//   - Secrets (host creds, user passwords) are crypto.encrypt'd ON INGEST and
//     stored inline as { _enc: '<iv:tag:ct>' }. They are NEVER echoed: use
//     redactDeclaration() for any response/export.
//   - Prototype-pollution guard on every nested object.
//   - Least-privilege roles: role allow-list; demo/trial may not declare admin;
//     at most one owner.
//   - Bounded volumes (anti-DoS).

const { encrypt, decrypt, sha256 } = require('../../utils/crypto');
const catalog = require('./catalog');
const { applyTemplateDefaults } = require('./template-merge');

// ── field domains ────────────────────────────────────────────────────────────
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;          // also blocks path traversal if slug→filename
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS = new Set(['client', 'plant', 'internal']);
const MODES = new Set(['demo', 'trial', 'production']);
const ROLES = new Set(['viewer', 'operator', 'admin']);
const PERMISSIONS = new Set(['view', 'operate', 'admin']);
const CONN_TYPES = new Set(['socket', 'tcp', 'ssh']);
const UNIT_SYSTEMS = new Set(['metric', 'imperial']);
const REGIONAL_KEYS = ['locale', 'timezone', 'currency', 'unitSystem', 'dateFormat', 'numberFormat'];

// ── volume caps (anti-DoS, security C5/T13) ──────────────────────────────────
const MAX_HOSTS = 100;
const MAX_USERS = 100;
const MAX_MODULES = 32;
const MAX_PERMISSIONS = 500;
const MAX_NOMENCLATURES = 500;
const MAX_STR = 512;          // generic string cap
const MAX_SECRET = 65536;     // an SSH private key can be a few KB

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function _assertNoProtoPollution(obj, path) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (PROTO_KEYS.has(key)) throw new Error(`forbidden key "${key}" at ${path || '<root>'}`);
    const v = obj[key];
    if (v && typeof v === 'object') _assertNoProtoPollution(v, `${path || ''}.${key}`);
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

// Encrypt a secret value inline. Returns { _enc } or undefined for empty input.
function _enc(v, field) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  if (v.length > MAX_SECRET) throw new Error(`${field} exceeds ${MAX_SECRET} characters`);
  return { _enc: encrypt(v) };
}

/** Decrypt an inline secret marker produced by _enc(). Returns undefined if absent. */
function revealSecret(marker) {
  if (marker === undefined || marker === null) return undefined;
  if (typeof marker === 'object' && typeof marker._enc === 'string') return decrypt(marker._enc);
  if (typeof marker === 'string') return marker; // defensive: plaintext should never reach here
  return undefined;
}

function _isSecretMarker(v) {
  return v && typeof v === 'object' && typeof v._enc === 'string';
}

// ── sub-block validators ─────────────────────────────────────────────────────

function _validateTenant(t) {
  if (!t || typeof t !== 'object') throw new Error('tenant block is required');
  // Reject any wire-supplied tenant identity (TC-02). The engine assigns it.
  for (const forbidden of ['id', 'tenant_id', 'tenantId']) {
    if (t[forbidden] !== undefined) throw new Error(`tenant.${forbidden} is not allowed (tenant is derived server-side)`);
  }
  const slug = _str(t.slug, 'tenant.slug', { required: true, max: 63 });
  if (!SLUG_RE.test(slug)) throw new Error('tenant.slug must match ^[a-z0-9][a-z0-9-]{1,62}$');
  const name = _str(t.name, 'tenant.name', { required: true, max: 200 });
  const kind = t.kind === undefined ? 'internal' : _str(t.kind, 'tenant.kind', { max: 32 });
  if (!KINDS.has(kind)) throw new Error(`tenant.kind must be one of ${[...KINDS].join(', ')}`);
  return { slug, name, kind };
}

function _validateRegional(r) {
  if (r === undefined || r === null) return undefined;
  if (typeof r !== 'object') throw new Error('regional must be an object');
  const out = {};
  for (const key of Object.keys(r)) {
    if (!REGIONAL_KEYS.includes(key)) continue; // whitelist: drop unknowns
    if (key === 'unitSystem') {
      const us = _str(r[key], 'regional.unitSystem', { max: 16 });
      if (us !== undefined && !UNIT_SYSTEMS.has(us)) throw new Error("regional.unitSystem must be 'metric' or 'imperial'");
      if (us !== undefined) out.unitSystem = us;
    } else {
      const val = _str(r[key], `regional.${key}`, { max: 64 });
      if (val !== undefined) out[key] = val;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function _validateModules(mods) {
  if (mods === undefined || mods === null) return [];
  if (!Array.isArray(mods)) throw new Error('modules must be an array');
  if (mods.length > MAX_MODULES) throw new Error(`too many modules (max ${MAX_MODULES})`);
  const seen = new Set();
  const out = [];
  mods.forEach((m, i) => {
    const key = typeof m === 'string' ? m : (m && m.key);
    const k = _str(key, `modules[${i}].key`, { required: true, max: 64 });
    const enabled = typeof m === 'object' && m.enabled === false ? false : true;
    if (seen.has(k)) return; // de-dupe
    seen.add(k);
    out.push({ key: k, enabled });
  });
  return out;
}

function _validateHosts(hosts) {
  if (hosts === undefined || hosts === null) return [];
  if (!Array.isArray(hosts)) throw new Error('hosts must be an array');
  if (hosts.length > MAX_HOSTS) throw new Error(`too many hosts (max ${MAX_HOSTS})`);
  const names = new Set();
  return hosts.map((h, i) => {
    if (!h || typeof h !== 'object') throw new Error(`hosts[${i}] must be an object`);
    const name = _str(h.name, `hosts[${i}].name`, { required: true, max: 200 });
    if (names.has(name)) throw new Error(`hosts[${i}]: duplicate host name "${name}"`);
    names.add(name);
    const connectionType = _str(h.connectionType, `hosts[${i}].connectionType`, { required: true, max: 16 });
    if (!CONN_TYPES.has(connectionType)) throw new Error(`hosts[${i}].connectionType must be one of ${[...CONN_TYPES].join(', ')}`);

    const out = {
      name,
      connectionType,
      socketPath: _str(h.socketPath, `hosts[${i}].socketPath`, { max: 256 }),
      host: _str(h.host, `hosts[${i}].host`, { max: 256 }),
      port: h.port === undefined || h.port === null ? undefined : Number(h.port),
      sshHost: _str(h.sshHost, `hosts[${i}].sshHost`, { max: 256 }),
      sshPort: h.sshPort === undefined || h.sshPort === null ? undefined : Number(h.sshPort),
      sshUsername: _str(h.sshUsername, `hosts[${i}].sshUsername`, { max: 128 }),
      sshDockerSocket: _str(h.sshDockerSocket, `hosts[${i}].sshDockerSocket`, { max: 256 }),
      tlsCa: _str(h.tlsCa, `hosts[${i}].tlsCa`, { max: MAX_SECRET }),
      tlsCert: _str(h.tlsCert, `hosts[${i}].tlsCert`, { max: MAX_SECRET }),
    };
    if (out.port !== undefined && !Number.isInteger(out.port)) throw new Error(`hosts[${i}].port must be an integer`);
    if (out.sshPort !== undefined && !Number.isInteger(out.sshPort)) throw new Error(`hosts[${i}].sshPort must be an integer`);

    // Minimal per-type requirements (mirrors routes/hosts.js).
    if (connectionType === 'tcp' && !out.host) throw new Error(`hosts[${i}]: host address is required for tcp`);
    if (connectionType === 'ssh' && (!out.sshHost || !out.sshUsername)) {
      throw new Error(`hosts[${i}]: sshHost and sshUsername are required for ssh`);
    }

    // Secret bundle — encrypted inline on ingest, never echoed.
    const secretIn = h.secret && typeof h.secret === 'object' ? h.secret : {};
    const secret = {};
    for (const [k, field] of [
      ['sshPassword', `hosts[${i}].secret.sshPassword`],
      ['sshPrivateKey', `hosts[${i}].secret.sshPrivateKey`],
      ['sshPassphrase', `hosts[${i}].secret.sshPassphrase`],
      ['tlsKey', `hosts[${i}].secret.tlsKey`],
    ]) {
      const enc = _enc(secretIn[k], field);
      if (enc) secret[k] = enc;
    }
    out.secret = secret;
    return out;
  });
}

function _validateUsers(users, mode) {
  if (users === undefined || users === null) return [];
  if (!Array.isArray(users)) throw new Error('users must be an array');
  if (users.length > MAX_USERS) throw new Error(`too many users (max ${MAX_USERS})`);
  const names = new Set();
  let ownerCount = 0;
  return users.map((u, i) => {
    if (!u || typeof u !== 'object') throw new Error(`users[${i}] must be an object`);
    const username = _str(u.username, `users[${i}].username`, { required: true, max: 64 });
    if (!USERNAME_RE.test(username)) throw new Error(`users[${i}].username has invalid characters`);
    if (names.has(username.toLowerCase())) throw new Error(`users[${i}]: duplicate username "${username}"`);
    names.add(username.toLowerCase());

    const role = u.role === undefined ? 'viewer' : _str(u.role, `users[${i}].role`, { max: 16 });
    if (!ROLES.has(role)) throw new Error(`users[${i}].role must be one of ${[...ROLES].join(', ')}`);
    // Least-privilege: demo/trial runs may NEVER declare an admin (TC-08).
    if (role === 'admin' && mode !== 'production') {
      throw new Error(`users[${i}]: role 'admin' is not permitted in ${mode} mode (least-privilege)`);
    }
    const isOwner = u.isOwner === true;
    if (isOwner) {
      ownerCount += 1;
      if (ownerCount > 1) throw new Error('at most one user may be is_owner per run');
    }
    return {
      username,
      displayName: _str(u.displayName, `users[${i}].displayName`, { max: 128 }),
      email: _str(u.email, `users[${i}].email`, { max: 256 }),
      role,
      isOwner,
      password: _enc(u.password, `users[${i}].password`),
    };
  });
}

// v8.16.0 (Phase 2) — per-tenant lookup lists. Templates pre-fill them; the
// seed_nomenclatures step upserts them by (tenant_id, kind, code).
function _validateNomenclatures(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('nomenclatures must be an array');
  if (list.length > MAX_NOMENCLATURES) throw new Error(`too many nomenclatures (max ${MAX_NOMENCLATURES})`);
  const seen = new Set();
  return list.map((n, i) => {
    if (!n || typeof n !== 'object') throw new Error(`nomenclatures[${i}] must be an object`);
    const kind = _str(n.kind, `nomenclatures[${i}].kind`, { required: true, max: 64 });
    catalog.validateNomenclatureKind(kind); // known-set guard (091 has no CHECK)
    const code = _str(n.code, `nomenclatures[${i}].code`, { required: true, max: 64 });
    if (!CODE_RE.test(code)) throw new Error(`nomenclatures[${i}].code has invalid characters`);
    const label = _str(n.label, `nomenclatures[${i}].label`, { required: true, max: 200 });
    const dedupe = `${kind}\u0000${code.toLowerCase()}`; // NUL separator: unambiguous composite key
    if (seen.has(dedupe)) throw new Error(`nomenclatures[${i}]: duplicate ${kind}/${code}`);
    seen.add(dedupe);

    const out = { kind, code, label, sort: 0 };
    if (n.sort !== undefined && n.sort !== null && n.sort !== '') {
      const sort = Number(n.sort);
      if (!Number.isInteger(sort)) throw new Error(`nomenclatures[${i}].sort must be an integer`);
      out.sort = sort;
    }
    if (n.meta !== undefined && n.meta !== null) {
      if (typeof n.meta !== 'object' || Array.isArray(n.meta)) throw new Error(`nomenclatures[${i}].meta must be an object`);
      const metaJson = JSON.stringify(n.meta);
      if (metaJson.length > 2048) throw new Error(`nomenclatures[${i}].meta is too large`);
      out.meta = JSON.parse(metaJson);
    }
    return out;
  });
}

function _validatePermissions(perms) {
  if (perms === undefined || perms === null) return [];
  if (!Array.isArray(perms)) throw new Error('permissions must be an array');
  if (perms.length > MAX_PERMISSIONS) throw new Error(`too many permissions (max ${MAX_PERMISSIONS})`);
  return perms.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error(`permissions[${i}] must be an object`);
    const username = _str(p.username, `permissions[${i}].username`, { required: true, max: 64 });
    const hostName = _str(p.hostName, `permissions[${i}].hostName`, { required: true, max: 200 });
    const permission = p.permission === undefined ? 'view' : _str(p.permission, `permissions[${i}].permission`, { max: 16 });
    if (!PERMISSIONS.has(permission)) throw new Error(`permissions[${i}].permission must be one of ${[...PERMISSIONS].join(', ')}`);
    return { username, hostName, permission };
  });
}

/**
 * Validate + normalize an onboarding-declaration v1 document.
 *
 * If `doc.template` names a template, its spec is merged in as DEFAULTS FIRST
 * (user values always win) — so the MERGED document is what is validated,
 * fingerprinted and stored. See template-merge.js for the precedence rules.
 *
 * @returns the whitelisted canonical declaration (secrets encrypted inline).
 * @throws Error with per-field context on the first problem.
 */
function validateDeclaration(rawDoc) {
  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) throw new Error('declaration must be an object');
  _assertNoProtoPollution(rawDoc, 'declaration');

  if (rawDoc.version !== 1) throw new Error('unsupported declaration.version (expected 1)');
  if (rawDoc.kind !== undefined && rawDoc.kind !== 'onboarding-declaration') {
    throw new Error("declaration.kind must be 'onboarding-declaration'");
  }
  // Reject any wire-supplied tenant identity at the top level too (TC-02).
  for (const forbidden of ['tenant_id', 'tenantId', 'org_id', 'orgId']) {
    if (rawDoc[forbidden] !== undefined) throw new Error(`${forbidden} is not allowed (tenant is derived server-side)`);
  }

  // Template defaults go UNDER the user's explicit values, before anything else
  // is normalized. Proto-pollution was already rejected above, so the merge can
  // never introduce a poisoned key.
  const doc = applyTemplateDefaults(rawDoc);

  const tenant = _validateTenant(doc.tenant);
  // mode comes from top-level `mode` OR tenant.usageMode; default production.
  const rawMode = doc.mode !== undefined ? doc.mode : (doc.tenant && doc.tenant.usageMode);
  const mode = rawMode === undefined || rawMode === null ? 'production' : _str(rawMode, 'mode', { max: 16 });
  if (!MODES.has(mode)) throw new Error(`mode must be one of ${[...MODES].join(', ')}`);

  const idempotencyKey = _str(doc.idempotencyKey, 'idempotencyKey', { max: 128 });
  const templateKey = _str(doc.template, 'template', { max: 128 });

  const out = {
    version: 1,
    kind: 'onboarding-declaration',
    idempotencyKey,
    template: templateKey,
    mode,
    tenant,
    regional: _validateRegional(doc.regional),
    modules: _validateModules(doc.modules),
    nomenclatures: _validateNomenclatures(doc.nomenclatures),
    hosts: _validateHosts(doc.hosts),
    users: _validateUsers(doc.users, mode),
    permissions: _validatePermissions(doc.permissions),
  };
  return out;
}

/**
 * Deep clone of a normalized declaration with every inline secret marker
 * replaced by '<redacted>'. Used for API responses, run/step JSON in responses,
 * and the golden-config export. Never returns ciphertext or plaintext.
 */
function redactDeclaration(decl) {
  const walk = (v) => {
    if (_isSecretMarker(v)) return '<redacted>';
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  return walk(decl);
}

/**
 * Deterministic fingerprint of the LOGICAL declaration (secrets excluded, so it
 * is stable across re-encryption). Two applies with the same idempotency key
 * must carry the same fingerprint; a different fingerprint under a reused key is
 * a 409 (key-fixation guard, security C5/TC-07).
 */
function fingerprintDeclaration(decl) {
  const canonical = {
    slug: decl.tenant.slug.toLowerCase(),
    kind: decl.tenant.kind,
    mode: decl.mode,
    template: decl.template || null,
    regional: decl.regional ? REGIONAL_KEYS.filter((k) => decl.regional[k] !== undefined).map((k) => [k, decl.regional[k]]) : [],
    modules: decl.modules.map((m) => `${m.key}:${m.enabled ? 1 : 0}`).sort(),
    nomenclatures: (decl.nomenclatures || []).map((n) => `${n.kind}|${n.code}|${n.label}|${n.sort}`).sort(),
    hosts: decl.hosts.map((h) => `${h.name}|${h.connectionType}`).sort(),
    users: decl.users.map((u) => `${u.username.toLowerCase()}|${u.role}|${u.isOwner ? 1 : 0}`).sort(),
    permissions: decl.permissions.map((p) => `${p.username.toLowerCase()}|${p.hostName}|${p.permission}`).sort(),
  };
  return sha256(JSON.stringify(canonical));
}

module.exports = {
  validateDeclaration,
  redactDeclaration,
  fingerprintDeclaration,
  revealSecret,
};
