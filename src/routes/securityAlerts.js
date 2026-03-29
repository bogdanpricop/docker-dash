'use strict';

const { Router } = require('express');
const securityAlerts = require('../services/securityAlerts');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();

// List all security alert rules (admin only)
router.get('/rules', requireAuth, requireRole('admin'), (req, res) => {
  try {
    res.json(securityAlerts.listRules());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new security alert rule (admin only)
router.post('/rules', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const result = securityAlerts.createRule(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update a security alert rule (admin only)
router.put('/rules/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    securityAlerts.updateRule(parseInt(req.params.id), req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a security alert rule (admin only)
router.delete('/rules/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    securityAlerts.deleteRule(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get recent security alerts (admin only)
router.get('/recent', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    res.json(securityAlerts.getRecentAlerts(hours));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test-fire a security alert rule (admin only)
router.post('/test/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await securityAlerts.testRule(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
