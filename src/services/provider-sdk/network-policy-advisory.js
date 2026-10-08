'use strict';

const registry = require('./registry');
const CAPABILITY_STATES = new Set(['supported', 'conditional', 'unsupported', 'unknown']);
const MAX_MTU = 65535;

class NetworkPolicyAdvisoryError extends Error {
  constructor(message, code = 'NETWORK_POLICY_ADVISORY_UNAVAILABLE', status = 400) { super(message); this.name = 'NetworkPolicyAdvisoryError'; this.code = code; this.status = status; }
}

function _policy(options = {}) {
  const minMtu = options.minMtu === undefined || options.minMtu === null || options.minMtu === '' ? null : Number(options.minMtu);
  if (minMtu !== null && (!Number.isInteger(minMtu) || minMtu < 576 || minMtu > MAX_MTU)) throw new NetworkPolicyAdvisoryError('Minimum MTU must be an integer between 576 and 65535', 'INVALID_MIN_MTU');
  const bool = key => options[key] === undefined || options[key] === null || options[key] === '' ? false : options[key];
  const requireManaged = bool('requireManaged'); const requireVlan = bool('requireVlan');
  if (typeof requireManaged !== 'boolean' || typeof requireVlan !== 'boolean') throw new NetworkPolicyAdvisoryError('Network policy booleans must be true or false', 'INVALID_NETWORK_POLICY');
  return { requireAccessible: true, minMtu, requireManaged, requireVlan };
}

function assessNetworkPolicy(network, policy) {
  const signals = [];
  const add = (key, value, pass, fail, unknown) => signals.push({ key, state: value === true ? 'pass' : (value === false ? 'fail' : 'unknown'), reason: value === true ? pass : (value === false ? fail : unknown) });
  add('accessibility', network.status?.accessible, 'Provider reports this network as accessible', 'Provider reports this network as inaccessible', 'Provider did not report network accessibility');
  if (policy.requireManaged) add('managed', network.spec?.managed, 'Provider reports this network as managed', 'Provider reports this network as unmanaged', 'Provider did not report network management state');
  if (policy.requireVlan) add('vlan', Number.isInteger(network.spec?.vlanId) ? true : null, 'Provider reported a VLAN identifier', 'Provider reported no usable VLAN identifier', 'Provider did not report a VLAN identifier');
  if (policy.minMtu !== null) {
    const mtu = network.spec?.mtu;
    signals.push({ key: 'minMtu', state: !Number.isInteger(mtu) ? 'unknown' : (mtu >= policy.minMtu ? 'pass' : 'fail'), reason: !Number.isInteger(mtu) ? 'Provider did not report an MTU' : (mtu >= policy.minMtu ? 'Reported MTU meets the policy minimum' : 'Reported MTU is below the policy minimum') });
  }
  const state = signals.some(s => s.state === 'fail') ? 'noncompliant' : (signals.some(s => s.state === 'unknown') ? 'unknown' : 'compliant');
  return { id: network.id, displayName: network.displayName, bridge: network.spec?.bridge || null, vlanId: network.spec?.vlanId ?? null, mtu: network.spec?.mtu ?? null, state, signals };
}

async function advisoryForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new NetworkPolicyAdvisoryError('Valid provider host required', 'INVALID_HOST');
  const policy = _policy(options); const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  if (capabilities.probe?.status !== 'reachable') throw new NetworkPolicyAdvisoryError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  const feature = capabilities.features?.['network.policy.read'] || {}; const capability = { state: CAPABILITY_STATES.has(feature.state) ? feature.state : 'unknown', reason: feature.reason || 'No capability evidence was provided' };
  if (!['supported', 'conditional'].includes(capability.state)) throw new NetworkPolicyAdvisoryError(capability.reason || 'Network policy evidence is unavailable for this provider');
  const inventory = await registry.resourcesForHost(host, 'networks', { limit: 500, database: options.database }); const networks = inventory.items.map(item => assessNetworkPolicy(item, policy));
  return { schemaVersion: '1.0', provider: inventory.provider, observedAt: inventory.observedAt, capability, policy, summary: { compliantCount: networks.filter(n => n.state === 'compliant').length, noncompliantCount: networks.filter(n => n.state === 'noncompliant').length, unknownCount: networks.filter(n => n.state === 'unknown').length }, networks, limitations: ['This transient read-only policy is not persisted or applied to provider network configuration.', 'Unknown provider evidence is never compliant.', 'No traffic test, network mutation or remediation is performed.'] };
}

module.exports = { NetworkPolicyAdvisoryError, assessNetworkPolicy, advisoryForHost, _internals: { _policy } };
