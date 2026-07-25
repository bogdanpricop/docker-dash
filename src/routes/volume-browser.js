'use strict';

// v8.9.9-alpha.1 — Portainer G07 closure: volume file browser routes.

const { Router } = require('express');
const svc = require('../services/volume-browser');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const { requireHostAccessForMethod } = require('../middleware/hostAccess');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(requireAuth);
router.use(extractHostId);
router.use(requireHostAccessForMethod());

// GET /api/volumes/:name/browse?path=/  — list directory
router.get('/:name/browse', requireAuth, asyncHandler(async (req, res) => {
  const p = req.query.path || '/';
  try {
    const result = await svc.list(req.hostId, req.params.name, p);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// GET /api/volumes/:name/read?path=/file  — read a file's contents
router.get('/:name/read', requireAuth, asyncHandler(async (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: 'path is required' });
  try {
    const result = await svc.readFile(req.hostId, req.params.name, p);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'volume_file_read', targetType: 'volume', targetId: req.params.name,
      details: { hostId: req.hostId, path: p, encoding: result.encoding },
      ip: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// DELETE /api/volumes/:name/file?path=/file  — delete a file/dir
router.delete('/:name/file', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const p = req.query.path;
    if (!p) return res.status(400).json({ error: 'path is required' });
    try {
      await svc.remove(req.hostId, req.params.name, p);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'volume_file_delete', targetType: 'volume', targetId: req.params.name,
        details: { hostId: req.hostId, path: p }, ip: getClientIp(req),
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

module.exports = router;
