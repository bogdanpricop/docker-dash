'use strict';

const { Router } = require('express');
const selfService = require('../services/self-service');
const auditService = require('../services/audit');
const { requireAuth, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();
router.use(requireAuth);

function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof selfService.SelfServiceError || (Number.isInteger(error?.status) && error.status < 500)) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code || 'SELF_SERVICE_ERROR', details: error.details || undefined });
      }
      return next(error);
    }
  };
}

function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType, targetId: String(targetId),
    details, ip: getClientIp(req), userAgent: req.headers['user-agent'] });
}

router.get('/catalog', route((req, res) => res.json(selfService.listCatalog(req.user, { includeAll: req.query.includeAll === 'true' }))));
router.get('/catalog/:slug', route((req, res) => res.json(selfService.getCatalogItem(req.params.slug, req.user, req.query.versions === 'true'))));
router.post('/catalog', writeable, route((req, res) => {
  const result = selfService.saveCatalogItem(null, req.body || {}, req.user);
  audit(req, 'self_service_catalog_create', 'catalog_item', result.item.id, { slug: result.item.slug, kind: result.item.kind });
  res.status(201).json(result);
}));
router.put('/catalog/:id', writeable, route((req, res) => {
  const result = selfService.saveCatalogItem(req.params.id, req.body || {}, req.user);
  audit(req, 'self_service_catalog_update', 'catalog_item', result.item.id, { slug: result.item.slug, lifecycle: result.item.lifecycle });
  res.json(result);
}));
router.post('/catalog/:id/versions', writeable, route((req, res) => {
  const result = selfService.createCatalogVersion(req.params.id, req.body || {}, req.user);
  audit(req, 'self_service_catalog_version_create', 'catalog_version', result.version.id, { itemId: req.params.id, version: result.version.version, versionHash: result.version.versionHash });
  res.status(201).json(result);
}));
router.post('/catalog/:id/versions/:versionId/state', writeable, route((req, res) => {
  const result = selfService.transitionCatalogVersion(req.params.id, req.params.versionId, req.body?.state, req.user);
  audit(req, 'self_service_catalog_version_transition', 'catalog_version', req.params.versionId, { itemId: req.params.id, state: req.body?.state });
  res.json(result);
}));

router.get('/projects/:id/policy', route((req, res) => res.json(selfService.getProjectPolicy(req.params.id, req.user))));
router.put('/projects/:id/policy', writeable, route((req, res) => {
  const result = selfService.saveProjectPolicy(req.params.id, req.body || {}, req.user);
  audit(req, 'self_service_project_policy_update', 'project', req.params.id, { maximumRisk: result.policy.maximumRisk, requireApproval: result.policy.requireApproval });
  res.json(result);
}));
router.get('/projects/:id/dashboard', route((req, res) => res.json(selfService.projectDashboard(req.params.id, req.user))));
router.post('/projects/:id/resources/:resourceId/lifecycle', writeable, route((req, res) => {
  const result = selfService.createLifecycleRequest(req.params.id, req.params.resourceId, req.body || {}, req.user);
  audit(req, 'self_service_lifecycle_request', 'self_service_request', result.request.id, { tenantId: req.params.id, resourceId: req.params.resourceId, action: result.request.actionKey, risk: result.request.risk });
  res.status(201).json(result);
}));

router.post('/catalog/:slug/preview', route((req, res) => res.json(selfService.previewCatalogRequest(req.params.slug, req.body || {}, req.user))));
router.post('/catalog/:slug/requests', writeable, route((req, res) => {
  const result = selfService.createProvisionRequest(req.params.slug, req.body || {}, req.user);
  audit(req, 'self_service_provision_request', 'self_service_request', result.request.id, { tenantId: result.request.tenantId, catalogVersionId: result.request.catalogVersionId, risk: result.request.risk });
  res.status(201).json(result);
}));

router.get('/approval-inbox', route((req, res) => res.json(selfService.listRequests(req.user, { inbox: true, limit: req.query.limit || 100 }))));
router.get('/requests', route((req, res) => res.json(selfService.listRequests(req.user, { tenantId: req.query.tenantId, state: req.query.state, limit: req.query.limit || 100 }))));
router.get('/requests/:id', route((req, res) => res.json(selfService.getRequest(req.params.id, req.user))));
router.post('/requests/:id/decision', writeable, route((req, res) => {
  const result = selfService.decideRequest(req.params.id, req.body?.decision, req.body?.comment, req.user);
  audit(req, `self_service_request_${req.body?.decision}`, 'self_service_request', req.params.id, { state: result.request.state, comment: req.body?.comment ? String(req.body.comment).slice(0, 200) : null });
  res.json(result);
}));
router.post('/requests/:id/fulfillment/preflight', route(async (req, res) => res.json(await selfService.preflightFulfillment(req.params.id, req.user))));
router.post('/requests/:id/fulfillment', writeable, route(async (req, res) => {
  const result = await selfService.fulfillRequest(req.params.id, req.body || {}, req.user);
  audit(req, 'self_service_request_fulfill', 'self_service_request', req.params.id, { providerOperationId: result.request.providerOperationId, state: result.request.state });
  res.json(result);
}));

router.get('/basket', route((req, res) => res.json(selfService.getBasket(req.user))));
router.post('/basket', writeable, route((req, res) => {
  const result = selfService.addBasketItem(req.body || {}, req.user);
  audit(req, 'self_service_basket_add', 'selection_basket', req.user.id, { count: result.items.length, resourceKind: req.body?.resourceKind });
  res.status(201).json(result);
}));
router.delete('/basket/:id', writeable, route((req, res) => res.json(selfService.removeBasketItem(req.params.id, req.user))));
router.delete('/basket', writeable, route((req, res) => res.json(selfService.clearBasket(req.user))));
router.get('/palette', route((req, res) => res.json(selfService.commandPalette(req.query.q, req.user))));

module.exports = router;
