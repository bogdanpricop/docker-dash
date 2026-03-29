'use strict';

const { Router } = require('express');
const auditService = require('../services/audit');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();

// Query audit log (admin only)
router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { action, targetType, userId, page, limit, since, until } = req.query;
    const result = auditService.query({
      action,
      targetType,
      userId: userId ? parseInt(userId) : undefined,
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 50, 500),
      since,
      until,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify audit log integrity (admin only)
router.get('/verify', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { from, to } = req.query;
    const result = auditService.verify({
      fromId: from ? parseInt(from) : undefined,
      toId: to ? parseInt(to) : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export audit log (admin only)
router.get('/export', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { format, since, until, action, userId } = req.query;
    const validFormats = ['json', 'csv', 'syslog'];
    const fmt = validFormats.includes(format) ? format : 'json';

    const data = auditService.export(fmt, {
      since,
      until,
      action,
      userId: userId ? parseInt(userId) : undefined,
    });

    const contentTypes = {
      json: 'application/json',
      csv: 'text/csv',
      syslog: 'text/plain',
    };

    const extensions = { json: 'json', csv: 'csv', syslog: 'log' };

    res.setHeader('Content-Type', contentTypes[fmt]);
    res.setHeader('Content-Disposition', `attachment; filename="audit-export.${extensions[fmt]}"`);
    res.send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
