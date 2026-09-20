'use strict';

const { Router } = require('express');
const { requireAuth, writeable } = require('../middleware/auth');
const views = require('../services/provider-inventory-views');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
router.use(requireAuth);

function route(handler) {
  return (req, res, next) => {
    try { handler(req, res); } catch (error) {
      if (error.name === 'ProviderInventoryViewError') {
        return res.status(error.status || 400).json({ error: error.message, code: error.code });
      }
      next(error);
    }
  };
}

function audit(req, action, view) {
  auditService.log({
    userId: req.user.id,
    username: req.user.username,
    action,
    targetType: 'provider_inventory_view',
    targetId: String(view.id),
    details: {
      resourceType: view.resourceType,
      providerHostId: view.providerHostId,
      isDefault: view.isDefault,
      version: view.version,
    },
    ip: getClientIp(req),
  });
}

router.get('/', route((req, res) => {
  res.json({ views: views.list(req.query.resourceType, req.user) });
}));

router.post('/', writeable, route((req, res) => {
  const view = views.create(req.body || {}, req.user);
  audit(req, 'provider_inventory_view_create', view);
  res.status(201).json({ view });
}));

router.put('/:id', writeable, route((req, res) => {
  const view = views.update(req.params.id, req.body || {}, req.user);
  audit(req, 'provider_inventory_view_update', view);
  res.json({ view });
}));

router.delete('/:id', writeable, route((req, res) => {
  const view = views.remove(req.params.id, req.user);
  audit(req, 'provider_inventory_view_delete', view);
  res.json({ ok: true, view });
}));

module.exports = router;
