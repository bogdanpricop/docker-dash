'use strict';

const { Router } = require('express');
const alertService = require('../services/alerts');
const auditService = require('../services/audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.get('/rules', requireAuth, (req, res) => { res.json(alertService.listRules()); });
router.get('/rules/:id', requireAuth, (req, res) => {
  const rule = alertService.getRule(parseInt(req.params.id));
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule);
});

router.post('/rules', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  try {
    const result = alertService.createRule({ ...req.body, created_by: req.user.id });
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'alert_rule_create', targetType: 'alert_rule', targetId: String(result.id), ip: getClientIp(req) });
    res.status(201).json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/rules/:id', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  try {
    alertService.updateRule(parseInt(req.params.id), req.body);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'alert_rule_update', targetType: 'alert_rule', targetId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/rules/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    alertService.deleteRule(parseInt(req.params.id));
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'alert_rule_delete', targetType: 'alert_rule', targetId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/active', requireAuth, (req, res) => { res.json(alertService.getActiveAlerts()); });
router.get('/history', requireAuth, (req, res) => {
  const { page, limit } = req.query;
  res.json(alertService.getAlertHistory({ page: parseInt(page) || 1, limit: parseInt(limit) || 50 }));
});

router.post('/events/:id/acknowledge', requireAuth, (req, res) => {
  try {
    alertService.acknowledge(parseInt(req.params.id), req.user.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
