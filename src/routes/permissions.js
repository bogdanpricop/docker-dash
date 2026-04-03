'use strict';

const { Router } = require('express');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const permService = require('../services/permissions');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();

// GET /api/permissions — list all stack permissions (admin only)
router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const permissions = permService.listAllPermissions();
    res.json({ permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/permissions/user/:userId — list permissions for a specific user
router.get('/user/:userId', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid userId' });
    const permissions = permService.listUserPermissions(userId);
    res.json({ permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/permissions/me — list current user's stack permissions
router.get('/me', requireAuth, (req, res) => {
  try {
    const permissions = permService.listUserPermissions(req.user.id);
    res.json({ permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/permissions — set a stack permission
router.post('/', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { stackName, userId, permission } = req.body;

    if (!stackName || !userId || !permission) {
      return res.status(400).json({ error: 'stackName, userId, and permission are required' });
    }

    const validPerms = ['none', 'view', 'operate', 'admin'];
    if (!validPerms.includes(permission)) {
      return res.status(400).json({ error: `Invalid permission. Must be one of: ${validPerms.join(', ')}` });
    }

    permService.setPermission(stackName, parseInt(userId), permission, req.user.id);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_permission_set',
      targetType: 'stack_permission',
      targetId: `${stackName}:${userId}`,
      details: { stackName, userId, permission },
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/permissions/:stackName/:userId — remove a stack permission
router.delete('/:stackName/:userId', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const stackName = decodeURIComponent(req.params.stackName);
    const userId = parseInt(req.params.userId);
    if (!stackName || !userId) return res.status(400).json({ error: 'Invalid parameters' });

    const removed = permService.removePermission(stackName, userId);

    if (removed) {
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'stack_permission_remove',
        targetType: 'stack_permission',
        targetId: `${stackName}:${userId}`,
        details: { stackName, userId },
        ip: getClientIp(req),
      });
    }

    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
