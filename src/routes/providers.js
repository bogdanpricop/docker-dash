'use strict';

const { Router } = require('express');
const config = require('../config');
const { getDb } = require('../db');
const providerSdk = require('../services/provider-sdk/registry');
const providerVmDetail = require('../services/provider-sdk/vm-detail');
const providerVmMigrationPreflight = require('../services/provider-sdk/vm-migration-preflight');
const providerVmMigration = require('../services/provider-operations/vm-migration');
const providerHostMaintenance = require('../services/provider-operations/host-maintenance');
const providerHaReadiness = require('../services/provider-sdk/ha-readiness');
const providerStoragePosture = require('../services/provider-sdk/storage-posture');
const providerPlacementAdvisory = require('../services/provider-sdk/placement-advisory');
const providerPlacementChanges = require('../services/provider-operations/placement-changes');
const providerVmPower = require('../services/provider-operations/vm-power');
const providerVmSnapshots = require('../services/provider-operations/vm-snapshots');
const providerVmSnapshotPolicies = require('../services/provider-operations/snapshot-policies');
const providerBackupPolicies = require('../services/provider-operations/backup-policies');
const providerBackupExecutions = require('../services/provider-operations/backup-executions');
const providerRecoveryRestore = require('../services/provider-operations/recovery-restore');
const providerRestoreDrills = require('../services/provider-operations/restore-drills');
const providerDrRunbooks = require('../services/provider-operations/dr-runbooks');
const providerVmDisks = require('../services/provider-operations/vm-disks');
const providerConsole = require('../services/provider-console/broker');
const providerVmProvision = require('../services/provider-operations/vm-provision');
const conformance = require('../services/provider-conformance');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { requireHostAccess } = require('../middleware/hostAccess');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.use((req, res, next) => config.features.providerSdkV2
  ? next() : res.status(404).json({ error: 'Provider SDK v2 is disabled' }));

function _isAdmin(user) {
  return user?.role === 'admin' || (Array.isArray(user?.roles) && user.roles.includes('admin'));
}

function _host(hostId) {
  const id = Number.parseInt(hostId, 10);
  if (!Number.isInteger(id) || id <= 0) return { error: { status: 400, message: 'Invalid provider host ID' } };
  const host = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(id);
  if (!host) return { error: { status: 404, message: 'Provider host not found' } };
  if (!host.is_active) return { error: { status: 400, message: `Provider host "${host.name}" is not active` } };
  return { host };
}

function _conformanceError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider conformance request failed' : err.message,
    code: err?.code || 'PROVIDER_CONFORMANCE_ERROR',
  });
}

function _powerError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM power request failed' : err.message,
    code: err?.code || 'VM_POWER_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _snapshotError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM snapshot request failed' : err.message,
    code: err?.code || 'VM_SNAPSHOT_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _diskError(res, err) {
  const trusted = err?.name === 'VmDiskError'
    && /^(?:VM_DISK_|MANAGED_VOLUME_|PROVIDER_|INVALID_|UNSTABLE_|TARGET_|CAPABILITY_|OPERATION_|POLICY_|PERMISSION_|DELETE_|VERIFIED_)[A-Z0-9_]{0,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM disk request failed' : err.message,
    code: trusted ? err.code : 'VM_DISK_ERROR',
    ...(trusted && status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _diskAudit(req, action, plan, operation = null) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_vm_disk_${action}`, targetType: plan.managedVolume ? 'managed_volume' : 'virtualMachine',
    targetId: plan.managedVolume?.id || plan.vm.id,
    details: {
      hostId: Number(req.params.hostId), provider: plan.providerType, vmId: plan.vm.id,
      diskId: plan.disk?.id || null, managedVolumeId: plan.managedVolume?.id || null,
      operationId: operation?.id || null, planHash: plan.planHash,
      targetStorageId: plan.storage?.id || null, sizeBytes: plan.request?.sizeBytes || null,
      retainBacking: plan.action === 'detach', permanentDelete: plan.action === 'delete',
      allowed: plan.allowed,
    }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _snapshotPolicyError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM snapshot policy request failed' : err.message,
    code: err?.code || 'VM_SNAPSHOT_POLICY_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _backupPolicyError(res, err) {
  const trusted = err?.name === 'BackupPolicyError'
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider backup policy request failed' : err.message,
    code: trusted ? err.code : 'PROVIDER_BACKUP_POLICY_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _backupPolicyAudit(req, action, policy, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_backup_policy_${action}`, targetType: 'provider_host',
    targetId: String(req.params.hostId), details: {
      hostId: Number(req.params.hostId), policyId: policy?.id || req.params.policyId || null,
      repositoryId: policy?.repositoryId || req.body?.repositoryId || null,
      mode: policy?.mode || 'plan_only', executionAuthorized: false, ...details,
    }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _backupExecutionError(res, err) {
  const trusted = err?.name === 'BackupExecutionError'
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider backup execution request failed' : err.message,
    code: trusted ? err.code : 'PROVIDER_BACKUP_EXECUTION_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _backupExecutionAudit(req, action, policy, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_backup_execution_${action}`, targetType: 'provider_host',
    targetId: String(req.params.hostId), details: {
      hostId: Number(req.params.hostId), policyId: policy?.id || req.params.policyId || null,
      executionMode: policy?.execution?.mode || null, retentionMutationAuthorized: false, ...details,
    }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _recoveryRestoreError(res, err) {
  const trusted = err?.name === 'RecoveryRestoreError'
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider recovery restore request failed' : err.message,
    code: trusted ? err.code : 'PROVIDER_RECOVERY_RESTORE_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _recoveryRestoreAudit(req, action, plan, operation) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_recovery_restore_${action}`, targetType: 'recovery_point',
    targetId: req.params.pointId, details: {
      hostId: Number(req.params.hostId), kind: plan.kind,
      recoveryPointId: plan.source?.recoveryPointId || req.params.pointId,
      targetNodeId: plan.target?.nodeId || null, targetStorageId: plan.target?.storageId || null,
      targetVmid: plan.target?.vmid || null, operationId: operation?.id || null,
      allowed: plan.allowed, verificationOverride: plan.verificationOverride?.requested === true,
      overwrite: false, startAfterRestore: false, automaticCleanupAuthorized: false,
    }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _restoreDrillError(res, err) {
  const trusted = err?.name === 'RestoreDrillError'
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider restore-drill request failed' : err.message,
    code: trusted ? err.code : 'PROVIDER_RESTORE_DRILL_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _drRunbookError(res, err) {
  const trusted = err?.name === 'DrRunbookError'
    && /^(?:DR_|INVALID_|PROVIDER_|OPERATION_)[A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider DR runbook request failed' : err.message,
    code: trusted ? err.code : 'DR_RUNBOOK_ERROR',
    ...(trusted && status < 500 && err.details ? { details: err.details } : {}),
  });
}

function _requireDrRunbooks() {
  if (!config.features.providerDrRunbooks) throw new providerDrRunbooks.DrRunbookError(
    'DR runbooks are disabled by release policy', 'DR_RUNBOOKS_DISABLED', 404);
}

function _drRunbookAudit(req, action, targetId, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_dr_${action}`, targetType: 'dr_protection_group', targetId,
    details: { hostId: Number(req.params.hostId), ...details },
    ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _restoreDrillAudit(req, action, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_restore_drill_${action}`,
    targetType: details.recoveryPointId ? 'recovery_point' : 'provider_host',
    targetId: details.recoveryPointId || String(req.params.hostId),
    details: {
      hostId: Number(req.params.hostId), allNicsDisconnectedBeforeBoot: true,
      arbitraryGuestCommandsAuthorized: false, ...details,
    }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _provisionError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM provisioning request failed' : err.message,
    code: err?.code || 'VM_PROVISION_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _migrationPreflightError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM migration preflight failed' : err.message,
    code: err?.code || 'VM_MIGRATION_PREFLIGHT_ERROR',
  });
}

function _migrationError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM migration request failed' : err.message,
    code: err?.code || 'VM_MIGRATION_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _maintenanceError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider host maintenance request failed' : err.message,
    code: err?.code || 'HOST_MAINTENANCE_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _haReadinessError(res, err) {
  const trusted = err?.name === 'HaReadinessError'
    && /^(?:HA_|INVALID_)[A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider HA readiness request failed' : err.message,
    code: trusted ? err.code : 'HA_READINESS_ERROR',
  });
}

function _placementError(res, err) {
  const trusted = ['PlacementAdvisoryError', 'MigrationPreflightError', 'ProviderAdapterError'].includes(err?.name)
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider placement advisory request failed' : err.message,
    code: trusted ? err.code : 'PLACEMENT_ADVISORY_ERROR',
  });
}

function _placementChangeError(res, err) {
  const trusted = err?.name === 'PlacementChangeError'
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider placement change request failed' : err.message,
    code: trusted ? err.code : 'PLACEMENT_CHANGE_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _placementChangeAudit(req, action, change, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_placement_change_${action}`, targetType: 'provider_host',
    targetId: String(req.params.hostId),
    details: { hostId: Number(req.params.hostId), changeId: change?.id || null,
      changeKind: change?.changeKind || req.body?.changeKind || null,
      state: change?.state || null, planHash: change?.planHash || details.planHash || null,
      operationId: change?.operationId || details.operationId || null, ...details },
    ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _maintenanceAudit(req, action, run, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_host_maintenance_${action}`, targetType: 'provider_host',
    targetId: run?.sourceHost?.id || String(req.params.hostId),
    details: {
      hostId: Number(req.params.hostId), runId: run?.id || null,
      provider: run?.provider?.type || null, goal: run?.goal || req.body?.goal || null,
      state: run?.state || null, ...details,
    }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

router.get('/manifests', requireAuth, (_req, res) => {
  res.json({ schemaVersion: '1.0', manifests: conformance.manifests.listManifests() });
});

router.get('/scorecard', requireAuth, (_req, res) => {
  res.json({ schemaVersion: '1.0', providers: conformance.scorecard() });
});

router.get('/conformance/export', requireAuth, requireRole('admin'), (req, res) => {
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  try { res.json(conformance.exportEvidence(undefined, { limit })); }
  catch (err) { _conformanceError(res, err); }
});

router.get('/:hostId/conformance', requireAuth, requireHostAccess('view', { param: 'hostId' }), (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  try {
    const items = conformance.listForHost(resolved.host.id, { limit });
    res.json({ schemaVersion: '1.0', count: items.length, items });
  } catch (err) { _conformanceError(res, err); }
});

router.get('/:hostId/conformance/:runId', requireAuth, requireHostAccess('view', { param: 'hostId' }), (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  const run = conformance.get(req.params.runId);
  if (!run || run.hostId !== resolved.host.id) return res.status(404).json({ error: 'Provider conformance run not found' });
  res.json(run);
});

router.post('/:hostId/conformance', requireAuth, requireRole('admin'), requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  if (req.body?.mode !== undefined && req.body.mode !== 'live_readonly') {
    return res.status(400).json({ error: 'Only live_readonly conformance is available', code: 'INVALID_CONFORMANCE_MODE' });
  }
  try {
    const run = await conformance.runForHost(resolved.host, { createdBy: req.user.id });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'provider_conformance_run', targetType: 'host', targetId: String(resolved.host.id),
      details: { runId: run.id, provider: run.providerType, mode: run.mode, grade: run.grade, score: run.score, maxScore: run.maxScore, evidenceHash: run.evidenceHash },
      ip: getClientIp(req),
    });
    res.status(201).json(run);
  } catch (err) { _conformanceError(res, err); }
}));

router.get('/:hostId/capabilities', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  if (!config.features.providerSdkV2) return res.status(404).json({ error: 'Provider SDK v2 is disabled' });
  const hostId = Number.parseInt(req.params.hostId, 10);
  if (!Number.isInteger(hostId) || hostId <= 0) return res.status(400).json({ error: 'Invalid provider host ID' });
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  if (refresh && !_isAdmin(req.user)) {
    return res.status(403).json({ error: 'Capability refresh requires admin role' });
  }
  const host = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Provider host not found' });
  if (!host.is_active) return res.status(400).json({ error: `Provider host "${host.name}" is not active` });
  try {
    const envelope = await providerSdk.capabilitiesForHost(host, { refresh });
    if (refresh) {
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_capability_refresh', targetType: 'host', targetId: String(hostId),
        details: {
          provider: host.daemon_type, status: envelope.probe.status,
          durationMs: envelope.probe.durationMs,
        },
        ip: getClientIp(req),
      });
    }
    res.json(envelope);
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: status >= 500 ? 'Provider capability discovery failed' : err.message,
      code: err?.code || 'PROVIDER_CAPABILITY_ERROR',
    });
  }
}));

router.get('/:hostId/artifacts', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  if (req.query.limit !== undefined && !/^\d{1,3}$/.test(String(req.query.limit))) {
    return res.status(400).json({ error: 'Artifact limit must be an integer between 1 and 500', code: 'INVALID_ARTIFACT_LIMIT' });
  }
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ error: 'Artifact limit must be an integer between 1 and 500', code: 'INVALID_ARTIFACT_LIMIT' });
  }
  const query = String(req.query.q || '');
  if (query.length > 120) return res.status(400).json({ error: 'Artifact search is limited to 120 characters', code: 'INVALID_ARTIFACT_QUERY' });
  try {
    res.json(await providerSdk.artifactsForHost(resolved.host, {
      limit, kind: req.query.kind, query,
    }));
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: status >= 500 ? 'Provider artifact inventory failed' : err.message,
      code: err?.code || 'PROVIDER_ARTIFACT_ERROR',
    });
  }
}));

router.get('/:hostId/recovery-points', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  if (!config.features.providerRecoveryPointInventory) {
    return res.status(404).json({ error: 'Recovery-point inventory is disabled by release policy', code: 'RECOVERY_POINT_INVENTORY_DISABLED' });
  }
  if (req.query.limit !== undefined && !/^\d{1,3}$/.test(String(req.query.limit))) {
    return res.status(400).json({ error: 'Recovery-point limit must be an integer between 1 and 500', code: 'INVALID_RECOVERY_POINT_LIMIT' });
  }
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  const query = String(req.query.q || '');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ error: 'Recovery-point limit must be an integer between 1 and 500', code: 'INVALID_RECOVERY_POINT_LIMIT' });
  }
  if (query.length > 120) {
    return res.status(400).json({ error: 'Recovery-point search is limited to 120 characters', code: 'INVALID_RECOVERY_POINT_QUERY' });
  }
  try {
    const envelope = await providerSdk.recoveryPointsForHost(resolved.host, {
      limit, query, repositoryId: req.query.repository,
      workloadId: req.query.workload, verification: req.query.verification,
      from: req.query.from, to: req.query.to,
    });
    res.json({ ...envelope, restoreFeatureEnabled: config.features.providerRecoveryRestore,
      restoreDrillFeatureEnabled: config.features.providerRestoreDrills });
  } catch (err) {
    const trusted = err?.name === 'ProviderAdapterError'
      && /^(?:PROVIDER_|RECOVERY_|INVALID_)[A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
    const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: status >= 500 ? 'Provider recovery-point inventory failed' : err.message,
      code: trusted ? err.code : 'PROVIDER_RECOVERY_POINT_ERROR',
    });
  }
}));

router.post('/:hostId/recovery-points/:pointId/restore/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerRecoveryRestore.preflightForHost(resolved.host,
        req.params.pointId, req.body || {}, { canOperate: true });
      _recoveryRestoreAudit(req, 'preflight', plan, null);
      res.json(plan);
    } catch (err) { _recoveryRestoreError(res, err); }
  }));

router.post('/:hostId/recovery-points/:pointId/restore', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerRecoveryRestore.submitForHost(resolved.host,
        req.params.pointId, { ...(req.body || {}), idempotencyKey: req.get('Idempotency-Key') },
        { canOperate: true, createdBy: req.user.id });
      _recoveryRestoreAudit(req, result.operation.deduplicated ? 'deduplicated' : 'submitted',
        result.plan, result.operation);
      res.status(result.operation.deduplicated ? 200 : 202).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _recoveryRestoreError(res, err); }
  }));

router.post('/:hostId/recovery-points/:pointId/drill/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerRestoreDrills.preflightForHost(resolved.host,
        req.params.pointId, req.body || {}, { canOperate: true });
      _restoreDrillAudit(req, 'preflight', {
        recoveryPointId: req.params.pointId, planHash: plan.planHash,
        targetNodeId: plan.target?.nodeId || null, targetStorageId: plan.target?.storageId || null,
        targetVmid: plan.target?.vmid || null, allowed: plan.allowed,
        automaticCleanupAuthorized: plan.cleanup?.automaticCleanupAuthorized === true,
      });
      res.json(plan);
    } catch (err) { _restoreDrillError(res, err); }
  }));

router.post('/:hostId/recovery-points/:pointId/drill', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerRestoreDrills.submitForHost(resolved.host, req.params.pointId,
        { ...(req.body || {}), idempotencyKey: req.get('Idempotency-Key') },
        { canOperate: true, createdBy: req.user.id });
      _restoreDrillAudit(req, result.deduplicated ? 'deduplicated' : 'submitted', {
        recoveryPointId: req.params.pointId, runId: result.run.id,
        operationId: result.operation?.id || result.run.operationId,
        planHash: result.plan.planHash, targetNodeId: result.plan.target.nodeId,
        targetStorageId: result.plan.target.storageId, targetVmid: result.plan.target.vmid,
        automaticCleanupAuthorized: result.plan.cleanup.automaticCleanupAuthorized,
      });
      res.status(result.deduplicated ? 200 : 202).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _restoreDrillError(res, err); }
  }));

router.get('/:hostId/restore-drills', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (!config.features.providerRestoreDrills) return _restoreDrillError(res,
      new providerRestoreDrills.RestoreDrillError('Restore drills are disabled by release policy',
        'RESTORE_DRILLS_DISABLED', 404));
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return _restoreDrillError(res,
      new providerRestoreDrills.RestoreDrillError('Run limit must be an integer between 1 and 200',
        'INVALID_RESTORE_DRILL_LIMIT'));
    try {
      await providerRestoreDrills.reconcile({ hostId: resolved.host.id });
      const items = providerRestoreDrills.listRuns(resolved.host.id, {
        limit, policyId: req.query.policy || null,
      });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _restoreDrillError(res, err); }
  }));

router.get('/:hostId/restore-drills/:runId', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      await providerRestoreDrills.reconcile({ hostId: resolved.host.id });
      const run = providerRestoreDrills.getRun(resolved.host.id, req.params.runId);
      if (!run) return _restoreDrillError(res,
        new providerRestoreDrills.RestoreDrillError('Restore-drill run was not found',
          'RESTORE_DRILL_RUN_NOT_FOUND', 404));
      res.json({ schemaVersion: '1.0', run });
    } catch (err) { _restoreDrillError(res, err); }
  }));

router.get('/:hostId/restore-drill-policies', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return _restoreDrillError(res,
      new providerRestoreDrills.RestoreDrillError('Policy limit must be an integer between 1 and 200',
        'INVALID_RESTORE_DRILL_POLICY_LIMIT'));
    try {
      const items = providerRestoreDrills.listPolicies(resolved.host.id, { limit });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _restoreDrillError(res, err); }
  });

router.post('/:hostId/restore-drill-policies', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerRestoreDrills.upsertPolicyForHost(
        resolved.host, req.body || {}, { createdBy: req.user.id });
      _restoreDrillAudit(req, result.created ? 'policy_created' : 'policy_updated', {
        policyId: result.policy.id, backupPolicyId: result.policy.backupPolicyId,
        enabled: result.policy.enabled,
        automaticCleanupAuthorized: result.policy.authorization.automaticCleanup,
      });
      res.status(result.created ? 201 : 200).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _restoreDrillError(res, err); }
  }));

router.put('/:hostId/restore-drill-policies/:policyId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerRestoreDrills.upsertPolicyForHost(resolved.host,
        { ...(req.body || {}), id: req.params.policyId }, { createdBy: req.user.id });
      _restoreDrillAudit(req, 'policy_updated', { policyId: result.policy.id,
        backupPolicyId: result.policy.backupPolicyId, enabled: result.policy.enabled,
        automaticCleanupAuthorized: result.policy.authorization.automaticCleanup });
      res.json({ schemaVersion: '1.0', ...result });
    } catch (err) { _restoreDrillError(res, err); }
  }));

router.delete('/:hostId/restore-drill-policies/:policyId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const policy = providerRestoreDrills.removePolicyForHost(resolved.host.id, req.params.policyId);
      _restoreDrillAudit(req, 'policy_deleted', { policyId: policy.id,
        automaticCleanupAuthorized: false });
      res.json({ ok: true, policyId: policy.id });
    } catch (err) { _restoreDrillError(res, err); }
  });

router.get('/:hostId/dr/overview', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      res.json(await providerDrRunbooks.overviewForHost(resolved.host));
    } catch (err) { _drRunbookError(res, err); }
  }));

router.get('/:hostId/dr/replications', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      res.json(await providerDrRunbooks.listReplicationsForHost(resolved.host));
    } catch (err) { _drRunbookError(res, err); }
  }));

router.get('/:hostId/dr/protection-groups', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
      const items = providerDrRunbooks.listGroups(resolved.host.id, { limit });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _drRunbookError(res, err); }
  });

router.post('/:hostId/dr/protection-groups', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      const result = providerDrRunbooks.upsertGroup(resolved.host, req.body || {}, { createdBy: req.user.id });
      _drRunbookAudit(req, result.created ? 'group_created' : 'group_updated', result.group.id, {
        recoveryHostId: result.group.recoveryHostId, strategy: result.group.strategy,
        memberCount: result.group.members.length, enabled: result.group.enabled,
      });
      res.status(result.created ? 201 : 200).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _drRunbookError(res, err); }
  });

router.put('/:hostId/dr/protection-groups/:groupId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      const result = providerDrRunbooks.upsertGroup(resolved.host,
        { ...(req.body || {}), id: req.params.groupId }, { createdBy: req.user.id });
      _drRunbookAudit(req, 'group_updated', result.group.id, {
        recoveryHostId: result.group.recoveryHostId, strategy: result.group.strategy,
        memberCount: result.group.members.length, enabled: result.group.enabled,
      });
      res.json({ schemaVersion: '1.0', ...result });
    } catch (err) { _drRunbookError(res, err); }
  });

router.delete('/:hostId/dr/protection-groups/:groupId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      const group = providerDrRunbooks.removeGroup(resolved.host.id, req.params.groupId);
      _drRunbookAudit(req, 'group_deleted', group.id, { memberCount: group.members.length, enabled: false });
      res.json({ ok: true, groupId: group.id });
    } catch (err) { _drRunbookError(res, err); }
  });

router.post('/:hostId/dr/protection-groups/:groupId/preflight', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      const executionType = req.body?.executionType === 'rehearsal' ? 'rehearsal' : 'real';
      const plan = await providerDrRunbooks.preflightForHost(resolved.host, req.params.groupId,
        req.body || {}, { canOperate: true, executionType });
      _drRunbookAudit(req, 'preflight', plan.group.id, {
        mode: plan.mode, planHash: plan.planHash, allowed: plan.allowed,
        incidentDeclared: plan.incident?.reason ? true : undefined,
        blockerCount: plan.blockers.length, warningCount: plan.warnings.length,
      });
      res.json(plan);
    } catch (err) { _drRunbookError(res, err); }
  }));

router.post('/:hostId/dr/protection-groups/:groupId/rehearse', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      const result = await providerDrRunbooks.rehearseForHost(resolved.host, req.params.groupId,
        req.body || {}, { canOperate: true, createdBy: req.user.id });
      _drRunbookAudit(req, 'rehearsal_recorded', result.plan.group.id, {
        runId: result.run.id, mode: result.run.mode, state: result.run.state,
        incidentDeclared: result.plan.incident?.reason ? true : undefined,
        compliance: result.run.compliance, evidenceHash: result.run.evidenceHash,
      });
      res.status(201).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _drRunbookError(res, err); }
  }));

router.get('/:hostId/dr/runs', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      _requireDrRunbooks();
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      const items = providerDrRunbooks.listRuns(resolved.host.id,
        { limit, groupId: req.query.group || null });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _drRunbookError(res, err); }
  });

router.get('/:hostId/backup-policies', requireAuth, requireHostAccess('view', { param: 'hostId' }), (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  if (!config.features.providerBackupPolicies) {
    return res.status(404).json({ error: 'Provider backup policies are disabled by release policy', code: 'BACKUP_POLICIES_DISABLED' });
  }
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return res.status(400).json({ error: 'Policy limit must be an integer between 1 and 200', code: 'INVALID_BACKUP_POLICY_LIMIT' });
  }
  try {
    const items = providerBackupPolicies.listForHost(resolved.host.id, { limit });
    res.json({ schemaVersion: '1.0', count: items.length,
      executionFeatureEnabled: config.features.providerBackupExecution,
      executionAuthorized: items.some(item => item.execution?.mode && item.execution.mode !== 'disabled'), items });
  } catch (err) { _backupPolicyError(res, err); }
});

router.get('/:hostId/backup-policies/runs', requireAuth, requireHostAccess('view', { param: 'hostId' }), (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  if (!config.features.providerBackupPolicies) {
    return res.status(404).json({ error: 'Provider backup policies are disabled by release policy', code: 'BACKUP_POLICIES_DISABLED' });
  }
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return res.status(400).json({ error: 'Run limit must be an integer between 1 and 200', code: 'INVALID_BACKUP_POLICY_RUN_LIMIT' });
  }
  try {
    const items = providerBackupPolicies.listRuns(resolved.host.id, { limit, policyId: req.query.policy || null });
    res.json({ schemaVersion: '1.0', count: items.length,
      executionFeatureEnabled: config.features.providerBackupExecution,
      executionAuthorized: false, items });
  } catch (err) { _backupPolicyError(res, err); }
});

router.post('/:hostId/backup-policies/preflight', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (!config.features.providerBackupPolicies) return _backupPolicyError(res,
      new providerBackupPolicies.BackupPolicyError('Provider backup policies are disabled by release policy', 'BACKUP_POLICIES_DISABLED', 404));
    try {
      const plan = await providerBackupPolicies.preflightForHost(resolved.host, req.body || {});
      _backupPolicyAudit(req, 'preflight', null, { planHash: plan.planHash, allowed: plan.allowed,
        blockerCount: plan.summary.blockers, warningCount: plan.summary.warnings,
        selectedWorkloads: plan.summary.selectedWorkloads });
      res.json(plan);
    } catch (err) { _backupPolicyError(res, err); }
  }));

router.post('/:hostId/backup-policies', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerBackupPolicies.upsertForHost(resolved.host, req.body || {}, { createdBy: req.user.id });
      _backupPolicyAudit(req, result.created ? 'created' : 'updated', result.policy,
        { policyHash: result.policy.policyHash, enabled: result.policy.enabled, preflightAllowed: result.preflight.allowed });
      res.status(result.created ? 201 : 200).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _backupPolicyError(res, err); }
  }));

router.put('/:hostId/backup-policies/:policyId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerBackupPolicies.upsertForHost(resolved.host,
        { ...(req.body || {}), id: req.params.policyId }, { createdBy: req.user.id });
      _backupPolicyAudit(req, 'updated', result.policy,
        { policyHash: result.policy.policyHash, enabled: result.policy.enabled, preflightAllowed: result.preflight.allowed });
      res.json({ schemaVersion: '1.0', ...result });
    } catch (err) { _backupPolicyError(res, err); }
  }));

router.delete('/:hostId/backup-policies/:policyId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const policy = providerBackupPolicies.removeForHost(resolved.host.id, req.params.policyId);
      _backupPolicyAudit(req, 'deleted', policy);
      res.json({ ok: true, policyId: policy.id });
    } catch (err) { _backupPolicyError(res, err); }
  });

router.post('/:hostId/backup-policies/:policyId/plan', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const run = await providerBackupPolicies.planForHost(resolved.host, req.params.policyId,
        { createdBy: req.user.id, trigger: 'manual' });
      _backupPolicyAudit(req, 'planned', providerBackupPolicies.get(req.params.policyId),
        { runId: run.id, planHash: run.planHash, state: run.state });
      res.status(201).json({ schemaVersion: '1.0', run });
    } catch (err) { _backupPolicyError(res, err); }
  }));

router.get('/:hostId/backup-policies/executions', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (!config.features.providerBackupExecution) return _backupExecutionError(res,
      new providerBackupExecutions.BackupExecutionError('Provider backup execution is disabled by release policy', 'BACKUP_EXECUTION_DISABLED', 404));
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'Execution limit must be an integer between 1 and 200', code: 'INVALID_BACKUP_EXECUTION_LIMIT' });
    try {
      const items = providerBackupExecutions.listForHost(resolved.host.id, { limit, policyId: req.query.policy || null });
      res.json({ schemaVersion: '1.0', count: items.length, retentionMutationAuthorized: false, items });
    } catch (err) { _backupExecutionError(res, err); }
  });

router.get('/:hostId/backup-policies/executions/:executionId', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (!config.features.providerBackupExecution) return _backupExecutionError(res,
      new providerBackupExecutions.BackupExecutionError('Provider backup execution is disabled by release policy', 'BACKUP_EXECUTION_DISABLED', 404));
    const execution = providerBackupExecutions.getForHost(resolved.host.id, req.params.executionId);
    if (!execution) return _backupExecutionError(res,
      new providerBackupExecutions.BackupExecutionError('Backup execution was not found', 'BACKUP_EXECUTION_NOT_FOUND', 404));
    res.json({ schemaVersion: '1.0', execution });
  });

router.post('/:hostId/backup-policies/:policyId/execution-authorization', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const policy = providerBackupExecutions.authorizeForHost(resolved.host, req.params.policyId,
        req.body || {}, { createdBy: req.user.id });
      _backupExecutionAudit(req, policy.execution.mode === 'disabled' ? 'disabled' : 'authorized', policy);
      res.json({ schemaVersion: '1.0', policy });
    } catch (err) { _backupExecutionError(res, err); }
  });

router.post('/:hostId/backup-policies/:policyId/execute', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerBackupExecutions.createForHost(resolved.host, req.params.policyId,
        req.body || {}, { createdBy: req.user.id, idempotencyKey: req.get('Idempotency-Key') });
      _backupExecutionAudit(req, result.deduplicated ? 'deduplicated' : 'started',
        providerBackupPolicies.get(req.params.policyId), { executionId: result.execution.id,
          planRunId: result.execution.planRunId, planHash: result.execution.planHash });
      res.status(result.deduplicated ? 200 : 202).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _backupExecutionError(res, err); }
  }));

router.post('/:hostId/backup-policies/executions/:executionId/cancel', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const execution = await providerBackupExecutions.cancelForHost(resolved.host,
        req.params.executionId, req.body || {}, { createdBy: req.user.id });
      _backupExecutionAudit(req, 'cancel_requested', providerBackupPolicies.get(execution.policyId), {
        executionId: execution.id, state: execution.state,
      });
      res.status(202).json({ schemaVersion: '1.0', execution });
    } catch (err) { _backupExecutionError(res, err); }
  }));

router.post('/:hostId/artifacts/:artifactId/clone/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmProvision.preflightForHost(
        resolved.host, req.params.artifactId, req.body || {}, { canOperate: true }
      ));
    } catch (err) { _provisionError(res, err); }
  }));

router.post('/:hostId/artifacts/:artifactId/clone', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmProvision.submitForHost(resolved.host, req.params.artifactId, {
        ...req.body, idempotencyKey: req.get('Idempotency-Key'),
      }, { canOperate: true, createdBy: req.user.id });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_provision_submit', targetType: 'provider_artifact', targetId: result.plan.artifact.id,
        details: {
          provider: resolved.host.daemon_type, hostId: resolved.host.id,
          operationId: result.operation.id, targetName: result.plan.name,
          cloneMode: result.plan.mode.effective, storageId: result.plan.placement.selected.storageId,
          guestCustomization: result.plan.customization?.enabled === true,
          guestHostname: result.plan.customization?.hostname || null,
          guestNetworkMode: result.plan.customization?.network?.mode || null,
          startAfterCreate: false,
        }, ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _provisionError(res, err); }
  }));

router.post('/:hostId/virtual-machines/power/preflight', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmPower.preflightManyForHost(
        resolved.host, req.body?.resourceIds, req.body?.action, { canOperate: true }
      ));
    } catch (err) { _powerError(res, err); }
  }));

router.post('/:hostId/virtual-machines/power', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmPower.submitManyForHost(resolved.host, req.body?.resourceIds, {
        ...req.body, idempotencyKey: req.get('Idempotency-Key'),
      }, { canOperate: true, createdBy: req.user.id });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_power_bulk_submit', targetType: 'host', targetId: String(resolved.host.id),
        details: {
          provider: resolved.host.daemon_type, action: result.preflight.action,
          count: result.operations.length, operationIds: result.operations.map(operation => operation.id),
          forced: providerVmPower.ACTIONS[result.preflight.action].force,
        }, ip: getClientIp(req),
      });
      res.status(202).json({
        schemaVersion: '1.0', count: result.operations.length,
        operations: result.operations, planHashes: result.preflight.plans.map(plan => plan.planHash),
      });
    } catch (err) { _powerError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/power/preflight', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmPower.preflightForHost(
        resolved.host, req.params.resourceId, req.body?.action, { canOperate: true }
      ));
    } catch (err) { _powerError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/power', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmPower.submitForHost(resolved.host, req.params.resourceId, {
        ...req.body, idempotencyKey: req.get('Idempotency-Key'),
      }, { canOperate: true, createdBy: req.user.id });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_power_submit', targetType: 'virtualMachine', targetId: result.plan.resource.id,
        details: {
          provider: resolved.host.daemon_type, hostId: resolved.host.id,
          action: result.plan.action, operationId: result.operation.id,
          planHash: result.plan.planHash, forced: providerVmPower.ACTIONS[result.plan.action].force,
        }, ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _powerError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/console/preflight', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerConsole.preflightForHost(resolved.host, req.params.resourceId, { canOperate: true }));
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.status && err.status < 500 ? err.message : 'Provider VM console preflight failed',
        code: err.code || 'PROVIDER_CONSOLE_PREFLIGHT_ERROR',
      });
    }
  }));

router.post('/:hostId/virtual-machines/:resourceId/console', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const launch = await providerConsole.createForHost(resolved.host, req.params.resourceId, {
        canOperate: true, userId: req.user.id,
      });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_console_token_issue', targetType: 'virtualMachine',
        targetId: launch.resource.id,
        details: {
          sessionId: launch.id, hostId: resolved.host.id,
          provider: resolved.host.daemon_type, expiresAt: launch.expiresAt,
          singleUse: true, credentialIsolation: 'server-side',
        }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
      });
      res.status(201).json({
        schemaVersion: '1.0', id: launch.id, expiresAt: launch.expiresAt,
        resource: launch.resource,
        launchUrl: `/vm-console.html#${launch.token}`,
      });
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.status && err.status < 500 ? err.message : 'Provider VM console launch failed',
        code: err.code || 'PROVIDER_CONSOLE_LAUNCH_ERROR',
      });
    }
  }));

router.get('/:hostId/virtual-machines/:resourceId/disks', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(await providerVmDisks.inventoryForHost(resolved.host, req.params.resourceId)); }
    catch (err) { _diskError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/disks/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerVmDisks.preflightForHost(
        resolved.host, req.params.resourceId, 'create', req.body || {}, null, { canOperate: true }
      );
      _diskAudit(req, 'create_preflight', plan);
      res.json(plan);
    } catch (err) { _diskError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/disks', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmDisks.submitForHost(resolved.host, req.params.resourceId,
        'create', { ...req.body, idempotencyKey: req.get('Idempotency-Key') }, null,
        { canOperate: true, createdBy: req.user.id });
      _diskAudit(req, 'create_submit', result.plan, result.operation);
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _diskError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/disks/:diskId/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerVmDisks.preflightForHost(resolved.host, req.params.resourceId,
        req.body?.action, req.body || {}, req.params.diskId, { canOperate: true });
      _diskAudit(req, `${plan.action}_preflight`, plan);
      res.json(plan);
    } catch (err) { _diskError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/disks/:diskId/actions', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmDisks.submitForHost(resolved.host, req.params.resourceId,
        req.body?.action, { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        req.params.diskId, { canOperate: true, createdBy: req.user.id });
      _diskAudit(req, `${result.plan.action}_submit`, result.plan, result.operation);
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _diskError(res, err); }
  }));

router.get('/:hostId/managed-volumes', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (req.query.limit !== undefined && !/^\d{1,3}$/.test(String(req.query.limit))) {
      return res.status(400).json({ error: 'Limit must be an integer from 1 to 500', code: 'INVALID_LIMIT' });
    }
    const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: 'Limit must be an integer from 1 to 500', code: 'INVALID_LIMIT' });
    }
    const items = providerVmDisks.listManagedForHost(resolved.host.id, { limit, state: req.query.state });
    res.json({ schemaVersion: '1.0', count: items.length, items });
  });

router.post('/:hostId/managed-volumes/:volumeId/delete/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerVmDisks.preflightDeleteForHost(
        resolved.host, req.params.volumeId, req.body || {}, { canOperate: true }
      );
      _diskAudit(req, 'delete_preflight', plan);
      res.json(plan);
    } catch (err) { _diskError(res, err); }
  }));

router.delete('/:hostId/managed-volumes/:volumeId', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmDisks.submitDeleteForHost(resolved.host, req.params.volumeId,
        { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        { canOperate: true, createdBy: req.user.id });
      _diskAudit(req, 'delete_submit', result.plan, result.operation);
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _diskError(res, err); }
  }));

router.get('/:hostId/virtual-machines/:resourceId/snapshot-policy', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json({
        schemaVersion: '1.0',
        automation: {
          executeEnabled: config.features.providerVmSnapshots === true
            && config.features.providerVmSnapshotAutomation === true,
          timezone: 'UTC',
        },
        policy: providerVmSnapshotPolicies.getForVm(resolved.host.id, req.params.resourceId),
      });
    } catch (err) { _snapshotPolicyError(res, err); }
  });

router.get('/:hostId/virtual-machines/:resourceId/snapshot-policy/runs', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (req.query.limit !== undefined && !/^\d{1,3}$/.test(String(req.query.limit))) {
      return res.status(400).json({ error: 'Run limit must be an integer between 1 and 200', code: 'INVALID_RUN_LIMIT' });
    }
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'Run limit must be an integer between 1 and 200', code: 'INVALID_RUN_LIMIT' });
    }
    try {
      const items = providerVmSnapshotPolicies.listRuns(resolved.host.id, req.params.resourceId, { limit });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _snapshotPolicyError(res, err); }
  });

router.put('/:hostId/virtual-machines/:resourceId/snapshot-policy', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmSnapshotPolicies.upsertForHost(
        resolved.host, req.params.resourceId, req.body || {}, { createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: result.created ? 'provider_vm_snapshot_policy_create' : 'provider_vm_snapshot_policy_update',
        targetType: 'virtualMachine', targetId: req.params.resourceId,
        details: {
          hostId: resolved.host.id, policyId: result.policy.id,
          enabled: result.policy.enabled, mode: result.policy.mode,
          frequency: result.policy.schedule.frequency,
          retainCount: result.policy.retainCount, maxAgeDays: result.policy.maxAgeDays,
        }, ip: getClientIp(req),
      });
      res.status(result.created ? 201 : 200).json({ schemaVersion: '1.0', policy: result.policy });
    } catch (err) { _snapshotPolicyError(res, err); }
  }));

router.delete('/:hostId/virtual-machines/:resourceId/snapshot-policy', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const policy = providerVmSnapshotPolicies.removeForVm(resolved.host.id, req.params.resourceId);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_policy_delete', targetType: 'virtualMachine', targetId: req.params.resourceId,
        details: { hostId: resolved.host.id, policyId: policy.id }, ip: getClientIp(req),
      });
      res.json({ ok: true, policyId: policy.id });
    } catch (err) { _snapshotPolicyError(res, err); }
  });

router.post('/:hostId/virtual-machines/:resourceId/snapshot-policy/preview', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerVmSnapshotPolicies.previewForHost(
        resolved.host, req.params.resourceId, req.body?.draft || null
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_policy_preview', targetType: 'virtualMachine', targetId: req.params.resourceId,
        details: {
          hostId: resolved.host.id, policyId: plan.policyId,
          managedCount: plan.retention.managedCount, candidateCount: plan.retention.candidates.length,
          isBackup: false,
        }, ip: getClientIp(req),
      });
      res.json(plan);
    } catch (err) { _snapshotPolicyError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/snapshot-policy/run', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const run = await providerVmSnapshotPolicies.runForHost(resolved.host, req.params.resourceId, {
        trigger: 'manual', confirm: req.body?.confirm === true,
        confirmName: req.body?.confirmName, createdBy: req.user.id,
      });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_policy_run', targetType: 'virtualMachine', targetId: req.params.resourceId,
        details: {
          hostId: resolved.host.id, policyId: run.policyId, runId: run.id,
          state: run.state, currentOperationId: run.currentOperationId, isBackup: false,
        }, ip: getClientIp(req),
      });
      res.status(run.state === 'previewed' ? 200 : 202).json({ schemaVersion: '1.0', run });
    } catch (err) { _snapshotPolicyError(res, err); }
  }));

router.get('/:hostId/virtual-machines/:resourceId/snapshots', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(await providerVmSnapshots.inventoryForHost(resolved.host, req.params.resourceId)); }
    catch (err) { _snapshotError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/snapshots/preflight', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmSnapshots.preflightForHost(
        resolved.host, req.params.resourceId, 'create', req.body || {}, null, { canOperate: true }
      ));
    } catch (err) { _snapshotError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/snapshots', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmSnapshots.submitForHost(
        resolved.host, req.params.resourceId, 'create', { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        null, { canOperate: true, createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_create', targetType: 'virtualMachine', targetId: result.plan.vm.id,
        details: {
          provider: resolved.host.daemon_type, hostId: resolved.host.id,
          operationId: result.operation.id, snapshotName: result.plan.name,
          consistency: result.plan.consistency, isBackup: false,
        }, ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _snapshotError(res, err); }
  }));

for (const action of ['revert', 'delete']) {
  router.post(`/:hostId/virtual-machines/:resourceId/snapshots/:snapshotId/${action}/preflight`, requireAuth,
    requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
      const resolved = _host(req.params.hostId);
      if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
      try {
        res.json(await providerVmSnapshots.preflightForHost(
          resolved.host, req.params.resourceId, action, req.body || {}, req.params.snapshotId, { canOperate: true }
        ));
      } catch (err) { _snapshotError(res, err); }
    }));
}

router.post('/:hostId/virtual-machines/:resourceId/snapshots/:snapshotId/revert', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmSnapshots.submitForHost(
        resolved.host, req.params.resourceId, 'revert', { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        req.params.snapshotId, { canOperate: true, createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_revert', targetType: 'provider_snapshot', targetId: result.plan.snapshot.id,
        details: { provider: resolved.host.daemon_type, hostId: resolved.host.id, vmId: result.plan.vm.id, operationId: result.operation.id },
        ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _snapshotError(res, err); }
  }));

router.delete('/:hostId/virtual-machines/:resourceId/snapshots/:snapshotId', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmSnapshots.submitForHost(
        resolved.host, req.params.resourceId, 'delete', { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        req.params.snapshotId, { canOperate: true, createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_delete', targetType: 'provider_snapshot', targetId: result.plan.snapshot.id,
        details: { provider: resolved.host.daemon_type, hostId: resolved.host.id, vmId: result.plan.vm.id, operationId: result.operation.id },
        ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _snapshotError(res, err); }
  }));

router.get('/:hostId/virtual-machines/:resourceId/migration-preflight', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmMigrationPreflight.preflightForHost(resolved.host, req.params.resourceId));
    } catch (err) { _migrationPreflightError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/migration/preflight', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }),
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmMigration.preflightForHost(
        resolved.host, req.params.resourceId, req.body, { canOperate: true }
      ));
    } catch (err) { _migrationError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/migration', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmMigration.submitForHost(
        resolved.host, req.params.resourceId,
        { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        { canOperate: true, createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_migrate', targetType: 'virtualMachine', targetId: result.plan.vm.id,
        details: {
          provider: resolved.host.daemon_type, hostId: resolved.host.id,
          targetId: result.plan.target.id, targetStorageId: result.plan.targetStorage?.id || null,
          mode: result.plan.mode, operationId: result.operation.id,
        },
        ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _migrationError(res, err); }
  }));

router.post('/:hostId/host-maintenance/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }),
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerHostMaintenance.preflightForHost(
        resolved.host, req.body || {}, { canOperate: true }
      );
      _maintenanceAudit(req, 'preflight', null, {
        sourceHostId: plan.sourceHost.id, goal: plan.goal, waveSize: plan.waveSize,
        itemCount: plan.itemCount, deferredCount: plan.deferredCount, allowed: plan.allowed,
      });
      res.json(plan);
    } catch (err) { _maintenanceError(res, err); }
  }));

router.post('/:hostId/host-maintenance/runs', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerHostMaintenance.submitForHost(resolved.host, {
        ...(req.body || {}), idempotencyKey: req.get('Idempotency-Key'),
      }, { canOperate: true, createdBy: req.user.id });
      _maintenanceAudit(req, result.deduplicated ? 'deduplicated' : 'start', result.run, {
        waveSize: result.run.waveSize, itemCount: result.run.items.length,
        deferredCount: result.run.counts.deferred,
      });
      res.status(result.deduplicated ? 200 : 202).json({ schemaVersion: '1.0', run: result.run, plan: result.plan });
    } catch (err) { _maintenanceError(res, err); }
  }));

router.get('/:hostId/host-maintenance/runs', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'Limit must be an integer between 1 and 200', code: 'INVALID_RUN_LIMIT' });
    }
    try {
      const items = providerHostMaintenance.listForHost(resolved.host.id, { limit });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _maintenanceError(res, err); }
  });

router.get('/:hostId/host-maintenance/runs/:runId', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    const run = providerHostMaintenance.get(req.params.runId);
    if (!run || run.provider.endpointId !== resolved.host.id) {
      return res.status(404).json({ error: 'Host maintenance run not found', code: 'HOST_MAINTENANCE_RUN_NOT_FOUND' });
    }
    res.json(run);
  });

for (const action of ['pause', 'resume', 'cancel', 'exit', 'reconcile']) {
  router.post(`/:hostId/host-maintenance/runs/:runId/${action}`, requireAuth,
    requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
    asyncHandler(async (req, res) => {
      const resolved = _host(req.params.hostId);
      if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
      const current = providerHostMaintenance.get(req.params.runId);
      if (!current || current.provider.endpointId !== resolved.host.id) {
        return res.status(404).json({ error: 'Host maintenance run not found', code: 'HOST_MAINTENANCE_RUN_NOT_FOUND' });
      }
      try {
        const method = action === 'reconcile' ? 'reconcileUnknown' : action;
        const run = await providerHostMaintenance[method](current.id, { createdBy: req.user.id });
        _maintenanceAudit(req, action, run, { previousState: current.state });
        res.status(['cancel', 'exit'].includes(action) && !['cancelled', 'completed'].includes(run.state) ? 202 : 200)
          .json({ schemaVersion: '1.0', run });
      } catch (err) { _maintenanceError(res, err); }
    }));
}

router.get('/:hostId/ha/readiness', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const snapshot = await providerHaReadiness.getForHost(resolved.host);
      res.json(snapshot);
    } catch (err) { _haReadinessError(res, err); }
  }));

router.post('/:hostId/ha/readiness/refresh', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }),
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const snapshot = await providerHaReadiness.getForHost(resolved.host, { refresh: true });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_ha_readiness_refresh', targetType: 'provider_host', targetId: String(resolved.host.id),
        details: { hostId: resolved.host.id, provider: resolved.host.daemon_type, state: snapshot.state, score: snapshot.score },
        ip: getClientIp(req), userAgent: req.headers['user-agent'],
      });
      res.json(snapshot);
    } catch (err) { _haReadinessError(res, err); }
  }));

router.get('/:hostId/ha/readiness/history', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (!config.features.providerHaReadiness) {
      return res.status(404).json({ error: 'HA readiness is disabled by release policy', code: 'HA_READINESS_DISABLED' });
    }
    try {
      const items = providerHaReadiness.historyForHost(resolved.host.id, { limit: req.query.limit === undefined ? 48 : Number(req.query.limit) });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _haReadinessError(res, err); }
  });

router.get('/:hostId/placement/affinity', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(await providerPlacementAdvisory.affinityForHost(resolved.host)); }
    catch (err) { _placementError(res, err); }
  }));

router.get('/:hostId/virtual-machines/:resourceId/placement/recommendations', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(await providerPlacementAdvisory.recommendForVm(resolved.host, req.params.resourceId)); }
    catch (err) { _placementError(res, err); }
  }));

router.post('/:hostId/placement/rebalance/plan', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerPlacementAdvisory.rebalancePlanForHost(resolved.host, req.body || {});
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_placement_rebalance_plan', targetType: 'provider_host', targetId: String(resolved.host.id),
        details: {
          hostId: resolved.host.id, provider: resolved.host.daemon_type,
          moveCount: plan.moves.length, skippedCount: plan.skipped.length,
          planHash: plan.planHash, expiresAt: plan.expiresAt,
        },
        ip: getClientIp(req), userAgent: req.headers['user-agent'],
      });
      res.json(plan);
    } catch (err) { _placementError(res, err); }
  }));

router.post('/:hostId/placement/changes/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerPlacementChanges.preflightForHost(resolved.host, req.body || {}, { canOperate: true });
      _placementChangeAudit(req, 'preflight', null, { changeKind: plan.changeKind, planHash: plan.planHash,
        allowed: plan.allowed, diffCount: plan.diff.length, moveCount: plan.moves?.length || 0 });
      res.json(plan);
    } catch (err) { _placementChangeError(res, err); }
  }));

router.post('/:hostId/placement/changes', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerPlacementChanges.createForHost(resolved.host, {
        ...(req.body || {}), idempotencyKey: req.get('Idempotency-Key'),
      }, { canOperate: true, createdBy: req.user.id });
      _placementChangeAudit(req, result.deduplicated ? 'deduplicated' : 'requested', result.change);
      res.status(result.deduplicated ? 200 : 202).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _placementChangeError(res, err); }
  }));

router.get('/:hostId/placement/changes', requireAuth,
  requireRole('admin'), requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'Limit must be an integer between 1 and 200', code: 'INVALID_CHANGE_LIMIT' });
    try {
      const items = providerPlacementChanges.listForHost(resolved.host.id, { limit });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _placementChangeError(res, err); }
  });

router.get('/:hostId/placement/changes/:changeId', requireAuth,
  requireRole('admin'), requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    const change = providerPlacementChanges.get(req.params.changeId);
    if (!change || change.provider.endpointId !== resolved.host.id) return res.status(404).json({ error: 'Placement change not found', code: 'PLACEMENT_CHANGE_NOT_FOUND' });
    res.json(change);
  });

router.post('/:hostId/placement/changes/:changeId/approve', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerPlacementChanges.approveForHost(resolved.host, req.params.changeId,
        { actorId: req.user.id, comment: req.body?.comment, canOperate: true });
      _placementChangeAudit(req, result.deduplicated ? 'approval_deduplicated' : 'approved', result.change,
        { operationId: result.operation?.id || null });
      res.status(result.deduplicated ? 200 : 202).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _placementChangeError(res, err); }
  }));

router.post('/:hostId/placement/changes/:changeId/reject', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const change = providerPlacementChanges.rejectForHost(resolved.host, req.params.changeId,
        { actorId: req.user.id, reason: req.body?.reason });
      _placementChangeAudit(req, 'rejected', change);
      res.json({ schemaVersion: '1.0', change });
    } catch (err) { _placementChangeError(res, err); }
  });

router.post('/:hostId/placement/changes/:changeId/rollback/plan', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerPlacementChanges.planRollbackForHost(resolved.host, req.params.changeId,
        { waveSize: req.body?.waveSize, windowEndsAt: req.body?.windowEndsAt, canOperate: true });
      _placementChangeAudit(req, 'rollback_requested', providerPlacementChanges.get(req.params.changeId),
        { rollbackPlanHash: result.plan.planHash });
      res.json(result);
    } catch (err) { _placementChangeError(res, err); }
  }));

for (const action of ['pause', 'resume', 'cancel']) {
  router.post(`/:hostId/placement/changes/:changeId/${action}`, requireAuth,
    requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
      const resolved = _host(req.params.hostId);
      if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
      try {
        const change = providerPlacementChanges.controlForHost(resolved.host, req.params.changeId, action, { actorId: req.user.id });
        _placementChangeAudit(req, action, change);
        res.status(action === 'cancel' ? 202 : 200).json({ schemaVersion: '1.0', change });
      } catch (err) { _placementChangeError(res, err); }
    });
}

router.get('/:hostId/virtual-machines/:resourceId', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (req.query.refresh !== undefined && !['true', 'false', '1', '0'].includes(String(req.query.refresh))) {
      return res.status(400).json({ error: 'refresh must be true or false', code: 'INVALID_REFRESH' });
    }
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
    if (refresh && !_isAdmin(req.user)) {
      return res.status(403).json({ error: 'VM detail refresh requires admin role' });
    }
    try {
      const canOperate = _isAdmin(req.user) || ['operate', 'admin'].includes(req.hostAccess);
      const detail = await providerVmDetail.detailForHost(resolved.host, req.params.resourceId, {
        refresh, canOperate,
      });
      if (refresh) {
        auditService.log({
          userId: req.user.id, username: req.user.username,
          action: 'provider_vm_detail_refresh', targetType: 'virtualMachine',
          targetId: detail.resource.id,
          details: { hostId: resolved.host.id, provider: resolved.host.daemon_type, freshness: detail.freshness.state },
          ip: getClientIp(req),
        });
      }
      res.json(detail);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 ? 'Provider VM detail failed' : err.message,
        code: err?.code || 'PROVIDER_VM_DETAIL_ERROR',
      });
    }
  }));

router.get('/:hostId/storage-posture', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerStoragePosture.postureForHost(resolved.host));
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 ? 'Provider storage posture failed' : err.message,
        code: err?.code || 'STORAGE_POSTURE_ERROR',
      });
    }
  }));

router.get('/:hostId/resources/:kind', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  if (!config.features.providerSdkV2) return res.status(404).json({ error: 'Provider SDK v2 is disabled' });
  const hostId = Number.parseInt(req.params.hostId, 10);
  if (!Number.isInteger(hostId) || hostId <= 0) return res.status(400).json({ error: 'Invalid provider host ID' });
  if (req.query.limit !== undefined && !/^\d{1,3}$/.test(String(req.query.limit))) {
    return res.status(400).json({ error: 'Resource limit must be an integer between 1 and 500', code: 'INVALID_RESOURCE_LIMIT' });
  }
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ error: 'Resource limit must be an integer between 1 and 500', code: 'INVALID_RESOURCE_LIMIT' });
  }
  const host = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Provider host not found' });
  if (!host.is_active) return res.status(400).json({ error: `Provider host "${host.name}" is not active` });
  try {
    res.json(await providerSdk.resourcesForHost(host, req.params.kind, { limit }));
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: status >= 500 ? 'Provider resource inventory failed' : err.message,
      code: err?.code || 'PROVIDER_RESOURCE_ERROR',
    });
  }
}));

module.exports = router;
