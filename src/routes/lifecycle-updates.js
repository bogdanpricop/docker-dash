'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const lifecycle = require('../services/lifecycle-updates');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'LifecycleUpdatesError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details });
  next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(lifecycle.overview(req.user))));
router.post('/inventory', writeable, route((req, res) => {
  const inventory = lifecycle.recordInventory(req.body || {}, req.user);
  audit(req, 'lifecycle_inventory_record', 'lifecycle_inventory', inventory.id,
    { componentType: inventory.componentType, vendor: inventory.vendor, product: inventory.product,
      version: inventory.version, evidenceHash: inventory.evidenceHash });
  res.status(201).json({ inventory });
}));
router.put('/support', writeable, route((req, res) => {
  const support = lifecycle.saveSupport(req.body || {}, req.user);
  audit(req, 'lifecycle_support_update', 'lifecycle_support', support.id,
    { vendor: support.vendor, product: support.product, versionLine: support.versionLine,
      state: support.state, sourceUrl: support.sourceUrl });
  res.json({ support });
}));
router.put('/upgrade-paths', writeable, route((req, res) => {
  const path = lifecycle.saveUpgradePath(req.body || {}, req.user);
  audit(req, 'lifecycle_upgrade_path_update', 'lifecycle_upgrade_path', path.id,
    { vendor: path.vendor, product: path.product, fromVersion: path.fromVersion,
      toVersion: path.toVersion, blockers: path.blockers.length });
  res.json({ path });
}));
router.get('/inventory/:id/advisor', route((req, res) => res.json(lifecycle.advise(req.params.id, req.query.targetVersion, req.user))));
router.post('/catalog/ingest', writeable, route((req, res) => {
  const result = lifecycle.ingestCatalog(req.body || {}, req.user);
  audit(req, 'lifecycle_update_catalog_ingest', 'lifecycle_update_catalog', `${result.vendor}:${result.product}`,
    { sourceKind: result.sourceKind, sourceUrl: result.sourceUrl, created: result.created,
      updated: result.updated, packagesInstalled: 0 });
  res.status(201).json(result);
}));
router.post('/prechecks', writeable, route((req, res) => {
  const precheck = lifecycle.runPrecheck(req.body || {}, req.user);
  audit(req, 'lifecycle_upgrade_precheck', 'lifecycle_upgrade_precheck', precheck.id,
    { inventoryId: precheck.inventoryId, targetVersion: precheck.targetVersion, status: precheck.status,
      evidenceHash: precheck.evidenceHash, upgradeStarted: false });
  res.status(201).json({ precheck });
}));

module.exports = router;
