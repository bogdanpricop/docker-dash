'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const operationsSingleton = require('./index');
const policySingleton = require('./policy');
const { TYPE } = require('./handlers/vm-nic-link');

const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_NIC_ID = /^ddh_nic_[a-f0-9]{26}$/;
const ACTIVE_STATES = new Set(['queued', 'running', 'waiting_retry', 'reconciling', 'cancel_requested', 'unknown']);
const ACTIONS = Object.freeze({
  connect: Object.freeze({ capability: 'vm.nic.connect', expectedConnected: true }),
  disconnect: Object.freeze({ capability: 'vm.nic.disconnect', expectedConnected: false }),
});

class VmNicError extends Error {
  constructor(message, code = 'VM_NIC_LINK_ERROR', status = 400, details = null) {
    super(message); this.name = 'VmNicError'; this.code = code; this.status = status; this.details = details;
  }
}

function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _blocker(type, reason, evidence = null) {
  return { type, reason, ...(evidence ? { evidence } : {}) };
}

function _text(value, min, max, label) {
  const result = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (result.length < min || result.length > max) throw new VmNicError(`${label} must contain ${min}-${max} characters`, `INVALID_VM_NIC_${label.toUpperCase().replace(/\s+/g, '_')}`);
  return result;
}

function _action(value) {
  const action = String(value || '');
  if (!ACTIONS[action]) throw new VmNicError('Action must be connect or disconnect', 'INVALID_VM_NIC_LINK_ACTION');
  return action;
}

function _releaseEnabled(providerType, options = {}) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  const keys = {
    proxmox: 'providerVmNicLinkProxmox', vsphere: 'providerVmNicLinkVsphere', xen: 'providerVmNicLinkXen',
  };
  return config.features?.[keys[providerType]] === true;
}

function _fingerprint(vmId, nic) {
  return sha256(_canonical({
    vmId, nicId: nic.id, label: nic.label || null, device: nic.device || null,
    model: nic.model || null, macAddress: nic.macAddress || null,
    network: {
      id: nic.network?.id || null, bridge: nic.network?.bridge || null,
      vlanId: nic.network?.vlanId ?? null, distributedSwitch: nic.network?.distributedSwitch || null,
    },
  }));
}

function _declarationRow(database, hostId, vmId, nicId) {
  try {
    return database.prepare(`SELECT * FROM provider_vm_nic_safety_declarations
      WHERE host_id=? AND vm_id=? AND nic_id=?`).get(hostId, vmId, nicId) || null;
  } catch { return null; }
}

function _declaration(row, fingerprint) {
  if (!row) return { state: 'missing', valid: false, reason: 'No safety declaration exists for this NIC' };
  const expired = !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now();
  const hardwareChanged = row.nic_fingerprint !== fingerprint;
  const fieldsSafe = row.management_role === 'non_management'
    && row.boot_dependency === 'not_required' && row.guest_dependency === 'not_required';
  const valid = !expired && !hardwareChanged && fieldsSafe;
  return {
    id: Number(row.id), state: expired ? 'expired' : hardwareChanged ? 'hardware_changed' : fieldsSafe ? 'valid' : 'unsafe',
    valid, managementRole: row.management_role, bootDependency: row.boot_dependency,
    guestDependency: row.guest_dependency, reason: row.reason, expiresAt: row.expires_at,
    declaredBy: row.declared_by || null, updatedAt: row.updated_at,
  };
}

function _activeOperations(operations, hostId, vmId) {
  try {
    return operations.list({ hostId, limit: 500 })
      .filter(item => ACTIVE_STATES.has(item.state) && item.resource?.id === vmId);
  } catch { return [{ id: null, state: 'unknown' }]; }
}

async function _context(host, vmIdInput, options = {}) {
  const vmId = String(vmIdInput || '');
  if (!SAFE_VM_ID.test(vmId)) throw new VmNicError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  const database = options.database || getDb();
  const registry = options.registry || registrySingleton;
  const inventory = await registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database });
  const vm = inventory.items.find(item => item.id === vmId);
  if (!vm) throw new VmNicError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  if (vm.identity?.stability === 'transient') {
    throw new VmNicError('Stable VM identity is required for NIC link operations', 'UNSTABLE_RESOURCE_IDENTITY', 409);
  }
  const [hardware, capabilities] = await Promise.all([
    registry.vmHardwareForHost(host, vm, { database }), registry.capabilitiesForHost(host),
  ]);
  let policy;
  try {
    policy = (options.policy || policySingleton).evaluate({ providerType: host.daemon_type, hostId: Number(host.id) });
  } catch {
    policy = { allowed: false, code: 'POLICY_UNAVAILABLE', mode: 'unknown', reason: 'Operation policy is unavailable' };
  }
  return {
    host, database, vm, hardware, capabilities, policy,
    activeOperations: _activeOperations(options.operations || operationsSingleton, Number(host.id), vmId),
    canOperate: options.canOperate === true, enabled: _releaseEnabled(host.daemon_type, options),
  };
}

function _nic(context, nicIdInput) {
  const nicId = String(nicIdInput || '');
  if (!SAFE_NIC_ID.test(nicId)) throw new VmNicError('Network interface was not found', 'PROVIDER_VM_NIC_NOT_FOUND', 404);
  const nic = context.hardware.nics.find(item => item.id === nicId);
  if (!nic) throw new VmNicError('Network interface was not found', 'PROVIDER_VM_NIC_NOT_FOUND', 404);
  return nic;
}

function _safety(context, nic) {
  const fingerprint = _fingerprint(context.vm.id, nic);
  const row = _declarationRow(context.database, Number(context.host.id), context.vm.id, nic.id);
  return { fingerprint, declaration: _declaration(row, fingerprint) };
}

async function inventoryForHost(host, vmId, options = {}) {
  const context = await _context(host, vmId, options);
  return {
    schemaVersion: '1.0', hostId: Number(host.id), providerType: host.daemon_type,
    vm: { id: context.vm.id, displayName: context.vm.displayName, powerState: context.vm.status?.powerState || 'unknown' },
    summary: context.hardware.summary, sections: context.hardware.sections,
    nics: context.hardware.nics.map(nic => ({ ...nic, safety: _safety(context, nic).declaration })),
    release: { enabled: context.enabled, flag: `DD_PROVIDER_VM_NIC_LINK_${host.daemon_type.toUpperCase()}` },
    observedAt: context.hardware.observedAt,
    limitations: [
      'Only link state is mutable; NIC attach, detach, delete, network mapping and guest configuration are out of scope.',
      'Disconnect requires a current admin declaration for non-management, non-boot and no known guest dependency.',
    ],
  };
}

async function declareSafetyForHost(host, vmId, nicId, input = {}, options = {}) {
  const context = await _context(host, vmId, options);
  if (!context.canOperate) throw new VmNicError('Admin operate permission is required', 'PERMISSION_BLOCKED', 403);
  const nic = _nic(context, nicId);
  const managementRole = String(input.managementRole || '');
  const bootDependency = String(input.bootDependency || '');
  const guestDependency = String(input.guestDependency || '');
  if (!['management', 'non_management'].includes(managementRole)
    || !['required', 'not_required'].includes(bootDependency)
    || !['required', 'not_required'].includes(guestDependency)) {
    throw new VmNicError('Safety declaration fields must be explicit', 'INVALID_VM_NIC_SAFETY_DECLARATION');
  }
  const reason = _text(input.reason, 8, 500, 'safety reason');
  const maxHours = Number(config.providerVmNics?.safetyDeclarationMaxHours || 4);
  const validForHours = Number(input.validForHours ?? maxHours);
  if (!Number.isInteger(validForHours) || validForHours < 1 || validForHours > maxHours) {
    throw new VmNicError(`Safety declaration validity must be 1-${maxHours} hours`, 'INVALID_VM_NIC_SAFETY_TTL');
  }
  const fingerprint = _fingerprint(context.vm.id, nic);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + validForHours * 60 * 60 * 1000).toISOString();
  context.database.prepare(`INSERT INTO provider_vm_nic_safety_declarations
    (host_id,vm_id,nic_id,nic_fingerprint,management_role,boot_dependency,guest_dependency,reason,expires_at,declared_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(host_id,vm_id,nic_id) DO UPDATE SET
      nic_fingerprint=excluded.nic_fingerprint, management_role=excluded.management_role,
      boot_dependency=excluded.boot_dependency, guest_dependency=excluded.guest_dependency,
      reason=excluded.reason, expires_at=excluded.expires_at, declared_by=excluded.declared_by,
      updated_at=excluded.updated_at`)
    .run(Number(host.id), context.vm.id, nic.id, fingerprint, managementRole, bootDependency,
      guestDependency, reason, expiresAt, options.createdBy || null, now, now);
  return {
    schemaVersion: '1.0', vm: { id: context.vm.id, displayName: context.vm.displayName },
    nic: { id: nic.id, label: nic.label, macAddress: nic.macAddress, network: nic.network },
    safety: _safety(context, nic).declaration,
  };
}

function _semanticPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion, hostId: plan.hostId, providerType: plan.providerType,
    vm: plan.vm, nic: plan.nic, action: plan.action, expectedConnected: plan.expectedConnected,
    capability: { key: plan.capability.key, state: plan.capability.state },
    safety: plan.safety, noChange: plan.noChange, allowed: plan.allowed,
    blockers: plan.blockers, warnings: plan.warnings, confirmation: plan.confirmation,
    rollbackPlan: plan.rollbackPlan, validUntil: plan.validUntil,
  };
}

async function preflightForHost(host, vmId, nicId, actionInput, options = {}) {
  const action = _action(actionInput);
  const definition = ACTIONS[action];
  const context = await _context(host, vmId, options);
  const nic = _nic(context, nicId);
  const capability = context.capabilities.features?.[definition.capability]
    || { state: 'unknown', reason: 'NIC link capability evidence is unavailable' };
  const currentConnected = nic.attachment?.connected;
  const noChange = currentConnected === definition.expectedConnected;
  const safety = _safety(context, nic);
  const blockers = [];
  if (!context.enabled) blockers.push(_blocker('RELEASE_DISABLED', 'VM NIC link control is disabled for this provider', {
    flag: `DD_PROVIDER_VM_NIC_LINK_${host.daemon_type.toUpperCase()}`,
  }));
  if (!context.canOperate) blockers.push(_blocker('PERMISSION_BLOCKED', 'Operate permission is required for this endpoint'));
  if (!context.policy.allowed) blockers.push(_blocker('POLICY_BLOCKED', context.policy.reason,
    { code: context.policy.code, mode: context.policy.mode }));
  if (!['supported', 'conditional'].includes(capability.state)) blockers.push(_blocker(
    capability.state === 'unknown' ? 'CAPABILITY_UNKNOWN' : 'CAPABILITY_UNSUPPORTED',
    capability.reason || 'NIC link action is unavailable', { capability: definition.capability, state: capability.state }));
  if (nic.capabilities?.connectDisconnect !== true) blockers.push(_blocker('VM_NIC_LINK_CAPABILITY_UNPROVEN',
    'The provider did not positively advertise connect/disconnect for this NIC'));
  if (typeof currentConnected !== 'boolean') blockers.push(_blocker('VM_NIC_LINK_STATE_UNKNOWN',
    'Current NIC link state must be positively known'));
  if (context.activeOperations.length) blockers.push(_blocker('OPERATION_CONFLICT',
    'Another provider operation is active for this VM', context.activeOperations[0]));
  if (action === 'disconnect' && !noChange) {
    const connectedCount = context.hardware.nics.filter(item => item.attachment?.connected === true).length;
    if (connectedCount <= 1) blockers.push(_blocker('LAST_CONNECTED_NIC',
      'Disconnecting the last connected NIC is forbidden', { connectedNicCount: connectedCount }));
    if (!safety.declaration.valid) blockers.push(_blocker('VM_NIC_SAFETY_DECLARATION_REQUIRED',
      'A current non-management, non-boot, no-guest-dependency declaration is required', {
        state: safety.declaration.state,
      }));
  }
  const warnings = [action === 'connect'
    ? { type: 'NETWORK_EXPOSURE', reason: 'Connecting the NIC can immediately expose the guest to the selected virtual network' }
    : { type: 'GUEST_CONNECTIVITY_LOSS', reason: 'Disconnecting the NIC can interrupt active guest sessions and services' }];
  const label = nic.label || nic.device || nic.id;
  const ttl = 5 * 60 * 1000;
  const plan = {
    schemaVersion: '1.0', hostId: Number(host.id), providerType: host.daemon_type,
    vm: { id: context.vm.id, displayName: context.vm.displayName, powerState: context.vm.status?.powerState || 'unknown' },
    nic: {
      id: nic.id, label, device: nic.device, macAddress: nic.macAddress,
      network: nic.network, currentConnected, fingerprint: safety.fingerprint,
    },
    action, expectedConnected: definition.expectedConnected,
    capability: { key: definition.capability, state: capability.state, reason: capability.reason || null },
    safety: safety.declaration, noChange, allowed: blockers.length === 0, blockers, warnings,
    confirmation: { required: true, mode: 'typed_vm_and_nic', expected: `${context.vm.displayName}/${label}` },
    rollbackPlan: {
      automatic: false, action: action === 'connect' ? 'disconnect' : 'connect', nicId: nic.id,
      reason: 'Rollback requires a fresh preflight because provider outcome can be ambiguous',
    },
    validUntil: new Date((Math.floor(Date.now() / ttl) + 1) * ttl).toISOString(),
  };
  plan.planHash = sha256(_canonical(_semanticPlan(plan)));
  return plan;
}

function _assertSubmission(plan, input = {}) {
  if (!plan.allowed) throw new VmNicError('VM NIC link preflight is blocked', 'VM_NIC_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new VmNicError('VM NIC link preflight changed; review the new plan', 'VM_NIC_PREFLIGHT_STALE', 409);
  }
  if (input.confirm !== true) throw new VmNicError('VM NIC link operation requires confirm=true', 'VM_NIC_CONFIRMATION_REQUIRED');
  if (input.confirmText !== plan.confirmation.expected) {
    throw new VmNicError('Type the exact VM/NIC confirmation text', 'VM_NIC_TYPED_CONFIRMATION_REQUIRED');
  }
}

async function submitForHost(host, vmId, nicId, input = {}, options = {}) {
  const plan = await preflightForHost(host, vmId, nicId, input.action, options);
  _assertSubmission(plan, input);
  const engine = options.operations || operationsSingleton;
  return {
    plan,
    operation: engine.create({
      type: TYPE, providerType: host.daemon_type, hostId: Number(host.id),
      resourceKind: 'virtualMachine', resourceId: plan.vm.id, action: plan.action,
      idempotencyKey: input.idempotencyKey,
      request: {
        planHash: plan.planHash, nicId: plan.nic.id, nicFingerprint: plan.nic.fingerprint,
        expectedConnected: plan.expectedConnected, previousConnected: plan.nic.currentConnected,
        safetyDeclarationId: plan.safety?.valid ? plan.safety.id : null,
        rollbackAction: plan.rollbackPlan.action,
      },
      lockScopes: [`resource:${plan.vm.id}`, `device:${plan.nic.id}`], createdBy: options.createdBy,
    }),
  };
}

module.exports = {
  ACTIONS, VmNicError, inventoryForHost, declareSafetyForHost, preflightForHost, submitForHost,
  _internals: {
    _canonical, _fingerprint, _declaration, _releaseEnabled, _semanticPlan, _assertSubmission,
  },
};
