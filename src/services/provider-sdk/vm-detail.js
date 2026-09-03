'use strict';

const { getDb } = require('../../db');
const config = require('../../config');
const registrySingleton = require('./registry');
const snapshotsSingleton = require('./resource-snapshots');
const operationsSingleton = require('../provider-operations');
const policySingleton = require('../provider-operations/policy');
const vmSnapshotStore = require('./vm-snapshot-store');

const DETAIL_SCHEMA_VERSION = '1.0';
const MAX_DETAIL_BYTES = 512 * 1024;
const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const FRESH_MS = 2 * 60 * 1000;

class ProviderVmDetailError extends Error {
  constructor(message, code = 'PROVIDER_VM_DETAIL_ERROR', status = 400) {
    super(message);
    this.name = 'ProviderVmDetailError';
    this.code = code;
    this.status = status;
  }
}

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(token|apiKey|secret|password)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _blocker(type, reason, evidence = null) {
  return { type, reason: _text(reason) || 'Action is unavailable', evidence };
}

function _capabilityBlocker(evidence, key) {
  if (evidence && ['supported', 'conditional'].includes(evidence.state)) return null;
  if (evidence?.state === 'unknown') {
    return _blocker('CAPABILITY_UNKNOWN', evidence.reason || `${key} could not be verified`, { capability: key, state: 'unknown' });
  }
  return _blocker('CAPABILITY_UNSUPPORTED', evidence?.reason || `${key} is unsupported`, {
    capability: key, state: evidence?.state || 'unsupported',
  });
}

function _stateAllows(action, state) {
  if (action === 'start') return ['stopped', 'suspended', 'offline'].includes(state);
  return ['running', 'paused'].includes(state);
}

function _resourceAllows(resource, names) {
  const available = new Set(resource.actions || []);
  return names.some(name => available.has(name));
}

function _actions(resource, capabilities, policy, canOperate, enabled = config.features.providerVmPower) {
  const definitions = [
    { key: 'vm.power.start', action: 'start', label: 'Start', names: ['start'], stateAction: 'start' },
    { key: 'vm.power.shutdown', action: 'shutdown', label: 'Shut down', names: ['shutdown', 'cleanShutdown'], stateAction: 'shutdown' },
    { key: 'vm.power.reboot', action: 'reboot', label: 'Reboot', names: ['reboot', 'cleanReboot'], stateAction: 'reboot' },
    { key: 'vm.power.force', action: 'forceShutdown', label: 'Force off', names: ['forceShutdown', 'stop'], stateAction: 'force' },
    { key: 'vm.power.force', action: 'forceReboot', label: 'Force reboot', names: ['forceReboot', 'reset'], stateAction: 'force' },
  ];
  return definitions.map(definition => {
    const blockers = [];
    const capabilityBlocker = _capabilityBlocker(capabilities?.features?.[definition.key], definition.key);
    if (capabilityBlocker) blockers.push(capabilityBlocker);
    const state = resource.status?.powerState || 'unknown';
    if (!_stateAllows(definition.stateAction, state)) {
      blockers.push(_blocker('RESOURCE_STATE_BLOCKED', `${definition.label} is unavailable while the VM is ${state}`, { state }));
    }
    if (!_resourceAllows(resource, definition.names)) {
      blockers.push(_blocker('RESOURCE_ACTION_BLOCKED', 'The provider did not advertise this action for the VM'));
    }
    if (resource.identity?.stability === 'transient') {
      blockers.push(_blocker('UNSTABLE_RESOURCE_IDENTITY',
        'Durable power operations require a VM identity that survives provider and worker restarts',
        { stability: 'transient' }));
    }
    if (!policy.allowed) {
      blockers.push(_blocker('POLICY_BLOCKED', policy.reason, { code: policy.code, mode: policy.mode }));
    }
    if (!canOperate) blockers.push(_blocker('PERMISSION_BLOCKED', 'Operate permission is required for this endpoint'));
    if (!enabled) blockers.push(_blocker('ACTION_NOT_ENABLED', 'Common VM power actions are disabled by release policy'));
    return { key: definition.key, action: definition.action, label: definition.label, available: blockers.length === 0, blockers };
  });
}

function _section(available, options = {}) {
  const section = {
    available: !!available,
    capability: options.capability || null,
    reason: available ? null : (_text(options.reason) || 'Section is unavailable'),
  };
  if (options.data !== undefined) section.data = options.data;
  if (options.items !== undefined) section.items = options.items;
  if (options.providerState !== undefined) section.providerState = options.providerState;
  return section;
}

function _sections(resource, capabilities, activity, vmSnapshots = [], vmHardware = null, hardwareError = null) {
  const labels = resource.labels || {};
  const snapshotEvidence = capabilities?.features?.['vm.snapshot.list'];
  const eventEvidence = capabilities?.features?.['event.stream'];
  return {
    overview: _section(true, { data: {
      id: resource.id, displayName: resource.displayName,
      provider: resource.provider, observedAt: resource.observedAt,
      powerState: resource.status?.powerState || 'unknown',
      health: resource.status?.health || 'unknown', ipAddress: resource.status?.ipAddress || null,
      guestOS: resource.spec?.guestOS || null, guestHostname: resource.extensions?.guestHostname || null,
      placement: resource.relationships || {},
      ownership: {
        owner: labels.owner || null, service: labels.service || null,
        costCenter: labels.costCenter || labels.cost_center || null,
        pager: labels.pager || null, runbook: labels.runbook || null,
      },
      labels,
    } }),
    hardware: _section(true, { data: {
      cpuCount: resource.spec?.cpuCount ?? null,
      memoryBytes: resource.spec?.memoryBytes ?? null,
      cpuUsageMHz: resource.extensions?.cpuUsageMHz ?? null,
      memoryUsageBytes: resource.extensions?.memoryUsageBytes ?? null,
      hardwareVersion: resource.extensions?.hardwareVersion || null,
      toolsStatus: resource.extensions?.toolsStatus || null,
      toolsVersion: resource.extensions?.toolsVersion || null,
    } }),
    disks: _section(vmHardware?.sections?.disks?.available === true, {
      capability: 'vm.disk.read',
      reason: hardwareError || vmHardware?.sections?.disks?.reason
        || capabilities?.features?.['vm.disk.read']?.reason || 'Portable disk detail is unavailable',
      items: vmHardware?.disks || [], data: vmHardware ? {
        ...vmHardware.summary, warnings: vmHardware.sections?.disks?.warnings || [],
        truncated: vmHardware.sections?.disks?.truncated === true,
      } : null,
    }),
    network: _section(vmHardware?.sections?.network?.available === true, {
      capability: 'vm.nic.read',
      reason: hardwareError || vmHardware?.sections?.network?.reason
        || capabilities?.features?.['vm.nic.read']?.reason || 'Portable NIC detail is unavailable',
      items: vmHardware?.nics || [], data: vmHardware ? {
        ...vmHardware.summary, warnings: vmHardware.sections?.network?.warnings || [],
        truncated: vmHardware.sections?.network?.truncated === true,
      } : null,
    }),
    snapshots: _section(snapshotEvidence && ['supported', 'conditional'].includes(snapshotEvidence.state), {
      capability: 'vm.snapshot.list',
      reason: snapshotEvidence?.reason || 'Portable snapshot detail is not implemented by the common provider adapter',
      items: vmSnapshots,
      providerState: { consolidationNeeded: resource.extensions?.consolidationNeeded === true },
    }),
    tasks: _section(true, { items: activity }),
    events: _section(false, {
      capability: 'event.stream',
      reason: eventEvidence?.reason || 'Portable VM event streaming is not implemented by the common provider adapter',
      items: [],
    }),
  };
}

function _freshness(resource, refreshError) {
  const ageMs = Math.max(0, Date.now() - Date.parse(resource.observedAt));
  return {
    state: ageMs <= FRESH_MS && !refreshError ? 'fresh' : 'stale',
    observedAt: resource.observedAt, ageSeconds: Math.floor(ageMs / 1000),
    refreshError: refreshError ? { code: refreshError.code || 'PROVIDER_RESOURCE_READ_FAILED', message: 'Live inventory refresh failed; cached data is shown' } : null,
  };
}

async function detailForHost(host, canonicalId, options = {}) {
  const id = String(canonicalId || '');
  if (!host || !Number.isInteger(Number(host.id))) {
    throw new ProviderVmDetailError('Valid provider host required', 'INVALID_HOST');
  }
  if (!SAFE_VM_ID.test(id)) {
    throw new ProviderVmDetailError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  }
  const database = options.database || getDb();
  const registry = options.registry || registrySingleton;
  const snapshots = options.snapshots || snapshotsSingleton;
  const operations = options.operations || operationsSingleton;
  const policyService = options.policy || policySingleton;
  let resource = snapshots.get(id, Number(host.id), 'virtualMachine', database);
  let refreshError = null;

  if (options.refresh === true || !resource) {
    try {
      const inventory = await registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database });
      const refreshed = inventory.items.find(item => item.id === id) || null;
      if (!refreshed) {
        if (!resource) throw new ProviderVmDetailError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
      } else resource = refreshed;
    } catch (err) {
      if (!resource || err instanceof ProviderVmDetailError) throw err;
      refreshError = err;
    }
  }
  if (!resource) throw new ProviderVmDetailError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);

  let capabilities;
  try { capabilities = await registry.capabilitiesForHost(host); }
  catch {
    capabilities = { schemaVersion: '1.0', provider: resource.provider, probe: { status: 'unreachable' }, features: {} };
  }
  let activity = [];
  try {
    activity = operations.list({ hostId: Number(host.id), limit: 100 })
      .filter(operation => operation.resource?.id === id).slice(0, 50);
  } catch { /* migration-safe read-only activity */ }
  let policy;
  try { policy = policyService.evaluate({ providerType: host.daemon_type, hostId: Number(host.id) }); }
  catch { policy = { allowed: false, code: 'POLICY_UNAVAILABLE', mode: 'unknown', reason: 'Operation policy could not be evaluated' }; }
  let vmSnapshots = [];
  try { vmSnapshots = vmSnapshotStore.list(Number(host.id), id, database).slice(0, 128); }
  catch { /* migration-safe empty snapshot section */ }
  let vmHardware = null;
  let hardwareError = null;
  try {
    vmHardware = await registry.vmHardwareForHost(host, resource, { database, capabilities });
  } catch (err) {
    hardwareError = ['PROVIDER_VM_HARDWARE_UNAVAILABLE'].includes(err?.code)
      ? null : 'Live device inventory could not be read; other VM detail remains available';
  }

  const envelope = {
    schemaVersion: DETAIL_SCHEMA_VERSION,
    resource, capabilities, freshness: _freshness(resource, refreshError),
    actions: _actions(resource, capabilities, policy, options.canOperate === true, options.powerEnabled),
    sections: _sections(resource, capabilities, activity, vmSnapshots, vmHardware, hardwareError),
    activity,
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_DETAIL_BYTES) {
    throw new ProviderVmDetailError('Virtual machine detail exceeds the response size limit', 'PROVIDER_VM_DETAIL_TOO_LARGE', 502);
  }
  return envelope;
}

module.exports = {
  detailForHost, ProviderVmDetailError, DETAIL_SCHEMA_VERSION, MAX_DETAIL_BYTES,
  _internals: { _text, _actions, _sections, _freshness, _stateAllows, _resourceAllows },
};
