'use strict';

const { Router } = require('express');
const fleet = require('../services/fleet-operations');
const auditService = require('../services/audit');
const config = require('../config');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.get('/health', requireAuth, requireRole('admin'), (req, res) => {
  res.json(fleet.fleetHealth(req.query.hours));
});

router.post('/bulk/preview', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  res.json(await fleet.preview(req.body.action, req.body.host_ids));
}));

router.post('/bulk/run', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  if (req.body.action === 'prune' && !config.features.prune) {
    return res.status(403).json({ error: "Feature 'prune' is disabled" });
  }
  const result = await fleet.run(req.body.action, req.body.host_ids);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `fleet_bulk_${result.action}`, targetType: 'fleet',
    details: {
      host_ids: req.body.host_ids,
      status: result.status,
      results: result.hosts.map(host => ({ host_id: host.host_id, status: host.status })),
    },
    ip: getClientIp(req),
  });
  res.json(result);
}));

module.exports = router;
