'use strict';

const { Router } = require('express');
const channelService = require('../services/notificationChannels');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.get('/providers', requireAuth, (req, res) => {
  res.json(channelService.getProviders());
});

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  res.json(channelService.list());
});

router.post('/', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const result = channelService.create({ ...req.body, created_by: req.user.id });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'notification_channel_create', targetType: 'notification_channel',
      targetId: String(result.id), ip: getClientIp(req),
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    channelService.update(parseInt(req.params.id), req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  channelService.delete(parseInt(req.params.id));
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'notification_channel_delete', targetType: 'notification_channel',
    targetId: req.params.id, ip: getClientIp(req),
  });
  res.json({ ok: true });
});

router.post('/:id/test', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await channelService.test(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
