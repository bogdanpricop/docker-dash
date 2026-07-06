'use strict';

// v8.9.10-alpha.1 — Portainer G01 closure: teams routes.

const { Router } = require('express');
const svc = require('../services/teams');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.get('/', requireAuth, asyncHandler(async (_req, res) => {
  res.json(svc.list());
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const row = svc.get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Team not found' });
  res.json(row);
}));

router.post('/', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const id = svc.create(req.body, req.user.id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'team_create', targetType: 'team', targetId: String(id),
      details: { name: req.body.name, memberCount: (req.body.memberIds || []).length },
      ip: getClientIp(req),
    });
    res.status(201).json({ ok: true, id });
  })
);

router.put('/:id', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    svc.update(id, req.body);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'team_update', targetType: 'team', targetId: String(id),
      details: req.body, ip: getClientIp(req),
    });
    res.json({ ok: true });
  })
);

router.delete('/:id', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    svc.remove(id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'team_delete', targetType: 'team', targetId: String(id),
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  })
);

router.post('/:id/members', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const teamId = parseInt(req.params.id, 10);
    const userId = req.body.userId;
    svc.addMember(teamId, userId, req.user.id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'team_member_add', targetType: 'team', targetId: String(teamId),
      details: { userId }, ip: getClientIp(req),
    });
    res.json({ ok: true });
  })
);

router.delete('/:id/members/:userId', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const teamId = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    svc.removeMember(teamId, userId);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'team_member_remove', targetType: 'team', targetId: String(teamId),
      details: { userId }, ip: getClientIp(req),
    });
    res.json({ ok: true });
  })
);

module.exports = router;
