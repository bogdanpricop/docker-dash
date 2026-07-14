'use strict';

// v8.9.42-alpha.1 — Declarative Reconciler. A blueprint is a JSON desired-state
// doc. This service captures it from reality, PLANs (diffs desired vs the actual
// app-managed firewall rules), and APPLIES it by converging through the existing
// firewall primitives (applyRule/removeRule — guarded, snapshotted, audited). It
// NEVER re-implements rule execution and NEVER touches manual/system rules.

const { assertSafe } = require('../firewall/validate');
const log = require('../../utils/logger')('reconciler');

function _db() { return require('../../db').getDb(); }
function _fw() { return require('../firewall'); }

// Identity of a firewall rule independent of its uuid/backend.
function _ruleKey(r) {
  return [r.scope, r.action, r.source_ip || '', r.destination_port || '', r.protocol || 'tcp'].join('|');
}

// Pure diff of desired specs vs actual (app-managed) rules, by rule identity.
function _diff(desired, actual) {
  const desiredByKey = new Map(desired.map(r => [_ruleKey(r), r]));
  const actualByKey = new Map(actual.map(r => [_ruleKey(r), r]));
  return {
    toCreate: desired.filter(r => !actualByKey.has(_ruleKey(r))),
    toRemove: actual.filter(r => !desiredByKey.has(_ruleKey(r))),
    inSync: desired.filter(r => actualByKey.has(_ruleKey(r))),
  };
}

// ── Blueprint CRUD ──────────────────────────────────────────
function list() {
  return _db().prepare('SELECT id, name, description, enforce, is_active, created_by, created_at, updated_at, last_plan_at, last_apply_at FROM blueprints ORDER BY updated_at DESC').all();
}
function get(id) {
  const row = _db().prepare('SELECT * FROM blueprints WHERE id = ?').get(id);
  if (!row) return null;
  row.doc = _parse(row.doc);
  row.runs = _db().prepare('SELECT id, kind, summary, by, at FROM blueprint_runs WHERE blueprint_id = ? ORDER BY at DESC LIMIT 25').all(id)
    .map(r => ({ ...r, summary: _parse(r.summary) }));
  return row;
}
function _parse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function create({ name, description, doc, user }) {
  const norm = validateDoc(doc); // throws on bad
  const info = _db().prepare('INSERT INTO blueprints (name, description, doc, created_by) VALUES (?,?,?,?)')
    .run(name || 'blueprint', description || null, JSON.stringify(norm), (user && user.username) || 'system');
  return get(info.lastInsertRowid);
}
function update(id, { name, description, doc, user }) {
  const row = _db().prepare('SELECT id FROM blueprints WHERE id = ?').get(id);
  if (!row) throw new Error('Blueprint not found');
  const norm = doc !== undefined ? validateDoc(doc) : undefined;
  _db().prepare(`UPDATE blueprints SET
    name = COALESCE(?, name), description = COALESCE(?, description),
    doc = COALESCE(?, doc), updated_at = datetime('now') WHERE id = ?`)
    .run(name ?? null, description ?? null, norm ? JSON.stringify(norm) : null, id);
  return get(id);
}
function remove(id) { _db().prepare('DELETE FROM blueprints WHERE id = ?').run(id); return { ok: true }; }
function setEnforce(id, enforce) {
  _db().prepare("UPDATE blueprints SET enforce = ?, updated_at = datetime('now') WHERE id = ?").run(enforce ? 1 : 0, id);
  return get(id);
}

// ── Validation ──────────────────────────────────────────────
// Validate the whole doc; every firewall rule must pass assertSafe. Returns the
// canonical (normalized) doc. Throws with per-rule context on the first problem.
function validateDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('doc must be an object');
  if (doc.version !== 1) throw new Error('unsupported doc.version (expected 1)');
  const hosts = doc.hosts || {};
  if (typeof hosts !== 'object') throw new Error('doc.hosts must be an object');
  const out = { version: 1, kind: 'estate-blueprint', hosts: {} };
  for (const [hostId, block] of Object.entries(hosts)) {
    const fw = (block && block.firewall) || [];
    if (!Array.isArray(fw)) throw new Error(`host ${hostId}: firewall must be an array`);
    const containers = (block && block.containers) || [];
    if (!Array.isArray(containers)) throw new Error(`host ${hostId}: containers must be an array`);
    out.hosts[hostId] = {
      firewall: fw.map((r, i) => {
        try { return assertSafe(r); }
        catch (e) { throw new Error(`host ${hostId} firewall[${i}]: ${e.message}`); }
      }),
      containers: containers.map((c, i) => _validateContainer(c, hostId, i)),
    };
  }
  return out;
}

// Container desired-state (MVP: ensure-running only — never delete). Name must be
// a safe container name; state must be 'running'.
function _validateContainer(c, hostId, i) {
  if (!c || typeof c !== 'object') throw new Error(`host ${hostId} containers[${i}]: must be an object`);
  const name = c.name;
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) throw new Error(`host ${hostId} containers[${i}]: invalid name "${name}"`);
  const state = c.state || 'running';
  if (state !== 'running') throw new Error(`host ${hostId} containers[${i}]: only state "running" is supported`);
  return { name, state: 'running' };
}

// ── Capture ─────────────────────────────────────────────────
async function capture() {
  const hosts = _db().prepare('SELECT id, name FROM docker_hosts WHERE is_active = 1').all();
  const out = { version: 1, kind: 'estate-blueprint', capturedAt: new Date().toISOString(), hosts: {} };
  for (const h of hosts) {
    const key = String(h.id);
    // Firewall rules (app-managed).
    try {
      const info = await _fw().listRules(h.id);
      const rules = (info && info.rules) || [];
      if (rules.length) {
        (out.hosts[key] = out.hosts[key] || {}).firewall = rules.map(r => ({
          action: r.action, scope: r.scope,
          source_ip: r.source_ip || undefined, destination_port: r.destination_port || undefined,
          protocol: r.protocol || 'tcp', reason: r.reason || undefined,
        }));
      }
    } catch { /* unreachable → skip firewall for this host */ }
    // Currently-running containers → an ensure-running baseline (Docker/Podman only).
    const dt = h.daemon_type || 'docker';
    if (dt === 'docker' || dt === 'podman') {
      try {
        const cs = await require('../docker').listContainers(h.id);
        const running = (cs || []).filter(c => c.state === 'running').map(c => ({ name: c.name, state: 'running' }));
        if (running.length) (out.hosts[key] = out.hosts[key] || {}).containers = running;
      } catch { /* unreachable → skip containers */ }
    }
  }
  return out;
}

// ── Plan (diff desired vs actual app-managed rules) ─────────
async function plan(doc) {
  const norm = validateDoc(doc);
  const result = { hosts: {}, summary: { create: 0, remove: 0, inSync: 0, hosts: 0, unreachable: 0, containerStart: 0, containerMissing: 0 } };
  for (const [hostIdStr, block] of Object.entries(norm.hosts)) {
    const hostId = parseInt(hostIdStr, 10);
    const hostRow = _db().prepare('SELECT name, daemon_type FROM docker_hosts WHERE id = ?').get(hostId);
    if (!hostRow) { result.hosts[hostIdStr] = { orphaned: true, hostName: `host ${hostId}` }; continue; }
    result.summary.hosts++;
    const hostResult = { hostName: hostRow.name };

    // Firewall (only if the blueprint declares any for this host).
    if ((block.firewall || []).length || true) {
      try {
        const info = await _fw().listRules(hostId);
        const actual = (info && info.rules) || [];
        // Removals only ever touch app-managed rules (listRules.rules are all APPFW-tagged).
        const { toCreate, toRemove, inSync } = _diff(block.firewall || [], actual);
        Object.assign(hostResult, { toCreate, toRemove, inSync });
        result.summary.create += toCreate.length;
        result.summary.remove += toRemove.length;
        result.summary.inSync += inSync.length;
      } catch (e) {
        // Firewall unreachable — still try containers below; note the gap.
        Object.assign(hostResult, { toCreate: [], toRemove: [], inSync: [], firewallError: e.message });
      }
    }

    // Containers (ensure-running; Docker/Podman only; never delete).
    const dt = hostRow.daemon_type || 'docker';
    if ((block.containers || []).length && (dt === 'docker' || dt === 'podman')) {
      try {
        const actualC = await require('../docker').listContainers(hostId);
        const byName = new Map((actualC || []).map(c => [c.name, c]));
        const toStart = [], missing = [], running = [];
        for (const d of block.containers) {
          const a = byName.get(d.name);
          if (!a) missing.push({ name: d.name });
          else if (a.state !== 'running') toStart.push({ name: d.name, id: a.id });
          else running.push({ name: d.name });
        }
        hostResult.containers = { toStart, missing, running };
        result.summary.containerStart += toStart.length;
        result.summary.containerMissing += missing.length;
      } catch (e) { hostResult.containers = { toStart: [], missing: [], running: [], error: e.message }; }
    }

    if (hostResult.firewallError && !hostResult.containers) { hostResult.unreachable = true; hostResult.error = hostResult.firewallError; result.summary.unreachable++; }
    result.hosts[hostIdStr] = hostResult;
  }
  return result;
}

// ── Apply (converge) ────────────────────────────────────────
async function apply(doc, user) {
  const p = await plan(doc);
  const fw = _fw();
  const perHost = {};
  let applied = 0, removed = 0, started = 0, failed = 0;
  for (const [hostIdStr, h] of Object.entries(p.hosts)) {
    if (h.orphaned) { perHost[hostIdStr] = { skipped: 'orphaned' }; continue; }
    const hostId = parseInt(hostIdStr, 10);
    const res = { created: 0, removed: 0, started: 0, errors: [] };
    for (const spec of (h.toCreate || [])) {
      try { await fw.applyRule(hostId, spec, user); res.created++; applied++; }
      catch (e) { res.errors.push(`create ${_ruleKey(spec)}: ${e.message}`); failed++; }
    }
    for (const rule of (h.toRemove || [])) {
      try { await fw.removeRule(hostId, rule.rule_uuid, user); res.removed++; removed++; }
      catch (e) { res.errors.push(`remove ${rule.rule_uuid}: ${e.message}`); failed++; }
    }
    // Containers: start stopped ones (never delete). Missing ones can't be started.
    for (const c of ((h.containers && h.containers.toStart) || [])) {
      try { await require('../docker').getDocker(hostId).getContainer(c.id || c.name).start(); res.started++; started++; }
      catch (e) { res.errors.push(`start ${c.name}: ${e.message}`); failed++; }
    }
    perHost[hostIdStr] = res;
  }
  return { ok: failed === 0, applied, removed, started, failed, perHost };
}

function recordRun(blueprintId, kind, summary, by) {
  _db().prepare('INSERT INTO blueprint_runs (blueprint_id, kind, summary, by) VALUES (?,?,?,?)')
    .run(blueprintId, kind, JSON.stringify(summary || {}), by || 'system');
  const col = kind === 'apply' ? 'last_apply_at' : (kind === 'plan' ? 'last_plan_at' : null);
  if (col) _db().prepare(`UPDATE blueprints SET ${col} = datetime('now') WHERE id = ?`).run(blueprintId);
}

module.exports = {
  list, get, create, update, remove, setEnforce,
  validateDoc, capture, plan, apply, recordRun,
  _internals: { _ruleKey, _diff },
};
