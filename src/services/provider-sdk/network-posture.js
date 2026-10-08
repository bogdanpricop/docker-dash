'use strict';

// Network posture is an evidence-only projection. A bridge, VLAN or MTU being
// present is not treated as a routing, firewall or tenant-isolation guarantee.

const registry = require('./registry');

const SCHEMA_VERSION = '1.0';
const STATES = Object.freeze(['pass', 'warning', 'fail', 'unknown']);
const CAPABILITY_STATES = new Set(['supported', 'conditional', 'unsupported', 'unknown']);

class NetworkPostureError extends Error {
  constructor(message, code = 'NETWORK_POSTURE_UNAVAILABLE', status = 400) {
    super(message);
    this.name = 'NetworkPostureError';
    this.code = code;
    this.status = status;
  }
}

function _capability(capabilities) {
  const item = capabilities?.features?.['network.health.read'] || {};
  return { state: CAPABILITY_STATES.has(item.state) ? item.state : 'unknown', reason: item.reason || 'No capability evidence was provided' };
}

function _state(signals) {
  if (signals.some(item => item.state === 'fail')) return 'fail';
  if (signals.some(item => item.state === 'warning')) return 'warning';
  if (signals.some(item => item.state === 'pass')) return 'pass';
  return 'unknown';
}

function assessNetwork(network) {
  const signals = [];
  if (network.status?.accessible === true) signals.push({ key: 'accessibility', state: 'pass', reason: 'Provider reports this network as accessible' });
  else if (network.status?.accessible === false) signals.push({ key: 'accessibility', state: 'fail', reason: 'Provider reports this network as inaccessible' });
  else signals.push({ key: 'accessibility', state: 'unknown', reason: 'Provider did not report network accessibility' });
  if (network.spec?.managed === true) signals.push({ key: 'managed', state: 'pass', reason: 'Provider reports this network as managed' });
  else if (network.spec?.managed === false) signals.push({ key: 'managed', state: 'warning', reason: 'Provider reports this network as unmanaged' });
  else signals.push({ key: 'managed', state: 'unknown', reason: 'Provider did not report network management state' });
  if (network.spec?.bridge) signals.push({ key: 'bridge', state: 'pass', reason: 'Provider reported a bridge or backing network' });
  else signals.push({ key: 'bridge', state: 'unknown', reason: 'Provider did not report a bridge or backing network' });
  if (Number.isInteger(network.spec?.vlanId)) signals.push({ key: 'vlan', state: 'pass', reason: 'Provider reported a VLAN identifier', evidence: { vlanId: network.spec.vlanId } });
  else signals.push({ key: 'vlan', state: 'unknown', reason: 'Provider did not report a VLAN identifier' });
  if (Number.isInteger(network.spec?.mtu)) signals.push({ key: 'mtu', state: 'pass', reason: 'Provider reported an MTU', evidence: { mtu: network.spec.mtu } });
  else signals.push({ key: 'mtu', state: 'unknown', reason: 'Provider did not report an MTU' });
  return {
    id: network.id, displayName: network.displayName, observedAt: network.observedAt,
    bridge: network.spec?.bridge || null, vlanId: network.spec?.vlanId ?? null, mtu: network.spec?.mtu ?? null,
    managed: network.spec?.managed ?? null, accessible: network.status?.accessible ?? null,
    state: _state(signals), signals,
  };
}

async function postureForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new NetworkPostureError('Valid provider host required', 'INVALID_HOST');
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  if (capabilities.probe?.status !== 'reachable') throw new NetworkPostureError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  const capability = _capability(capabilities);
  if (!['supported', 'conditional'].includes(capability.state)) throw new NetworkPostureError(capability.reason || 'Virtual network posture is unavailable for this provider');
  const inventory = await registry.resourcesForHost(host, 'networks', { limit: options.limit || 500, database: options.database });
  const networks = inventory.items.map(assessNetwork);
  const states = Object.fromEntries(STATES.map(state => [state, networks.filter(item => item.state === state).length]));
  return {
    schemaVersion: SCHEMA_VERSION, provider: inventory.provider, observedAt: inventory.observedAt, capability,
    summary: { state: _state(networks.map(item => ({ state: item.state }))), networkCount: networks.length, states }, networks,
    limitations: [
      'This is a read-only inventory projection; it does not validate routing, firewall policy, traffic flow or tenant isolation.',
      'A reported VLAN, bridge or MTU is configuration evidence, not proof of end-to-end connectivity or segmentation.',
      'No network mutation, test traffic, provider CLI fallback or automatic remediation is performed.',
    ],
  };
}

module.exports = { SCHEMA_VERSION, NetworkPostureError, assessNetwork, postureForHost, _internals: { _state } };
