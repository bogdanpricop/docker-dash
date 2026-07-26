'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const operationsSingleton = require('./index');
const policySingleton = require('./policy');
const { TYPE } = require('./handlers/vm-provision');

const SAFE_ARTIFACT_ID = /^dda_art_[a-f0-9]{26}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_STORAGE_ID = /^ddr_storage_[a-f0-9]{26}$/;
const SAFE_NODE = /^[A-Za-z0-9._-]{1,160}$/;
const PLAN_TTL_MS = 5 * 60 * 1000;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

class VmProvisionError extends Error {
  constructor(message, code = 'VM_PROVISION_ERROR', status = 400, details = null) {
    super(message); this.name = 'VmProvisionError'; this.code = code; this.status = status; this.details = details;
  }
}

function _text(value, max) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function _name(value) {
  const name = _text(value, 80);
  if (!name || !SAFE_NAME.test(name)) {
    throw new VmProvisionError('VM name must be 1-80 portable characters: letters, numbers, dot, underscore or hyphen', 'INVALID_VM_NAME');
  }
  return name;
}

function _mode(value, providerType, xenVariant) {
  const requested = String(value || 'auto');
  if (!['auto', 'full', 'linked'].includes(requested)) throw new VmProvisionError('Clone mode must be auto, full or linked', 'INVALID_CLONE_MODE');
  if (requested !== 'auto') return { requested, effective: requested };
  return { requested, effective: providerType === 'xen' && xenVariant === 'xapi' ? 'linked' : 'full' };
}

function _blocker(type, reason, evidence = null) { return { type, reason, ...(evidence ? { evidence } : {}) }; }

function _semanticPlan(plan) {
  return {
    hostId: plan.hostId, providerType: plan.providerType,
    artifact: { id: plan.artifact.id, kind: plan.artifact.kind, displayName: plan.artifact.displayName },
    name: plan.name, mode: plan.mode, placement: plan.placement.selected,
    capability: { key: plan.capability.key, state: plan.capability.state },
    blockers: plan.blockers.map(item => `${item.type}:${item.evidence?.code || item.evidence?.state || ''}`).sort(),
    validUntil: plan.validUntil,
  };
}

async function _context(host, artifactId, input, options = {}) {
  if (!SAFE_ARTIFACT_ID.test(String(artifactId || ''))) throw new VmProvisionError('VM template was not found', 'PROVIDER_ARTIFACT_NOT_FOUND', 404);
  const database = options.database || getDb();
  const registry = options.registry || registrySingleton;
  const operations = options.operations || operationsSingleton;
  const policyService = options.policy || policySingleton;
  const [catalog, inventory, storages, capabilities] = await Promise.all([
    registry.artifactsForHost(host, { kind: 'vmTemplate', limit: 500, database }),
    registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database }),
    registry.resourcesForHost(host, 'storages', { limit: 500, database }),
    registry.capabilitiesForHost(host),
  ]);
  const artifact = catalog.items.find(item => item.id === artifactId);
  if (!artifact) throw new VmProvisionError('VM template was not found', 'PROVIDER_ARTIFACT_NOT_FOUND', 404);
  let activeOperations = [];
  try {
    activeOperations = operations.list({ hostId: Number(host.id), limit: 500 })
      .filter(operation => !TERMINAL_STATES.has(operation.state) && operation.resource?.id === artifactId);
  } catch { /* create remains fail-closed through the engine */ }
  let policy;
  try { policy = policyService.evaluate({ providerType: host.daemon_type, hostId: Number(host.id) }); }
  catch { policy = { allowed: false, code: 'POLICY_UNAVAILABLE', mode: 'unknown', reason: 'Operation policy is unavailable' }; }
  const xenVariant = host.daemon_type === 'xen'
    ? (capabilities.provider?.variant || 'unknown') : null;
  return {
    host, database, catalog, artifact, inventory, storages, capabilities, activeOperations, policy, xenVariant,
    enabled: options.enabled === undefined ? config.features.providerVmProvisioning : options.enabled === true,
    canOperate: options.canOperate === true, input,
  };
}

function _plan(context, input = {}) {
  const blockers = [];
  const warnings = [];
  const name = _name(input.name);
  const mode = _mode(input.mode, context.host.daemon_type, context.xenVariant);
  const capability = context.capabilities.features['vm.create']
    || { state: 'unknown', reason: 'Create-from-template capability evidence is unavailable', constraints: {} };
  const storageId = input.storageId ? String(input.storageId) : null;
  const targetNode = input.targetNode ? String(input.targetNode) : null;
  if (!context.enabled) blockers.push(_blocker('RELEASE_DISABLED', 'VM provisioning is disabled by release policy', { code: 'DD_PROVIDER_VM_PROVISIONING' }));
  if (!context.canOperate) blockers.push(_blocker('PERMISSION_BLOCKED', 'Operate permission is required for this endpoint'));
  if (!context.policy.allowed) blockers.push(_blocker('POLICY_BLOCKED', context.policy.reason, { code: context.policy.code, mode: context.policy.mode }));
  if (!['supported', 'conditional'].includes(capability.state)) blockers.push(_blocker(
    capability.state === 'unknown' ? 'CAPABILITY_UNKNOWN' : 'CAPABILITY_UNSUPPORTED',
    capability.reason || 'Create-from-template is unavailable', { state: capability.state }
  ));
  if (context.activeOperations.length) blockers.push(_blocker('OPERATION_CONFLICT', 'Another provisioning operation is active for this template', {
    operationId: context.activeOperations[0].id, state: context.activeOperations[0].state,
  }));
  if (context.inventory.items.some(item => item.displayName.toLowerCase() === name.toLowerCase())) {
    blockers.push(_blocker('VM_NAME_CONFLICT', 'A VM with this name already exists'));
  }
  if (mode.effective === 'linked' && context.host.daemon_type === 'vsphere') {
    blockers.push(_blocker('CLONE_MODE_UNAVAILABLE', 'Linked clone is not enabled for vSphere templates in this release'));
  }
  if (context.host.daemon_type === 'xen' && context.xenVariant !== 'xapi') {
    blockers.push(_blocker('PROVIDER_VARIANT_UNAVAILABLE', 'Direct XAPI is required because the current Xen Orchestra REST API does not expose template instantiation', { state: context.xenVariant }));
  }
  if (storageId && (!SAFE_STORAGE_ID.test(storageId) || !context.storages.items.some(item => item.id === storageId))) {
    blockers.push(_blocker('PROVIDER_PLACEMENT_UNAVAILABLE', 'Selected storage is not available on this endpoint'));
  }
  if (targetNode && (!SAFE_NODE.test(targetNode) || context.host.daemon_type !== 'proxmox')) {
    blockers.push(_blocker('PROVIDER_PLACEMENT_UNAVAILABLE', 'Target node is invalid or unsupported by this provider'));
  }
  if (mode.effective === 'linked') warnings.push({ type: 'LINKED_CLONE_DEPENDENCY', reason: 'A linked clone depends on the source storage chain and is not an independent copy' });
  warnings.push({ type: 'CREATES_COMPUTE_RESOURCE', reason: 'This operation allocates a new provider VM and storage resources' });
  const candidates = context.storages.items.map(item => ({
    id: item.id, displayName: item.displayName, type: item.spec?.type || null,
    freeBytes: item.status?.freeBytes ?? null, accessible: item.status?.accessible ?? null,
  }));
  const plan = {
    schemaVersion: '1.0', hostId: Number(context.host.id), providerType: context.host.daemon_type,
    artifact: {
      id: context.artifact.id, kind: context.artifact.kind, displayName: context.artifact.displayName,
      identity: context.artifact.identity, provenance: context.artifact.provenance, spec: context.artifact.spec,
    },
    name, mode, placement: { selected: { storageId, targetNode }, candidates },
    capability: { key: 'vm.create', state: capability.state, reason: capability.reason || null },
    allowed: blockers.length === 0, blockers, warnings,
    confirmation: { required: true, mode: 'typed_name', expected: name },
    validUntil: new Date((Math.floor(Date.now() / PLAN_TTL_MS) + 1) * PLAN_TTL_MS).toISOString(),
  };
  plan.planHash = sha256(JSON.stringify(_semanticPlan(plan)));
  return plan;
}

async function preflightForHost(host, artifactId, input = {}, options = {}) {
  return _plan(await _context(host, artifactId, input, options), input);
}

function _assertSubmission(plan, input = {}) {
  if (!plan.allowed) throw new VmProvisionError('Create-from-template preflight is blocked', 'VM_PROVISION_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new VmProvisionError('Create-from-template preflight changed; review the new plan', 'VM_PROVISION_PREFLIGHT_STALE', 409);
  }
  if (input.confirm !== true) throw new VmProvisionError('Create-from-template requires confirm=true', 'VM_PROVISION_CONFIRMATION_REQUIRED');
  if (input.confirmName !== plan.confirmation.expected) {
    throw new VmProvisionError('Create-from-template requires the exact target VM name', 'VM_PROVISION_TYPED_CONFIRMATION_REQUIRED');
  }
  if (!/^[\x21-\x7e]{8,200}$/.test(String(input.idempotencyKey || ''))) {
    throw new VmProvisionError('Idempotency-Key must contain 8-200 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
  }
}

async function submitForHost(host, artifactId, input = {}, options = {}) {
  const plan = await preflightForHost(host, artifactId, input, options);
  _assertSubmission(plan, input);
  const engine = options.operations || operationsSingleton;
  return { plan, operation: engine.create({
    type: TYPE, providerType: host.daemon_type, hostId: Number(host.id),
    resourceKind: 'artifact', resourceId: artifactId, action: 'clone',
    idempotencyKey: input.idempotencyKey,
    request: {
      planHash: plan.planHash, artifactId, name: plan.name, mode: plan.mode.effective,
      storageId: plan.placement.selected.storageId, targetNode: plan.placement.selected.targetNode,
      startAfterCreate: false,
    },
    lockScopes: [
      `resource:${artifactId}`,
      `provider-name:${sha256(`${host.id}|${plan.name.toLowerCase()}`).slice(0, 32)}`,
    ],
    createdBy: options.createdBy,
  }) };
}

module.exports = {
  VmProvisionError, preflightForHost, submitForHost,
  _internals: { _text, _name, _mode, _semanticPlan, _context, _plan, _assertSubmission },
};
