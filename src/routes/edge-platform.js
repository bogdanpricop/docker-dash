'use strict';

const { Router } = require('express');
const edge = require('../services/edge-platform');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.post('/enrollments/redeem', writeable, route((req, res) => {
  const enrollment = edge.redeemEnrollment(req.body || {});
  auditService.log({ userId: null, username: 'edge-enrollment-device', action: 'edge_enrollment_redeem',
    targetType: 'edge_enrollment_attestation', targetId: String(enrollment.id), details: { siteId: enrollment.siteId,
      agentId: enrollment.agentId, attestationHash: enrollment.attestationHash, publicKeyFingerprint: enrollment.publicKeyFingerprint,
      enrollmentTokenReturned: false, certificatePrivateKeyReturned: false }, ip: getClientIp(req) });
  res.status(201).json({ enrollment });
}));

router.use(requireAuth, requireRole('admin'));

function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (['EdgePlatformError','InfrastructureOperationsError'].includes(error.name)) return res.status(error.status || 400)
        .json({ error: error.message, code: error.code, details: error.details });
      next(error);
    }
  };
}
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/overview', route((req, res) => res.json(edge.overview(req.user))));

router.post('/sites', writeable, route((req, res) => {
  const site = edge.saveSite(req.body || {}, req.user);
  audit(req, 'edge_site_save', 'edge_site', site.id, { slug: site.slug, region: site.region,
    jurisdiction: site.jurisdiction, hostCount: site.hosts.length, configHash: site.configHash });
  res.status(201).json({ site });
}));
router.put('/sites/:id/connectivity', writeable, route((req, res) => {
  const policy = edge.saveConnectivity(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_connectivity_policy_save', 'edge_site', req.params.id, { mode: policy.mode,
    mutationMode: policy.mutationMode, maxStalenessSeconds: policy.maxStalenessSeconds, policyHash: policy.policyHash });
  res.json({ policy });
}));
router.get('/sites/:id/cache', route((req, res) => res.json({ entries: edge.cacheEntries(req.params.id, req.user) })));
router.post('/sites/:id/cache', writeable, route((req, res) => {
  const entry = edge.recordCache(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_cache_evidence_record', 'edge_cache_entry', entry.id, { siteId: entry.siteId,
    resourceKind: entry.resourceKind, resourceRef: entry.resourceRef, payloadHash: entry.payloadHash, duplicate: entry.duplicate });
  res.status(entry.duplicate ? 200 : 201).json({ entry });
}));

router.post('/sites/:id/intents', writeable, route((req, res) => {
  const intent = edge.createIntent(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_offline_intent_queue', 'edge_offline_intent', intent.id, { siteId: intent.siteId,
    actionKey: intent.actionKey, targetRef: intent.targetRef, expiresAt: intent.expiresAt,
    intentHash: intent.intentHash, duplicate: intent.duplicate, providerMutationsStarted: 0 });
  res.status(intent.duplicate ? 200 : 201).json({ intent });
}));
router.post('/intents/:id/revalidate', writeable, route((req, res) => {
  const intent = edge.revalidateIntent(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_offline_intent_revalidate', 'edge_offline_intent', intent.id, { state: intent.state,
    intentHash: intent.intentHash, ready: intent.revalidation?.ready || false, providerMutationsStarted: 0 });
  res.json({ intent });
}));

router.post('/sites/:id/agents', writeable, route((req, res) => {
  const agent = edge.registerAgent(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_agent_profile_save', 'edge_agent', agent.id, { siteId: agent.siteId,
    agentId: agent.agentId, updateRing: agent.updateRing, state: agent.state,
    certificateFingerprint: agent.certificateFingerprint });
  res.status(201).json({ agent });
}));
router.post('/sites/:id/heartbeats', writeable, route((req, res) => {
  const heartbeat = edge.heartbeat(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_heartbeat_ingest', 'edge_site', heartbeat.siteId, { agentId: heartbeat.agentId,
    sequence: heartbeat.sequence, status: heartbeat.status, evidenceHash: heartbeat.evidenceHash,
    transport: heartbeat.transport, providerMutationsStarted: 0 });
  res.status(201).json({ heartbeat });
}));

router.put('/sites/:id/sync-policy', writeable, route((req, res) => {
  const policy = edge.saveSyncPolicy(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_sync_policy_save', 'edge_site', policy.siteId, { bandwidthKbps: policy.bandwidthKbps,
    maxBatchBytes: policy.maxBatchBytes, priorityOrder: policy.priorityOrder, policyHash: policy.policyHash });
  res.json({ policy });
}));
router.post('/sites/:id/events', writeable, route((req, res) => {
  const result = edge.bufferEvents(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_event_buffer_ingest', 'edge_site', result.siteId, { agentId: result.agentId,
    acceptedCount: result.acceptedCount, duplicateCount: result.duplicateCount, compression: result.compression,
    providerMutationsStarted: 0 });
  res.status(201).json(result);
}));
router.post('/sites/:id/sync-plans', writeable, route((req, res) => {
  const plan = edge.createSyncPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_sync_plan_create', 'edge_sync_plan', plan.id, { siteId: plan.siteId,
    firstCursor: plan.firstCursor, lastCursor: plan.lastCursor, totalBytes: plan.totalBytes,
    planHash: plan.planHash, duplicate: plan.duplicate, providerMutationsStarted: 0 });
  res.status(plan.duplicate ? 200 : 201).json({ plan });
}));
router.post('/sync-plans/:id/acknowledge', writeable, route((req, res) => {
  const plan = edge.acknowledgeSyncPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_sync_plan_acknowledge', 'edge_sync_plan', plan.id, { siteId: plan.siteId,
    firstCursor: plan.firstCursor, lastCursor: plan.lastCursor, planHash: plan.planHash, duplicate: plan.duplicate });
  res.json({ plan });
}));

router.post('/agents/:id/runbooks', writeable, route((req, res) => {
  const envelope = edge.createRunbookEnvelope(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_runbook_envelope_issue', 'edge_runbook_envelope', envelope.id, { agentRecordId: envelope.agentRecordId,
    runbookKey: envelope.runbookKey, targetRef: envelope.targetRef, expiresAt: envelope.expiresAt,
    envelopeHash: envelope.envelopeHash, duplicate: envelope.duplicate, providerMutationsStarted: 0 });
  res.status(envelope.duplicate ? 200 : 201).json({ envelope });
}));
router.post('/agents/:id/update-plans', writeable, route((req, res) => {
  const plan = edge.planAgentUpdate(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_agent_update_plan', 'edge_update_plan', plan.id, { agentRecordId: plan.agentRecordId,
    ring: plan.ring, targetVersion: plan.targetVersion, state: plan.state, planHash: plan.planHash,
    applySupported: false, providerMutationsStarted: 0 });
  res.status(plan.duplicate ? 200 : 201).json({ plan });
}));

router.post('/sites/:id/bootstrap-manifests', writeable, route((req, res) => {
  const manifest = edge.createBootstrapManifest(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_airgap_bootstrap_manifest', 'edge_bootstrap_manifest', manifest.id, { siteId: manifest.siteId,
    version: manifest.version, artifactCount: manifest.artifacts.length, state: manifest.state,
    manifestHash: manifest.manifestHash, containsPrivateKeys: false, providerMutationsStarted: 0 });
  res.status(manifest.duplicate ? 200 : 201).json({ manifest });
}));
router.post('/sites/:id/mirror-manifests', writeable, route((req, res) => {
  const manifest = edge.saveMirrorManifest(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_content_mirror_manifest', 'edge_content_mirror_manifest', manifest.id, { siteId: manifest.siteId,
    itemCount: manifest.items.length, totalBytes: manifest.totalBytes, state: manifest.state,
    manifestHash: manifest.manifestHash, syncSupported: false, providerMutationsStarted: 0 });
  res.status(manifest.duplicate ? 200 : 201).json({ manifest });
}));

router.put('/sites/:id/residency-policy', writeable, route((req, res) => {
  const policy = edge.saveResidencyPolicy(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_residency_policy_save', 'edge_site', policy.siteId, { zone: policy.zone,
    categoryRules: policy.categoryRules, failClosed: true, policyHash: policy.policyHash }); res.json({ policy });
}));
router.post('/sites/:id/residency-evaluations', writeable, route((req, res) => {
  const evaluation = edge.evaluateResidency(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_residency_evaluate', 'edge_residency_evaluation', evaluation.id, { siteId: evaluation.siteId,
    dataCategory: evaluation.dataCategory, destinationJurisdiction: evaluation.destinationJurisdiction,
    decision: evaluation.decision, policyHash: evaluation.policyHash }); res.status(evaluation.duplicate ? 200 : 201).json({ evaluation });
}));
router.put('/sites/:id/identity-cache-policy', writeable, route((req, res) => {
  const policy = edge.saveIdentityCachePolicy(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_identity_cache_policy_save', 'edge_site', policy.siteId, { issuerRef: policy.issuerRef,
    normalTtlSeconds: policy.normalTtlSeconds, emergencyTtlSeconds: policy.emergencyTtlSeconds,
    policyHash: policy.policyHash, storesBearerTokens: false }); res.json({ policy });
}));
router.post('/sites/:id/identity-grants', writeable, route((req, res) => {
  const grant = edge.issueIdentityGrant(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_identity_grant_issue', 'edge_identity_grant', grant.id, { siteId: grant.siteId, subjectRef: grant.subjectRef,
    mode: grant.mode, scopes: grant.scopes, expiresAt: grant.expiresAt, grantHash: grant.grantHash, tokenReturnedByApi: false });
  res.status(grant.duplicate ? 200 : 201).json({ grant });
}));
router.post('/identity-grants/:id/activate', writeable, route((req, res) => {
  const grant = edge.activateIdentityGrant(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_identity_grant_activate', 'edge_identity_grant', grant.id, { subjectRef: grant.subjectRef,
    mode: grant.mode, expiresAt: grant.expiresAt, grantHash: grant.grantHash, activatedBy: grant.activatedBy, tokenReturnedByApi: false });
  res.json({ grant });
}));
router.post('/sites/:id/vault-adapters', writeable, route((req, res) => {
  const adapter = edge.saveVaultAdapter(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_vault_adapter_save', 'edge_vault_adapter', adapter.id, { siteId: adapter.siteId,
    providerKind: adapter.providerKind, endpointRef: adapter.endpointRef, authMethod: adapter.authMethod,
    configHash: adapter.configHash, credentialsStoredCentrally: false }); res.status(201).json({ adapter });
}));
router.post('/vault-adapters/:id/resolution-plans', writeable, route((req, res) => {
  const plan = edge.createSecretResolutionPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_secret_resolution_plan', 'edge_secret_resolution_plan', plan.id, { adapterId: plan.adapterId,
    agentRecordId: plan.agentRecordId, purpose: plan.purpose, secretRef: plan.secretRef, planHash: plan.planHash,
    resolutionLocation: 'edge_agent', secretReturnedByApi: false }); res.status(plan.duplicate ? 200 : 201).json({ plan });
}));
router.put('/sites/:id/single-node-profile', writeable, route((req, res) => {
  const profile = edge.saveSingleNodeProfile(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_single_node_profile_save', 'edge_site', profile.siteId, { profileHash: profile.profileHash,
    requireExternalBackup: true, requireMaintenanceWindow: true, automaticUpgrade: false }); res.json({ profile });
}));
router.post('/sites/:id/single-node-assessments', writeable, route((req, res) => {
  const assessment = edge.assessSingleNode(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_single_node_assess', 'edge_single_node_assessment', assessment.id, { siteId: assessment.siteId,
    state: assessment.state, checks: assessment.checks, assessmentHash: assessment.assessmentHash, applySupported: false });
  res.status(201).json({ assessment });
}));
router.post('/sites/:id/quorum-snapshots', writeable, route((req, res) => {
  const snapshot = edge.recordQuorumSnapshot(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_quorum_snapshot_ingest', 'edge_quorum_snapshot', snapshot.id, { siteId: snapshot.siteId,
    clusterRef: snapshot.clusterRef, requiredVotes: snapshot.requiredVotes, availableVotes: snapshot.availableVotes,
    risks: snapshot.risks, state: snapshot.state, providerMutationsStarted: 0 }); res.status(snapshot.duplicate ? 200 : 201).json({ snapshot });
}));
router.put('/sites/:id/reservation-policy', writeable, route((req, res) => {
  const policy = edge.saveReservationPolicy(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_reservation_policy_save', 'edge_site', policy.siteId, { policyHash: policy.policyHash,
    maxWorkloadPercent: policy.maxWorkloadPercent, evictionFreeStoragePercent: policy.evictionFreeStoragePercent }); res.json({ policy });
}));
router.post('/sites/:id/reservation-assessments', writeable, route((req, res) => {
  const assessment = edge.assessReservations(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_reservation_assess', 'edge_reservation_assessment', assessment.id, { siteId: assessment.siteId,
    state: assessment.state, checks: assessment.checks, assessmentHash: assessment.assessmentHash, applySupported: false }); res.status(201).json({ assessment });
}));
router.put('/sites/:id/console-profile', writeable, route((req, res) => {
  const profile = edge.saveConsoleProfile(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_console_profile_save', 'edge_site', profile.siteId, { transportOrder: profile.transportOrder,
    maxBandwidthKbps: profile.maxBandwidthKbps, clipboardEnabled: false, fileTransferEnabled: false,
    profileHash: profile.profileHash, launchSupported: false }); res.json({ profile });
}));
router.post('/sites/:id/remote-hands-plans', writeable, route((req, res) => {
  const plan = edge.createRemoteHandsPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_remote_hands_plan', 'edge_remote_hands_plan', plan.id, { siteId: plan.siteId,
    targetRef: plan.targetRef, approvalId: plan.approvalId, planHash: plan.planHash, state: plan.state,
    centralExecutionSupported: false, providerMutationsStarted: 0 }); res.status(plan.duplicate ? 200 : 201).json({ plan });
}));
router.post('/remote-hands-plans/:id/authorize', writeable, route((req, res) => {
  const plan = edge.authorizeRemoteHands(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_remote_hands_authorize', 'edge_remote_hands_plan', plan.id, { approvalId: plan.approvalId,
    planHash: plan.planHash, authorizedBy: plan.authorizedBy, state: plan.state, executionLocation: plan.executionLocation,
    providerMutationsStarted: 0 }); res.json({ plan });
}));
router.post('/sites/:id/bmc-endpoints', writeable, route((req, res) => {
  const endpoint = edge.saveBmcEndpoint(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_bmc_endpoint_save', 'edge_bmc_endpoint', endpoint.id, { siteId: endpoint.siteId,
    hostId: endpoint.hostId, protocol: endpoint.protocol, endpointRef: endpoint.endpointRef, owner: endpoint.owner,
    configHash: endpoint.configHash, credentialsStoredCentrally: false }); res.status(201).json({ endpoint });
}));
router.post('/bmc-endpoints/:id/inventory', writeable, route((req, res) => {
  const inventory = edge.recordBmcInventory(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_bmc_inventory_ingest', 'edge_bmc_inventory', inventory.id, { endpointId: inventory.endpointId,
    powerState: inventory.powerState, health: inventory.health, evidenceHash: inventory.evidenceHash,
    collectionLocation: 'edge_agent', credentialsReturned: false }); res.status(inventory.duplicate ? 200 : 201).json({ inventory });
}));
router.post('/bmc-endpoints/:id/recovery-plans', writeable, route((req, res) => {
  const plan = edge.createBmcRecoveryPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_bmc_recovery_plan', 'edge_bmc_recovery_plan', plan.id, { endpointId: plan.endpointId,
    actionKey: plan.actionKey, safeguards: plan.safeguards, approvalId: plan.approvalId, state: plan.state,
    planHash: plan.planHash, centralBmcExecutionSupported: false, providerMutationsStarted: 0 }); res.status(plan.duplicate ? 200 : 201).json({ plan });
}));
router.post('/bmc-recovery-plans/:id/authorize', writeable, route((req, res) => {
  const plan = edge.authorizeBmcRecovery(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_bmc_recovery_authorize', 'edge_bmc_recovery_plan', plan.id, { approvalId: plan.approvalId,
    actionKey: plan.actionKey, planHash: plan.planHash, authorizedBy: plan.authorizedBy, state: plan.state,
    executionLocation: 'edge_agent', providerMutationsStarted: 0 }); res.json({ plan });
}));

router.post('/sites/:id/disasters', writeable, route((req, res) => {
  const declaration = edge.declareDisaster(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_disaster_declare', 'edge_disaster_declaration', declaration.id, { siteId: declaration.siteId,
    severity: declaration.severity, ticketRef: declaration.ticketRef, runbookEnvelopeId: declaration.runbookEnvelopeId,
    declarationHash: declaration.declarationHash, mutationFreeze: true, externalNotificationDeliveryStarted: false });
  res.status(201).json({ declaration });
}));
router.post('/disasters/:id/resolve', writeable, route((req, res) => {
  const declaration = edge.resolveDisaster(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_disaster_resolve', 'edge_disaster_declaration', declaration.id, { siteId: declaration.siteId,
    declarationHash: declaration.declarationHash, resolutionEvidenceHash: declaration.resolutionEvidenceHash,
    resolvedBy: declaration.resolvedBy, mutationFreeze: false }); res.json({ declaration });
}));
router.post('/sites/:id/backup-seeds', writeable, route((req, res) => {
  const seed = edge.createBackupSeed(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_backup_seed_manifest', 'edge_backup_seed', seed.id, { siteId: seed.siteId, datasetRef: seed.datasetRef,
    chunkCount: seed.chunks.length, totalBytes: seed.totalBytes, state: seed.state, manifestHash: seed.manifestHash,
    transferStarted: false }); res.status(seed.duplicate ? 200 : 201).json({ seed });
}));
router.post('/backup-seeds/:id/checkpoints', writeable, route((req, res) => {
  const checkpoint = edge.recordBackupSeedCheckpoint(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_backup_seed_checkpoint', 'edge_backup_seed_checkpoint', checkpoint.id, { seedId: checkpoint.seedId,
    sequence: checkpoint.sequence, completedChunk: checkpoint.completedChunk, transferredBytes: checkpoint.transferredBytes,
    checkpointHash: checkpoint.checkpointHash, state: checkpoint.state, transferPerformedByApi: false }); res.status(201).json({ checkpoint });
}));
router.put('/sites/:id/compliance-profile', writeable, route((req, res) => {
  const profile = edge.saveComplianceProfile(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_compliance_profile_save', 'edge_site', profile.siteId, { requiredControls: profile.requiredControls,
    maximumUnknown: profile.maximumUnknown, profileHash: profile.profileHash, exportsSensitiveEvidence: false }); res.json({ profile });
}));
router.post('/sites/:id/compliance-snapshots', writeable, route((req, res) => {
  const snapshot = edge.recordComplianceSnapshot(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_compliance_snapshot_ingest', 'edge_compliance_snapshot', snapshot.id, { siteId: snapshot.siteId,
    posture: snapshot.posture, passedCount: snapshot.passedCount, failedCount: snapshot.failedCount,
    unknownCount: snapshot.unknownCount, snapshotHash: snapshot.snapshotHash, sensitiveDetailsWithheld: true });
  res.status(snapshot.duplicate ? 200 : 201).json({ snapshot });
}));
router.get('/fleet-compliance', route((req, res) => res.json(edge.fleetCompliance(req.user))));
router.post('/sites/:id/fault-domains', writeable, route((req, res) => {
  const domain = edge.saveFaultDomain(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_fault_domain_save', 'edge_fault_domain', domain.id, { siteId: domain.siteId, domainType: domain.domainType,
    domainKey: domain.domainKey, hostCount: domain.hostIds.length, domainHash: domain.domainHash }); res.status(201).json({ domain });
}));
router.post('/sites/:id/fault-domain-assessments', writeable, route((req, res) => {
  const assessment = edge.assessFaultDomains(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_fault_domain_assess', 'edge_fault_domain_assessment', assessment.id, { siteId: assessment.siteId,
    workloadRef: assessment.workloadRef, requiredReplicas: assessment.requiredReplicas, risks: assessment.risks,
    state: assessment.state, assessmentHash: assessment.assessmentHash, placementMutationStarted: false });
  res.status(assessment.duplicate ? 200 : 201).json({ assessment });
}));
router.post('/sites/:id/enrollment-tokens', writeable, route((req, res) => {
  const enrollment = edge.createEnrollmentToken(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_enrollment_token_issue', 'edge_enrollment_token', enrollment.id, { siteId: enrollment.siteId,
    tokenFingerprint: enrollment.tokenFingerprint, expiresAt: enrollment.expiresAt, expectedHardware: enrollment.expectedHardware,
    tokenReturnedOnce: true, privateKeyGenerated: false }); res.status(201).json({ enrollment });
}));
router.post('/enrollments/:id/approve', writeable, route((req, res) => {
  const enrollment = edge.approveEnrollment(req.params.id, req.body || {}, req.user);
  audit(req, 'edge_enrollment_approve', 'edge_enrollment_attestation', enrollment.id, { siteId: enrollment.siteId,
    agentId: enrollment.agentId, edgeAgentId: enrollment.edgeAgentId, certificateFingerprint: enrollment.certificateFingerprint,
    identityHash: enrollment.identityHash, approvedBy: enrollment.approvedBy, certificatePrivateKeyReturned: false }); res.json({ enrollment });
}));

module.exports = router;
