'use strict';

// v8.15.0 (Onboarding & Provisioning Wizard — Phase 1 backend) — REST face.
//
// One engine, one document. Every mutating route is admin-gated + writeable +
// audited; secrets are NEVER returned (run/step JSON and the export are
// redacted). The tenant is derived server-side — a wire-supplied tenant_id is
// rejected by validateDeclaration (400).
//
//   POST /api/onboarding/plan              (admin)            dry-run: impact + warnings
//   POST /api/onboarding/apply             (admin+writeable)  run the saga (audited)
//   GET  /api/onboarding/runs/active       (admin)            latest non-terminal run
//   GET  /api/onboarding/runs/:id          (admin)            run + steps (redacted)
//   POST /api/onboarding/runs/:id/resume   (admin+writeable)  continue from cursor
//   POST /api/onboarding/runs/:id/rollback (admin+writeable)  compensate in reverse
//   GET  /api/onboarding/runs/:id/export   (admin)            golden config (secrets stripped)
//                                                             ?asTemplate=1 → template-shaped spec
//   GET  /api/onboarding/templates         (auth)             built-in + custom templates
//   GET  /api/onboarding/templates/:key    (auth)             one template
//   POST /api/onboarding/templates         (admin+writeable)  save-as-template (secrets stripped)
//   DELETE /api/onboarding/templates/:key  (admin+writeable)  custom templates only
//
// Phase 3 (v8.17.0) — demo/trial mock data + the promotion gate:
//   GET  /api/onboarding/seed/catalog                 (admin)  profiles+scenarios+row estimates
//   GET  /api/onboarding/tenants/:id/seed             (admin)  live datasets + manifest
//   POST /api/onboarding/tenants/:id/seed/purge       (admin+writeable, audited)
//   POST /api/onboarding/tenants/:id/seed/reset       (admin+writeable, audited)
//   POST /api/onboarding/tenants/:id/seed/regenerate  (admin+writeable, audited)
//   GET  /api/onboarding/tenants/:id/promotion        (admin)  gate check (no writes)
//   POST /api/onboarding/tenants/:id/promote          (admin+writeable, audited)

const { Router } = require('express');
const provisioning = require('../services/provisioning');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');
const log = require('../utils/logger')('onboarding');

const router = Router();
const admin = [requireAuth, requireRole('admin')];
const adminWrite = [requireAuth, requireRole('admin'), writeable];

function _audit(req, action, targetType, targetId, details) {
  auditService.log({
    userId: req.user && req.user.id,
    username: (req.user && req.user.username) || 'system',
    action, targetType, targetId: targetId != null ? String(targetId) : null,
    details, ip: getClientIp(req),
  });
}

// Map an engine error to an HTTP status. Validation/idempotency conflicts are
// client errors (400/409); a step failure mid-apply is surfaced as 409 with the
// run id so the client can resume/rollback.
function _fail(res, err, fallback = 400) {
  const status = err.status || (err.resumable ? 409 : fallback);
  const body = { error: err.message };
  if (err.runId) body.runId = err.runId;
  if (err.step) body.step = err.step;
  if (err.resumable) body.resumable = true;
  if (err.code) body.code = err.code;
  // The promotion gate returns a structured remediation list, never just "no".
  if (Array.isArray(err.blockers)) body.blockers = err.blockers;
  return res.status(status).json(body);
}

// POST /plan — dry-run. Validates + computes impact/warnings. Writes nothing.
router.post('/plan', ...admin, asyncHandler(async (req, res) => {
  try {
    const result = provisioning.plan({ declaration: req.body, user: req.user, ip: getClientIp(req) });
    res.json(result);
  } catch (err) { _fail(res, err); }
}));

// POST /apply — validate → plan → execute the saga (audited).
router.post('/apply', ...adminWrite, asyncHandler(async (req, res) => {
  try {
    const run = await provisioning.apply({
      declaration: req.body,
      user: req.user,
      idempotencyKey: req.body && req.body.idempotencyKey,
      ip: getClientIp(req),
    });
    // provisioning_run_start/complete/fail are already audited inside the engine;
    // this row records the API entry point + outcome.
    _audit(req, 'provisioning_run_start', 'provisioning_run', run.id, { status: run.status, tenantId: run.tenantId });
    res.status(run.status === 'completed' ? 200 : 202).json(run);
  } catch (err) {
    log.warn('apply failed', { error: err.message, runId: err.runId, step: err.step });
    _fail(res, err);
  }
}));

// GET /runs/active — the latest pending/running/failed run (for wizard resume).
router.get('/runs/active', ...admin, asyncHandler(async (_req, res) => {
  res.json({ run: provisioning.getActiveRun() });
}));

// GET /runs/:id — run + steps status (secrets redacted).
router.get('/runs/:id', ...admin, asyncHandler(async (req, res) => {
  const run = provisioning.getRun(parseInt(req.params.id, 10));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
}));

// POST /runs/:id/resume — continue from the persisted cursor.
router.post('/runs/:id/resume', ...adminWrite, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const run = await provisioning.resume(id, { user: req.user, ip: getClientIp(req) });
    _audit(req, 'provisioning_run_resume', 'provisioning_run', id, { status: run.status });
    res.json(run);
  } catch (err) { _fail(res, err); }
}));

// POST /runs/:id/rollback — compensate completed steps in reverse.
router.post('/runs/:id/rollback', ...adminWrite, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const run = await provisioning.rollback(id, { user: req.user, ip: getClientIp(req) });
    _audit(req, 'provisioning_run_rollback', 'provisioning_run', id, { status: run.status });
    res.json(run);
  } catch (err) { _fail(res, err); }
}));

// GET /runs/:id/export — golden-config declaration with secrets STRIPPED.
// `?asTemplate=1` emits a template-shaped document ready to POST to /templates.
router.get('/runs/:id/export', ...admin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const asTemplate = req.query.asTemplate === '1' || req.query.asTemplate === 'true';
  let payload;
  try {
    payload = asTemplate ? provisioning.exportRunAsTemplate(id) : provisioning.exportRun(id);
  } catch (err) { return _fail(res, err); }
  if (!payload) return res.status(404).json({ error: 'Run not found' });
  _audit(req, 'onboarding_export', 'provisioning_run', id, {
    asTemplate,
    tenantSlug: (payload.tenant && payload.tenant.slug) || null,
    templateKey: asTemplate ? payload.key : (payload.template || null),
  });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="onboarding-${asTemplate ? 'template' : 'run'}-${id}.json"`);
  res.send(JSON.stringify(payload, null, 2));
}));

// ── templates (Phase 2) ─────────────────────────────────────────────────────
// Reads are open to any authenticated user (the wizard's step-0 picker needs
// them and a template carries no secrets by construction). Writes are
// admin + writeable + audited, and a built-in key can never be overwritten or
// deleted — built-ins are owned by the files under src/db/onboarding-templates/.

// GET /templates — built-ins first, then custom.
router.get('/templates', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ templates: provisioning.templates.list() });
}));

// GET /templates/:key — one template (404 if unknown).
router.get('/templates/:key', requireAuth, asyncHandler(async (req, res) => {
  const tpl = provisioning.templates.get(req.params.key);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tpl);
}));

// POST /templates — save (or update) a CUSTOM template.
// Accepts either an explicit `spec`, or a `declaration` to derive one from —
// in which case secrets are stripped BEFORE validation (hosts dropped wholesale,
// passwords never copied) and validateTemplateSpec throws on anything
// secret-shaped that survived.
router.post('/templates', ...adminWrite, asyncHandler(async (req, res) => {
  const body = req.body || {};
  try {
    const spec = body.declaration !== undefined
      ? provisioning.templates.specFromDeclaration(body.declaration)
      : body.spec;
    const saved = provisioning.templates.saveCustom({
      key: body.key,
      name: body.name,
      description: body.description,
      industry: body.industry,
      version: body.version,
      spec,
    }, req.user);
    _audit(req, 'onboarding_template_save', 'onboarding_template', saved.key, {
      name: saved.name, version: saved.version, industry: saved.industry, isBuiltin: false,
    });
    res.status(201).json(saved);
  } catch (err) {
    log.warn('template save failed', { error: err.message });
    _fail(res, err);
  }
}));

// DELETE /templates/:key — custom templates only (built-ins are file-owned).
router.delete('/templates/:key', ...adminWrite, asyncHandler(async (req, res) => {
  const key = req.params.key;
  try {
    provisioning.templates.remove(key);
    _audit(req, 'onboarding_template_delete', 'onboarding_template', key, {});
    res.json({ success: true });
  } catch (err) { _fail(res, err); }
}));

// ── seed / demo data (Phase 3) ──────────────────────────────────────────────
// Every mutating route is admin + writeable + audited. Production is refused at
// three independent layers (wizard step, provisioning step, generator), and the
// promotion gate is the matching outbound lock.

// GET /seed/catalog — profiles, scenarios and pure row estimates (no writes).
router.get('/seed/catalog', ...admin, asyncHandler(async (req, res) => {
  const scenario = typeof req.query.scenario === 'string' ? req.query.scenario : undefined;
  try {
    const scenarios = provisioning.seed.listScenarios();
    const profiles = provisioning.seed.PROFILE_KEYS.map((p) => provisioning.seed.estimate({
      profile: p,
      scenario: scenario && provisioning.seed.SCENARIO_KEYS.includes(scenario) ? scenario : undefined,
    }));
    res.json({ profiles, scenarios, maxTotalRows: provisioning.seed.MAX_TOTAL_ROWS });
  } catch (err) { _fail(res, err); }
}));

// GET /tenants/:id/seed — live datasets + their purge manifests.
router.get('/tenants/:id/seed', ...admin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid tenant id' });
  try {
    res.json({ datasets: provisioning.seed.listDatasets(id, { includePurged: req.query.all === '1' }) });
  } catch (err) { _fail(res, err); }
}));

function _seedOp(opName, action) {
  return asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid tenant id' });
    const body = req.body || {};
    try {
      let result;
      if (opName === 'purge') {
        result = provisioning.seed.purgeAll(id);
      } else {
        // reset/regenerate both route through purge+generate, so no path can
        // ever accumulate a second live batch.
        result = provisioning.seed[opName]({
          tenantId: id,
          profile: body.profile,
          scenario: body.scenario,
          locale: body.locale,
          seed: body.seed,
          createdBy: (req.user && req.user.username) || 'system',
        });
      }
      const hasDataset = result.datasetId != null;
      _audit(req, action, hasDataset ? 'seed_dataset' : 'tenant', hasDataset ? result.datasetId : id, {
        tenantId: id,
        profile: result.profile,
        scenario: result.scenario,
        rows: result.total,
        purged: result.purged,
        purgedRows: result.purgedRows,
        skipped: (result.results || []).flatMap((r) => r.skipped || []),
      });
      res.json(result);
    } catch (err) {
      log.warn(`seed ${opName} failed`, { tenantId: id, error: err.message });
      _fail(res, err);
    }
  });
}

router.post('/tenants/:id/seed/purge', ...adminWrite, _seedOp('purge', 'seed_dataset_purge'));
router.post('/tenants/:id/seed/reset', ...adminWrite, _seedOp('reset', 'seed_dataset_reset'));
router.post('/tenants/:id/seed/regenerate', ...adminWrite, _seedOp('regenerate', 'seed_dataset_regenerate'));

// GET /tenants/:id/promotion — run the gate WITHOUT changing anything.
router.get('/tenants/:id/promotion', ...admin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid tenant id' });
  try {
    res.json(provisioning.checkProductionReady(id));
  } catch (err) { _fail(res, err); }
}));

// POST /tenants/:id/promote — switch usage_mode, gated + audited.
// `?purgeFirst=1` (or body.purgeFirst) performs the remediation then promotes.
router.post('/tenants/:id/promote', ...adminWrite, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid tenant id' });
  const body = req.body || {};
  const mode = body.mode || 'production';
  try {
    const result = (body.purgeFirst === true && mode === 'production')
      ? provisioning.promotion.purgeAndPromote(id, { user: req.user, ip: getClientIp(req) })
      : provisioning.setUsageMode(id, mode, { user: req.user, ip: getClientIp(req) });
    // setUsageMode already writes the `tenant_promote` chain row; this records the
    // API entry point + outcome (mirrors the /apply pattern).
    _audit(req, 'tenant_promote', 'tenant', id, { from: result.from, to: result.to, changed: result.changed, via: 'api' });
    res.json(result);
  } catch (err) {
    log.warn('promotion refused', { tenantId: id, error: err.message });
    _fail(res, err);
  }
}));

module.exports = router;
