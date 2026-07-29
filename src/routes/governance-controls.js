'use strict';

const { Router } = require('express');
const { requireAuth, requireFeature, writeable } = require('../middleware/auth');
const approvals = require('../services/governance-approvals');
const capacity = require('../services/governance-capacity');
const identity = require('../services/identity-governance');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
router.use(requireAuth, requireFeature('governance'));

function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (['ApprovalError', 'CapacityError', 'IdentityGovernanceError'].includes(error.name)) {
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

router.get('/catalog', route((_req, res) => res.json({
  capacityMetrics: capacity.EXTENDED_METRICS,
  serviceScopes: [...identity.SERVICE_SCOPES],
  identityProtocols: ['oidc', 'saml'], workloadIdentityKinds: ['oidc', 'spiffe', 'aws', 'azure', 'gcp'],
})));

router.get('/projects/:id/capacity', route((req, res) => res.json(capacity.projectCapacity(req.params.id, req.user))));
router.put('/projects/:id/capacity/quotas', writeable, route((req, res) => {
  const result = capacity.setQuotas(req.params.id, req.body?.quotas, req.user);
  audit(req, 'governance_extended_quota_update', 'project', req.params.id, { quotas: req.body?.quotas });
  res.json(result);
}));
router.post('/projects/:id/capacity/allocations', writeable, route((req, res) => {
  const result = capacity.assign(req.params.id, req.body || {}, req.user);
  audit(req, 'governance_capacity_assign', 'project', req.params.id, { metric: req.body?.metric, resourceKey: req.body?.resourceKey });
  res.status(201).json(result);
}));
router.delete('/projects/:id/capacity/allocations/:allocationId', writeable, route((req, res) => {
  const result = capacity.remove(req.params.id, req.params.allocationId, req.user);
  audit(req, 'governance_capacity_remove', 'project', req.params.id, { allocationId: req.params.allocationId });
  res.json(result);
}));
router.get('/projects/:id/quota-requests', route((req, res) => res.json({ requests: capacity.listQuotaRequests(req.params.id, req.user) })));
router.post('/projects/:id/quota-requests', writeable, route((req, res) => {
  const request = capacity.requestQuota(req.params.id, req.body || {}, req.user);
  audit(req, 'governance_quota_request', 'quota_request', request.id, { projectId: req.params.id, limits: request.requestedLimits });
  res.status(201).json({ request });
}));

router.get('/approval-policies', route((_req, res) => res.json({ policies: approvals.listPolicies() })));
router.post('/approval-policies', writeable, route((req, res) => {
  const policy = approvals.savePolicy(null, req.body || {}, req.user);
  audit(req, 'approval_policy_create', 'approval_policy', policy.id);
  res.status(201).json({ policy });
}));
router.put('/approval-policies/:id', writeable, route((req, res) => {
  const policy = approvals.savePolicy(req.params.id, req.body || {}, req.user);
  audit(req, 'approval_policy_update', 'approval_policy', policy.id);
  res.json({ policy });
}));
router.delete('/approval-policies/:id', writeable, route((req, res) => {
  const result = approvals.deletePolicy(req.params.id, req.user);
  audit(req, 'approval_policy_delete', 'approval_policy', req.params.id);
  res.json(result);
}));
router.get('/approval-requests', route((req, res) => res.json({ requests: approvals.listRequests(req.query),
  decisions: req.query.requestId ? approvals.decisions(req.query.requestId) : undefined })));
router.post('/approval-requests', writeable, route((req, res) => {
  const request = approvals.createRequest(req.body || {}, req.user);
  audit(req, 'approval_request_create', 'approval_request', request.id, { actionKey: request.action_key });
  res.status(201).json({ request });
}));
router.post('/approval-requests/:id/decision', writeable, route((req, res) => {
  let request = approvals.decide(req.params.id, req.body?.decision, req.body?.comment, req.user);
  const quota = capacity.syncQuotaRequest(request.id);
  request = approvals.getRequest(request.id);
  audit(req, `approval_request_${req.body?.decision}`, 'approval_request', request.id, { quotaRequestId: quota?.id || null });
  res.json({ request, quotaRequest: quota });
}));

router.get('/blackouts', route((_req, res) => res.json({ windows: approvals.listBlackouts() })));
router.post('/blackouts', writeable, route((req, res) => {
  const window = approvals.saveBlackout(null, req.body || {}, req.user);
  audit(req, 'blackout_create', 'blackout_window', window.id);
  res.status(201).json({ window });
}));
router.put('/blackouts/:id', writeable, route((req, res) => {
  const window = approvals.saveBlackout(req.params.id, req.body || {}, req.user);
  audit(req, 'blackout_update', 'blackout_window', window.id);
  res.json({ window });
}));
router.delete('/blackouts/:id', writeable, route((req, res) => {
  const result = approvals.deleteBlackout(req.params.id, req.user);
  audit(req, 'blackout_delete', 'blackout_window', req.params.id);
  res.json(result);
}));

router.get('/identity-realms', route((req, res) => { identity._admin(req.user); res.json({ realms: identity.listRealms() }); }));
router.post('/identity-realms', writeable, route((req, res) => {
  const realm = identity.saveRealm(null, req.body || {}, req.user);
  audit(req, 'identity_realm_create', 'identity_realm', realm.id, { slug: realm.slug, protocol: realm.protocol, domains: realm.domains });
  res.status(201).json({ realm });
}));
router.put('/identity-realms/:id', writeable, route((req, res) => {
  const realm = identity.saveRealm(req.params.id, req.body || {}, req.user);
  audit(req, 'identity_realm_update', 'identity_realm', realm.id);
  res.json({ realm });
}));
router.delete('/identity-realms/:id', writeable, route((req, res) => {
  const result = identity.deleteRealm(req.params.id, req.user);
  audit(req, 'identity_realm_delete', 'identity_realm', req.params.id);
  res.json(result);
}));

router.get('/service-tokens', route((req, res) => res.json({ tokens: identity.listTokens(req.user) })));
router.post('/service-tokens', writeable, route((req, res) => {
  const token = identity.issueToken(req.body || {}, req.user);
  audit(req, 'service_token_issue', 'service_token', token.id, { scopes: token.scopes, expiresAt: token.expires_at });
  res.status(201).json({ token });
}));
router.post('/service-tokens/:id/rotate', writeable, route((req, res) => {
  const token = identity.rotateToken(req.params.id, req.body || {}, req.user);
  audit(req, 'service_token_rotate', 'service_token', token.id, { rotatedFrom: req.params.id });
  res.status(201).json({ token });
}));
router.delete('/service-tokens/:id', writeable, route((req, res) => {
  const result = identity.revokeToken(req.params.id, req.user);
  audit(req, 'service_token_revoke', 'service_token', req.params.id);
  res.json(result);
}));

router.get('/workload-trusts', route((req, res) => res.json({ trusts: identity.listTrusts(req.user) })));
router.post('/workload-trusts', writeable, route((req, res) => {
  const trust = identity.saveTrust(null, req.body || {}, req.user);
  audit(req, 'workload_trust_create', 'workload_identity_trust', trust.id, { issuer: trust.issuer, audience: trust.audience });
  res.status(201).json({ trust });
}));
router.put('/workload-trusts/:id', writeable, route((req, res) => {
  const trust = identity.saveTrust(req.params.id, req.body || {}, req.user);
  audit(req, 'workload_trust_update', 'workload_identity_trust', trust.id);
  res.json({ trust });
}));
router.delete('/workload-trusts/:id', writeable, route((req, res) => {
  const result = identity.deleteTrust(req.params.id, req.user);
  audit(req, 'workload_trust_delete', 'workload_identity_trust', req.params.id);
  res.json(result);
}));

module.exports = router;
