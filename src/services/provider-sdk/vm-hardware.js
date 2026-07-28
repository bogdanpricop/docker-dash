'use strict';

const { sha256 } = require('../../utils/crypto');

const VM_HARDWARE_SCHEMA_VERSION = '1.0';
const MAX_HARDWARE_BYTES = 512 * 1024;
const MAX_DISKS = 128;
const MAX_NICS = 64;
const MAX_ADDRESSES = 32;

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(token|apiKey|secret|password)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _number(value, options = {}) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < (options.min ?? 0) || result > (options.max ?? Number.MAX_SAFE_INTEGER)) return null;
  return options.integer ? Math.round(result) : result;
}

function _tri(value) { return typeof value === 'boolean' ? value : null; }

function _opaqueId(prefix, hostId, vmId, nativeRef, index) {
  const stable = nativeRef === null || nativeRef === undefined || nativeRef === '' ? `index:${index}` : String(nativeRef);
  return `ddh_${prefix}_${sha256(`${hostId}|${vmId}|${prefix}|${stable}`).slice(0, 26)}`;
}

function _attachment(value = {}) {
  return {
    connected: _tri(value.connected), startConnected: _tri(value.startConnected),
    bootable: _tri(value.bootable), readOnly: _tri(value.readOnly), shared: _tri(value.shared),
  };
}

function _capabilities(value = {}, nic = false) {
  const result = {
    hotPlug: _tri(value.hotPlug), hotUnplug: _tri(value.hotUnplug),
  };
  if (nic) result.connectDisconnect = _tri(value.connectDisconnect);
  else result.onlineResize = _tri(value.onlineResize);
  return result;
}

function _disk(row, index, context) {
  const backing = row?.backing && typeof row.backing === 'object' ? row.backing : {};
  const backingRef = backing.nativeRef ?? backing.path ?? backing.id;
  return {
    id: _opaqueId('disk', context.hostId, context.vmId, row?.nativeRef ?? row?.id ?? row?.device, index),
    label: _text(row?.label ?? row?.name ?? row?.device, 160),
    type: _text(row?.type, 40) || 'disk', device: _text(row?.device, 120),
    bus: _text(row?.bus, 40), unit: _number(row?.unit, { integer: true, max: 65535 }),
    capacityBytes: _number(row?.capacityBytes), allocatedBytes: _number(row?.allocatedBytes),
    provisioning: ['thin', 'thick', 'eagerZeroedThick', 'unknown'].includes(row?.provisioning) ? row.provisioning : 'unknown',
    format: _text(row?.format, 40),
    backing: {
      // A backing can be correlated across VMs without publishing its provider
      // reference.  This is deliberately distinct from the attachment disk id.
      id: backingRef === null || backingRef === undefined || backingRef === '' ? null
        : _opaqueId('backing', context.hostId, 'storage', backingRef, index),
      type: _text(backing.type, 80), storageId: _text(backing.storageId, 160),
      storageName: _text(backing.storageName, 160), path: _text(backing.path, 512),
    },
    attachment: _attachment(row?.attachment), capabilities: _capabilities(row?.capabilities),
    status: _text(row?.status, 80) || 'unknown',
  };
}

function _mac(value) {
  const compact = String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  return compact.length === 12 ? compact.match(/.{2}/g).join(':') : null;
}

function _address(row) {
  const address = _text(row?.address ?? row, 128);
  if (!address || !/^[0-9a-f:.]+$/i.test(address)) return null;
  return {
    address, family: row?.family === 'ipv6' || address.includes(':') ? 'ipv6' : 'ipv4',
    prefixLength: _number(row?.prefixLength, { integer: true, max: address.includes(':') ? 128 : 32 }),
    source: _text(row?.source, 40) || 'provider',
  };
}

function _nic(row, index, context) {
  const network = row?.network && typeof row.network === 'object' ? row.network : {};
  const security = row?.security && typeof row.security === 'object' ? row.security : {};
  const qos = row?.qos && typeof row.qos === 'object' ? row.qos : {};
  return {
    id: _opaqueId('nic', context.hostId, context.vmId, row?.nativeRef ?? row?.id ?? row?.device ?? row?.macAddress, index),
    label: _text(row?.label ?? row?.name ?? row?.device, 160), device: _text(row?.device, 120),
    model: _text(row?.model, 80), macAddress: _mac(row?.macAddress),
    network: {
      id: _text(network.id, 160), name: _text(network.name, 160), bridge: _text(network.bridge, 160),
      vlanId: _number(network.vlanId, { integer: true, max: 4094 }),
      distributedSwitch: _text(network.distributedSwitch, 160),
    },
    addresses: (Array.isArray(row?.addresses) ? row.addresses : []).slice(0, MAX_ADDRESSES).map(_address).filter(Boolean),
    mtu: _number(row?.mtu, { integer: true, min: 576, max: 65535 }),
    attachment: _attachment(row?.attachment),
    security: {
      firewall: _tri(security.firewall), lockingMode: _text(security.lockingMode, 80),
      spoofingAllowed: _tri(security.spoofingAllowed),
    },
    qos: { rateLimitMbps: _number(qos.rateLimitMbps), reservationMbps: _number(qos.reservationMbps) },
    capabilities: _capabilities(row?.capabilities, true), status: _text(row?.status, 80) || 'unknown',
  };
}

function _warnings(value) {
  return (Array.isArray(value) ? value : []).slice(0, 32)
    .map(item => _text(item?.reason ?? item, 240)).filter(Boolean);
}

function normalizeVmHardware({ host, providerType, resource, raw, observedAt }) {
  if (!host || !Number.isInteger(Number(host.id)) || !resource?.id || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('VM hardware normalization context is invalid');
  }
  const context = { hostId: Number(host.id), vmId: resource.id };
  const diskRows = Array.isArray(raw.disks) ? raw.disks : [];
  const nicRows = Array.isArray(raw.nics) ? raw.nics : [];
  const disks = diskRows.slice(0, MAX_DISKS).map((row, index) => _disk(row, index, context));
  const nics = nicRows.slice(0, MAX_NICS).map((row, index) => _nic(row, index, context));
  const envelope = {
    schemaVersion: VM_HARDWARE_SCHEMA_VERSION,
    provider: { type: _text(providerType, 40), endpointId: Number(host.id) },
    vmId: resource.id, observedAt: observedAt || new Date().toISOString(),
    summary: {
      diskCount: disks.length, nicCount: nics.length,
      connectedDiskCount: disks.filter(item => item.attachment.connected === true).length,
      connectedNicCount: nics.filter(item => item.attachment.connected === true).length,
      totalDiskCapacityBytes: disks.reduce((sum, item) => sum + (item.capacityBytes || 0), 0),
      totalDiskAllocatedBytes: disks.reduce((sum, item) => sum + (item.allocatedBytes || 0), 0),
    },
    disks, nics,
    sections: {
      disks: {
        available: raw.diskAvailable !== false,
        reason: raw.diskAvailable === false ? (_text(raw.diskReason, 240) || 'Disk inventory is unavailable') : null,
        warnings: _warnings(raw.diskWarnings), truncated: diskRows.length > disks.length,
      },
      network: {
        available: raw.nicAvailable !== false,
        reason: raw.nicAvailable === false ? (_text(raw.nicReason, 240) || 'NIC inventory is unavailable') : null,
        warnings: _warnings(raw.nicWarnings), truncated: nicRows.length > nics.length,
      },
    },
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_HARDWARE_BYTES) throw new Error('VM hardware response exceeds the size limit');
  return envelope;
}

module.exports = {
  VM_HARDWARE_SCHEMA_VERSION, MAX_HARDWARE_BYTES, MAX_DISKS, MAX_NICS, normalizeVmHardware,
  _internals: { _text, _number, _tri, _mac, _address, _opaqueId },
};
