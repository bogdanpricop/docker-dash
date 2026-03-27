'use strict';

const { Router } = require('express');
const migrationService = require('../services/migration');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

// Preview migration (dry run)
router.post('/preview', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { containerId, sourceHostId, destHostId } = req.body;
    if (!containerId || destHostId === undefined) {
      return res.status(400).json({ error: 'containerId and destHostId are required' });
    }
    const preview = await migrationService.previewMigration({
      containerId, sourceHostId: sourceHostId || 0, destHostId,
    });
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Migrate a single container
router.post('/container', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { containerId, sourceHostId, destHostId, removeSource, zeroDowntime } = req.body;
    if (!containerId || destHostId === undefined) {
      return res.status(400).json({ error: 'containerId and destHostId are required' });
    }

    const result = await migrationService.migrateContainer({
      containerId,
      sourceHostId: sourceHostId || 0,
      destHostId,
      removeSource: removeSource || false,
      zeroDowntime: zeroDowntime !== false,
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_migrate', targetType: 'container',
      targetId: result.source.name,
      details: JSON.stringify({
        from: sourceHostId || 0, to: destHostId,
        zeroDowntime, destContainer: result.destination.name,
      }),
      ip: getClientIp(req),
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, steps: err.steps || [] });
  }
});

// Migrate an entire stack
router.post('/stack', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { stackName, sourceHostId, destHostId, removeSource, zeroDowntime } = req.body;
    if (!stackName || destHostId === undefined) {
      return res.status(400).json({ error: 'stackName and destHostId are required' });
    }

    const result = await migrationService.migrateStack({
      stackName,
      sourceHostId: sourceHostId || 0,
      destHostId,
      removeSource: removeSource || false,
      zeroDowntime: zeroDowntime !== false,
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_migrate', targetType: 'stack',
      targetId: stackName,
      details: JSON.stringify({
        from: sourceHostId || 0, to: destHostId,
        total: result.total, migrated: result.migrated, failed: result.failed,
      }),
      ip: getClientIp(req),
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
