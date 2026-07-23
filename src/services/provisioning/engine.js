'use strict';

// v8.15.0 (Onboarding — Phase 1) — Provisioning saga engine.
//
// An idempotent, checkpointed, resumable, rollback-able orchestrator over
// provisioning_runs / provisioning_steps. See plans/onboarding-architecture.md §2.
//
// ProvisioningStep interface (steps/*.js):
//   { key, kind:'db'|'external', run(ctx)->checkpoint, compensate?(ctx,cp), estimate?(ctx) }
//   - kind:'db'       — run() is SYNC pure-SQLite; the engine wraps it in
//                       db.transaction so the writes + step-done + cursor-advance
//                       COMMIT atomically (better-sqlite3 forbids awaiting inside
//                       a transaction, which is exactly why the two kinds exist).
//   - kind:'external' — run() is async / has real side effects; it runs OUTSIDE
//                       any transaction and its checkpoint is persisted in a tiny
//                       follow-up sync txn. Undo is the explicit compensate().
//
// Three-layer idempotency:
//   1. provisioning_runs.idempotency_key UNIQUE  — attach-or-create; a concurrent
//      same-key apply attaches to the existing run instead of duplicating.
//   2. UNIQUE(run_id, step_key) + status='completed' skip — provision-once.
//   3. natural-key UPSERTs inside each step — a torn re-run converges.

const { getDb } = require('../../db');
const auditService = require('../audit');
const log = require('../../utils/logger')('provisioning');
const { validateDeclaration, redactDeclaration, fingerprintDeclaration, revealSecret } = require('./declaration');
const { buildSteps, STEP_REGISTRY } = require('./steps');
const catalog = require('./catalog');

const _nowIso = () => new Date().toISOString();
const _parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ── row helpers ──────────────────────────────────────────────────────────────
function _getRun(runId) {
  return getDb().prepare('SELECT * FROM provisioning_runs WHERE id = ?').get(runId);
}
// Field names come ONLY from code (never user input) — safe to interpolate.
function _setRunFields(runId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE provisioning_runs SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), runId);
}
function _setStepFields(runId, stepKey, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE provisioning_steps SET ${sets} WHERE run_id = ? AND step_key = ?`)
    .run(...keys.map((k) => fields[k]), runId, stepKey);
}
function _ensureStepRow(runId, step) {
  getDb().prepare(
    "INSERT OR IGNORE INTO provisioning_steps (run_id, step_key, ordinal, status) VALUES (?, ?, ?, 'pending')",
  ).run(runId, step.key, step.ordinal);
}
function _recordStepDone(runId, step, checkpoint) {
  getDb().prepare(
    "UPDATE provisioning_steps SET status = 'completed', checkpoint_json = ?, finished_at = ?, error = NULL WHERE run_id = ? AND step_key = ?",
  ).run(JSON.stringify(checkpoint || {}), _nowIso(), runId, step.key);
}
function _setCursor(runId, ordinal) {
  getDb().prepare('UPDATE provisioning_runs SET current_step = ? WHERE id = ?').run(ordinal, runId);
}

// ── ctx ──────────────────────────────────────────────────────────────────────
function _buildCtx({ decl, user, run, ip }) {
  const db = getDb();
  const ctx = {
    db,
    decl,
    user: user || { username: 'system' },
    ip: ip || null,
    run,
    tenantId: (run && run.tenant_id) || null,
    log,
    setTenantId(id) {
      ctx.tenantId = id;
      if (run && run.id) db.prepare('UPDATE provisioning_runs SET tenant_id = ? WHERE id = ?').run(id, run.id);
    },
    reveal(marker) { return revealSecret(marker); },
    checkpoint(stepKey) {
      if (!run || !run.id) return null;
      const row = db.prepare('SELECT checkpoint_json FROM provisioning_steps WHERE run_id = ? AND step_key = ?').get(run.id, stepKey);
      return row ? _parse(row.checkpoint_json) : null;
    },
    // Audit the ACT (counts/ids/names) — NEVER a secret. tenantId + runId are
    // folded into details so the trail is tenant-attributable.
    audit(action, targetType, targetId, details) {
      auditService.log({
        userId: ctx.user && ctx.user.id,
        username: (ctx.user && ctx.user.username) || 'system',
        action,
        targetType,
        targetId: targetId != null ? String(targetId) : null,
        details: { ...(details || {}), runId: run && run.id, tenantId: ctx.tenantId },
        ip: ctx.ip,
      });
    },
  };
  return ctx;
}

// ── plan (dry-run, NO writes) ────────────────────────────────────────────────
function _warnings(decl) {
  const w = [];
  if (decl.mode !== 'production') w.push(`mode '${decl.mode}': demo/trial seeding is not available in Phase 1`);
  if (!decl.users.length) w.push('no users declared — the tenant will have no members');
  else if (!decl.users.some((u) => u.isOwner)) w.push('no owner declared (is_owner)');
  for (const h of decl.hosts) {
    const s = h.secret || {};
    if (h.connectionType === 'ssh' && !s.sshPassword && !s.sshPrivateKey) {
      w.push(`host '${h.name}': no SSH credential provided`);
    }
  }
  return w;
}
function _computePlanData(decl, ctx) {
  const steps = buildSteps(ctx);
  const creates = {};
  for (const step of steps) {
    if (typeof step.estimate !== 'function') continue;
    const est = step.estimate(ctx) || {};
    for (const [k, v] of Object.entries(est)) creates[k] = (creates[k] || 0) + (v || 0);
  }
  return {
    steps: steps.map((s) => ({ key: s.key, ordinal: s.ordinal, kind: s.kind })),
    impact: { creates },
    warnings: _warnings(decl),
  };
}

/** Dry-run: validate + compute impact/warnings. Writes NOTHING. */
function plan({ declaration, user, ip }) {
  const decl = validateDeclaration(declaration);
  const ctx = _buildCtx({ decl, user, run: { id: null }, ip });
  return _computePlanData(decl, ctx);
}

// ── replan / drift (READ-ONLY diff of a declaration vs an existing tenant) ────
//
// v8.18.0 (Phase 4). Diffs the DESIRED declaration against the tenant's CURRENT
// state and returns a categorized { toCreate, toUpdate, inSync } per resource —
// reconciler-plan style, writing NOTHING. Convergence is the existing idempotent
// apply(): every step upserts on its natural key, so re-applying the same
// declaration turns every resource `inSync` with no duplication.
const _REGIONAL_KEY_MAP = {
  locale: 'locale', timezone: 'timezone', currency: 'currency',
  unitSystem: 'unit_system', dateFormat: 'date_format', numberFormat: 'number_format',
};

function replan(tenantId, declaration) {
  const db = getDb();
  const tenant = db.prepare('SELECT id, slug, usage_mode, status FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) { const e = new Error(`tenant ${tenantId} not found`); e.status = 404; throw e; }
  const decl = validateDeclaration(declaration); // same contract as apply()

  const cat = () => ({ toCreate: [], toUpdate: [], inSync: [] });
  const diff = {
    tenantId, slug: tenant.slug, usageMode: tenant.usage_mode, mode: decl.mode,
    settings: cat(), modules: cat(), nomenclatures: cat(),
    entities: cat(), relations: cat(), hosts: cat(), users: cat(),
  };

  // regional → tenant_settings (snake_case)
  const r = decl.regional || {};
  for (const [camel, snake] of Object.entries(_REGIONAL_KEY_MAP)) {
    if (r[camel] === undefined) continue;
    const row = db.prepare('SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?').get(tenantId, snake);
    const desired = String(r[camel]);
    if (!row) diff.settings.toCreate.push({ key: snake, value: desired });
    else if (row.value !== desired) diff.settings.toUpdate.push({ key: snake, from: row.value, to: desired });
    else diff.settings.inSync.push({ key: snake });
  }

  // modules → dependency closure vs tenant_modules(enabled)
  let closure = [];
  try { closure = catalog.resolveDependencies((decl.modules || []).filter((m) => m.enabled !== false).map((m) => m.key)); } catch { closure = []; }
  for (const key of closure) {
    const row = db.prepare('SELECT enabled FROM tenant_modules WHERE tenant_id = ? AND module_key = ?').get(tenantId, key);
    if (!row) diff.modules.toCreate.push({ key });
    else if (!row.enabled) diff.modules.toUpdate.push({ key, from: 'disabled', to: 'enabled' });
    else diff.modules.inSync.push({ key });
  }

  // nomenclatures → by (kind, code)
  for (const n of decl.nomenclatures || []) {
    const row = db.prepare('SELECT label, sort FROM nomenclatures WHERE tenant_id = ? AND kind = ? AND code = ?').get(tenantId, n.kind, n.code);
    if (!row) diff.nomenclatures.toCreate.push({ kind: n.kind, code: n.code });
    else if (row.label !== n.label || row.sort !== (n.sort || 0)) diff.nomenclatures.toUpdate.push({ kind: n.kind, code: n.code });
    else diff.nomenclatures.inSync.push({ kind: n.kind, code: n.code });
  }

  // entities → by (entity_type, code)
  for (const e of decl.entities || []) {
    const row = db.prepare('SELECT name FROM tenant_entities WHERE tenant_id = ? AND entity_type = ? AND code = ?').get(tenantId, e.entityType, e.code);
    if (!row) diff.entities.toCreate.push({ entityType: e.entityType, code: e.code });
    else if (row.name !== e.name) diff.entities.toUpdate.push({ entityType: e.entityType, code: e.code });
    else diff.entities.inSync.push({ entityType: e.entityType, code: e.code });
  }

  // relations → resolve endpoints, then presence by (from,to,relationType)
  const findEntity = db.prepare('SELECT id FROM tenant_entities WHERE tenant_id = ? AND entity_type = ? AND code = ?');
  for (const rel of decl.relations || []) {
    const label = { fromType: rel.fromType, fromCode: rel.fromCode, toType: rel.toType, toCode: rel.toCode, relationType: rel.relationType };
    const from = findEntity.get(tenantId, rel.fromType, rel.fromCode);
    const to = findEntity.get(tenantId, rel.toType, rel.toCode);
    if (!from || !to) { diff.relations.toCreate.push(label); continue; } // endpoint not yet created
    const row = db.prepare('SELECT id FROM tenant_entity_relations WHERE tenant_id = ? AND from_entity_id = ? AND to_entity_id = ? AND relation_type = ?').get(tenantId, from.id, to.id, rel.relationType);
    if (!row) diff.relations.toCreate.push(label);
    else diff.relations.inSync.push(label); // relations carry no updatable payload beyond meta
  }

  // hosts / users are a SHARED pool (not tenant-scoped) — presence-only, matched
  // by their natural key. create_hosts/create_users upsert by the same key.
  for (const h of decl.hosts || []) {
    const row = db.prepare('SELECT id FROM docker_hosts WHERE name = ?').get(h.name);
    (row ? diff.hosts.inSync : diff.hosts.toCreate).push({ name: h.name });
  }
  for (const u of decl.users || []) {
    const row = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(u.username);
    (row ? diff.users.inSync : diff.users.toCreate).push({ username: u.username });
  }

  const resourceKeys = ['settings', 'modules', 'nomenclatures', 'entities', 'relations', 'hosts', 'users'];
  const sum = (bucket) => resourceKeys.reduce((s, k) => s + diff[k][bucket].length, 0);
  diff.summary = { toCreate: sum('toCreate'), toUpdate: sum('toUpdate'), inSync: sum('inSync') };
  diff.inSync = diff.summary.toCreate === 0 && diff.summary.toUpdate === 0;
  return diff;
}

// ── apply ────────────────────────────────────────────────────────────────────
function _deriveKey(decl) {
  // Stable per LOGICAL declaration (secrets excluded) — identical re-applies
  // dedupe; a genuinely different declaration mints a different run.
  return `auto:${fingerprintDeclaration(decl)}`;
}

function _createRun({ decl, user, key, fingerprint, ip }) {
  const db = getDb();
  const ctx = _buildCtx({ decl, user, run: { id: null }, ip });
  const planData = _computePlanData(decl, ctx);
  const planJson = JSON.stringify({ ...planData, fingerprint });
  const inputJson = JSON.stringify(decl); // normalized decl; secrets are {_enc} inline
  try {
    const r = db.prepare(`
      INSERT INTO provisioning_runs (mode, template_key, status, idempotency_key, plan_json, input_json, total_steps, started_by, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'))
    `).run(decl.mode, decl.template || null, key, planJson, inputJson, planData.steps.length, (user && user.username) || 'system');
    return _getRun(Number(r.lastInsertRowid));
  } catch (err) {
    // Lost a concurrent same-key race → attach to the existing run (layer 1).
    if (/UNIQUE|constraint/i.test(err.message)) {
      const existing = db.prepare('SELECT * FROM provisioning_runs WHERE idempotency_key = ?').get(key);
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Validate → attach-or-create the run → execute the saga.
 * @returns the shaped run (getRun) on success; throws (resumable) on step failure.
 */
async function apply({ declaration, user, idempotencyKey, ip }) {
  const decl = validateDeclaration(declaration);
  const key = idempotencyKey || decl.idempotencyKey || _deriveKey(decl);
  const fingerprint = fingerprintDeclaration(decl);
  const db = getDb();

  let run = db.prepare('SELECT * FROM provisioning_runs WHERE idempotency_key = ?').get(key);
  if (run) {
    const meta = _parse(run.plan_json) || {};
    if (meta.fingerprint && meta.fingerprint !== fingerprint) {
      const err = new Error('idempotency_key already used with a different declaration');
      err.status = 409;
      throw err;
    }
    if (run.status === 'completed') return getRun(run.id); // no-op replay
    if (run.status === 'rolled_back') {
      const err = new Error('run was rolled back; start a new run');
      err.status = 409;
      throw err;
    }
    // pending / running / failed → (re)enter the saga (resume semantics)
  } else {
    run = _createRun({ decl, user, key, fingerprint, ip });
  }
  return _execute(run.id, { user, ip });
}

// ── execute (the saga loop; also the resume path) ────────────────────────────
async function _execute(runId, { user, ip }) {
  const db = getDb();
  let run = _getRun(runId);
  // input_json is the server-written NORMALIZED declaration (secrets are {_enc}
  // markers) — it was validated at apply/create time, so parse (never
  // re-validate, which would try to re-encrypt the already-encrypted secrets).
  const decl = _parse(run.input_json);
  const ctx = _buildCtx({ decl, user, run, ip });
  ctx.tenantId = run.tenant_id || null;
  const steps = buildSteps(ctx);

  const isResume = run.current_step > 0;
  _setRunFields(runId, { status: 'running', started_at: run.started_at || _nowIso(), error: null });
  ctx.audit(isResume ? 'provisioning_run_resume' : 'provisioning_run_start', 'provisioning_run', runId, { mode: run.mode });

  for (const step of steps) {
    run = _getRun(runId);
    ctx.tenantId = run.tenant_id != null ? run.tenant_id : ctx.tenantId;
    if (step.ordinal <= run.current_step) continue; // already completed (resume/idempotent skip)

    _ensureStepRow(runId, step);
    const stepRow = db.prepare('SELECT * FROM provisioning_steps WHERE run_id = ? AND step_key = ?').get(runId, step.key);
    if (stepRow.status === 'completed') { _setCursor(runId, step.ordinal); continue; }

    _setStepFields(runId, step.key, { status: 'running', started_at: _nowIso(), error: null });
    try {
      if (step.kind === 'db') {
        // SYNC step + step-done + cursor advance commit atomically.
        db.transaction(() => {
          const cp = step.run(ctx);
          _recordStepDone(runId, step, cp);
          _setCursor(runId, step.ordinal);
        })();
      } else {
        // EXTERNAL step runs outside any txn; persist checkpoint + cursor after.
        const cp = await step.run(ctx);
        db.transaction(() => {
          _recordStepDone(runId, step, cp);
          _setCursor(runId, step.ordinal);
        })();
      }
      ctx.audit('provisioning_step_apply', 'provisioning_run', runId, { step: step.key, ordinal: step.ordinal, kind: step.kind });
    } catch (stepErr) {
      _setStepFields(runId, step.key, { status: 'failed', error: stepErr.message, finished_at: _nowIso() });
      _setRunFields(runId, { status: 'failed', error: `${step.key}: ${stepErr.message}` });
      ctx.audit('provisioning_run_fail', 'provisioning_run', runId, { step: step.key, error: stepErr.message });
      log.warn('provisioning step failed', { runId, step: step.key, error: stepErr.message });
      const err = new Error(`provisioning failed at step '${step.key}': ${stepErr.message}`);
      err.runId = runId;
      err.step = step.key;
      err.resumable = true;
      throw err;
    }
  }

  // All steps completed → assemble result, wipe inline secrets, mark completed.
  const result = _collectResult(runId);
  _setRunFields(runId, { status: 'completed', finished_at: _nowIso(), result_json: JSON.stringify(result) });
  _wipeInlineSecrets(runId, decl);
  const finalRun = _getRun(runId);
  ctx.audit('provisioning_run_complete', 'provisioning_run', runId, { tenantId: finalRun.tenant_id, steps: result.steps.length });
  return getRun(runId);
}

// Replace input_json with the REDACTED declaration once the run completes — the
// real secrets now live encrypted in their proper homes (docker_hosts.ssh_config,
// users.password_hash), so the run copy (even ciphertext) is no longer needed.
function _wipeInlineSecrets(runId, decl) {
  getDb().prepare('UPDATE provisioning_runs SET input_json = ? WHERE id = ?')
    .run(JSON.stringify(redactDeclaration(decl)), runId);
}

function _collectResult(runId) {
  const steps = getDb().prepare(
    'SELECT step_key, ordinal, status, checkpoint_json FROM provisioning_steps WHERE run_id = ? ORDER BY ordinal ASC',
  ).all(runId);
  const summary = { steps: [], created: {}, warnings: [] };
  for (const s of steps) {
    const cp = _parse(s.checkpoint_json) || {};
    summary.steps.push({ key: s.step_key, ordinal: s.ordinal, status: s.status });
    if (s.step_key === 'create_tenant' && cp.tenantId) summary.created.tenantId = cp.tenantId;
    if (Array.isArray(cp.keys)) summary.created.settings = cp.keys.length;
    if (Array.isArray(cp.modules)) summary.created.modules = cp.modules.length;
    if (s.step_key === 'seed_nomenclatures') {
      summary.created.nomenclatures = (Array.isArray(cp.inserted) ? cp.inserted.length : 0) + (cp.updated || 0);
    }
    if (s.step_key === 'seed_entities') {
      summary.created.entities = (Array.isArray(cp.insertedEntities) ? cp.insertedEntities.length : 0) + (cp.updatedEntities || 0);
      summary.created.relations = Array.isArray(cp.insertedRelations) ? cp.insertedRelations.length : 0;
    }
    if (Array.isArray(cp.hosts)) summary.created.hosts = cp.hosts.length;
    if (Array.isArray(cp.users)) summary.created.users = cp.users.length;
    if (s.step_key === 'grant_permissions' && Array.isArray(cp.created)) summary.created.grants = cp.created.length;
    if (Array.isArray(cp.warnings)) summary.warnings.push(...cp.warnings);
  }
  return summary;
}

// ── resume ───────────────────────────────────────────────────────────────────
async function resume(runId, opts = {}) {
  const run = _getRun(runId);
  if (!run) { const e = new Error('run not found'); e.status = 404; throw e; }
  if (run.status === 'completed') return getRun(runId);
  if (run.status === 'rolled_back') { const e = new Error('run was rolled back'); e.status = 409; throw e; }
  return _execute(runId, { user: opts.user, ip: opts.ip });
}

// ── rollback (compensate completed steps in reverse) ─────────────────────────
async function rollback(runId, opts = {}) {
  const db = getDb();
  const run = _getRun(runId);
  if (!run) { const e = new Error('run not found'); e.status = 404; throw e; }
  if (run.status === 'rolled_back') return getRun(runId);

  const decl = _parse(run.input_json); // already-normalized (see _execute note)
  const ctx = _buildCtx({ decl, user: opts.user, run, ip: opts.ip });
  ctx.tenantId = run.tenant_id || null;

  const done = db.prepare(
    "SELECT * FROM provisioning_steps WHERE run_id = ? AND status = 'completed' ORDER BY ordinal DESC",
  ).all(runId);

  for (const stepRow of done) {
    const def = STEP_REGISTRY[stepRow.step_key];
    if (!def || typeof def.compensate !== 'function') {
      // No compensation → the step's writes unwind via the create_tenant cascade.
      _setStepFields(runId, stepRow.step_key, { status: 'compensated', finished_at: _nowIso() });
      continue;
    }
    const cp = _parse(stepRow.checkpoint_json) || {};
    try {
      await def.compensate(ctx, cp);
      _setStepFields(runId, stepRow.step_key, { status: 'compensated', finished_at: _nowIso() });
      ctx.audit('provisioning_step_compensate', 'provisioning_run', runId, { step: stepRow.step_key, ok: true });
    } catch (compErr) {
      // A failed compensation is surfaced (step stays failed) but MUST NOT abort
      // the remaining compensations. e.g. create_tenant refusing is_default=1.
      _setStepFields(runId, stepRow.step_key, { status: 'failed', error: `compensate: ${compErr.message}` });
      ctx.audit('provisioning_step_compensate', 'provisioning_run', runId, { step: stepRow.step_key, ok: false, error: compErr.message });
      log.warn('compensation failed', { runId, step: stepRow.step_key, error: compErr.message });
    }
  }

  _setRunFields(runId, { status: 'rolled_back', finished_at: _nowIso() });
  ctx.audit('provisioning_run_rollback', 'provisioning_run', runId, { tenantId: run.tenant_id });
  return getRun(runId);
}

// ── read models (secrets redacted) ───────────────────────────────────────────
function _shapeRun(run) {
  const steps = getDb().prepare(
    'SELECT step_key, ordinal, status, error, started_at, finished_at FROM provisioning_steps WHERE run_id = ? ORDER BY ordinal ASC',
  ).all(run.id);
  const input = _parse(run.input_json);
  return {
    id: run.id,
    tenantId: run.tenant_id,
    mode: run.mode,
    templateKey: run.template_key,
    status: run.status,
    idempotencyKey: run.idempotency_key,
    currentStep: run.current_step,
    totalSteps: run.total_steps,
    startedBy: run.started_by,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    error: run.error,
    createdAt: run.created_at,
    plan: _parse(run.plan_json),
    declaration: input ? redactDeclaration(input) : null, // secrets → '<redacted>'
    result: _parse(run.result_json),
    steps,
  };
}

function getRun(runId) {
  const run = _getRun(runId);
  return run ? _shapeRun(run) : null;
}

function getActiveRun() {
  const run = getDb().prepare(
    "SELECT id FROM provisioning_runs WHERE status IN ('pending','running','failed') ORDER BY id DESC LIMIT 1",
  ).get();
  return run ? getRun(run.id) : null;
}

function listRuns({ limit = 50 } = {}) {
  const rows = getDb().prepare(
    'SELECT id FROM provisioning_runs ORDER BY id DESC LIMIT ?',
  ).all(limit);
  return rows.map((r) => getRun(r.id));
}

/**
 * Golden-config export: the declaration as a re-usable document with secrets
 * STRIPPED (never plaintext, never ciphertext) and the instance-specific
 * idempotencyKey dropped. v8.16.0 also pins the `template` key the run actually
 * used (from the run row, which is authoritative) so the exported doc replays
 * with the same defaults.
 */
function exportRun(runId) {
  const run = _getRun(runId);
  if (!run) return null;
  const input = _parse(run.input_json);
  if (!input) return null;
  const golden = redactDeclaration(input);
  delete golden.idempotencyKey;
  const templateKey = run.template_key || input.template || null;
  if (templateKey) golden.template = templateKey;
  else delete golden.template;
  return golden;
}

/**
 * Golden config re-shaped as an onboarding TEMPLATE, ready to POST to
 * /api/onboarding/templates. Secrets are stripped twice over: the source is the
 * already-redacted export, and specFromDeclaration() drops hosts wholesale and
 * runs validateTemplateSpec() (which throws on any secret-shaped key).
 */
function exportRunAsTemplate(runId, { key, name, description, industry, version } = {}) {
  const run = _getRun(runId);
  if (!run) return null;
  const golden = exportRun(runId);
  if (!golden) return null;
  const templates = require('./templates');
  const slug = (golden.tenant && golden.tenant.slug) || `run-${runId}`;
  return {
    key: key || `${slug}-template`.slice(0, 63),
    name: name || `${(golden.tenant && golden.tenant.name) || slug} template`,
    description: description !== undefined ? description : `Captured from provisioning run #${runId}.`,
    industry: industry || null,
    version: version || '1.0.0',
    spec: templates.specFromDeclaration(golden),
  };
}

module.exports = {
  plan,
  replan,
  apply,
  resume,
  rollback,
  getRun,
  getActiveRun,
  listRuns,
  exportRun,
  exportRunAsTemplate,
};
