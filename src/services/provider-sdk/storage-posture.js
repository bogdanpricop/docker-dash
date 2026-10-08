'use strict';

// Storage posture is intentionally a read-only evidence projection. It does
// not infer provider health from an absent metric: unsupported QoS/multipath
// signals remain explicitly unknown instead of becoming a pass.

const registry = require('./registry');

const SCHEMA_VERSION = '1.0';
const WARNING_USED_PERCENT = 85;
const CRITICAL_USED_PERCENT = 95;
const STATES = Object.freeze(['pass', 'warning', 'fail', 'unknown']);
const CAPABILITY_STATES = Object.freeze(['supported', 'conditional', 'unsupported', 'unknown']);

class StoragePostureError extends Error {
  constructor(message, code = 'STORAGE_POSTURE_UNAVAILABLE', status = 400) {
    super(message);
    this.name = 'StoragePostureError';
    this.code = code;
    this.status = status;
  }
}

function _signal(key, state, reason, evidence = {}) {
  return { key, state, reason, evidence };
}

function _number(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function _state(signals) {
  if (signals.some(item => item.state === 'fail')) return 'fail';
  if (signals.some(item => item.state === 'warning')) return 'warning';
  if (signals.some(item => item.state === 'pass')) return 'pass';
  return 'unknown';
}

function _maintenanceState(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).toLowerCase().replace(/[\s_-]+/g, '');
  if (['maintenance', 'inmaintenance', 'enteringmaintenance'].includes(normalized)) return 'maintenance';
  if (['normal', 'active', 'available'].includes(normalized)) return 'normal';
  return normalized;
}

function _capability(capabilities, key) {
  const item = capabilities?.features?.[key] || {};
  return {
    state: CAPABILITY_STATES.includes(item.state) ? item.state : 'unknown',
    reason: item.reason || 'No capability evidence was provided',
  };
}

function assessStorage(storage, capabilities) {
  const capacityBytes = _number(storage?.spec?.capacityBytes);
  const usedBytes = _number(storage?.status?.usedBytes);
  const freeBytes = _number(storage?.status?.freeBytes);
  const virtualAllocationBytes = _number(storage?.extensions?.virtualAllocationBytes);
  const usedPercent = capacityBytes && usedBytes !== null ? Math.round(usedBytes / capacityBytes * 1000) / 10 : null;
  const signals = [];

  if (storage?.status?.accessible === true) {
    signals.push(_signal('accessibility', 'pass', 'Provider reports this storage as accessible'));
  } else if (storage?.status?.accessible === false) {
    signals.push(_signal('accessibility', 'fail', 'Provider reports this storage as inaccessible'));
  } else {
    signals.push(_signal('accessibility', 'unknown', 'Provider did not report storage accessibility'));
  }

  const maintenance = _maintenanceState(storage?.status?.maintenanceMode);
  if (maintenance === 'maintenance') signals.push(_signal('maintenance', 'warning', 'Storage is in provider maintenance mode'));
  else if (maintenance === 'normal') signals.push(_signal('maintenance', 'pass', 'Provider reports normal maintenance state'));
  else signals.push(_signal('maintenance', 'unknown', 'Provider did not report a normalized maintenance state'));

  if (usedPercent === null) {
    signals.push(_signal('capacity', 'unknown', 'Provider did not report enough capacity evidence'));
  } else if (usedPercent >= CRITICAL_USED_PERCENT) {
    signals.push(_signal('capacity', 'fail', `Used capacity is ${usedPercent}% (critical threshold ${CRITICAL_USED_PERCENT}%)`, { usedPercent }));
  } else if (usedPercent >= WARNING_USED_PERCENT) {
    signals.push(_signal('capacity', 'warning', `Used capacity is ${usedPercent}% (warning threshold ${WARNING_USED_PERCENT}%)`, { usedPercent }));
  } else {
    signals.push(_signal('capacity', 'pass', `Used capacity is ${usedPercent}%`, { usedPercent }));
  }

  if (virtualAllocationBytes === null || capacityBytes === null || capacityBytes === 0) {
    signals.push(_signal('overcommit', 'unknown', 'Provider did not report virtual allocation and physical capacity'));
  } else if (virtualAllocationBytes > capacityBytes) {
    signals.push(_signal('overcommit', 'warning', 'Virtual allocation exceeds physical capacity', {
      virtualAllocationBytes, capacityBytes,
    }));
  } else {
    signals.push(_signal('overcommit', 'pass', 'Virtual allocation does not exceed physical capacity', {
      virtualAllocationBytes, capacityBytes,
    }));
  }

  for (const [key, label] of [['storage.qos.read', 'QoS'], ['storage.multipath.read', 'Multipath']]) {
    const evidence = _capability(capabilities, key);
    signals.push(_signal(key === 'storage.qos.read' ? 'qos' : 'multipath', 'unknown',
      evidence.state === 'unsupported' ? `${label} evidence is not implemented for this provider` : `${label} evidence is not collected by this storage inventory`,
      { capability: evidence }));
  }

  return {
    id: storage.id, displayName: storage.displayName, observedAt: storage.observedAt,
    type: storage.spec?.type || null, shared: storage.spec?.shared ?? null,
    contentType: storage.extensions?.contentType || null,
    capacityBytes, usedBytes, freeBytes, virtualAllocationBytes, usedPercent,
    state: _state(signals), signals,
  };
}

function _summary(storages) {
  const states = Object.fromEntries(STATES.map(state => [state, 0]));
  for (const storage of storages) states[storage.state] += 1;
  return {
    state: _state(storages.map(storage => ({ state: storage.state }))),
    storageCount: storages.length, states,
    capacityBytes: storages.reduce((total, item) => total + (item.capacityBytes || 0), 0),
    usedBytes: storages.reduce((total, item) => total + (item.usedBytes || 0), 0),
    freeBytes: storages.reduce((total, item) => total + (item.freeBytes || 0), 0),
  };
}

async function postureForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new StoragePostureError('Valid provider host required', 'INVALID_HOST');
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  if (capabilities.probe.status !== 'reachable') throw new StoragePostureError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  const health = _capability(capabilities, 'storage.health.read');
  if (!['supported', 'conditional'].includes(health.state)) {
    throw new StoragePostureError(health.reason || 'Storage posture is unavailable for this provider', 'STORAGE_POSTURE_UNAVAILABLE');
  }
  const inventory = await registry.resourcesForHost(host, 'storage', { limit: options.limit || 500, database: options.database });
  const storages = inventory.items.map(item => assessStorage(item, capabilities));
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: inventory.provider,
    observedAt: inventory.observedAt,
    capabilities: {
      health: _capability(capabilities, 'storage.health.read'),
      policy: _capability(capabilities, 'storage.policy.read'),
      qos: _capability(capabilities, 'storage.qos.read'),
      multipath: _capability(capabilities, 'storage.multipath.read'),
    },
    summary: _summary(storages),
    storages,
    limitations: [
      'This is a read-only posture assessment from provider inventory.',
      'Unknown QoS, multipath, Ceph, Longhorn, vSAN, S2D or appliance telemetry is never treated as healthy.',
      'Capacity is an observed point-in-time signal and does not reserve storage or replace execution-time validation.',
    ],
  };
}

module.exports = {
  SCHEMA_VERSION, WARNING_USED_PERCENT, CRITICAL_USED_PERCENT, StoragePostureError, assessStorage, postureForHost,
  _internals: { _state, _maintenanceState, _summary, _capability },
};
