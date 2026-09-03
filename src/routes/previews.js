'use strict';

const { Router } = require('express');
const previews = require('../services/preview-environments');
const audit = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');
const hostPermissions = require('../services/host-permissions');

const router = Router();
const ACCESS_RANK = { view: 1, operate: 2, admin: 3 };

function canAccess(req, environment, required) {
  if (req.user.role === 'admin') return true;
  const level = hostPermissions.resolveEffectivePermission(req.user.id, environment.host_id, false);
  return (ACCESS_RANK[level] || 0) >= ACCESS_RANK[required];
}

function environmentAccess(req, res, required) {
  const environment = previews.list().find(item => item.id === Number(req.params.id));
  if (!environment) { res.status(404).json({ error: 'Preview environment not found' }); return null; }
  if (!canAccess(req, environment, required)) { res.status(403).json({ error: 'Insufficient host access' }); return null; }
  return environment;
}

function record(req, action, targetId, details = {}) {
  audit.log({
    userId: req.user.id, username: req.user.username,
    action, targetType: 'preview_environment', targetId: String(targetId),
    details, ip: getClientIp(req),
  });
}

router.get('/', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  res.json(previews.list(req.query.stackId ? Number(req.query.stackId) : null)
    .filter(environment => canAccess(req, environment, 'view')));
});

router.get('/stacks/:stackId/config', requireAuth, requireRole('admin'), (req, res) => {
  res.json(previews.getConfig(Number(req.params.stackId)) || { enabled: false });
});

router.put('/stacks/:stackId/config', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const stackId = Number(req.params.stackId);
    const config = previews.updateConfig(stackId, req.body || {});
    record(req, 'preview_config_update', stackId, {
      enabled: config.enabled, host_id: config.host_id, ttl_minutes: config.ttl_minutes,
      allow_forks: config.allow_forks, variable_count: config.variables.length,
    });
    res.json(config);
  } catch (err) { res.status(err.status || 400).json({ error: err.message, code: err.code }); }
});

router.post('/:id/redeploy', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  try {
    if (!environmentAccess(req, res, 'operate')) return;
    const result = await previews.deploy(Number(req.params.id));
    record(req, 'preview_redeploy', result.id, { stack_id: result.stack_id, pr_number: result.pr_number });
    res.json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
}));

router.delete('/:id', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  try {
    if (!environmentAccess(req, res, 'operate')) return;
    const id = Number(req.params.id);
    const result = await previews.remove(id);
    record(req, 'preview_delete', id);
    res.json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
}));

module.exports = router;
