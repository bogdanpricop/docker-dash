'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const lifecycle = require('../services/lifecycle-assurance');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'LifecycleAssuranceError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details });
  next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(lifecycle.overview(req.user))));
router.post('/certificate-renewals', writeable, route((req, res) => {
  const job = lifecycle.planRenewal(req.body || {}, req.user);
  audit(req, 'certificate_renewal_plan', 'certificate_renewal', job.id,
    { ownershipId: job.ownershipId, adapterKey: job.adapterKey, state: job.state, planHash: job.planHash, applyStarted: job.applyStarted });
  res.status(201).json({ job });
}));
router.post('/certificate-renewals/:id/approve', writeable, route((req, res) => {
  const job = lifecycle.approveRenewal(req.params.id, req.body || {}, req.user);
  audit(req, 'certificate_renewal_approve', 'certificate_renewal', job.id, { planHash: job.planHash, applyStarted: job.applyStarted });
  res.json({ job });
}));
router.post('/certificate-renewals/:id/execute', writeable, route(async (req, res) => {
  const job = await lifecycle.executeRenewal(req.params.id, req.body || {}, req.user);
  audit(req, 'certificate_renewal_execute', 'certificate_renewal', job.id,
    { state: job.state, operationId: job.operationId, approvalId: job.approvalId,
      renewedFingerprint: job.renewedFingerprint, implicitRebootScheduled: job.implicitRebootScheduled });
  res.json({ job });
}));

router.put('/licenses/entitlements', writeable, route((req, res) => {
  const entitlement = lifecycle.saveEntitlement(req.body || {}, req.user);
  audit(req, 'license_entitlement_update', 'license_entitlement', entitlement.id,
    { vendor: entitlement.vendor, product: entitlement.product, edition: entitlement.edition,
      metric: entitlement.metric, capacity: entitlement.capacity, entitlementHash: entitlement.entitlementHash });
  res.json({ entitlement });
}));
router.put('/licenses/entitlements/:id/assignments', writeable, route((req, res) => {
  const entitlement = lifecycle.assignEntitlement(req.params.id, req.body || {}, req.user);
  audit(req, 'license_assignment_update', 'license_entitlement', entitlement.id,
    { resourceType: req.body?.resourceType, resourceRef: req.body?.resourceRef, assignedCapacity: req.body?.assignedCapacity });
  res.json({ entitlement });
}));
router.post('/licenses/entitlements/:id/usage', writeable, route((req, res) => {
  const usage = lifecycle.recordLicenseUsage(req.params.id, req.body || {}, req.user);
  audit(req, 'license_usage_record', 'license_entitlement', usage.entitlementId,
    { usageId: usage.id, usedCapacity: usage.usedCapacity, assignedCapacity: usage.assignedCapacity, evidenceHash: usage.evidenceHash });
  res.status(201).json({ usage });
}));
router.post('/licenses/alert-policies', writeable, route((req, res) => {
  const policy = lifecycle.saveLicenseAlertPolicy(req.body || {}, req.user);
  audit(req, 'license_alert_policy_create', 'license_alert_policy', policy.id, policy);
  res.status(201).json({ policy });
}));
router.post('/licenses/alerts/evaluate', writeable, route((req, res) => {
  const result = lifecycle.evaluateLicenseAlerts(req.user);
  audit(req, 'license_alerts_evaluate', 'license_alert', 'all', { created: result.created, licenseChangesApplied: result.licenseChangesApplied });
  res.json(result);
}));

router.post('/configuration/snapshots', writeable, route((req, res) => {
  const snapshot = lifecycle.saveConfigurationSnapshot(req.body || {}, req.user);
  audit(req, 'host_configuration_snapshot', 'host_configuration_snapshot', snapshot.id,
    { providerHostId: snapshot.providerHostId, scopeRef: snapshot.scopeRef, sourceKind: snapshot.sourceKind,
      configurationHash: snapshot.configurationHash, redactedPaths: snapshot.redactedPaths.length });
  res.status(201).json({ snapshot });
}));
router.post('/configuration/diffs', writeable, route((req, res) => {
  const diff = lifecycle.createConfigurationDiff(req.body || {}, req.user);
  audit(req, 'host_configuration_diff', 'host_configuration_diff', diff.id,
    { fromSnapshotId: diff.fromSnapshotId, toSnapshotId: diff.toSnapshotId,
      diffHash: diff.diffHash, changes: diff.changes.length, remediationStarted: diff.remediationStarted });
  res.status(201).json({ diff });
}));
router.post('/configuration/drift-policies', writeable, route((req, res) => {
  const policy = lifecycle.saveDriftPolicy(req.body || {}, req.user);
  audit(req, 'host_drift_policy_create', 'host_drift_policy', policy.id,
    { providerHostId: policy.providerHostId, scopePattern: policy.scopePattern, owner: policy.owner });
  res.status(201).json({ policy });
}));
router.post('/configuration/drift-policies/:id/evaluate/:diffId', writeable, route((req, res) => {
  const assessment = lifecycle.evaluateDrift(req.params.id, req.params.diffId, req.user);
  audit(req, 'host_drift_evaluate', 'host_drift_policy', assessment.policy.id,
    { diffId: assessment.diffId, state: assessment.state, evidenceHash: assessment.evidenceHash,
      remediationStarted: assessment.remediationStarted });
  res.json({ assessment });
}));
router.post('/configuration/profiles', writeable, route((req, res) => {
  const profile = lifecycle.saveHostProfile(req.body || {}, req.user);
  audit(req, 'host_profile_create', 'host_profile', profile.id,
    { version: profile.version, scopePattern: profile.scopePattern, baselineHash: profile.baselineHash });
  res.status(201).json({ profile });
}));
router.post('/configuration/profiles/:id/assess/:snapshotId', writeable, route((req, res) => {
  const assessment = lifecycle.assessHostProfile(req.params.id, req.params.snapshotId, req.user);
  audit(req, 'host_profile_assess', 'host_profile', assessment.profile.id,
    { snapshotId: assessment.snapshotId, state: assessment.state, evidenceHash: assessment.evidenceHash,
      remediationStarted: assessment.remediationStarted });
  res.json({ assessment });
}));

router.post('/airgap/mirrors', writeable, route((req, res) => {
  const mirror = lifecycle.saveMirror(req.body || {}, req.user);
  audit(req, 'airgap_mirror_create', 'airgap_mirror', mirror.id,
    { siteRef: mirror.siteRef, adapterKey: mirror.adapterKey, rootReference: mirror.rootReference, maxBytes: mirror.maxBytes });
  res.status(201).json({ mirror });
}));
router.post('/airgap/mirrors/:id/sync', writeable, route(async (req, res) => {
  const result = await lifecycle.syncMirror(req.params.id, req.body || {}, req.user);
  audit(req, 'airgap_mirror_sync', 'airgap_mirror', req.params.id,
    { runId: result.runId, state: result.state, artifactsAdded: result.artifactsAdded,
      bytesAdded: result.bytesAdded, unsignedArtifactsAccepted: result.unsignedArtifactsAccepted || 0 });
  res.status(202).json(result);
}));
router.post('/support-bundles', writeable, route(async (req, res) => {
  const bundle = await lifecycle.collectSupportBundle(req.body || {}, req.user);
  audit(req, 'support_bundle_collect', 'support_bundle', bundle.requestId,
    { state: bundle.state, nodes: bundle.nodes.length, checksumSha256: bundle.checksumSha256,
      byteSize: bundle.byteSize, secretsReturned: bundle.secretsReturned });
  res.status(202).json({ bundle });
}));
router.post('/validation-packs', writeable, route((req, res) => {
  const pack = lifecycle.saveValidationPack(req.body || {}, req.user);
  audit(req, 'post_upgrade_validation_pack_create', 'post_upgrade_validation_pack', pack.id,
    { version: pack.version, checks: pack.checks.length, packHash: pack.packHash });
  res.status(201).json({ pack });
}));
router.post('/validation-packs/:id/run', writeable, route(async (req, res) => {
  const run = await lifecycle.runValidationPack(req.params.id, req.body || {}, req.user);
  audit(req, 'post_upgrade_validation_run', 'post_upgrade_validation_pack', run.pack.id,
    { campaignId: run.campaignId, targetRef: run.targetRef, state: run.state,
      evidenceHash: run.evidenceHash, providerMutationsStarted: run.providerMutationsStarted });
  res.status(201).json({ run });
}));

module.exports = router;
