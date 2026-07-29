'use strict';

const { Router } = require('express');
const edge = require('../services/edge-platform');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();
router.use(requireAuth, requireRole('admin'));

function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (error.name === 'EdgePlatformError') return res.status(error.status || 400)
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

module.exports = router;
