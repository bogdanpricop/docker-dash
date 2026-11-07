'use strict';

const { Router } = require('express');
const { performance } = require('node:perf_hooks');
const channelService = require('../services/notificationChannels');
const auditService = require('../services/audit');
const notificationSmtp = require('../services/notification-smtp');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.get('/providers', requireAuth, (req, res) => {
  res.json(channelService.getProviders());
});

router.get('/smtp-settings', requireAuth, requireRole('admin'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(notificationSmtp.publicSettings()); }
  catch { res.status(500).json({ error: 'SMTP settings could not be read' }); }
});

router.put('/smtp-settings', requireAuth, requireRole('admin'), writeable, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const saved = notificationSmtp.save(req.body, req.user.id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'notification_smtp_update', targetType: 'notification_smtp',
      details: { mode: saved.mode }, ip: getClientIp(req),
    });
    res.json(saved);
  } catch (err) {
    res.status(err.status === 400 ? 400 : 500).json({
      error: err.status === 400 ? err.message : 'SMTP settings could not be saved',
    });
  }
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
    if (channelService.update(parseInt(req.params.id, 10), req.body)) {
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'notification_channel_update', targetType: 'notification_channel',
        targetId: req.params.id, ip: getClientIp(req),
      });
    }
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

router.post('/:id/test', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const started = performance.now();
  const completed = () => ({ testedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) });
  try {
    await channelService.test(Number(req.params.id));
    res.json({ ok: true, ...completed() });
  } catch (err) {
    const known = err.details || err.status === 400 || err.status === 404;
    res.json({
      ok: false,
      error: known ? err.message : 'Notification test could not be completed',
      details: err.details,
      ...completed(),
    });
  }
});

module.exports = router;
