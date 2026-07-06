'use strict';

// v8.9.8-alpha.1 — Portainer G06 closure: container webhooks routes.
// Trigger endpoint is intentionally unauthenticated (token IS the auth)
// with rate limiting. Management endpoints require admin.

const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const svc = require('../services/container-webhooks');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');
const log = require('../utils/logger')('container-webhooks-route');

// Management routes — need X-Host-ID + admin
const mgmt = Router();
mgmt.use(extractHostId);

mgmt.get('/', requireAuth, asyncHandler(async (req, res) => {
  res.json(svc.list(req.hostId));
}));

mgmt.get('/:containerId', requireAuth, asyncHandler(async (req, res) => {
  const row = svc.getByContainer(req.hostId, req.params.containerId);
  if (!row) return res.status(404).json({ error: 'Webhook not found' });
  res.json(row);
}));

mgmt.post('/:containerId', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    try {
      const result = svc.create({
        hostId: req.hostId,
        containerId: req.params.containerId,
        containerName: (req.body && req.body.containerName) || null,
        action: (req.body && req.body.action) || 'recreate',
      }, req.user.id);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'container_webhook_create', targetType: 'container',
        targetId: req.params.containerId,
        details: { hostId: req.hostId, webhookId: result.id, action: result.action },
        ip: getClientIp(req),
      });
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  })
);

mgmt.delete('/:containerId', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    svc.removeByContainer(req.hostId, req.params.containerId);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_webhook_delete', targetType: 'container',
      targetId: req.params.containerId, ip: getClientIp(req),
    });
    res.json({ ok: true });
  })
);

// ─── PUBLIC trigger endpoint (no auth, rate-limited) ───────────
const trigger = Router();

const triggerLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many trigger attempts, rate-limited' },
});

trigger.post('/:token', triggerLimiter, asyncHandler(async (req, res) => {
  const row = svc.getByToken(req.params.token);
  // 404 on unknown token (NOT 401) to avoid enumeration.
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await svc.trigger(row, getClientIp(req));
    auditService.log({
      userId: null, username: null,
      action: 'container_webhook_trigger', targetType: 'container',
      targetId: row.container_id,
      details: { hostId: row.host_id, webhookId: row.id, action: result.action, image: result.image },
      ip: getClientIp(req),
    });
    res.json({ ok: true, action: result.action, image: result.image });
  } catch (err) {
    log.error('Webhook trigger failed', { error: err.message });
    auditService.log({
      userId: null, username: null,
      action: 'container_webhook_trigger_failed', targetType: 'container',
      targetId: row.container_id,
      details: { hostId: row.host_id, webhookId: row.id, error: err.message },
      ip: getClientIp(req),
    });
    res.status(500).json({ error: err.message });
  }
}));

module.exports = { mgmt, trigger };
