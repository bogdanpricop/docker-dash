'use strict';

const identityStore = require('./identity-store');
const { resourceKind } = require('./resource-catalog');

const RESOURCE_SCHEMA_VERSION = '1.0';
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;
const SAFE_ACTION = /^[a-z][a-zA-Z0-9._-]{0,79}$/;

function _string(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _number(value, options = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (options.min !== undefined && number < options.min) return null;
  if (options.max !== undefined && number > options.max) return null;
  return options.integer ? Math.round(number) : number;
}

function _bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function _timestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function _redact(value) {
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(token|apiKey|secret|password)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
}

function _summary(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) return _string(_redact(value.filter(v => ['string', 'number', 'boolean'].includes(typeof v)).join('; ')), max);
  if (typeof value === 'object') {
    const parts = ['code', 'status', 'message', 'name'].filter(key => value[key] !== undefined)
      .map(key => `${key}: ${value[key]}`);
    return parts.length ? _string(_redact(parts.join('; ')), max) : 'Provider returned structured details';
  }
  return _string(_redact(value), max);
}

function _powerState(value) {
  const raw = _string(value, 80);
  if (!raw) return 'unknown';
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, '');
  const states = {
    running: 'running', poweredon: 'running', started: 'running', up: 'running',
    halted: 'stopped', stopped: 'stopped', poweredoff: 'stopped', shutdown: 'stopped', down: 'stopped',
    paused: 'paused', suspended: 'suspended', disabled: 'disabled', offline: 'offline',
    online: 'running', connected: 'running', disconnected: 'offline', notresponding: 'offline',
  };
  return states[normalized] || 'unknown';
}

function _taskState(value) {
  const raw = _string(value, 80);
  if (!raw) return 'unknown';
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, '');
  const states = {
    pending: 'pending', queued: 'pending', running: 'running', started: 'running',
    success: 'succeeded', succeeded: 'succeeded', completed: 'succeeded', complete: 'succeeded',
    failure: 'failed', failed: 'failed', error: 'failed', cancelled: 'cancelled', canceled: 'cancelled',
  };
  return states[normalized] || 'unknown';
}

function _actions(value) {
  const values = Array.isArray(value) ? value : Object.keys(value || {});
  return [...new Set(values.map(v => _string(v, 80)).filter(v => v && SAFE_ACTION.test(v)))].sort().slice(0, 64);
}

function _labels(raw) {
  const output = {};
  const source = raw?.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels) ? raw.labels : {};
  for (const [key, value] of Object.entries(source).slice(0, 64)) {
    const safeKey = _string(key, 64);
    const safeValue = _string(value, 240);
    if (/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(safeKey || '') && safeValue !== null) output[safeKey] = safeValue;
  }
  for (const [index, tag] of (Array.isArray(raw?.tags) ? raw.tags : []).slice(0, 64 - Object.keys(output).length).entries()) {
    const value = _string(tag, 240);
    if (value) output[`tag${index}`] = value;
  }
  return output;
}

function _relation(value) {
  const text = _string(value, 160);
  if (!text) return null;
  if (/^ddr_(vm|host|cluster|storage|network|task)_[a-f0-9]{26}$/.test(text)) return text;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5a-f][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(text)) return text;
  return null;
}

const RELATION_KINDS = Object.freeze({
  host: 'host', cluster: 'cluster', coordinator: 'host', defaultStorage: 'storage',
});

function _canonicalRelation(value, relationship, context) {
  const text = _string(value, 2048);
  if (!text) return null;
  if (/^ddr_(vm|host|cluster|storage|network|task)_[a-f0-9]{26}$/.test(text)) return text;
  const kind = RELATION_KINDS[relationship];
  if (!kind) return null;
  const isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5a-f][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(text);
  return identityStore.remember({
    hostId: Number(context.host.id), providerType: context.providerType, kind,
    nativeRef: text, uuid: isUuid ? text : null, stability: isUuid ? 'stable' : 'derived',
  }, context.database).id;
}

function _extensions(kind, raw) {
  const output = {};
  const addString = (key, value, max = 160) => { const safe = _string(value, max); if (safe !== null) output[key] = safe; };
  const addNumber = (key, value) => { const safe = _number(value, { min: 0 }); if (safe !== null) output[key] = safe; };
  if (kind === 'virtualMachine') {
    addString('guestHostname', raw.guestHostname);
    addString('toolsStatus', raw.toolsStatus);
    addString('toolsVersion', raw.toolsVersion);
    addString('hardwareVersion', raw.hwVersion);
    addString('node', raw.node);
    addString('guestType', raw.type);
    addNumber('cpuUsageMHz', raw.cpuUsageMHz);
    addNumber('memoryUsageBytes', raw.memoryUsageBytes ?? (_number(raw.memoryUsageMB, { min: 0 }) !== null ? Number(raw.memoryUsageMB) * 1024 * 1024 : null));
    addNumber('storageCommittedBytes', raw.storageCommittedBytes);
    addNumber('storageUncommittedBytes', raw.storageUncommittedBytes);
    if (raw.consolidationNeeded === true) output.consolidationNeeded = true;
    addNumber('domainId', raw.domid);
    addNumber('cpuTimeSeconds', raw.cpuTimeSeconds);
  } else if (kind === 'host') {
    addString('model', raw.model);
    addString('cpuModel', raw.cpuModel);
    addString('apiVersion', raw.apiVersion);
    addString('build', raw.build);
    addNumber('cpuThreadCount', raw.cpuThreads);
    addNumber('cpuPackageCount', raw.cpuPackages);
    addNumber('cpuMHz', raw.cpuMHz);
    addNumber('cpuUsageMHz', raw.cpuUsageMHz);
    addNumber('cpuTotalMHz', raw.cpuTotalMHz);
    addNumber('uptimeSeconds', raw.uptimeSeconds);
    const bootTime = _timestamp(raw.bootTime); if (bootTime) output.bootTime = bootTime;
  } else if (kind === 'storage') {
    addNumber('virtualAllocationBytes', raw.virtualAllocationBytes);
    addString('contentType', raw.contentType);
    addString('node', raw.node);
  }
  return output;
}

function _identityInput(kind, raw) {
  const transient = raw?.transient === true;
  const uuid = transient ? null : _string(raw?.uuid ?? raw?.hostUuid, 512);
  let nativeRef = raw?.ref ?? raw?.moref ?? raw?.id ?? raw?.vmid ?? raw?.node ?? raw?.storage ?? uuid;
  if (nativeRef === null || nativeRef === undefined || nativeRef === '') nativeRef = raw?.name;
  return {
    uuid,
    nativeRef: _string(nativeRef, 2048),
    stability: transient ? 'transient' : (uuid ? 'stable' : 'derived'),
    kind,
  };
}

function _model(kind, raw) {
  if (kind === 'virtualMachine') {
    return {
      spec: {
        cpuCount: _number(raw.cpus ?? raw.numCPU ?? raw.maxcpu, { min: 0, integer: true }),
        memoryBytes: _number(raw.memoryBytes ?? (raw.memoryMB !== undefined ? Number(raw.memoryMB) * 1024 * 1024 : raw.maxmem), { min: 0 }),
        guestOS: _string(raw.guestOS, 240),
      },
      status: {
        powerState: _powerState(raw.powerState ?? raw.status),
        ipAddress: _string(raw.ipAddress, 128),
        health: _string(raw.health, 80) || 'unknown',
        cpuUtilizationPercent: _number(raw.cpuUtilizationPercent
          ?? raw.cpuPercent ?? (raw.cpu !== undefined ? Number(raw.cpu) * 100 : null), { min: 0, max: 100 }),
        memoryUtilizationPercent: _number(raw.memoryUtilizationPercent
          ?? (raw.memoryUsageBytes !== undefined && raw.memoryBytes ? Number(raw.memoryUsageBytes) / Number(raw.memoryBytes) * 100 : null), { min: 0, max: 100 }),
      },
      actions: _actions(raw.allowedActions),
      relationships: { host: raw.hostUuid ?? raw.hostId ?? raw.hostRef ?? raw.node, cluster: raw.poolUuid ?? raw.poolId ?? raw.poolRef },
    };
  }
  if (kind === 'host') {
    const memoryBytes = _number(raw.memoryBytes ?? raw.memoryTotal ?? raw.maxmem, { min: 0 });
    const memoryUsedBytes = _number(raw.memoryUsedBytes
      ?? (raw.memoryUsageMB !== undefined ? Number(raw.memoryUsageMB) * 1024 * 1024 : raw.mem), { min: 0 });
    const maintenance = typeof raw.maintenanceMode === 'boolean'
      ? (raw.maintenanceMode ? 'maintenance' : 'normal') : raw.maintenanceMode;
    return {
      spec: {
        address: _string(raw.address ?? raw.node, 240),
        cpuCount: _number(raw.cpus ?? raw.cpuThreads ?? raw.maxcpu, { min: 0, integer: true }),
        cpuCoreCount: _number(raw.cpuCores, { min: 0, integer: true }),
        memoryBytes,
        product: _string(raw.product, 160), version: _string(raw.version ?? raw.productVersion, 120),
      },
      status: {
        powerState: _powerState(raw.powerState ?? raw.status ?? raw.connectionState),
        enabled: _bool(raw.enabled), maintenanceMode: _string(maintenance, 80),
        memoryFreeBytes: _number(raw.memoryFreeBytes ?? (raw.memoryFree !== undefined ? Number(raw.memoryFree)
          : (memoryBytes !== null && memoryUsedBytes !== null ? memoryBytes - memoryUsedBytes : null)), { min: 0 }),
        cpuUtilizationPercent: _number(raw.cpuUtilizationPercent
          ?? raw.cpuPercent ?? (raw.cpu !== undefined ? Number(raw.cpu) * 100 : null), { min: 0, max: 100 }),
        memoryUtilizationPercent: _number(raw.memoryUtilizationPercent
          ?? (memoryBytes !== null && memoryUsedBytes !== null && memoryBytes > 0 ? memoryUsedBytes / memoryBytes * 100 : null), { min: 0, max: 100 }),
        health: _string(raw.health, 80) || 'unknown',
      },
      actions: _actions(raw.allowedActions), relationships: { cluster: raw.poolUuid ?? raw.poolId ?? raw.poolRef },
    };
  }
  if (kind === 'cluster') {
    return {
      spec: { haEnabled: _bool(raw.haEnabled) },
      status: { health: _string(raw.health, 80) || 'unknown' }, actions: _actions(raw.allowedActions),
      relationships: { coordinator: raw.masterUuid ?? raw.masterId ?? raw.masterRef, defaultStorage: raw.defaultStorageUuid ?? raw.defaultStorageId ?? raw.defaultStorageRef },
    };
  }
  if (kind === 'storage') {
    const capacity = _number(raw.totalBytes ?? raw.capacityBytes ?? raw.maxdisk, { min: 0 });
    const used = _number(raw.usedBytes ?? raw.disk ?? (capacity !== null && raw.freeSpaceBytes !== undefined ? capacity - Number(raw.freeSpaceBytes) : null), { min: 0 });
    const free = _number(raw.freeBytes ?? raw.freeSpaceBytes ?? (capacity !== null && used !== null ? capacity - used : null), { min: 0 });
    return {
      spec: { type: _string(raw.type, 120), capacityBytes: capacity, shared: _bool(raw.shared), attached: _bool(raw.attached) },
      status: { usedBytes: used, freeBytes: free, accessible: _bool(raw.accessible), maintenanceMode: _string(raw.maintenanceMode, 80), health: _string(raw.health, 80) || 'unknown' },
      actions: _actions(raw.allowedActions), relationships: { cluster: raw.poolUuid ?? raw.poolId ?? raw.poolRef },
    };
  }
  if (kind === 'network') {
    return {
      spec: { bridge: _string(raw.bridge, 160), vlanId: _number(raw.vlanId ?? raw.vlan, { min: 0, max: 4094, integer: true }), mtu: _number(raw.mtu, { min: 576, max: 65535, integer: true }), cidr: _string(raw.cidr, 128), managed: _bool(raw.managed) },
      status: { accessible: _bool(raw.accessible), health: _string(raw.health, 80) || 'unknown' },
      actions: _actions(raw.allowedActions), relationships: { cluster: raw.poolUuid ?? raw.poolId ?? raw.poolRef },
    };
  }
  return {
    spec: {},
    status: {
      state: _taskState(raw.status ?? raw.state), progress: _number(raw.progress, { min: 0, max: 1 }),
      startedAt: _timestamp(raw.startedAt), endedAt: _timestamp(raw.endedAt),
      result: _summary(raw.result), error: _summary(raw.error),
    },
    actions: _actions(raw.allowedActions), relationships: {},
  };
}

function normalizeResource({ host, providerType, kind, raw, observedAt, database }) {
  if (!host || !Number.isInteger(Number(host.id)) || !resourceKind(kind)) throw new Error('Resource normalization context is invalid');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Provider resource must be an object');
  const identityInput = _identityInput(kind, raw);
  if (!identityInput.nativeRef) throw new Error('Provider resource has no usable identity');
  const identity = identityStore.remember({
    hostId: Number(host.id), providerType, ...identityInput,
  }, database);
  const specific = _model(kind, raw);
  const relationships = Object.fromEntries(Object.entries(specific.relationships)
    .map(([relationship, value]) => [relationship, _canonicalRelation(value, relationship, {
      host, providerType, database,
    })]).filter(([, value]) => value !== null));
  const item = {
    schemaVersion: RESOURCE_SCHEMA_VERSION,
    kind,
    id: identity.id,
    displayName: _string(raw.name ?? raw.name_label ?? raw.displayName ?? identity.uuid ?? identity.id, 240),
    observedAt: observedAt || new Date().toISOString(),
    provider: { type: _string(providerType, 40), endpointId: Number(host.id) },
    identity: { uuid: identity.uuid, stability: identity.stability },
    labels: _labels(raw),
    relationships,
    spec: specific.spec,
    status: specific.status,
    actions: specific.actions,
    extensions: _extensions(kind, raw),
  };
  validateResource(item);
  return item;
}

function validateResource(item) {
  const errors = [];
  if (item?.schemaVersion !== RESOURCE_SCHEMA_VERSION) errors.push('schemaVersion');
  if (!resourceKind(item?.kind)) errors.push('kind');
  if (!/^ddr_(vm|host|cluster|storage|network|task)_[a-f0-9]{26}$/.test(item?.id || '')) errors.push('id');
  if (!item?.displayName) errors.push('displayName');
  if (Number.isNaN(Date.parse(item?.observedAt))) errors.push('observedAt');
  if (!Number.isInteger(item?.provider?.endpointId) || !item?.provider?.type) errors.push('provider');
  if (!['stable', 'derived', 'transient'].includes(item?.identity?.stability)) errors.push('identity');
  if (errors.length) throw new Error(`Invalid normalized resource: ${errors.join(', ')}`);
  return true;
}

module.exports = {
  RESOURCE_SCHEMA_VERSION, MAX_INVENTORY_BYTES, normalizeResource, validateResource,
  _internals: { _string, _number, _timestamp, _summary, _powerState, _taskState, _labels, _identityInput, _relation, _canonicalRelation },
};
