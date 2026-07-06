'use strict';

// v8.9.10-alpha.1 — Portainer G02 closure: per-host access control routes.

const { Router } = require('express');
const svc = require('../services/host-permissions');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// GET /api/host-permissions?hostId=X — all grants for a host
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const hostId = parseInt(req.query.hostId, 10);
  if (!hostId) return res.status(400).json({ error: 'hostId query param required' });
  res.json(svc.grantsForHost(hostId));
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
  const hostId = parseInt(req.query.hostId, 10);
  if (!hostId) return res.status(400).json({ error: 'hostId query param required' });
  const isAdmin = req.user.role === 'admin' || (Array.isArray(req.user.roles) && req.user.roles.includes('admin'));
  const permission = svc.resolveEffectivePermission(req.user.id, hostId, isAdmin);
  res.json({ hostId, userId: req.user.id, permission });
}));

// Legacy default toggle — admin only. When false, users with no grants
// are locked out; when true (default post-migration), they get 'operate'
// on every host to preserve pre-upgrade behavior.
router.get('/legacy-default', requireAuth, asyncHandler(async (_req, res) => {
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
