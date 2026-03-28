'use strict';

const { Router } = require('express');
const groups = require('../services/groups');
const auditService = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

// List groups (with member counts)
router.get('/', requireAuth, (req, res) => {
  try {
    const list = groups.list(req.user.id);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reorder groups — MUST be before /:id to avoid matching "order" as id
router.put('/order', requireAuth, (req, res) => {
  try {
    const { order } = req.body;
    if (!order || !Array.isArray(order)) {
      return res.status(400).json({ error: 'order array required' });
    }
    groups.reorder(order);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single group with members
router.get('/:id', requireAuth, (req, res) => {
  try {
    const group = groups.get(parseInt(req.params.id), req.user.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create group
router.post('/', requireAuth, (req, res) => {
  try {
    const { name, color, icon, scope } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = groups.create({ name, color, icon, scope, userId: req.user.id, createdBy: req.user.id });
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'group_create', details: { name }, ip: getClientIp(req) });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update group
router.put('/:id', requireAuth, (req, res) => {
  try {
    const { name, color, icon } = req.body;
    groups.update(parseInt(req.params.id), { name, color, icon }, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete group
router.delete('/:id', requireAuth, (req, res) => {
  try {
    groups.delete(parseInt(req.params.id), req.user.id);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'group_delete', details: { id: req.params.id }, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add containers to group
router.post('/:id/containers', requireAuth, (req, res) => {
  try {
    const { containerIds } = req.body;
    if (!containerIds || !Array.isArray(containerIds)) {
      return res.status(400).json({ error: 'containerIds array required' });
    }
    groups.addContainers(parseInt(req.params.id), containerIds);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove container from group
router.delete('/:id/containers/:containerId', requireAuth, (req, res) => {
  try {
    groups.removeContainer(parseInt(req.params.id), req.params.containerId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
