'use strict';

const { Router } = require('express');
const webhookService = require('../services/webhooks');
const auditService = require('../services/audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.get('/', requireAuth, requireRole('admin'), (req, res) => { res.json(webhookService.list()); });
router.get('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const hook = webhookService.get(parseInt(req.params.id));
  if (!hook) return res.status(404).json({ error: 'Webhook not found' });
  res.json(hook);
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const result = webhookService.create({ ...req.body, created_by: req.user.id });
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'webhook_create', targetType: 'webhook', targetId: String(result.id), ip: getClientIp(req) });
  res.status(201).json(result);
});

router.put('/:id', requireAuth, requireRole('admin'), (req, res) => {
  webhookService.update(parseInt(req.params.id), req.body);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  webhookService.delete(parseInt(req.params.id));
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'webhook_delete', targetType: 'webhook', targetId: req.params.id, ip: getClientIp(req) });
  res.json({ ok: true });
});

router.post('/:id/test', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const hook = webhookService.get(parseInt(req.params.id));
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });
    await webhookService.dispatch('test', { message: 'Test event from Docker Dash' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/deliveries', requireAuth, requireRole('admin'), (req, res) => {
  const { page, limit } = req.query;
  res.json(webhookService.getDeliveries(parseInt(req.params.id), {
    page: parseInt(page) || 1, limit: parseInt(limit) || 20,
  }));
});

module.exports = router;
