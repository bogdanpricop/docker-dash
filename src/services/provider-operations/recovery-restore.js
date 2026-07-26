'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const recoveryCatalog = require('../provider-sdk/recovery-point-catalog');
const identityStore = require('../provider-sdk/identity-store');
const operationsSingleton = require('./index');
const policySingleton = require('./policy');
const { TYPE } = require('./handlers/vm-restore');

const SAFE_POINT_ID = /^ddr_rp_[a-f0-9]{26}$/;
const SAFE_NODE_ID = /^ddr_host_[a-f0-9]{26}$/;
const SAFE_STORAGE_ID = /^ddr_storage_[a-f0-9]{26}$/;
const SAFE_NODE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_STORAGE = /^[A-Za-z0-9._-]{1,128}$/;
const PLAN_TTL_MS = 5 * 60 * 1000;
const ACTIVE_STATES = new Set(['queued', 'running', 'waiting_retry', 'reconciling', 'cancel_requested', 'unknown']);

class RecoveryRestoreError extends Error {
  constructor(message, code = 'RECOVERY_RESTORE_ERROR', status = 400, details = null) {
    super(message); this.name = 'RecoveryRestoreError'; this.code = code; this.status = status; this.details = details;
  }
}

function _database(options) { return options.database || getDb(); }
function _registry(options) { return options.registry || registrySingleton; }
function _operations(options) { return options.operations || operationsSingleton; }
function _policy(options) { return options.policy || policySingleton; }
function _blocker(type, reason, details = {}) { return { type, reason, ...details }; }
function _text(value, max) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}
function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _kind(value) {
  const kind = String(value || 'vm').toLowerCase();
  if (!['vm', 'disk', 'file'].includes(kind)) {
    throw new RecoveryRestoreError('Restore kind must be vm, disk or file', 'INVALID_RECOVERY_RESTORE_KIND');
  }
  return kind;
}

function _target(input, kind) {
  if (kind !== 'vm') return null;
  const targetNodeId = String(input.targetNodeId || '');
  const targetStorageId = String(input.targetStorageId || '');
  const targetVmid = Number(input.targetVmid);
  if (!SAFE_NODE_ID.test(targetNodeId) || !SAFE_STORAGE_ID.test(targetStorageId)
    || !Number.isSafeInteger(targetVmid) || targetVmid < 100 || targetVmid > 999999999) {
    throw new RecoveryRestoreError('VM restore requires canonical target node/storage and a VMID from 100 to 999999999',
      'INVALID_RECOVERY_RESTORE_TARGET');
  }
  return { targetNodeId, targetStorageId, targetVmid };
}

function _storageIdentity(nativeRef) {
  const value = String(nativeRef || '');
  let match = /^storage\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (match && SAFE_NODE.test(match[1]) && SAFE_STORAGE.test(match[2])) {
    return { node: match[1], storage: match[2] };
  }
  if (SAFE_STORAGE.test(value)) return { node: null, storage: value };
  return null;
}

function _guestType(point) {
  const value = String(point?.workload?.guestType || '').toLowerCase();
  if (value === 'lxc' || value === 'ct') return 'lxc';
  if (value === 'qemu' || value === 'vm') return 'qemu';
  return null;
}

function _semanticPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion, hostId: plan.hostId, providerType: plan.providerType,
    kind: plan.kind, source: plan.source, target: plan.target,
    verificationOverride: plan.verificationOverride, capability: plan.capability,
    operationPolicy: plan.operationPolicy, allowed: plan.allowed,
    blockers: plan.blockers, warnings: plan.warnings,
    safety: plan.safety, confirmation: plan.confirmation,
  };
}

function _activeConflicts(database, hostId, pointId, targetVmid) {
  const vmidScope = `provider-vmid:${hostId}:${targetVmid}`;
  return database.prepare(`SELECT id, state, resource_id, lock_scopes_json
    FROM provider_operations WHERE host_id=? AND operation_type=?
      AND state IN ('queued','running','waiting_retry','reconciling','cancel_requested','unknown')
    ORDER BY created_at`).all(hostId, TYPE).filter(row => {
    let scopes = [];
    try { scopes = JSON.parse(row.lock_scopes_json || '[]'); } catch { /* invalid evidence remains a point conflict */ }
    return row.resource_id === pointId || scopes.includes(vmidScope);
  }).map(row => ({ id: row.id, state: ACTIVE_STATES.has(row.state) ? row.state : 'unknown' }));
}

async function _context(host, pointIdInput, input, options) {
  const database = _database(options);
  const pointId = String(pointIdInput || '');
  if (!SAFE_POINT_ID.test(pointId)) {
    throw new RecoveryRestoreError('Recovery point was not found', 'RECOVERY_POINT_NOT_FOUND', 404);
  }
  const stored = recoveryCatalog.resolveRecoveryPoint(pointId, { hostId: Number(host.id) }, database);
  if (!stored || stored.providerType !== host.daemon_type) {
    throw new RecoveryRestoreError('Recovery point was not found', 'RECOVERY_POINT_NOT_FOUND', 404);
  }
  const kind = _kind(input.kind);
  const target = _target(input, kind);
  const registry = _registry(options);
  const [recovery, capabilities, nodes, storages, vms] = await Promise.all([
    registry.recoveryPointsForHost(host, { recoveryPointId: pointId, limit: 1, database }),
    registry.capabilitiesForHost(host),
    kind === 'vm' ? registry.resourcesForHost(host, 'hosts', { limit: 64, database }) : Promise.resolve({ items: [] }),
    kind === 'vm' ? registry.resourcesForHost(host, 'storages', { limit: 500, database }) : Promise.resolve({ items: [] }),
    kind === 'vm' ? registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database }) : Promise.resolve({ items: [] }),
  ]);
  const point = recovery.items.find(item => item.id === pointId);
  if (!point) throw new RecoveryRestoreError('Recovery point is no longer present in live provider inventory',
    'RECOVERY_POINT_NOT_LIVE', 409);
  const repository = recovery.repositories.find(item => item.id === point.repository?.id) || null;
  let node = null; let nodeIdentity = null; let storage = null; let storageIdentity = null;
  if (target) {
    node = nodes.items.find(item => item.id === target.targetNodeId) || null;
    storage = storages.items.find(item => item.id === target.targetStorageId) || null;
    nodeIdentity = identityStore.resolveCanonical(target.targetNodeId,
      { hostId: Number(host.id), kind: 'host' }, database);
    const rawStorage = identityStore.resolveCanonical(target.targetStorageId,
      { hostId: Number(host.id), kind: 'storage' }, database);
    storageIdentity = rawStorage ? _storageIdentity(rawStorage.nativeRef) : null;
  }
  let policy;
  try { policy = _policy(options).evaluate({ providerType: host.daemon_type, hostId: Number(host.id) }); }
  catch { policy = { allowed: false, code: 'POLICY_UNAVAILABLE', mode: 'unknown', reason: 'Operation policy is unavailable' }; }
  return {
    host, database, stored, kind, target, point, repository, capabilities,
    nodes, storages, vms, node, nodeIdentity, storage, storageIdentity, policy,
    conflicts: target ? _activeConflicts(database, Number(host.id), pointId, target.targetVmid) : [],
    enabled: options.enabled === undefined ? config.features.providerRecoveryRestore : options.enabled === true,
    canOperate: options.canOperate === true,
  };
}

function _plan(context, input) {
  const blockers = []; const warnings = [];
  const capabilityKey = context.kind === 'vm' ? 'backup.restore.vm'
    : context.kind === 'disk' ? 'backup.restore.disk' : 'backup.restore.file';
  const capability = context.capabilities.features?.[capabilityKey]
    || { state: 'unknown', reason: 'Restore capability evidence is unavailable', constraints: {} };
  const overrideReason = _text(input.overrideReason, 240);
  const overrideReasonValid = typeof input.overrideReason === 'string'
    && input.overrideReason.length <= 240 && !/[\u0000-\u001f\u007f]/.test(input.overrideReason)
    && !!overrideReason && overrideReason.length >= 20;
  const allowUnverified = input.allowUnverified === true;
  const verification = context.point.verification?.state || 'unknown';
  const guestType = _guestType(context.point);
  if (!context.enabled) blockers.push(_blocker('RELEASE_DISABLED',
    'Recovery restore is disabled by release policy', { code: 'DD_PROVIDER_RECOVERY_RESTORE' }));
  if (!context.canOperate) blockers.push(_blocker('PERMISSION_BLOCKED', 'Operate permission is required for this endpoint'));
  if (!context.policy.allowed) blockers.push(_blocker('POLICY_BLOCKED', context.policy.reason,
    { code: context.policy.code, mode: context.policy.mode }));
  if (!['supported', 'conditional'].includes(capability.state)) blockers.push(_blocker(
    capability.state === 'unknown' ? 'RESTORE_CAPABILITY_UNKNOWN' : 'RESTORE_CAPABILITY_UNSUPPORTED',
    capability.reason || `${context.kind} restore is unavailable`, { capability: capabilityKey, state: capability.state }));
  if (context.kind !== 'vm') blockers.push(_blocker('RESTORE_KIND_NOT_EXECUTABLE',
    `${context.kind} restore has no conformance-tested execution adapter in this release`, { kind: context.kind }));
  if (context.host.daemon_type !== 'proxmox') blockers.push(_blocker('RESTORE_PROVIDER_UNSUPPORTED',
    'This provider has no conformance-tested restore mutation transport'));
  if (!context.repository || context.repository.status?.accessible === false) blockers.push(_blocker(
    'RESTORE_SOURCE_UNAVAILABLE', 'The recovery-point repository is not currently accessible'));
  if (verification === 'failed') blockers.push(_blocker('RECOVERY_POINT_VERIFICATION_FAILED',
    'A recovery point with failed verification cannot be restored through this workflow'));
  if (verification !== 'verified' && verification !== 'failed') {
    if (!allowUnverified) blockers.push(_blocker('RECOVERY_POINT_UNVERIFIED',
      'Explicit unverified restore override is required', { verification }));
    if (allowUnverified && !overrideReasonValid) blockers.push(_blocker(
      'RESTORE_OVERRIDE_REASON_REQUIRED', 'Unverified restore requires a 20-240 character reason'));
    if (allowUnverified && overrideReasonValid) warnings.push({ type: 'UNVERIFIED_RECOVERY_POINT_OVERRIDE',
      reason: 'Integrity, bootability, and application consistency are not proven', verification });
  }
  if (context.kind === 'vm' && !guestType) blockers.push(_blocker('RESTORE_GUEST_TYPE_UNKNOWN',
    'The recovery point does not prove whether it contains a QEMU VM or LXC container'));
  if (context.target) {
    if (!context.node || !context.nodeIdentity || context.nodeIdentity.providerType !== 'proxmox') {
      blockers.push(_blocker('RESTORE_TARGET_NODE_UNAVAILABLE', 'Selected target node is unavailable'));
    } else if (!SAFE_NODE.test(context.nodeIdentity.nativeRef)) {
      blockers.push(_blocker('RESTORE_TARGET_NODE_INVALID', 'Selected target node identity is invalid'));
    }
    if (!context.storage || !context.storageIdentity) {
      blockers.push(_blocker('RESTORE_TARGET_STORAGE_UNAVAILABLE', 'Selected target storage is unavailable'));
    } else {
      if (context.storageIdentity.node && context.nodeIdentity
        && context.storageIdentity.node !== context.nodeIdentity.nativeRef) {
        blockers.push(_blocker('RESTORE_TARGET_STORAGE_NODE_MISMATCH',
          'Selected target storage belongs to a different node'));
      }
      if (context.storage.status?.accessible === false) blockers.push(_blocker('RESTORE_TARGET_STORAGE_OFFLINE',
        'Selected target storage is not accessible'));
      const requiredContent = guestType === 'lxc' ? 'rootdir' : 'images';
      const content = String(context.storage.extensions?.contentType || '').split(',').map(value => value.trim()).filter(Boolean);
      if (content.length && !content.includes(requiredContent)) blockers.push(_blocker(
        'RESTORE_TARGET_STORAGE_CONTENT_UNSUPPORTED', `Selected storage does not support ${requiredContent}`, { requiredContent }));
      if (!content.length) warnings.push({ type: 'RESTORE_STORAGE_CONTENT_UNKNOWN',
        reason: 'Storage content types were not reported and will be revalidated before submission' });
      const pointBytes = Number(context.point.backup?.sizeBytes);
      const freeBytes = Number(context.storage.status?.freeBytes);
      if (Number.isFinite(pointBytes) && pointBytes > 0 && Number.isFinite(freeBytes) && freeBytes >= 0
        && freeBytes < pointBytes) blockers.push(_blocker('RESTORE_TARGET_CAPACITY_INSUFFICIENT',
        'Selected target storage has less reported free space than the recovery-point size', { requiredBytes: pointBytes, freeBytes }));
      if (!(Number.isFinite(pointBytes) && pointBytes > 0 && Number.isFinite(freeBytes) && freeBytes >= 0)) {
        warnings.push({ type: 'RESTORE_CAPACITY_INCOMPLETE', reason: 'Recovery-point size or destination free capacity is unknown' });
      }
    }
    const conflict = context.vms.items.find(item => {
      const identity = identityStore.resolveCanonical(item.id,
        { hostId: Number(context.host.id), kind: 'virtualMachine' }, context.database);
      const match = /^(?:qemu|lxc)\/(\d+)$/.exec(String(identity?.nativeRef || ''));
      return match && Number(match[1]) === context.target.targetVmid;
    });
    if (conflict) blockers.push(_blocker('RESTORE_TARGET_VMID_CONFLICT',
      'The requested target VMID already exists', { resourceId: conflict.id, displayName: conflict.displayName }));
    if (context.conflicts.length) blockers.push(_blocker('RESTORE_OPERATION_CONFLICT',
      'The recovery point or target VMID is reserved by another restore operation', context.conflicts[0]));
  }
  const bandwidthLimitMbps = input.bandwidthLimitMbps === undefined || input.bandwidthLimitMbps === null
    || input.bandwidthLimitMbps === '' ? null : Number(input.bandwidthLimitMbps);
  if (bandwidthLimitMbps !== null && (!Number.isSafeInteger(bandwidthLimitMbps)
    || bandwidthLimitMbps < 1 || bandwidthLimitMbps > 100000)) {
    blockers.push(_blocker('INVALID_RESTORE_BANDWIDTH_LIMIT', 'Bandwidth limit must be an integer from 1 to 100000 Mbps'));
  }
  warnings.push({ type: 'RESTORE_CREATE_ONLY', reason: 'Restore creates a new powered-off workload and never overwrites an existing VMID' });
  warnings.push({ type: 'RESTORE_NO_AUTOMATIC_CLEANUP', reason: 'Failure or cancellation can leave partial provider resources that require manual inspection' });
  const expected = context.target
    ? `${allowUnverified && verification !== 'verified' ? 'RESTORE UNVERIFIED' : 'RESTORE'} ${context.target.targetVmid}`
    : null;
  const plan = {
    schemaVersion: '1.0', hostId: Number(context.host.id), providerType: context.host.daemon_type,
    kind: context.kind,
    source: {
      recoveryPointId: context.point.id, displayName: context.point.displayName,
      repositoryId: context.point.repository?.id || null,
      workload: context.point.workload || null, createdAt: context.point.createdAt || null,
      guestType, sizeBytes: context.point.backup?.sizeBytes ?? null,
      verification: context.point.verification,
    },
    target: context.target ? {
      nodeId: context.target.targetNodeId, nodeName: context.node?.displayName || null,
      storageId: context.target.targetStorageId, storageName: context.storage?.displayName || null,
      vmid: context.target.targetVmid, bandwidthLimitMbps,
    } : null,
    verificationOverride: { allowed: verification !== 'failed', requested: allowUnverified,
      reason: allowUnverified ? overrideReason : null },
    capability: { key: capabilityKey, state: capability.state, reason: capability.reason || null,
      constraints: capability.constraints || {} },
    operationPolicy: { allowed: !!context.policy.allowed, code: context.policy.code || null,
      mode: context.policy.mode || null, reason: context.policy.reason || null },
    allowed: blockers.length === 0, blockers, warnings,
    safety: { createOnly: true, overwrite: false, startAfterRestore: false,
      liveRestore: false, uniqueNetworkIdentity: true, automaticCleanupAuthorized: false },
    confirmation: { required: context.kind === 'vm', mode: 'typed_restore_target', expected },
    validUntil: new Date((Math.floor(Date.now() / PLAN_TTL_MS) + 1) * PLAN_TTL_MS).toISOString(),
  };
  plan.planHash = sha256(_canonical(_semanticPlan(plan)));
  return plan;
}

async function preflightForHost(host, pointId, input = {}, options = {}) {
  return _plan(await _context(host, pointId, input, options), input);
}

function _assertSubmission(plan, input) {
  if (!plan.allowed) throw new RecoveryRestoreError('Recovery restore preflight is blocked',
    'RECOVERY_RESTORE_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new RecoveryRestoreError('Recovery restore preflight changed; review the new plan',
      'RECOVERY_RESTORE_PREFLIGHT_STALE', 409);
  }
  if (input.confirm !== true || String(input.confirmText || '') !== plan.confirmation.expected) {
    throw new RecoveryRestoreError(`Type ${plan.confirmation.expected} to confirm restore`,
      'RECOVERY_RESTORE_CONFIRMATION_REQUIRED', 409);
  }
  if (!/^[\x21-\x7e]{8,200}$/.test(String(input.idempotencyKey || ''))) {
    throw new RecoveryRestoreError('Idempotency-Key must contain 8-200 visible ASCII characters',
      'INVALID_IDEMPOTENCY_KEY');
  }
}

async function submitForHost(host, pointId, input = {}, options = {}) {
  const plan = await preflightForHost(host, pointId, input, options);
  _assertSubmission(plan, input);
  const operation = _operations(options).create({
    type: TYPE, providerType: host.daemon_type, hostId: Number(host.id),
    resourceKind: 'recoveryPoint', resourceId: plan.source.recoveryPointId, action: 'restore',
    idempotencyKey: input.idempotencyKey,
    request: {
      planHash: plan.planHash, recoveryPointId: plan.source.recoveryPointId,
      repositoryId: plan.source.repositoryId, guestType: plan.source.guestType,
      targetNodeId: plan.target.nodeId, targetStorageId: plan.target.storageId,
      targetVmid: plan.target.vmid, bandwidthLimitMbps: plan.target.bandwidthLimitMbps,
      verificationOverride: plan.verificationOverride.requested,
      overrideReason: plan.verificationOverride.reason,
      startAfterRestore: false, liveRestore: false, overwrite: false,
    },
    lockScopes: [
      `resource:${plan.source.recoveryPointId}`,
      `provider-vmid:${host.id}:${plan.target.vmid}`,
      `resource:${plan.target.nodeId}`,
      `resource:${plan.target.storageId}`,
    ],
    createdBy: options.createdBy,
  });
  return { plan, operation };
}

module.exports = {
  RecoveryRestoreError, preflightForHost, submitForHost,
  _internals: {
    _kind, _target, _storageIdentity, _guestType, _semanticPlan,
    _activeConflicts, _context, _plan, _assertSubmission,
  },
};
