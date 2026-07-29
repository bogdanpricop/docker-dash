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

function _safeguards(features = {}) {
  const privileged = Object.values(features).filter(feature => feature?.state !== 'unsupported' && ['approval', 'confirmation', 'revalidate', 'postVerify', 'durableTask'].some(key => feature?.[key]));
  return { declaredPrivilegedFeatureCount: privileged.length, approvalRequired: privileged.filter(feature => feature.approval === 'four_eyes').length, typedConfirmation: privileged.filter(feature => feature.confirmation === 'typed_name').length, revalidation: privileged.filter(feature => feature.revalidate === true).length, postVerification: privileged.filter(feature => feature.postVerify === true).length, durableTasks: privileged.filter(feature => feature.durableTask === true).length };
}

function _recovery(features = {}) {
  const entries = Object.entries(features).filter(([key]) => /^(backup|replication|dr)\./.test(key)).map(([, value]) => value || {});
  return { declaredFeatureCount: entries.length, supportedOrConditional: entries.filter(feature => ['supported', 'conditional'].includes(feature.state)).length, readOnlyEvidence: entries.filter(feature => feature.readOnly === true).length, durableTasks: entries.filter(feature => feature.durableTask === true).length, createOnlyRestore: entries.filter(feature => feature.createOnly === true).length, isolatedDrills: entries.filter(feature => feature.isolated).length, retentionMutationDisabled: entries.filter(feature => feature.retentionMutation === false).length };
}

function _consoleExposure(features = {}) {
  const feature = features['vm.console'] || {};
  const available = ['supported', 'conditional'].includes(feature.state);
  return { state: feature.state || 'unknown', available, protocols: Array.isArray(feature.protocols) ? feature.protocols.slice(0, 8) : [], clients: Array.isArray(feature.clients) ? feature.clients.slice(0, 8) : [], singleUseToken: feature.singleUseToken === true, credentialIsolation: feature.credentialIsolation === 'server-side', emergencyLock: feature.emergencyLock === true, reason: feature.reason || null };
}
function _taskAssurance(features = {}) {
  const entries = Object.values(features).filter(feature => feature?.state !== 'unsupported' && (feature?.durableTask === true || feature?.cancel === true || feature?.postVerify === true));
  return { declaredTaskFeatures: entries.length, durable: entries.filter(feature => feature.durableTask === true).length, cancellable: entries.filter(feature => feature.cancel === true).length, postVerified: entries.filter(feature => feature.postVerify === true).length, revalidated: entries.filter(feature => feature.revalidate === true).length };
}
function _networkGuardrails(features = {}) {
  const entries = Object.entries(features).filter(([key]) => key.startsWith('network.') || key.startsWith('vm.nic.')).map(([, value]) => value || {});
  const mutation = features['network.mutate'] || {};
  return { declaredFeatureCount: entries.length, readOnlyEvidence: entries.filter(feature => feature.readOnly === true || feature.evidenceOnly === true || feature.advisoryOnly === true).length, boundedEvidence: entries.filter(feature => feature.bounded === true).length, nicHotplugEvidenceOnly: features['vm.nic.hotplug']?.evidenceOnly === true, mutationState: mutation.state || 'unknown', mutationReleased: ['supported', 'conditional'].includes(mutation.state) };
}
function _lifecycleGuardrails(features = {}) {
  const entries = Object.entries(features).filter(([key]) => /^(vm\.power\.|vm\.snapshot\.|vm\.(clone|create|guestCustomize)$)/.test(key)).map(([, value]) => value || {});
  return { declaredFeatureCount: entries.length, supportedOrConditional: entries.filter(feature => ['supported', 'conditional'].includes(feature.state)).length, durableTasks: entries.filter(feature => feature.durableTask === true).length, confirmationRequired: entries.filter(feature => feature.confirmation === true || feature.confirmation === 'typed_name').length, postVerified: entries.filter(feature => feature.postVerify === true).length, revalidated: entries.filter(feature => feature.revalidate === true).length };
}

async function postureForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new ProviderSecurityPostureError('Valid provider host required', 'INVALID_HOST');
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  return {
    schemaVersion: '1.0', provider: capabilities.provider || { type: host.daemon_type, endpointId: Number(host.id) }, observedAt: capabilities.observedAt || new Date().toISOString(),
    coverage: _coverage(capabilities.features),
    safeguards: _safeguards(capabilities.features),
    recovery: _recovery(capabilities.features),
    consoleExposure: _consoleExposure(capabilities.features),
    taskAssurance: _taskAssurance(capabilities.features),
    networkGuardrails: _networkGuardrails(capabilities.features),
    lifecycleGuardrails: _lifecycleGuardrails(capabilities.features),
    limitations: ['This is a declared SDK capability-coverage summary, not a security scan, vulnerability assessment, compliance certification, or authorization audit.', 'Feature declarations can be conditional per resource and do not prove current entitlement or runtime availability.', 'No TLS, certificate, port, credential, guest, provider CLI, packet, or configuration operation is performed.'],
  };
}

module.exports = { ProviderSecurityPostureError, postureForHost, _internals: { _coverage, _safeguards, _recovery, _consoleExposure, _taskAssurance, _networkGuardrails, _lifecycleGuardrails } };
