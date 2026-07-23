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
router.get('/runs/:id/export', ...admin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const golden = provisioning.exportRun(id);
  if (!golden) return res.status(404).json({ error: 'Run not found' });
  _audit(req, 'onboarding_export', 'provisioning_run', id, { tenantSlug: golden.tenant && golden.tenant.slug });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="onboarding-run-${id}.json"`);
  res.send(JSON.stringify(golden, null, 2));
}));

module.exports = router;
