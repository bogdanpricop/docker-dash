'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const lifecycle = require('../services/governance-lifecycle');
const metrics = require('../services/vm-metrics');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (['LifecycleError', 'GovernanceLifecycleError', 'VmMetricsError'].includes(error.name)) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
      next(error);
    }
  };
}
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/catalog', route((req, res) => res.json({ renewalModes: ['holder', 'cleanup_owner', 'admin'],
  environments: ['production', 'nonproduction'], reviewKinds: ['access', 'service_accounts', 'all'],
  adapters: metrics.ADAPTER_CATALOG, metrics: metrics.definitions(req.user) })));

router.get('/lease-policies', route((req, res) => res.json({ policies: lifecycle.listLeasePolicies(req.query.tenantId, req.user) })));
router.put('/lease-policies', writeable, route((req, res) => {
  const policy = lifecycle.saveLeasePolicy(req.body?.tenantId, req.body || {}, req.user);
  audit(req, 'resource_lease_policy_update', 'resource_lease_policy', policy.id, { tenantId: policy.tenant_id, resourceType: policy.resource_type });
  res.json({ policy });
}));
router.get('/leases', route((req, res) => res.json({ leases: lifecycle.listLeases(req.query, req.user) })));
router.post('/leases', writeable, route((req, res) => {
  const lease = lifecycle.createLease(req.body?.tenantId, req.body || {}, req.user);
  audit(req, 'resource_lease_create', 'resource_lease', lease.id, { resourceId: lease.resource_id, expiresAt: lease.expires_at });
  res.status(201).json({ lease });
}));
router.post('/leases/:id/renew', writeable, route((req, res) => {
  const lease = lifecycle.renewLease(req.params.id, req.body || {}, req.user);
  audit(req, 'resource_lease_renew', 'resource_lease', lease.id, { expiresAt: lease.expires_at, renewalCount: lease.renewal_count });
  res.json({ lease });
}));
router.post('/leases/:id/release', writeable, route((req, res) => {
  const lease = lifecycle.releaseLease(req.params.id, req.body || {}, req.user);
  audit(req, lease.state === 'cleaned' ? 'resource_lease_cleanup_attest' : 'resource_lease_release', 'resource_lease', lease.id);
  res.json({ lease });
}));

router.get('/projects/:id/ownership-policy', route((req, res) => res.json({ policy: lifecycle.getOwnershipPolicy(req.params.id, req.user),
  resources: lifecycle.ownershipReport(req.params.id, req.user) })));
router.put('/projects/:id/ownership-policy', writeable, route((req, res) => {
  const policy = lifecycle.ownershipPolicy(req.params.id, req.body || {}, req.user);
  const resources = lifecycle.ownershipReport(req.params.id, req.user);
  audit(req, 'resource_ownership_policy_update', 'project', req.params.id, { incomplete: resources.filter(item => item.completeness_state !== 'complete').length });
  res.json({ policy, resources });
}));
router.put('/resources/:id/ownership', writeable, route((req, res) => {
  const ownership = lifecycle.setOwnership(req.body?.tenantId, req.params.id, req.body || {}, req.user);
  audit(req, 'resource_ownership_update', 'project_resource', req.params.id, { completeness: ownership.completeness_state,
    environment: ownership.environment });
  res.json({ ownership });
}));

router.get('/sod-report', route((req, res) => res.json(lifecycle.sodReport(req.user))));
router.post('/sod-rules', writeable, route((req, res) => {
  const rule = lifecycle.saveSodRule(req.body || {}, req.user);
  audit(req, 'sod_rule_create', 'sod_rule', rule.id, { leftRoleId: rule.left_role_id, rightRoleId: rule.right_role_id });
  res.status(201).json({ rule });
}));

router.get('/access-reviews', route((req, res) => res.json({ campaigns: lifecycle.listReviewCampaigns(req.user) })));
router.post('/access-reviews', writeable, route((req, res) => {
  const campaign = lifecycle.createReviewCampaign(req.body || {}, req.user);
  audit(req, 'access_review_create', 'access_review', campaign.id, { itemCount: campaign.itemCount, dueAt: campaign.due_at });
  res.status(201).json({ campaign });
}));
router.get('/access-reviews/:id', route((req, res) => res.json({ campaign: lifecycle.listReviewCampaigns(req.user).find(item => item.id === Number(req.params.id)) || null,
  items: lifecycle.reviewItems(req.params.id, req.user) })));
router.post('/access-reviews/:id/items/:itemId/decision', writeable, route((req, res) => {
  const item = lifecycle.decideReviewItem(req.params.itemId, req.body || {}, req.user);
  audit(req, `access_review_${item.decision}`, 'access_review_item', item.id, { campaignId: item.campaign_id });
  res.json({ item });
}));
router.post('/access-reviews/:id/complete', writeable, route((req, res) => {
  const campaign = lifecycle.completeReviewCampaign(req.params.id, req.user);
  audit(req, 'access_review_complete', 'access_review', campaign.id);
  res.json({ campaign });
}));

router.post('/tenants/:id/exports', writeable, route((req, res) => {
  const tenantExport = lifecycle.exportTenant(req.params.id, req.user);
  audit(req, 'tenant_export_create', 'tenant_export', tenantExport.id, { tenantId: tenantExport.tenantId,
    checksumSha256: tenantExport.checksumSha256, byteSize: tenantExport.byteSize });
  res.status(201).json({ export: tenantExport });
}));
router.get('/tenant-exports/:id', route((req, res) => res.json({ export: lifecycle.getTenantExport(req.params.id, req.user) })));
router.post('/tenants/:id/offboarding', writeable, route((req, res) => {
  const request = lifecycle.planOffboarding(req.params.id, req.body || {}, req.user);
  audit(req, 'tenant_offboarding_plan', 'tenant_offboarding', request.id, { tenantId: request.tenant_id,
    state: request.state, blockerCodes: request.blockers.map(item => item.code) });
  res.status(201).json({ request });
}));
router.post('/offboarding/:id/complete', writeable, route((req, res) => {
  const result = lifecycle.completeOffboarding(req.params.id, req.body || {}, req.user);
  audit(req, 'tenant_offboarding_complete', 'tenant_offboarding', req.params.id, result);
  res.json(result);
}));

router.get('/metrics/definitions', route((req, res) => res.json({ definitions: metrics.definitions(req.user), adapters: metrics.ADAPTER_CATALOG })));
router.get('/metrics/samples', route((req, res) => res.json({ samples: metrics.samples(req.query, req.user) })));
router.get('/metrics/freshness', route((req, res) => res.json(metrics.freshness(req.query, req.user))));
router.get('/metrics/polling/:hostId/decision', route((req, res) => res.json(metrics.pollingDecision(req.params.hostId, {
  active: req.query.active === 'true', pageVisible: req.query.pageVisible !== 'false',
  activityAgeSeconds: req.query.activityAgeSeconds, resourceCount: req.query.resourceCount,
}, req.user))));
router.put('/metrics/polling/:hostId', writeable, route((req, res) => {
  const policy = metrics.savePollingPolicy(req.params.hostId, req.body || {}, req.user);
  audit(req, 'vm_metric_polling_policy_update', 'provider_host', req.params.hostId, policy);
  res.json({ policy });
}));
router.put('/metrics/cardinality/:hostId', writeable, route((req, res) => {
  const policy = metrics.saveCardinalityPolicy(req.params.hostId, req.body || {}, req.user);
  audit(req, 'vm_metric_cardinality_policy_update', 'provider_host', req.params.hostId, policy);
  res.json({ policy });
}));
router.post('/metrics/ingest', writeable, route((req, res) => {
  const result = metrics.ingest(req.body || {}, req.user);
  audit(req, 'vm_metric_ingest', 'provider_host', result.providerHostId, { adapter: result.adapter,
    acceptedSamples: result.acceptedSamples, droppedSamples: result.droppedSamples });
  res.status(202).json(result);
}));
router.post('/metrics/errors', writeable, route((req, res) => {
  const state = metrics.recordCollectionError(req.body || {}, req.user);
  audit(req, 'vm_metric_collection_error', 'provider_resource', state.resource_key, { adapter: state.adapter,
    providerHostId: state.provider_host_id, consecutiveErrors: state.consecutive_errors });
  res.json({ state });
}));

// V6.4a / B206-B215 — charts, performance dashboards, events, correlation,
// topology impact and advisory multi-signal alerts.
router.use('/observability', require('./vm-observability'));

// V0.3b / B226-B235 — durable-operation evidence, infrastructure manifests,
// stale-safe plans, workflow DAGs and compensation planning.
router.use('/automation', require('./infrastructure-automation'));

// V0.3d / B251-B255 — version/build inventory, support lifecycle, upgrade
// advice, official catalog evidence and non-mutating upgrade prechecks.
router.use('/updates', require('./lifecycle-updates'));

module.exports = router;
