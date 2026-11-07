'use strict';

// v8.9.10-alpha.1 — Portainer G02 closure: per-host access control routes.

const { Router } = require('express');
const svc = require('../services/host-permissions');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');
const { parseHostId } = require('../utils/host-id');
const { getDb } = require('../db');
const permissions = require('../services/permissions');
const config = require('../config');

const router = Router();

// GET /api/host-permissions?hostId=X — all grants for a host
router.get('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const hostId = Number.parseInt(req.query.hostId, 10);
  const hostGroupId = Number.parseInt(req.query.hostGroupId, 10);
  if (Number.isInteger(hostId) && hostId >= 0) return res.json(svc.grantsForHost(hostId));
  if (Number.isInteger(hostGroupId) && hostGroupId > 0) return res.json(svc.grantsForGroup(hostGroupId));
  return res.status(400).json({ error: 'hostId or hostGroupId query param required' });
}));

router.post('/', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    try {
      const id = svc.grant(req.body, req.user.id);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'host_permission_grant', targetType: 'host_permission', targetId: String(id),
        details: req.body, ip: getClientIp(req),
      });
      res.status(201).json({ ok: true, id });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

router.delete('/:id', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    svc.revoke(id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'host_permission_revoke', targetType: 'host_permission', targetId: String(id),
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  })
);

// GET /api/host-permissions/effective?hostId=X — inspect what the caller has.
router.get('/effective', requireAuth, asyncHandler(async (req, res) => {
  const hostId = Number.parseInt(req.query.hostId, 10);
  if (!Number.isInteger(hostId) || hostId < 0) {
    return res.status(400).json({ error: 'hostId query param required' });
  }
  const isAdmin = req.user.role === 'admin' || (Array.isArray(req.user.roles) && req.user.roles.includes('admin'));
  const permission = svc.resolveEffectivePermission(req.user.id, hostId, isAdmin);
  res.json({ hostId, userId: req.user.id, permission });
}));

router.get('/explain', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  const requestedHost = parseHostId(req.query.hostId);
  const userId = parseHostId(req.query.userId);
  const stack = req.query.stack || '_standalone';
  if (requestedHost === null || !userId || typeof stack !== 'string' || stack.length > 200) {
    return res.status(400).json({ error: 'Valid user, host and optional stack are required' });
  }
  const db = getDb();
  const host = db.prepare('SELECT id, name, is_active FROM docker_hosts WHERE id = ?').get(svc.normalizeHostId(requestedHost));
  const user = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(userId);
  if (!user || !host) return res.status(404).json({ error: 'User or host not found' });
  const grant = svc.describeGrantResolution(userId, host.id, user.role === 'admin');
  const role = permissions.getEffectiveRole(userId, stack, user.role);
  const enabled = Boolean(user.is_active && host.is_active);
  res.json({
    host: { id: host.id, name: host.name, active: Boolean(host.is_active) },
    user: { id: user.id, username: user.username, role: user.role, active: Boolean(user.is_active) },
    stack, stackPermission: role, permission: grant.permission, sources: grant.sources,
    actions: {
      viewContainers: enabled && grant.permission !== null && permissions.hasPermission(role, 'view'),
      operateContainers: enabled && !config.features.readOnly && ['admin', 'operator'].includes(user.role)
        && ['admin', 'operate'].includes(grant.permission)
        && permissions.hasPermission(role, 'operate'),
      manageHostSettings: Boolean(user.is_active && user.role === 'admin' && !config.features.readOnly),
    },
  });
}));

// Legacy default toggle — admin only. When false, users with no grants
// are locked out; when true (default post-migration), they get 'operate'
// on every host to preserve pre-upgrade behavior.
router.get('/legacy-default', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) => {
  res.json({ enabled: svc.isLegacyDefaultEnabled() });
}));

router.post('/legacy-default', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    svc.setLegacyDefault(!!req.body.enabled);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'host_permission_legacy_default_toggle',
      targetType: 'setting', targetId: 'legacy_host_access_default',
      details: { enabled: !!req.body.enabled }, ip: getClientIp(req),
    });
    res.json({ ok: true, enabled: !!req.body.enabled });
  })
);

module.exports = router;
