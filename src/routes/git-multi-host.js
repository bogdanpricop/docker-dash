'use strict';

// Multi-host target management and a compatibility alias for fan-out deploy.

const { Router } = require('express');
const svc = require('../services/git-multi-host');
const gitService = require('../services/git');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');
const hostPermissions = require('../services/host-permissions');

const router = Router();
const ACCESS_RANK = { view: 1, operate: 2, admin: 3 };

function assertTargetAccess(req, targets, required) {
  const isAdmin = req.user?.role === 'admin'
    || (Array.isArray(req.user?.roles) && req.user.roles.includes('admin'));
  if (isAdmin) return;
  const allowed = targets.every(target => {
    const permission = hostPermissions.resolveEffectivePermission(req.user?.id, target.host_id, false);
    return (ACCESS_RANK[permission] || 0) >= ACCESS_RANK[required];
  });
  if (!allowed) {
    throw Object.assign(new Error(`Insufficient ${required} access on one or more deployment targets`), { status: 403 });
  }
}

// GET /api/git/stacks/:id/targets — list all target hosts.
router.get('/stacks/:id/targets', requireAuth, asyncHandler(async (req, res) => {
  const stackId = parseInt(req.params.id, 10);
  const stack = gitService.getStack(stackId);
  if (!stack) return res.status(404).json({ error: 'Git stack not found' });
  const targets = svc.listTargets(stackId);
  assertTargetAccess(req, targets, 'view');
  res.json(targets);
}));

// PUT /api/git/stacks/:id/targets — replace the target list.
router.put('/stacks/:id/targets', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const stackId = parseInt(req.params.id, 10);
    const hostIds = req.body.hostIds ?? req.body.target_host_ids;
    const stack = gitService.getStack(stackId);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    if (stack.status === 'deploying' || stack.status === 'cloning') {
      return res.status(409).json({ error: 'Deployment targets cannot be changed while the stack is deploying' });
    }
    const result = svc.setTargets(stackId, hostIds);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_targets_update', targetType: 'git_stack', targetId: String(stackId),
      details: { hostIds }, ip: getClientIp(req),
    });
    res.json(result);
  })
);

// POST /api/git/stacks/:id/deploy-all — compatibility alias. The regular
// /deploy route is also multi-host aware; orchestration stays in one service
// call so the stack lock and deployment history remain coherent.
router.post('/stacks/:id/deploy-all', requireAuth, requireRole('admin', 'operator'), writeable,
  asyncHandler(async (req, res) => {
    const stackId = parseInt(req.params.id, 10);
    const stack = gitService.getStack(stackId);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    const targets = svc.listTargets(stackId);
    if (!targets.length) return res.status(400).json({ error: 'No targets configured for this stack' });
    assertTargetAccess(req, targets, 'operate');
    const deploymentId = await gitService.deployStack(stackId, {
      force: !!req.body?.force,
      actor: { userId: req.user.id, username: req.user.username, ip: getClientIp(req) },
    });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_deploy_all', targetType: 'git_stack', targetId: String(stackId),
      details: { targetCount: targets.length, deploymentId }, ip: getClientIp(req),
    });
    res.json({ ok: true, deployment_id: deploymentId, target_count: targets.length });
  })
);

module.exports = router;
