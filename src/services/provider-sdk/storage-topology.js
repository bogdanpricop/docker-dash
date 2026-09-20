'use strict';

// This projection intentionally does not expose provider VMDK/VDI/volume
// references.  Normalized hardware gives each backing a host-scoped opaque ID.
// A common backing is only called shared when every observed attachment carries
// the provider's explicit shared declaration; other collisions remain review
// evidence, never a claim of safe multi-writer configuration.

const { getDb } = require('../../db');
const registry = require('./registry');
const identityStore = require('./identity-store');

const SCHEMA_VERSION = '1.0';
const MAX_VMS = 100;
const MAX_GROUPS = 100;
const CONCURRENCY = 4;
const CAPABILITY_STATES = new Set(['supported', 'conditional', 'unsupported', 'unknown']);

class StorageTopologyError extends Error {
  constructor(message, code = 'STORAGE_TOPOLOGY_UNAVAILABLE', status = 400) {
    super(message);
    this.name = 'StorageTopologyError';
    this.code = code;
    this.status = status;
  }
}

function _capability(capabilities, key) {
  const item = capabilities?.features?.[key] || {};
  return {
    state: CAPABILITY_STATES.has(item.state) ? item.state : 'unknown',
    reason: item.reason || 'No capability evidence was provided',
  };
}

async function _mapBounded(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      try { results[current] = { value: await mapper(items[current]) }; }
      catch (error) { results[current] = { error }; }
    }
  }));
  return results;
}

function _storageMap(host, inventory, database) {
  const values = new Map();
  for (const storage of inventory.items || []) {
    const identity = identityStore.resolveCanonical(storage.id, { hostId: Number(host.id), kind: 'storage' }, database);
    if (!identity?.nativeRef) continue;
    values.set(identity.nativeRef, { id: storage.id, displayName: storage.displayName });
  }
  return values;
}

function _attachment(vm, disk, storages) {
  const storage = storages.get(disk.backing?.storageId) || null;
  return {
    vm: { id: vm.id, displayName: vm.displayName },
    disk: { id: disk.id, label: disk.label, device: disk.device },
    storage,
    attachment: { connected: disk.attachment?.connected ?? null, readOnly: disk.attachment?.readOnly ?? null, shared: disk.attachment?.shared ?? null },
  };
}

function _groups(hardwareRows, storages) {
  const grouped = new Map();
  for (const { vm, hardware } of hardwareRows) {
    if (hardware.sections?.disks?.available === false) continue;
    for (const disk of hardware.disks || []) {
      if (!disk.backing?.id || disk.type === 'cdrom') continue;
      const attachments = grouped.get(disk.backing.id) || [];
      attachments.push(_attachment(vm, disk, storages));
      grouped.set(disk.backing.id, attachments);
    }
  }
  return [...grouped.entries()].filter(([, attachments]) => attachments.length > 1).map(([id, attachments]) => {
    const confirmed = attachments.every(item => item.attachment.shared === true);
    return {
      id,
      state: confirmed ? 'confirmed' : 'review',
      reason: confirmed
        ? 'Every observed attachment is explicitly declared shared by the provider'
        : 'A common backing was observed, but the provider did not declare every attachment shared',
      consumerCount: attachments.length,
      attachments,
    };
  }).sort((a, b) => b.consumerCount - a.consumerCount || a.id.localeCompare(b.id)).slice(0, MAX_GROUPS);
}

async function topologyForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new StorageTopologyError('Valid provider host required', 'INVALID_HOST');
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  if (capabilities.probe?.status !== 'reachable') throw new StorageTopologyError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  const evidence = _capability(capabilities, 'storage.sharedTopology.read');
  if (!['supported', 'conditional'].includes(evidence.state)) {
    throw new StorageTopologyError(evidence.reason || 'Shared-disk topology is unavailable for this provider');
  }
  const database = options.database || getDb();
  const [vmInventory, storageInventory] = await Promise.all([
    registry.resourcesForHost(host, 'virtual-machines', { limit: options.limit || MAX_VMS, database }),
    registry.resourcesForHost(host, 'storage', { limit: 500, database }),
  ]);
  const readings = await _mapBounded(vmInventory.items, CONCURRENCY, async vm => ({
    vm, hardware: await registry.vmHardwareForHost(host, vm, { capabilities, database }),
  }));
  const successful = readings.filter(item => item.value).map(item => item.value);
  const unavailable = readings.filter(item => item.error).length;
  const groups = _groups(successful, _storageMap(host, storageInventory, database));
  const confirmed = groups.filter(item => item.state === 'confirmed').length;
  const review = groups.length - confirmed;
  const complete = vmInventory.truncated !== true && unavailable === 0
    && successful.every(item => item.hardware.sections?.disks?.available !== false && item.hardware.sections?.disks?.truncated !== true);
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: vmInventory.provider,
    observedAt: new Date().toISOString(),
    capability: evidence,
    coverage: {
      vmCount: vmInventory.count, totalObserved: vmInventory.totalObserved,
      truncated: vmInventory.truncated === true, hardwareUnavailable: unavailable, complete,
    },
    summary: { sharedBackingCount: groups.length, confirmedCount: confirmed, reviewCount: review },
    sharedBackings: groups,
    limitations: [
      'Backing identities and provider-native paths are never returned; identifiers are opaque and host-scoped.',
      'A backing is confirmed shared only when every observed attachment is explicitly declared shared by the provider.',
      complete ? 'All selected VM disk inventories were read.' : 'This is partial evidence; unobserved or unreadable VM disk inventories can hide additional consumers.',
    ],
  };
}

module.exports = { SCHEMA_VERSION, MAX_VMS, StorageTopologyError, topologyForHost, _internals: { _groups, _mapBounded, _storageMap } };
