'use strict';

const { Router } = require('express');
const procedures = require('../services/procedures');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
const runLimiter = rateLimit(10, 60 * 1000);

function actorFrom(req) {
  return {
    userId: req.user.id,
    username: req.user.username,
    ip: getClientIp(req),
    isAdmin: req.user.role === 'admin'
      || (Array.isArray(req.user.roles) && req.user.roles.includes('admin')),
  };
}

function assertRunAccess(req, run, required = 'view') {
  const actor = actorFrom(req);
  if (run.procedure_id) {
    procedures.assertActorAccess(actor, run.procedure_id, required);
  } else if (!actor.isAdmin && Number(run.started_by) !== Number(actor.userId)) {
    throw Object.assign(new Error('Insufficient access to this historical procedure run'), { status: 403 });
  }
  return actor;
}

router.get('/', requireAuth, (req, res) => {
  const actor = actorFrom(req);
  const visible = procedures.list().filter(procedure => {
    try { procedures.assertActorAccess(actor, procedure, 'view'); return true; } catch { return false; }
  });
  res.json(visible);
});

router.get('/templates', requireAuth, requireRole('admin'), (req, res) => {
  res.json(procedures.getTemplates());
});

router.get('/runs/:runId', requireAuth, (req, res) => {
  const run = procedures.getRun(parseInt(req.params.runId, 10));
  if (!run) return res.status(404).json({ error: 'Procedure run not found' });
  assertRunAccess(req, run, 'view');
  res.json(run);
});

router.post('/runs/:runId/cancel', requireAuth, requireRole('admin', 'operator'), writeable,
  asyncHandler((req, res) => {
    const run = procedures.getRun(parseInt(req.params.runId, 10));
    if (!run) return res.status(404).json({ error: 'Procedure run not found' });
    const actor = assertRunAccess(req, run, 'operate');
    const result = procedures.cancel(run.id, actor);
    auditService.log({
      userId: actor.userId, username: actor.username,
      action: 'procedure_run_cancel_request', targetType: 'procedure_run', targetId: String(run.id),
      details: { procedure_id: run.procedure_id }, ip: actor.ip,
    });
    res.json(result);
  })
);

router.get('/:id/runs', requireAuth, (req, res) => {
  const procedure = procedures.assertActorAccess(actorFrom(req), parseInt(req.params.id, 10), 'view');
  res.json({ procedure, runs: procedures.listRuns(procedure.id, { limit: req.query.limit }) });
});

router.get('/:id', requireAuth, (req, res) => {
  const procedure = procedures.assertActorAccess(actorFrom(req), parseInt(req.params.id, 10), 'view');
  res.json(procedure);
});

router.post('/', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const procedure = procedures.create({ ...req.body, created_by: req.user.id });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'procedure_create', targetType: 'procedure', targetId: String(procedure.id),
      details: {
        name: procedure.name, step_count: procedure.steps.length,
        stage_count: new Set(procedure.steps.map(step => step.stage)).size,
        max_parallel: procedure.max_parallel,
      }, ip: getClientIp(req),
    });
    res.status(201).json(procedure);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const procedure = procedures.update(parseInt(req.params.id, 10), req.body);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'procedure_update', targetType: 'procedure', targetId: String(procedure.id),
      details: {
        name: procedure.name, step_count: procedure.steps.length,
        stage_count: new Set(procedure.steps.map(step => step.stage)).size,
        max_parallel: procedure.max_parallel,
      }, ip: getClientIp(req),
    });
    res.json(procedure);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler((req, res) => {
  const id = parseInt(req.params.id, 10);
  procedures.delete(id);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'procedure_delete', targetType: 'procedure', targetId: String(id), ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

router.post('/:id/run', requireAuth, requireRole('admin', 'operator'), writeable, runLimiter,
  asyncHandler((req, res) => {
    const run = procedures.run(parseInt(req.params.id, 10), actorFrom(req));
    res.status(202).json(run);
  })
);

module.exports = router;
