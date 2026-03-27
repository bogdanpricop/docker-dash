'use strict';

const { Router } = require('express');
const registryService = require('../services/registry');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    res.json(registryService.list());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { name, url, username, password } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    const id = registryService.create({ name, url, username, password, createdBy: req.user.id });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'registry_create', targetType: 'registry', targetId: String(id),
      details: { name, url }, ip: getClientIp(req),
    });
    res.status(201).json({ id, name, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { name, url, username, password } = req.body;
    registryService.update(parseInt(req.params.id), { name, url, username, password });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    registryService.remove(parseInt(req.params.id));
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'registry_delete', targetType: 'registry', targetId: req.params.id,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/test', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await registryService.testConnection(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/catalog', requireAuth, async (req, res) => {
  try {
    const repos = await registryService.catalog(parseInt(req.params.id));
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/tags/:repo(*)', requireAuth, async (req, res) => {
  try {
    const tags = await registryService.tags(parseInt(req.params.id), req.params.repo);
    res.json(tags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
