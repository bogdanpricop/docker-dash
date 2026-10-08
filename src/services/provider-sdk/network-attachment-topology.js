'use strict';

// Bounded VM-to-network evidence. Network grouping is never presented as a
// connectivity, routing, firewall, or tenant-isolation assertion.
const { sha256 } = require('../../utils/crypto');
const registry = require('./registry');
const MAX_VMS = 100; const MAX_NETWORKS = 100; const CONCURRENCY = 4;

class NetworkAttachmentTopologyError extends Error {
  constructor(message, code = 'NETWORK_ATTACHMENT_TOPOLOGY_UNAVAILABLE', status = 400) { super(message); this.name = 'NetworkAttachmentTopologyError'; this.code = code; this.status = status; }
}
async function _mapBounded(items, mapper) {
  const results = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => { while (index < items.length) { const current = index++; try { results[current] = { value: await mapper(items[current]) }; } catch (error) { results[current] = { error }; } } }));
  return results;
}
function _id(hostId, value) { return `ddn_net_${sha256(`${hostId}|network|${value}`).slice(0, 26)}`; }
function _groups(host, rows) {
  const groups = new Map();
  for (const { vm, hardware } of rows) {
    if (hardware.sections?.network?.available === false) continue;
    for (const nic of hardware.nics || []) {
      const raw = nic.network?.id || nic.network?.bridge;
      if (!raw) continue;
      const id = _id(host.id, raw); const attachments = groups.get(id)?.attachments || [];
      attachments.push({ vm: { id: vm.id, displayName: vm.displayName }, nic: { id: nic.id, label: nic.label, macAddress: nic.macAddress }, attachment: { connected: nic.attachment?.connected ?? null }, addressesObserved: (nic.addresses || []).length });
      groups.set(id, { id, displayName: nic.network?.name || nic.network?.bridge || 'Provider network', bridge: nic.network?.bridge || null, vlanId: nic.network?.vlanId ?? null, attachments });
    }
  }
  return [...groups.values()].map(group => ({ ...group, consumerCount: group.attachments.length, connectedCount: group.attachments.filter(item => item.attachment.connected === true).length, unknownConnectionCount: group.attachments.filter(item => item.attachment.connected === null).length })).sort((a, b) => b.consumerCount - a.consumerCount || a.id.localeCompare(b.id)).slice(0, MAX_NETWORKS);
}
async function topologyForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new NetworkAttachmentTopologyError('Valid provider host required', 'INVALID_HOST');
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  if (capabilities.probe?.status !== 'reachable') throw new NetworkAttachmentTopologyError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  const feature = capabilities.features?.['network.attachmentTopology.read'] || {};
  const capability = { state: ['supported', 'conditional', 'unsupported', 'unknown'].includes(feature.state) ? feature.state : 'unknown', reason: feature.reason || 'No capability evidence was provided' };
  if (!['supported', 'conditional'].includes(capability.state)) throw new NetworkAttachmentTopologyError(capability.reason);
  const database = options.database; const inventory = await registry.resourcesForHost(host, 'virtual-machines', { limit: options.limit || MAX_VMS, database });
  const readings = await _mapBounded(inventory.items, async vm => ({ vm, hardware: await registry.vmHardwareForHost(host, vm, { capabilities, database }) }));
  const successful = readings.filter(item => item.value).map(item => item.value); const unavailable = readings.filter(item => item.error).length; const networks = _groups(host, successful);
  const complete = inventory.truncated !== true && unavailable === 0 && successful.every(item => item.hardware.sections?.network?.available !== false && item.hardware.sections?.network?.truncated !== true);
  return { schemaVersion: '1.0', provider: inventory.provider, observedAt: new Date().toISOString(), capability, coverage: { vmCount: inventory.count, totalObserved: inventory.totalObserved, truncated: inventory.truncated === true, hardwareUnavailable: unavailable, complete }, summary: { networkCount: networks.length, attachmentCount: networks.reduce((sum, item) => sum + item.consumerCount, 0) }, networks, limitations: ['Network identifiers are host-scoped opaque values; provider-native identifiers are not returned.', 'This is attachment evidence only and does not prove routing, firewall policy, connectivity or tenant isolation.', complete ? 'All selected VM NIC inventories were read.' : 'This is partial evidence; unreadable or unobserved VM NICs can hide additional attachments.', 'No network mutation, guest query, test traffic, provider CLI fallback or remediation is performed.'] };
}
module.exports = { NetworkAttachmentTopologyError, topologyForHost, _internals: { _groups, _id } };
