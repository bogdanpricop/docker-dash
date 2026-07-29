'use strict';

const registry = require('./registry');

class ProviderSecurityPostureError extends Error {
  constructor(message, code = 'PROVIDER_SECURITY_POSTURE_ERROR', status = 400) { super(message); this.name = 'ProviderSecurityPostureError'; this.code = code; this.status = status; }
}

function _coverage(features = {}) {
  const states = { supported: 0, conditional: 0, unsupported: 0, unknown: 0 };
  Object.values(features).forEach(feature => { const state = feature?.state; states[Object.hasOwn(states, state) ? state : 'unknown'] += 1; });
  return { declaredFeatureCount: Object.keys(features).length, states, readOnly: Object.values(features).filter(feature => feature?.readOnly === true).length };
}

async function postureForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new ProviderSecurityPostureError('Valid provider host required', 'INVALID_HOST');
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  return {
    schemaVersion: '1.0', provider: capabilities.provider || { type: host.daemon_type, endpointId: Number(host.id) }, observedAt: capabilities.observedAt || new Date().toISOString(),
    coverage: _coverage(capabilities.features),
    limitations: ['This is a declared SDK capability-coverage summary, not a security scan, vulnerability assessment, compliance certification, or authorization audit.', 'Feature declarations can be conditional per resource and do not prove current entitlement or runtime availability.', 'No TLS, certificate, port, credential, guest, provider CLI, packet, or configuration operation is performed.'],
  };
}

module.exports = { ProviderSecurityPostureError, postureForHost, _internals: { _coverage } };
