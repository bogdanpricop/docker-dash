'use strict';

const { Router } = require('express');
const workflowService = require('../services/workflows');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.get('/', requireAuth, (req, res) => {
  res.json(workflowService.list());
});

router.get('/templates', requireAuth, (req, res) => {
  res.json(workflowService.getTemplates());
});

router.get('/:id', requireAuth, (req, res) => {
  const rule = workflowService.get(parseInt(req.params.id));
  if (!rule) return res.status(404).json({ error: 'Workflow rule not found' });
  res.json(rule);
});

router.post('/', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const result = workflowService.create({ ...req.body, created_by: req.user.id });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'workflow_create', targetType: 'workflow',
      targetId: String(result.id), ip: getClientIp(req),
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    workflowService.update(parseInt(req.params.id), req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    workflowService.delete(parseInt(req.params.id));
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'workflow_delete', targetType: 'workflow',
      targetId: req.params.id, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
