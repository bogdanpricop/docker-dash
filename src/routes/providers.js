'use strict';

const { Router } = require('express');
const config = require('../config');
const { getDb } = require('../db');
const providerSdk = require('../services/provider-sdk/registry');
const auditService = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { requireHostAccess } = require('../middleware/hostAccess');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

function _isAdmin(user) {
  return user?.role === 'admin' || (Array.isArray(user?.roles) && user.roles.includes('admin'));
}

router.get('/:hostId/capabilities', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  if (!config.features.providerSdkV2) return res.status(404).json({ error: 'Provider SDK v2 is disabled' });
  const hostId = Number.parseInt(req.params.hostId, 10);
  if (!Number.isInteger(hostId) || hostId <= 0) return res.status(400).json({ error: 'Invalid provider host ID' });
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  if (refresh && !_isAdmin(req.user)) {
    return res.status(403).json({ error: 'Capability refresh requires admin role' });
  }
  const host = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Provider host not found' });
  if (!host.is_active) return res.status(400).json({ error: `Provider host "${host.name}" is not active` });
  try {
    const envelope = await providerSdk.capabilitiesForHost(host, { refresh });
    if (refresh) {
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_capability_refresh', targetType: 'host', targetId: String(hostId),
        details: {
          provider: host.daemon_type, status: envelope.probe.status,
          durationMs: envelope.probe.durationMs,
        },
        ip: getClientIp(req),
      });
    }
    res.json(envelope);
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: status >= 500 ? 'Provider capability discovery failed' : err.message,
      code: err?.code || 'PROVIDER_CAPABILITY_ERROR',
    });
  }
}));

router.get('/:hostId/resources/:kind', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  if (!config.features.providerSdkV2) return res.status(404).json({ error: 'Provider SDK v2 is disabled' });
  const hostId = Number.parseInt(req.params.hostId, 10);
  if (!Number.isInteger(hostId) || hostId <= 0) return res.status(400).json({ error: 'Invalid provider host ID' });
  if (req.query.limit !== undefined && !/^\d{1,3}$/.test(String(req.query.limit))) {
    return res.status(400).json({ error: 'Resource limit must be an integer between 1 and 500', code: 'INVALID_RESOURCE_LIMIT' });
  }
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ error: 'Resource limit must be an integer between 1 and 500', code: 'INVALID_RESOURCE_LIMIT' });
  }
  const host = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Provider host not found' });
  if (!host.is_active) return res.status(400).json({ error: `Provider host "${host.name}" is not active` });
  try {
    res.json(await providerSdk.resourcesForHost(host, req.params.kind, { limit }));
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: status >= 500 ? 'Provider resource inventory failed' : err.message,
      code: err?.code || 'PROVIDER_RESOURCE_ERROR',
    });
  }
}));

module.exports = router;
