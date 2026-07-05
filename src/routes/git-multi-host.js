'use strict';

// v8.9.7-alpha.1 — Komodo G01 closure (partial): routes for managing which
// hosts a git stack deploys to, plus a fan-out endpoint that iterates the
// existing deployStack() logic per target.

const { Router } = require('express');
const svc = require('../services/git-multi-host');
const gitService = require('../services/git');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// GET /api/git/stacks/:id/targets — list all target hosts.
router.get('/stacks/:id/targets', requireAuth, asyncHandler(async (req, res) => {
  const stackId = parseInt(req.params.id, 10);
  res.json(svc.listTargets(stackId));
}));

// PUT /api/git/stacks/:id/targets — replace the target list.
router.put('/stacks/:id/targets', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const stackId = parseInt(req.params.id, 10);
    const { hostIds } = req.body;
    const result = svc.setTargets(stackId, hostIds);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_targets_update', targetType: 'git_stack', targetId: String(stackId),
      details: { hostIds }, ip: getClientIp(req),
    });
    res.json(result);
  })
);

// POST /api/git/stacks/:id/deploy-all — sequential fan-out deploy. This is
// a lightweight scaffold; the underlying deployStack() writes to
// git_stacks.host_id (scalar), so we temporarily set that per target then
// call deploy. Full multi-host aware deploy is a follow-up.
router.post('/stacks/:id/deploy-all', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const stackId = parseInt(req.params.id, 10);
    const targets = svc.listTargets(stackId);
    if (!targets.length) return res.status(400).json({ error: 'No targets configured for this stack' });
    const results = [];
    for (const t of targets) {
      try {
        // Point the stack's scalar host_id at this target for the duration
        // of this deploy call. deployStack() is fire-and-forget so we
        // await only the initial validation, not the full deploy.
        const { getDb } = require('../db');
        getDb().prepare('UPDATE git_stacks SET host_id = ? WHERE id = ?').run(t.host_id, stackId);
        await gitService.deployStack(stackId, {});
        results.push({ hostId: t.host_id, hostName: t.host_name, status: 'queued' });
      } catch (err) {
        results.push({ hostId: t.host_id, hostName: t.host_name, status: 'failed', error: err.message });
      }
    }
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_deploy_all', targetType: 'git_stack', targetId: String(stackId),
      details: { targetCount: targets.length, results }, ip: getClientIp(req),
    });
    res.json({ ok: true, targets: results });
  })
);

module.exports = router;
