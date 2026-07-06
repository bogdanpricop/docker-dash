'use strict';

// v8.9.9-alpha.1 — Komodo G09 closure: alert channel routing routes.

const { Router } = require('express');
const svc = require('../services/alert-routes');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.get('/', requireAuth, asyncHandler(async (_req, res) => {
  res.json(svc.list());
}));

router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const id = svc.create(req.body);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'alert_route_create', targetType: 'alert_route', targetId: String(id),
    details: req.body, ip: getClientIp(req),
  });
  res.status(201).json({ ok: true, id });
}));

router.delete('/:id', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    svc.remove(id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'alert_route_delete', targetType: 'alert_route', targetId: String(id),
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  })
);

// GET /api/alert-routes/resolve?hostId=X&severity=warning — preview which
// channels an alert would hit right now. Useful for testing the routing UI.
router.get('/resolve', requireAuth, asyncHandler(async (req, res) => {
  const hostId = req.query.hostId ? parseInt(req.query.hostId, 10) : undefined;
  const severity = req.query.severity || 'info';
  res.json({ channelIds: svc.resolve({ hostId, severity }) });
}));

module.exports = router;
