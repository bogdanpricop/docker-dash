'use strict';

const {
  FEATURE_KEYS, FEATURE_KEY_SET, STATES, SOURCES,
} = require('./catalog');

const SCHEMA_VERSION = '1.0';
const MAX_REASON_LENGTH = 240;
const MAX_RESPONSE_BYTES = 256 * 1024;

function _boundedString(value, max = MAX_REASON_LENGTH) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _safeConstraints(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return {};
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      output[key] = item;
    } else if (typeof item === 'string') {
      output[key] = item.slice(0, 240);
    } else if (Array.isArray(item)) {
      output[key] = item.slice(0, 32).filter(v => ['string', 'number', 'boolean'].includes(typeof v))
        .map(v => typeof v === 'string' ? v.slice(0, 120) : v);
    } else if (typeof item === 'object') {
      output[key] = _safeConstraints(item, depth + 1);
    }
  }
  return output;
}

function evidence(state, options = {}) {
  if (!STATES.includes(state)) throw new Error(`Invalid provider capability state: ${state}`);
  const source = options.source || 'adapter';
  if (!SOURCES.includes(source)) throw new Error(`Invalid provider capability source: ${source}`);
  return {
    state,
    source,
    reason: _boundedString(options.reason),
    constraints: _safeConstraints(options.constraints),
  };
}

function completeFeatures(partial = {}) {
  for (const key of Object.keys(partial)) {
    if (!FEATURE_KEY_SET.has(key)) throw new Error(`Unknown provider capability key: ${key}`);
  }
  const features = {};
  for (const key of FEATURE_KEYS) {
    const item = partial[key];
    features[key] = item
      ? evidence(item.state, item)
      : evidence('unknown', { source: 'fallback', reason: 'No capability evidence was provided' });
  }
  return features;
}

function buildEnvelope({ host, provider = {}, probe = {}, features = {} }) {
  if (!host || !Number.isInteger(Number(host.id))) throw new Error('Provider capability host is required');
  const checkedAt = probe.checkedAt || new Date().toISOString();
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    provider: {
      type: _boundedString(provider.type || host.daemon_type, 40),
      variant: _boundedString(provider.variant || 'unknown', 80),
      product: _boundedString(provider.product || host.daemon_type || 'unknown', 160),
      version: _boundedString(provider.version, 120),
      apiVersion: _boundedString(provider.apiVersion, 120),
      endpointId: Number(host.id),
      endpointName: _boundedString(host.name || `host-${host.id}`, 160),
    },
    probe: {
      status: probe.status === 'reachable' ? 'reachable' : 'unreachable',
      checkedAt,
      cached: !!probe.cached,
      durationMs: Number.isFinite(probe.durationMs) ? Math.max(0, Math.round(probe.durationMs)) : null,
      error: probe.error ? {
        code: _boundedString(probe.error.code || 'PROBE_UNREACHABLE', 80),
        message: _boundedString(probe.error.message || 'Provider endpoint could not be reached', 200),
      } : null,
    },
    features: completeFeatures(features),
  };
  validateEnvelope(envelope);
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_RESPONSE_BYTES) {
    throw new Error(`Provider capability envelope exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  return envelope;
}

function validateEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object') throw new Error('Invalid provider capability envelope: envelope must be an object');
  if (envelope.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!envelope.provider?.type) errors.push('provider.type is required');
  if (!Number.isInteger(envelope.provider?.endpointId)) errors.push('provider.endpointId must be an integer');
  if (!['reachable', 'unreachable'].includes(envelope.probe?.status)) errors.push('probe.status is invalid');
  if (!envelope.probe?.checkedAt || Number.isNaN(Date.parse(envelope.probe.checkedAt))) errors.push('probe.checkedAt must be ISO time');
  const keys = Object.keys(envelope.features || {});
  if (keys.length !== FEATURE_KEYS.length || keys.some(key => !FEATURE_KEY_SET.has(key))) {
    errors.push('features must contain the complete capability catalog');
  }
  for (const [key, item] of Object.entries(envelope.features || {})) {
    if (!STATES.includes(item?.state)) errors.push(`${key}.state is invalid`);
    if (!SOURCES.includes(item?.source)) errors.push(`${key}.source is invalid`);
  }
  if (errors.length) throw new Error(`Invalid provider capability envelope: ${errors.join('; ')}`);
  return true;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_RESPONSE_BYTES,
  evidence,
  completeFeatures,
  buildEnvelope,
  validateEnvelope,
  _internals: { _boundedString, _safeConstraints },
};
