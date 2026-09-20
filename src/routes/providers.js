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
const providerSnapshotRisk = require('../services/provider-sdk/snapshot-risk');
const providerStorageTopology = require('../services/provider-sdk/storage-topology');
const providerStoragePlacementAdvisory = require('../services/provider-sdk/storage-placement-advisory');
const providerStoragePolicyAdvisory = require('../services/provider-sdk/storage-policy-advisory');
const providerNetworkPosture = require('../services/provider-sdk/network-posture');
const providerNetworkPolicyAdvisory = require('../services/provider-sdk/network-policy-advisory');
const providerNetworkAttachmentTopology = require('../services/provider-sdk/network-attachment-topology');
const providerNetworkPlacementAdvisory = require('../services/provider-sdk/network-placement-advisory');
const providerNetworkDriftBaseline = require('../services/provider-sdk/network-drift-baseline');
const providerIpAddressInventory = require('../services/provider-sdk/ip-address-inventory');
const providerIpConflictCandidates = require('../services/provider-sdk/ip-conflict-candidates');
const providerGuestNetworkReadiness = require('../services/provider-sdk/guest-network-readiness');
const providerEndpointTransportPosture = require('../services/provider-sdk/endpoint-transport-posture');
const providerSecurityPosture = require('../services/provider-sdk/security-posture');
const providerOperationalQualification = require('../services/provider-sdk/operational-qualification');
const providerNetworkEvidenceCapture = require('../services/provider-sdk/network-evidence-capture');
const providerSecurityAssurance = require('../services/provider-sdk/security-assurance');
const providerSecurityLifecycle = require('../services/provider-sdk/security-lifecycle');
const providerPrivilegedCompliance = require('../services/provider-sdk/privileged-compliance');
const providerPlacementAdvisory = require('../services/provider-sdk/placement-advisory');
const providerPlacementChanges = require('../services/provider-operations/placement-changes');
const providerVmPower = require('../services/provider-operations/vm-power');
const providerVmSnapshots = require('../services/provider-operations/vm-snapshots');
const providerVmSnapshotPolicies = require('../services/provider-operations/snapshot-policies');
const providerVmActionSchedules = require('../services/provider-operations/vm-action-schedules');
const providerBackupPolicies = require('../services/provider-operations/backup-policies');
const providerBackupExecutions = require('../services/provider-operations/backup-executions');
const providerRecoveryRestore = require('../services/provider-operations/recovery-restore');
const providerRestoreDrills = require('../services/provider-operations/restore-drills');
const providerDrRunbooks = require('../services/provider-operations/dr-runbooks');
const providerRestoreReplicationDepth = require('../services/provider-operations/restore-replication-depth');
const providerVmDisks = require('../services/provider-operations/vm-disks');
const providerVmNics = require('../services/provider-operations/vm-nics');
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
router.use('/inventory-views', require('./provider-inventory-views'));

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

function _nicError(res, err) {
  const trusted = err?.name === 'VmNicError'
    && /^(?:VM_NIC_|PROVIDER_|INVALID_|UNSTABLE_|CAPABILITY_|OPERATION_|POLICY_|PERMISSION_|LAST_)[A-Z0-9_]{0,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM NIC link request failed' : err.message,
    code: trusted ? err.code : 'VM_NIC_LINK_ERROR',
    ...(trusted && status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _nicAudit(req, action, plan, operation = null) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_vm_nic_${action}`, targetType: 'virtualMachine', targetId: plan.vm.id,
    details: {
      hostId: Number(req.params.hostId), provider: plan.providerType,
      vmId: plan.vm.id, nicId: plan.nic.id, linkAction: plan.action || null,
      operationId: operation?.id || null, planHash: plan.planHash || null,
      safetyState: plan.safety?.state || null, noDetachDelete: true,
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

function _vmActionScheduleError(res, err) {
  const trusted = err?.name === 'VmActionScheduleError'
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM action schedule request failed' : err.message,
    code: trusted ? err.code : 'VM_ACTION_SCHEDULE_ERROR',
    ...(trusted && status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _snapshotRiskError(res, err, fallback) {
  const trusted = err?.name === 'SnapshotRiskError'
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 502;
  return res.status(status).json({
    error: trusted ? err.message : fallback,
    code: trusted ? err.code : 'SNAPSHOT_RISK_PROVIDER_ERROR',
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

function _restoreReplicationDepthError(res, err) {
  const trusted = err?.name === 'RestoreReplicationDepthError'
    && /^(?:RESTORE_|RECOVERY_|REPLICATION_|INVALID_|UNSAFE_|PROVIDER_)[A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider restore and replication depth request failed' : err.message,
    code: trusted ? err.code : 'RESTORE_REPLICATION_DEPTH_ERROR',
    ...(trusted && status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _restoreReplicationDepthAudit(req, action, targetType, targetId, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_restore_depth_${action}`, targetType, targetId,
    details: { hostId: Number(req.params.hostId), providerMutationAuthorized: false, ...details },
    ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _securityAssuranceError(res, err) {
  const trusted = err?.name === 'ProviderSecurityAssuranceError'
    && /^(?:PROVIDER_|INVALID_|SECURITY_|KEY_|CONFIDENTIAL_|PERMISSION_)[A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider security assurance request failed' : err.message,
    code: trusted ? err.code : 'PROVIDER_SECURITY_ASSURANCE_ERROR',
    ...(trusted && status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _securityAssuranceAudit(req, action, targetType, targetId, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_security_assurance_${action}`, targetType, targetId,
    details: { hostId: Number(req.params.hostId), providerMutationAuthorized: false,
      networkCallsStarted: 0, ...details },
    ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _securityLifecycleError(res, err) {
  const trusted = err?.name === 'ProviderSecurityLifecycleError'
    && /^(?:PROVIDER_|INVALID_|SECURITY_|PERMISSION_)[A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider security lifecycle request failed' : err.message,
    code: trusted ? err.code : 'PROVIDER_SECURITY_LIFECYCLE_ERROR',
    ...(trusted && status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _securityLifecycleAudit(req, action, targetType, targetId, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_security_lifecycle_${action}`, targetType, targetId,
    details: { hostId: Number(req.params.hostId), providerMutationAuthorized: false,
      networkCallsStarted: 0, ...details },
    ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _privilegedComplianceError(res, err) {
  const trusted = err?.name === 'PrivilegedComplianceError'
    && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
  const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Privileged access and compliance request failed' : err.message,
    code: trusted ? err.code : 'PRIVILEGED_COMPLIANCE_ERROR',
    ...(trusted && status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _privilegedComplianceAudit(req, action, targetType, targetId, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `provider_privileged_compliance_${action}`, targetType, targetId,
    details: { hostId: Number(req.params.hostId), providerMutationsStarted: 0,
      secretMaterialStored: false, ...details },
    ip: getClientIp(req), userAgent: req.headers['user-agent'],
  });
}

function _criticalOperationAuthorization(operationKeyOrResolver) {
  return (req, res, next) => {
    if (config.features.providerCriticalOperationJit !== true) return next();
    const operationKey = typeof operationKeyOrResolver === 'function'
      ? operationKeyOrResolver(req) : operationKeyOrResolver;
    if (!operationKey) return next();
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const authorization = providerPrivilegedCompliance.authorizeCriticalOperation(resolved.host, {
        operationKey,
        scopeId: req.get('X-Docker-Dash-Privileged-Scope'),
        grantToken: req.get('X-Docker-Dash-Privileged-Grant'),
      }, req.user);
      req.criticalOperationAuthorization = authorization;
      _privilegedComplianceAudit(req, 'critical_operation_authorized', 'provider_host',
        String(resolved.host.id), {
          operationKey: authorization.operationKey, permissionKey: authorization.permissionKey,
          authorizationMode: authorization.mode, scopeId: authorization.scopeId,
          grantId: authorization.grantId, expiresAt: authorization.expiresAt,
          tokenStoredRaw: false,
        });
      return next();
    } catch (err) {
      _privilegedComplianceAudit(req, 'critical_operation_denied', 'provider_host',
        String(resolved.host.id), { operationKey, code: err?.code || 'PRIVILEGED_COMPLIANCE_ERROR',
          tokenStoredRaw: false });
      return _privilegedComplianceError(res, err);
    }
  };
}

function _criticalAuthorizationAudit(req) {
  const authorization = req.criticalOperationAuthorization;
  return authorization ? { criticalOperationJit: {
    operationKey: authorization.operationKey, permissionKey: authorization.permissionKey,
    authorizationMode: authorization.mode, scopeId: authorization.scopeId,
    grantId: authorization.grantId, expiresAt: authorization.expiresAt,
  } } : {};
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
      restoreDrillFeatureEnabled: config.features.providerRestoreDrills,
      restoreDepthFeatureEnabled: config.features.providerRestoreReplicationDepth });
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

router.get('/:hostId/recovery-points/:pointId/files', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerRestoreReplicationDepth.listFileEntries(resolved.host.id, req.params.pointId, {
        limit: req.query.limit, query: req.query.q, parent: req.query.parent,
      });
      res.json(result);
    } catch (err) { _restoreReplicationDepthError(res, err); }
  });

router.put('/:hostId/recovery-points/:pointId/files', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerRestoreReplicationDepth.importFileCatalog(resolved.host,
        req.params.pointId, req.body || {}, { createdBy: req.user.id });
      _restoreReplicationDepthAudit(req, result.created ? 'catalog_created' : 'catalog_updated',
        'recovery_point', req.params.pointId, { catalogId: result.catalog.id,
          entryCount: result.catalog.entryCount, manifestHash: result.catalog.manifestHash });
      res.status(result.created ? 201 : 200).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _restoreReplicationDepthError(res, err); }
  });

router.post('/:hostId/recovery-points/:pointId/restore-depth/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerRestoreReplicationDepth.preflightDepthForHost(resolved.host,
        req.params.pointId, req.body || {}, { canOperate: true, createdBy: req.user.id });
      _restoreReplicationDepthAudit(req, 'preflight', 'recovery_point', req.params.pointId, {
        planId: plan.id, kind: plan.request.kind, planHash: plan.planHash,
        allowed: plan.allowed, blockerCount: plan.blockers.length,
      });
      res.json(plan);
    } catch (err) { _restoreReplicationDepthError(res, err); }
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

router.get('/:hostId/dr/replication-policies', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const items = providerRestoreReplicationDepth.listReplicationPolicies(resolved.host.id,
        { limit: req.query.limit === undefined ? 100 : Number(req.query.limit) });
      res.json({ schemaVersion: '1.0', count: items.length, executionAuthorized: false, items });
    } catch (err) { _restoreReplicationDepthError(res, err); }
  });

router.post('/:hostId/dr/replication-policies', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerRestoreReplicationDepth.upsertReplicationPolicy(
        resolved.host, req.body || {}, { createdBy: req.user.id });
      _restoreReplicationDepthAudit(req, result.created ? 'replication_policy_created' : 'replication_policy_updated',
        'provider_replication_policy', result.policy.id, { targetHostId: result.policy.targetHostId,
          mode: result.policy.mode, enabled: false, policyHash: result.policy.policyHash });
      res.status(result.created ? 201 : 200).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _restoreReplicationDepthError(res, err); }
  }));

router.put('/:hostId/dr/replication-policies/:policyId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerRestoreReplicationDepth.upsertReplicationPolicy(resolved.host,
        { ...(req.body || {}), id: req.params.policyId }, { createdBy: req.user.id });
      _restoreReplicationDepthAudit(req, 'replication_policy_updated', 'provider_replication_policy',
        result.policy.id, { targetHostId: result.policy.targetHostId, mode: result.policy.mode,
          enabled: false, policyHash: result.policy.policyHash });
      res.json({ schemaVersion: '1.0', ...result });
    } catch (err) { _restoreReplicationDepthError(res, err); }
  }));

router.delete('/:hostId/dr/replication-policies/:policyId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const policy = providerRestoreReplicationDepth.removeReplicationPolicy(
        resolved.host.id, req.params.policyId);
      _restoreReplicationDepthAudit(req, 'replication_policy_deleted', 'provider_replication_policy',
        policy.id, { targetHostId: policy.targetHostId, enabled: false });
      res.json({ ok: true, policyId: policy.id });
    } catch (err) { _restoreReplicationDepthError(res, err); }
  });

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
  _criticalOperationAuthorization(req => providerVmPower.ACTIONS[req.body?.action]?.force === true
    ? 'provider.vm.power.force' : null),
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
          ..._criticalAuthorizationAudit(req),
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
  _criticalOperationAuthorization(req => providerVmPower.ACTIONS[req.body?.action]?.force === true
    ? 'provider.vm.power.force' : null),
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
          ..._criticalAuthorizationAudit(req),
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
      res.json(await providerConsole.preflightForHost(resolved.host, req.params.resourceId, {
        canOperate: true, recording: req.body?.recording || {},
      }));
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
        canOperate: true, userId: req.user.id, recording: req.body?.recording || {},
      });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_console_token_issue', targetType: 'virtualMachine',
        targetId: launch.resource.id,
        details: {
          sessionId: launch.id, hostId: resolved.host.id,
          provider: resolved.host.daemon_type, expiresAt: launch.expiresAt,
          singleUse: true, credentialIsolation: 'server-side',
          recordingPolicy: launch.recording.policy, recordingState: launch.recording.state,
          recordingConsentAt: launch.recording.consentAt, screenContentStored: false,
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

router.get('/:hostId/virtual-machines/:resourceId/nics', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(await providerVmNics.inventoryForHost(resolved.host, req.params.resourceId)); }
    catch (err) { _nicError(res, err); }
  }));

router.put('/:hostId/virtual-machines/:resourceId/nics/:nicId/safety', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmNics.declareSafetyForHost(resolved.host, req.params.resourceId,
        req.params.nicId, req.body || {}, { canOperate: true, createdBy: req.user.id });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_nic_safety_declare', targetType: 'virtualMachine', targetId: result.vm.id,
        details: {
          provider: resolved.host.daemon_type, hostId: resolved.host.id, nicId: result.nic.id,
          state: result.safety.state, managementRole: result.safety.managementRole,
          bootDependency: result.safety.bootDependency, guestDependency: result.safety.guestDependency,
          expiresAt: result.safety.expiresAt,
        }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
      });
      res.json(result);
    } catch (err) { _nicError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/nics/:nicId/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerVmNics.preflightForHost(resolved.host, req.params.resourceId,
        req.params.nicId, req.body?.action, { canOperate: true });
      _nicAudit(req, `${plan.action}_preflight`, plan);
      res.json(plan);
    } catch (err) { _nicError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/nics/:nicId/actions', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmNics.submitForHost(resolved.host, req.params.resourceId,
        req.params.nicId, { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        { canOperate: true, createdBy: req.user.id });
      _nicAudit(req, `${result.plan.action}_submit`, result.plan, result.operation);
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _nicError(res, err); }
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

router.get('/:hostId/virtual-machines/:resourceId/action-schedules', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const items = providerVmActionSchedules.listForVm(resolved.host.id, req.params.resourceId);
      res.json({ schemaVersion: '1.0', automation: { executeEnabled: config.features.providerVmActionSchedules === true,
        underlyingPowerEnabled: config.features.providerVmPower === true,
        underlyingSnapshotEnabled: config.features.providerVmSnapshots === true }, count: items.length, items });
    } catch (err) { _vmActionScheduleError(res, err); }
  });

router.post('/:hostId/virtual-machines/:resourceId/action-schedules', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const schedule = await providerVmActionSchedules.createForHost(
        resolved.host, req.params.resourceId, req.body || {}, { createdBy: req.user.id }
      );
      auditService.log({ userId: req.user.id, username: req.user.username,
        action: 'provider_vm_action_schedule_create', targetType: 'virtualMachine', targetId: schedule.vmId,
        details: { hostId: schedule.hostId, scheduleId: schedule.id, action: schedule.action,
          mode: schedule.mode, enabled: schedule.enabled, timezone: schedule.timezone, cron: schedule.cron },
        ip: getClientIp(req), userAgent: req.headers['user-agent'] });
      res.status(201).json({ schemaVersion: '1.0', schedule });
    } catch (err) { _vmActionScheduleError(res, err); }
  }));

router.put('/:hostId/virtual-machines/:resourceId/action-schedules/:scheduleId', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const schedule = await providerVmActionSchedules.updateForHost(
        resolved.host, req.params.resourceId, req.params.scheduleId, req.body || {}, { createdBy: req.user.id }
      );
      auditService.log({ userId: req.user.id, username: req.user.username,
        action: 'provider_vm_action_schedule_update', targetType: 'virtualMachine', targetId: schedule.vmId,
        details: { hostId: schedule.hostId, scheduleId: schedule.id, version: schedule.version,
          action: schedule.action, mode: schedule.mode, enabled: schedule.enabled,
          timezone: schedule.timezone, cron: schedule.cron }, ip: getClientIp(req), userAgent: req.headers['user-agent'] });
      res.json({ schemaVersion: '1.0', schedule });
    } catch (err) { _vmActionScheduleError(res, err); }
  }));

router.delete('/:hostId/virtual-machines/:resourceId/action-schedules/:scheduleId', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const schedule = providerVmActionSchedules.removeForVm(
        resolved.host.id, req.params.resourceId, req.params.scheduleId
      );
      auditService.log({ userId: req.user.id, username: req.user.username,
        action: 'provider_vm_action_schedule_delete', targetType: 'virtualMachine', targetId: schedule.vmId,
        details: { hostId: schedule.hostId, scheduleId: schedule.id, action: schedule.action },
        ip: getClientIp(req), userAgent: req.headers['user-agent'] });
      res.json({ ok: true, scheduleId: schedule.id });
    } catch (err) { _vmActionScheduleError(res, err); }
  });

router.get('/:hostId/virtual-machines/:resourceId/action-schedules/:scheduleId/runs', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const items = providerVmActionSchedules.listRuns(req.params.scheduleId, { limit: req.query.limit });
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _vmActionScheduleError(res, err); }
  });

router.post('/:hostId/virtual-machines/:resourceId/action-schedules/:scheduleId/run', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const schedules = providerVmActionSchedules.listForVm(resolved.host.id, req.params.resourceId);
      const schedule = schedules.find(item => item.id === req.params.scheduleId);
      if (!schedule) throw new providerVmActionSchedules.VmActionScheduleError(
        'VM action schedule was not found', 'VM_ACTION_SCHEDULE_NOT_FOUND', 404
      );
      const run = await providerVmActionSchedules.runNow(req.params.scheduleId, req.body || {}, { createdBy: req.user.id });
      auditService.log({ userId: req.user.id, username: req.user.username,
        action: 'provider_vm_action_schedule_run', targetType: 'virtualMachine', targetId: schedule.vmId,
        details: { hostId: schedule.hostId, scheduleId: schedule.id, runId: run?.id || null,
          action: schedule.action, mode: schedule.mode, state: run?.state || null,
          operationId: run?.operationId || null, emergencyOverrideUsed: false },
        ip: getClientIp(req), userAgent: req.headers['user-agent'] });
      res.status(run?.state === 'queued' || run?.state === 'running' ? 202 : 200)
        .json({ schemaVersion: '1.0', run });
    } catch (err) { _vmActionScheduleError(res, err); }
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
  _criticalOperationAuthorization('provider.vm.snapshot.revert'),
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
        details: { provider: resolved.host.daemon_type, hostId: resolved.host.id, vmId: result.plan.vm.id,
          operationId: result.operation.id, ..._criticalAuthorizationAudit(req) },
        ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _snapshotError(res, err); }
  }));

router.delete('/:hostId/virtual-machines/:resourceId/snapshots/:snapshotId', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  _criticalOperationAuthorization('provider.vm.snapshot.delete'),
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
        details: { provider: resolved.host.daemon_type, hostId: resolved.host.id, vmId: result.plan.vm.id,
          operationId: result.operation.id, ..._criticalAuthorizationAudit(req) },
        ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _snapshotError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/snapshots/consolidate/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmSnapshots.preflightForHost(
        resolved.host, req.params.resourceId, 'consolidate', req.body || {}, null,
        { canOperate: true, consolidationEnabled: config.features.providerVmSnapshotConsolidation }
      ));
    } catch (err) { _snapshotError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/snapshots/consolidate', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmSnapshots.submitForHost(
        resolved.host, req.params.resourceId, 'consolidate', { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        null, { canOperate: true, consolidationEnabled: config.features.providerVmSnapshotConsolidation, createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_consolidate', targetType: 'virtualMachine', targetId: result.plan.vm.id,
        details: { provider: resolved.host.daemon_type, hostId: resolved.host.id, operationId: result.operation.id, consolidationNeeded: true },
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
  _criticalOperationAuthorization('provider.vm.migration.execute'),
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
          ..._criticalAuthorizationAudit(req),
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

router.get('/:hostId/snapshot-risk', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { return res.json(providerSnapshotRisk.assessHost(resolved.host)); }
    catch (err) { return _snapshotRiskError(res, err, 'Provider snapshot risk assessment failed'); }
  });

router.post('/:hostId/snapshot-risk/refresh', requireAuth, requireRole('admin'),
  requireHostAccess('view', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerSnapshotRisk.refreshHost(resolved.host, { actor: req.user });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_snapshot_risk_refresh', targetType: 'providerHost', targetId: String(resolved.host.id),
        details: { provider: resolved.host.daemon_type, state: result.summary.state,
          snapshotCount: result.summary.snapshotCount, transitionCount: result.transitions.length,
          attemptedVms: result.coverage.collection?.attemptedVms || 0,
          failedVms: result.coverage.collection?.failedVms || 0 },
        ip: getClientIp(req),
      });
      res.json(result);
    } catch (err) { _snapshotRiskError(res, err, 'Provider snapshot risk refresh failed'); }
  }));

router.put('/:hostId/snapshot-risk/policy', requireAuth, requireRole('admin'),
  requireHostAccess('view', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const policy = providerSnapshotRisk.updatePolicy(resolved.host, req.body || {}, req.user);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_snapshot_risk_policy_update', targetType: 'providerHost', targetId: String(resolved.host.id),
        details: { provider: resolved.host.daemon_type, version: policy.version,
          warningAgeDays: policy.warningAgeDays, criticalAgeDays: policy.criticalAgeDays,
          warningChainDepth: policy.warningChainDepth, criticalChainDepth: policy.criticalChainDepth,
          warningGrowthPercent: policy.warningGrowthPercent, criticalGrowthPercent: policy.criticalGrowthPercent },
        ip: getClientIp(req),
      });
      return res.json({ policy });
    } catch (err) { return _snapshotRiskError(res, err, 'Provider snapshot risk policy update failed'); }
  });

router.get('/:hostId/storage-topology', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerStorageTopology.topologyForHost(resolved.host));
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 ? 'Provider storage topology failed' : err.message,
        code: err?.code || 'STORAGE_TOPOLOGY_ERROR',
      });
    }
  }));

router.get('/:hostId/storage-placement-advisory', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (req.query.requiredBytes !== undefined && !/^\d{1,14}$/.test(String(req.query.requiredBytes))) {
      return res.status(400).json({ error: 'Requested disk size must be an integer number of bytes', code: 'INVALID_REQUESTED_BYTES' });
    }
    try {
      res.json(await providerStoragePlacementAdvisory.advisoryForHost(resolved.host, { requestedBytes: req.query.requiredBytes }));
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 ? 'Provider storage placement advisory failed' : err.message,
        code: err?.code || 'STORAGE_PLACEMENT_ADVISORY_ERROR',
      });
    }
  }));

router.get('/:hostId/storage-policy-advisory', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (req.query.minFreeBytes !== undefined && !/^\d{1,14}$/.test(String(req.query.minFreeBytes))) {
      return res.status(400).json({ error: 'Minimum free capacity must be an integer number of bytes', code: 'INVALID_MIN_FREE_BYTES' });
    }
    if (req.query.requireShared !== undefined && !['true', 'false'].includes(String(req.query.requireShared))) {
      return res.status(400).json({ error: 'Shared-storage requirement must be true or false', code: 'INVALID_REQUIRE_SHARED' });
    }
    try {
      res.json(await providerStoragePolicyAdvisory.advisoryForHost(resolved.host, {
        minFreeBytes: req.query.minFreeBytes,
        requireShared: req.query.requireShared === undefined ? undefined : req.query.requireShared === 'true',
      }));
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 ? 'Provider storage policy advisory failed' : err.message,
        code: err?.code || 'STORAGE_POLICY_ADVISORY_ERROR',
      });
    }
  }));

router.get('/:hostId/network-posture', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerNetworkPosture.postureForHost(resolved.host));
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 ? 'Provider network posture failed' : err.message,
        code: err?.code || 'NETWORK_POSTURE_ERROR',
      });
    }
  }));

router.get('/:hostId/network-policy-advisory', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  if (req.query.minMtu !== undefined && !/^\d{3,5}$/.test(String(req.query.minMtu))) return res.status(400).json({ error: 'Minimum MTU must be an integer', code: 'INVALID_MIN_MTU' });
  if (['requireManaged', 'requireVlan'].some(key => req.query[key] !== undefined && !['true', 'false'].includes(String(req.query[key])))) return res.status(400).json({ error: 'Network policy booleans must be true or false', code: 'INVALID_NETWORK_POLICY' });
  try { res.json(await providerNetworkPolicyAdvisory.advisoryForHost(resolved.host, { minMtu: req.query.minMtu, requireManaged: req.query.requireManaged === 'true', requireVlan: req.query.requireVlan === 'true' })); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider network policy advisory failed' : err.message, code: err?.code || 'NETWORK_POLICY_ADVISORY_ERROR' }); }
}));

router.get('/:hostId/network-attachment-topology', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.json(await providerNetworkAttachmentTopology.topologyForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider network attachment topology failed' : err.message, code: err?.code || 'NETWORK_ATTACHMENT_TOPOLOGY_ERROR' }); }
}));

router.get('/:hostId/network-placement-advisory', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.json(await providerNetworkPlacementAdvisory.advisoryForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider network placement advisory failed' : err.message, code: err?.code || 'NETWORK_PLACEMENT_ADVISORY_ERROR' }); }
}));

router.get('/:hostId/network-drift-baseline', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.json(await providerNetworkDriftBaseline.getForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider network drift baseline failed' : err.message, code: err?.code || 'NETWORK_DRIFT_BASELINE_ERROR' }); }
}));

router.post('/:hostId/network-drift-baseline', requireAuth, requireHostAccess('admin', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.status(201).json(await providerNetworkDriftBaseline.saveForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider network drift baseline save failed' : err.message, code: err?.code || 'NETWORK_DRIFT_BASELINE_ERROR' }); }
}));

router.get('/:hostId/ip-address-inventory', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.json(await providerIpAddressInventory.inventoryForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider IP inventory failed' : err.message, code: err?.code || 'IP_ADDRESS_INVENTORY_ERROR' }); }
}));

router.get('/:hostId/ip-conflict-candidates', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.json(await providerIpConflictCandidates.candidatesForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider IP conflict candidate scan failed' : err.message, code: err?.code || 'IP_CONFLICT_CANDIDATES_ERROR' }); }
}));

router.get('/:hostId/guest-network-readiness', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.json(await providerGuestNetworkReadiness.readinessForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider guest network readiness failed' : err.message, code: err?.code || 'GUEST_NETWORK_READINESS_ERROR' }); }
}));

router.get('/:hostId/endpoint-transport-posture', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.json(await providerEndpointTransportPosture.postureForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider endpoint transport posture failed' : err.message, code: err?.code || 'ENDPOINT_TRANSPORT_POSTURE_ERROR' }); }
}));

router.get('/:hostId/security-posture', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId); if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  try { res.json(await providerSecurityPosture.postureForHost(resolved.host)); }
  catch (err) { const status = Number.isInteger(err?.status) ? err.status : 500; res.status(status).json({ error: status >= 500 ? 'Provider security posture failed' : err.message, code: err?.code || 'PROVIDER_SECURITY_POSTURE_ERROR' }); }
}));

router.get('/:hostId/operational-qualification', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(providerOperationalQualification.qualificationForHost(resolved.host,
        { actorId: req.user.id, batch: req.query.batch }));
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 ? 'Provider operational qualification failed' : err.message,
        code: err?.code || 'OPERATIONAL_QUALIFICATION_ERROR',
      });
    }
  });

router.post('/:hostId/network-evidence/capture', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerNetworkEvidenceCapture.captureForHost(resolved.host, req.user);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_network_evidence_capture', targetType: 'provider_host',
        targetId: String(resolved.host.id), details: {
          hostId: Number(resolved.host.id), provider: resolved.host.daemon_type,
          featureIds: result.features.map(item => item.featureId),
          captured: result.summary.captured, notObserved: result.summary.notObserved,
          unavailable: result.summary.unavailable,
          providerReadsStarted: result.summary.providerReadsStarted,
          providerMutationsStarted: 0, activeProbesStarted: 0,
          evidenceHash: result.evidenceHash,
        }, ip: getClientIp(req), userAgent: req.headers['user-agent'],
      });
      res.status(result.summary.captured ? 201 : 200).json(result);
    } catch (err) {
      const trusted = err?.name === 'NetworkEvidenceCaptureError'
        && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''));
      const status = trusted && Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 && !trusted ? 'Provider network evidence capture failed' : err.message,
        code: trusted ? err.code : 'NETWORK_EVIDENCE_CAPTURE_ERROR',
      });
    }
  }));

router.get('/:hostId/security-assurance', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(await providerSecurityAssurance.assuranceForHost(resolved.host)); }
    catch (err) { _securityAssuranceError(res, err); }
  }));

router.put('/:hostId/security-assurance/evidence', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerSecurityAssurance.upsertEvidence(resolved.host, req.body || {},
        { createdBy: req.user.id });
      _securityAssuranceAudit(req, result.created ? 'evidence_created' : 'evidence_updated',
        result.evidence.resourceKind, result.evidence.resourceId, {
          evidenceId: result.evidence.id, evidenceHash: result.evidence.evidenceHash,
          packKey: result.evidence.pack.key, source: result.evidence.source,
        });
      res.status(result.created ? 201 : 200).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _securityAssuranceError(res, err); }
  });

router.get('/:hostId/security-assurance/key-providers', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const items = providerSecurityAssurance.listKeyProviders(resolved.host.id);
      res.json({ schemaVersion: '1.0', count: items.length, items });
    } catch (err) { _securityAssuranceError(res, err); }
  });

router.post('/:hostId/security-assurance/key-providers', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerSecurityAssurance.upsertKeyProvider(resolved.host, req.body || {},
        { createdBy: req.user.id });
      _securityAssuranceAudit(req, result.created ? 'key_provider_created' : 'key_provider_updated',
        'provider_key_provider', result.keyProvider.id, {
          providerKind: result.keyProvider.providerKind, evidenceHash: result.keyProvider.evidenceHash,
          healthState: result.keyProvider.health.state,
        });
      res.status(result.created ? 201 : 200).json({ schemaVersion: '1.0', ...result });
    } catch (err) { _securityAssuranceError(res, err); }
  });

router.put('/:hostId/security-assurance/key-providers/:keyProviderId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerSecurityAssurance.upsertKeyProvider(resolved.host,
        { ...(req.body || {}), id: req.params.keyProviderId }, { createdBy: req.user.id });
      _securityAssuranceAudit(req, 'key_provider_updated', 'provider_key_provider',
        result.keyProvider.id, { providerKind: result.keyProvider.providerKind,
          evidenceHash: result.keyProvider.evidenceHash, healthState: result.keyProvider.health.state });
      res.json({ schemaVersion: '1.0', ...result });
    } catch (err) { _securityAssuranceError(res, err); }
  });

router.delete('/:hostId/security-assurance/key-providers/:keyProviderId', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const item = providerSecurityAssurance.removeKeyProvider(resolved.host.id, req.params.keyProviderId);
      _securityAssuranceAudit(req, 'key_provider_deleted', 'provider_key_provider', item.id,
        { providerKind: item.providerKind, evidenceHash: item.evidenceHash });
      res.json({ ok: true, keyProviderId: item.id });
    } catch (err) { _securityAssuranceError(res, err); }
  });

router.post('/:hostId/security-assurance/confidential-provisioning/preflight', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = await providerSecurityAssurance.preflightConfidentialProvisioning(
        resolved.host, req.body || {}, { canOperate: true, createdBy: req.user.id });
      _securityAssuranceAudit(req, 'confidential_preflight', 'provider_host', String(resolved.host.id), {
        planId: plan.id, planHash: plan.planHash, mode: plan.request.mode,
        allowed: plan.allowed, blockerCount: plan.blockers.length, executionAuthorized: false,
      });
      res.json(plan);
    } catch (err) { _securityAssuranceError(res, err); }
  }));

router.get('/:hostId/security-lifecycle', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(providerSecurityLifecycle.overview(resolved.host)); }
    catch (err) { _securityLifecycleError(res, err); }
  });

router.post('/:hostId/security-lifecycle/correlate', requireAuth, requireRole('admin'),
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerSecurityLifecycle.correlate(resolved.host,
        { canOperate: true, createdBy: req.user.id });
      _securityLifecycleAudit(req, 'advisories_correlated', 'provider_host', String(resolved.host.id), {
        findingCount: result.matched, skippedCount: result.skipped, source: result.source,
      });
      res.json(result);
    } catch (err) { _securityLifecycleError(res, err); }
  });

router.post('/:hostId/security-lifecycle/findings/:findingId/exceptions', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const finding = providerSecurityLifecycle.createException(resolved.host,
        req.params.findingId, req.body || {}, { canOperate: true, createdBy: req.user.id });
      _securityLifecycleAudit(req, 'exception_created', 'security_finding', finding.id, {
        exceptionId: finding.exception.id, exceptionHash: finding.exception.exceptionHash,
        expiresAt: finding.exception.expiresAt,
      });
      res.status(201).json(finding);
    } catch (err) { _securityLifecycleError(res, err); }
  });

router.delete('/:hostId/security-lifecycle/findings/:findingId/exceptions/:exceptionId', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const finding = providerSecurityLifecycle.revokeException(resolved.host, req.params.findingId,
        req.params.exceptionId, { canOperate: true, createdBy: req.user.id });
      _securityLifecycleAudit(req, 'exception_revoked', 'security_finding', finding.id,
        { exceptionId: req.params.exceptionId });
      res.json(finding);
    } catch (err) { _securityLifecycleError(res, err); }
  });

router.post('/:hostId/security-lifecycle/findings/:findingId/remediation-plans', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const plan = providerSecurityLifecycle.planRemediation(resolved.host,
        req.params.findingId, req.body || {}, { canOperate: true, createdBy: req.user.id });
      _securityLifecycleAudit(req, 'remediation_planned', 'security_finding', req.params.findingId, {
        planId: plan.id, planHash: plan.planHash, risk: plan.risk, allowed: plan.allowed,
        executionAuthorized: false,
      });
      res.status(201).json(plan);
    } catch (err) { _securityLifecycleError(res, err); }
  });

router.post('/:hostId/security-lifecycle/remediation-plans/:planId/execute', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const run = await providerSecurityLifecycle.executeLowRisk(resolved.host,
        req.params.planId, req.body || {}, { canOperate: true, createdBy: req.user.id });
      _securityLifecycleAudit(req, 'remediation_executed', 'security_remediation_plan',
        req.params.planId, { runId: run.id, state: run.state,
          providerMutationAuthorized: run.providerMutationsStarted,
          providerMutationsStarted: run.providerMutationsStarted });
      res.status(202).json(run);
    } catch (err) { _securityLifecycleError(res, err); }
  }));

router.post('/:hostId/security-lifecycle/secret-references/validate', requireAuth,
  requireRole('admin'), requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerSecurityLifecycle.validateSecretReferences(resolved.host,
        req.body || {}, { canOperate: true, createdBy: req.user.id });
      _securityLifecycleAudit(req, 'secret_references_validated', 'provider_host',
        String(resolved.host.id), { validationId: result.id, documentHash: result.documentHash,
          state: result.state, referenceCount: result.referenceCount, documentStored: false });
      res.status(result.state === 'valid' ? 200 : 422).json(result);
    } catch (err) { _securityLifecycleError(res, err); }
  });

router.get('/:hostId/privileged-compliance', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(providerPrivilegedCompliance.overview(resolved.host, req.user)); }
    catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/elevations', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.requestElevation(
        resolved.host, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'jit_requested', 'privileged_elevation', result.grant.id, {
        scopeId: result.grant.scopeId, permissionKey: result.grant.permissionKey,
        grantHash: result.grant.grantHash, mfaVerifiedAt: result.grant.mfaVerifiedAt,
        expiresAt: result.grant.expiresAt, tokenStored: false,
      });
      res.status(201).json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/elevations/:grantId/approve', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.approveElevation(
        resolved.host, req.params.grantId, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'jit_approved', 'privileged_elevation', result.grant.id, {
        scopeId: result.grant.scopeId, permissionKey: result.grant.permissionKey,
        approvedBy: result.grant.approvedBy, tokenIssued: false,
      });
      res.json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/elevations/:grantId/claim', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.claimElevation(
        resolved.host, req.params.grantId, req.user);
      _privilegedComplianceAudit(req, 'jit_claimed', 'privileged_elevation', result.grant.id, {
        scopeId: result.grant.scopeId, permissionKey: result.grant.permissionKey,
        tokenShownOnce: true, tokenStoredRaw: false,
      });
      res.json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.delete('/:hostId/privileged-compliance/elevations/:grantId', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const grant = providerPrivilegedCompliance.revokeElevation(
        resolved.host, req.params.grantId, req.user);
      _privilegedComplianceAudit(req, 'jit_revoked', 'privileged_elevation', grant.id, {
        scopeId: grant.scopeId, permissionKey: grant.permissionKey,
      });
      res.json({ grant });
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/break-glass', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.requestBreakGlass(
        resolved.host, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'break_glass_requested', 'break_glass', result.request.id, {
        scopeId: result.request.scopeId, ticketRef: result.request.ticketRef,
        notificationRefs: result.request.notificationRefs,
        recordingPolicy: result.request.recordingPolicy,
        recordingPolicyRef: result.request.recordingPolicyRef,
        recordingConsentAt: result.request.recordingConsentAt,
        expiresAt: result.request.expiresAt,
        notificationsDispatched: false,
      });
      res.status(201).json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/break-glass/:requestId/approve', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.approveBreakGlass(
        resolved.host, req.params.requestId, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'break_glass_approved', 'break_glass', result.request.id, {
        scopeId: result.request.scopeId, approvedBy: result.request.approvedBy,
        activationIssued: false,
      });
      res.json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/break-glass/:requestId/activate', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.activateBreakGlass(
        resolved.host, req.params.requestId, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'break_glass_activated', 'break_glass', result.request.id, {
        scopeId: result.request.scopeId, temporaryIdentity: result.request.temporaryIdentity,
        tokenShownOnce: true, temporaryAccountCreated: false,
      });
      res.json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/break-glass/:requestId/close', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const request = providerPrivilegedCompliance.closeBreakGlass(
        resolved.host, req.params.requestId, req.user);
      _privilegedComplianceAudit(req, 'break_glass_closed', 'break_glass', request.id, {
        scopeId: request.scopeId, reviewRequired: true,
      });
      res.json({ request });
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/break-glass/:requestId/review', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const request = providerPrivilegedCompliance.reviewBreakGlass(
        resolved.host, req.params.requestId, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'break_glass_reviewed', 'break_glass', request.id, {
        scopeId: request.scopeId, outcome: request.reviewOutcome, reviewedBy: request.reviewedBy,
      });
      res.json({ request });
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.put('/:hostId/privileged-compliance/classifications', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.upsertClassification(
        resolved.host, req.body || {}, req.user);
      _privilegedComplianceAudit(req, result.created ? 'classification_created' : 'classification_updated',
        result.classification.resourceKind, result.classification.resourceId, {
          scopeId: result.classification.scopeId,
          classification: result.classification.classification,
          classificationHash: result.classification.classificationHash,
        });
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/mappings', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.importMappings(
        resolved.host, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'mappings_imported', 'provider_host', String(resolved.host.id), {
        scopeId: Number(req.body?.scopeId), mappingCount: result.count,
        duplicatedFindingsCreated: 0,
      });
      res.status(201).json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/ransomware-posture', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.recordRansomwarePosture(
        resolved.host, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'ransomware_posture_recorded', 'ransomware_posture',
        result.posture.id, { scopeId: result.posture.scopeId, score: result.posture.score,
          confidence: result.posture.confidence, evidenceHash: result.posture.evidenceHash });
      res.status(201).json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

router.post('/:hostId/privileged-compliance/exports', requireAuth,
  requireHostAccess('operate', { param: 'hostId' }), writeable, (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = providerPrivilegedCompliance.createComplianceExport(
        resolved.host, req.body || {}, req.user);
      _privilegedComplianceAudit(req, 'evidence_exported', 'compliance_export', result.export.id, {
        scopeId: result.export.scopeId, format: result.export.format,
        classification: result.export.classification, bundleHash: result.export.bundleHash,
        signatureAlgorithm: result.export.signatureAlgorithm, bundleStored: false,
      });
      if (result.export.format === 'pdf') {
        res.set('Content-Type', result.contentType);
        res.set('Content-Disposition', `attachment; filename="docker-dash-compliance-${result.export.id}.pdf"`);
        res.set('X-Docker-Dash-Bundle-Hash', result.export.bundleHash);
        res.set('X-Docker-Dash-Signature', result.export.signature);
        return res.status(201).send(result.content);
      }
      res.status(201).json(result);
    } catch (err) { _privilegedComplianceError(res, err); }
  });

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
