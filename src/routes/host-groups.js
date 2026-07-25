'use strict';

// v8.9.7-alpha.1 — Portainer G03 + Komodo G02 closure: host groups routes.

const { Router } = require('express');
const svc = require('../services/host-groups');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.get('/', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) => {
  res.json(svc.list());
}));

router.get('/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const row = svc.get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Host group not found' });
  res.json(row);
}));

router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const id = svc.create(req.body, req.user.id);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'host_group_create', targetType: 'host_group', targetId: String(id),
    details: { name: req.body.name, memberCount: (req.body.hostIds || []).length },
    ip: getClientIp(req),
  });
  res.status(201).json({ ok: true, id });
}));

router.put('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  svc.update(id, req.body);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'host_group_update', targetType: 'host_group', targetId: String(id),
    details: req.body, ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

router.delete('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  svc.remove(id);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'host_group_delete', targetType: 'host_group', targetId: String(id),
    ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

module.exports = router;
