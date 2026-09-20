'use strict';

const { Router } = require('express');
const config = require('../config');
const fleet = require('../services/workstation-fleet');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.use(requireAuth, requireRole('admin'));
router.use((req, res, next) => config.features.workstationFleet ? next()
  : res.status(404).json({ error: 'Workstation fleet is disabled', code: 'WORKSTATION_FLEET_DISABLED' }));

function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (['WorkstationFleetError', 'ForemanClientError'].includes(error.name)) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
      next(error);
    }
  };
}

function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req), userAgent: req.headers['user-agent'] });
}

router.get('/overview', route((req, res) => res.json(fleet.overview(req.user))));
router.get('/devices', route((req, res) => res.json({ devices: fleet.devices(req.query || {}, req.user) })));
router.get('/connections', route((req, res) => res.json({ connections: fleet.connections(req.user) })));
router.get('/mappings', route((req, res) => res.json({ mappings: fleet.mappings(req.user) })));
router.get('/artifacts', route((req, res) => res.json({ artifacts: fleet.artifacts(req.user) })));
router.get('/artifacts/:id/promotions', route((req, res) => res.json(fleet.artifactPromotions(req.params.id, req.query || {}, req.user))));
router.get('/plans', route((req, res) => res.json({ plans: fleet.plans(req.user) })));
router.get('/plans/:id/preflight', route((req, res) => {
  const result = fleet.planPreflight(req.params.id, req.user);
  audit(req, 'workstation_bootc_plan_preflight', 'workstation_update_plan', result.plan.id, {
    ready: result.ready, blockerCodes: result.blockers.map(item => item.code),
    networkCallsStarted: 0, credentialsReturned: false });
  res.json(result);
}));

router.post('/connections', writeable, route((req, res) => {
  const connection = fleet.saveConnection(req.body || {}, req.user);
  audit(req, 'workstation_foreman_connection_save', 'workstation_connector', connection.id, {
    name: connection.name, baseUrl: connection.baseUrl, authType: connection.authType,
    tlsVerify: connection.tlsVerify, hasCustomCa: connection.hasCustomCa, hasSecret: connection.hasSecret,
    secretReturned: false });
  res.status(201).json({ connection });
}));

router.put('/connections/:id', writeable, route((req, res) => {
  const connection = fleet.saveConnection({ ...(req.body || {}), id: req.params.id }, req.user);
  audit(req, 'workstation_foreman_connection_save', 'workstation_connector', connection.id, {
    name: connection.name, baseUrl: connection.baseUrl, authType: connection.authType,
    tlsVerify: connection.tlsVerify, enabled: connection.enabled, secretReturned: false });
  res.json({ connection });
}));

router.delete('/connections/:id', writeable, route((req, res) => {
  const result = fleet.removeConnection(req.params.id, req.user);
  audit(req, 'workstation_foreman_connection_delete', 'workstation_connector', result.id, {
    cascadedInventory: true, cascadedTerminalWorkflowHistory: true, activeWorkflowsBlocked: true });
  res.json(result);
}));

router.post('/connections/:id/test', route(async (req, res) => {
  const result = await fleet.testConnection(req.params.id, req.user);
  audit(req, 'workstation_foreman_connection_test', 'workstation_connector', req.params.id, {
    ok: result.ok, status: result.status, version: result.version, credentialsReturned: false });
  res.json(result);
}));

router.post('/connections/:id/sync', writeable, route(async (req, res) => {
  const result = await fleet.syncConnection(req.params.id, req.user);
  audit(req, 'workstation_foreman_inventory_sync', 'workstation_sync_run', result.run.id, {
    connectionId: result.run.connectionId, state: result.run.state, counts: result.run.counts,
    sourceHash: result.run.sourceHash, warnings: result.warnings, externalMutationCount: 0,
    credentialsReturned: false, rawResponseStored: false });
  res.status(201).json(result);
}));

router.put('/connections/:id/mappings', writeable, route((req, res) => {
  const mapping = fleet.saveMapping(req.params.id, req.body || {}, req.user);
  audit(req, 'workstation_foreman_mapping_save', 'workstation_connector', req.params.id, {
    mappingId: mapping.id, sourceKind: mapping.sourceKind, sourceRef: mapping.sourceRef,
    edgeSiteId: mapping.edgeSiteId, scopeRef: mapping.scopeRef });
  res.json({ mapping });
}));

router.delete('/mappings/:id', writeable, route((req, res) => {
  const result = fleet.removeMapping(req.params.id, req.user);
  audit(req, 'workstation_foreman_mapping_delete', 'workstation_connector', result.connectionId, {
    mappingId: result.id, inventoryRemapped: true });
  res.json(result);
}));

router.post('/artifacts/inspect', writeable, route(async (req, res) => {
  const artifact = await fleet.inspectRegistryArtifact(req.body || {}, req.user);
  audit(req, 'workstation_bootc_artifact_inspect', 'bootc_artifact', artifact.id, {
    registryId: artifact.registryId, repository: artifact.repository, digest: artifact.digest,
    bootcDetected: artifact.bootcDetected, signaturePolicy: artifact.signaturePolicy,
    signatureState: artifact.signatureState, sbomRefCount: artifact.sbomRefs.length,
    channel: artifact.channel, registryMutationCount: 0 });
  res.status(201).json({ artifact });
}));

router.post('/artifacts/:id/promote', writeable, route((req, res) => {
  const artifact = fleet.promoteArtifact(req.params.id, req.body || {}, req.user);
  audit(req, 'workstation_bootc_artifact_promote', 'bootc_artifact', artifact.id, {
    digest: artifact.digest, channel: artifact.channel,
    promotionEvidenceHash: artifact.promotionEvidenceHash, registryMutationCount: 0 });
  res.json({ artifact });
}));

router.post('/devices/:id/plans', writeable, route((req, res) => {
  const plan = fleet.createUpdatePlan(req.params.id, req.body || {}, req.user);
  audit(req, 'workstation_bootc_plan_create', 'workstation_update_plan', plan.id, {
    deviceId: plan.deviceId, artifactId: plan.artifactId, action: plan.action,
    targetImageRef: plan.targetImageRef, targetDigest: plan.targetDigest, previousDigest: plan.previousDigest, channel: plan.channel,
    remoteJobTemplateId: plan.remoteJobTemplateId, maintenanceWindowRef: plan.maintenanceWindowRef,
    approvalRef: plan.approvalRef, planHash: plan.planHash, duplicate: plan.duplicate,
    externalMutationCount: 0 });
  res.status(plan.duplicate ? 200 : 201).json({ plan });
}));

router.post('/plans/:id/cancel', writeable, route((req, res) => {
  const plan = fleet.cancelPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'workstation_bootc_plan_cancel', 'workstation_update_plan', plan.id, {
    deviceId: plan.deviceId, action: plan.action, state: plan.state,
    reason: plan.errorMessage, duplicate: plan.duplicate, externalMutationCount: 0 });
  res.json({ plan });
}));

router.post('/plans/:id/execute', writeable, route(async (req, res) => {
  const plan = await fleet.executePlan(req.params.id, req.body || {}, req.user);
  audit(req, 'workstation_bootc_plan_execute', 'workstation_update_plan', plan.id, {
    deviceId: plan.deviceId, action: plan.action, targetImageRef: plan.targetImageRef, targetDigest: plan.targetDigest,
    channel: plan.channel, taskRef: plan.taskRef, state: plan.state, planHash: plan.planHash,
    approvalRef: plan.approvalRef, maintenanceWindowRef: plan.maintenanceWindowRef,
    credentialsReturned: false, remoteOutputStored: false });
  res.json({ plan });
}));

router.post('/plans/:id/reconcile', writeable, route(async (req, res) => {
  const plan = await fleet.reconcilePlan(req.params.id, req.user);
  audit(req, 'workstation_bootc_plan_reconcile', 'workstation_update_plan', plan.id, {
    deviceId: plan.deviceId, action: plan.action, targetDigest: plan.targetDigest,
    postReadDigest: plan.postReadDigest, state: plan.state,
    postReadVerified: plan.postReadVerified === true, remoteOutputStored: false });
  res.json({ plan });
}));

module.exports = router;
