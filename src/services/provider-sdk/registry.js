'use strict';

const log = require('../../utils/logger')('provider-sdk');
const metrics = require('../metrics');
const { buildEnvelope } = require('./schema');

const adapters = new Map();
const cache = new Map();
const inFlight = new Map();
const SUCCESS_TTL_MS = 60_000;
const ERROR_TTL_MS = 10_000;
const MAX_CACHE_ENTRIES = 512;

class ProviderAdapterError extends Error {
  constructor(message, code = 'PROVIDER_ADAPTER_UNAVAILABLE', status = 400) {
    super(message);
    this.name = 'ProviderAdapterError';
    this.code = code;
    this.status = status;
  }
}

function register(adapter) {
  if (!adapter || !/^[a-z][a-z0-9_-]{1,39}$/.test(adapter.type || '')) {
    throw new Error('Provider adapter requires a safe type');
  }
  if (typeof adapter.declared !== 'function' || typeof adapter.probe !== 'function') {
    throw new Error(`Provider adapter ${adapter.type} must implement declared() and probe()`);
  }
  if (adapters.has(adapter.type)) throw new Error(`Provider adapter already registered: ${adapter.type}`);
  adapters.set(adapter.type, Object.freeze({ ...adapter }));
}

function getAdapter(type) {
  const adapter = adapters.get(String(type || '').toLowerCase());
  if (!adapter) throw new ProviderAdapterError(`Provider SDK v2 does not support daemon type: ${type}`);
  return adapter;
}

function _cloneWithCache(envelope, cached) {
  return { ...envelope, probe: { ...envelope.probe, cached: !!cached } };
}

function _sanitizeProbeError(err) {
  const rawCode = String(err?.code || '').toUpperCase();
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(rawCode) ? rawCode : 'PROBE_UNREACHABLE';
  const configuration = /config|credential|decrypt|endpoint|required/i.test(String(err?.message || ''));
  return {
    code: configuration ? 'PROBE_CONFIGURATION_ERROR' : code,
    message: configuration
      ? 'Provider configuration could not be loaded'
      : 'Provider endpoint could not be reached',
  };
}

function _putCache(hostId, envelope, ttlMs) {
  if (!cache.has(hostId) && cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(hostId, { envelope, expiresAt: Date.now() + ttlMs });
}

async function _probe(host, adapter) {
  const started = Date.now();
  let declared = {};
  let result = null;
  try {
    declared = adapter.declared(host) || {};
    result = await adapter.probe(host);
    const durationMs = Date.now() - started;
    const envelope = buildEnvelope({
      host,
      provider: result?.provider || { type: adapter.type },
      probe: { status: 'reachable', checkedAt: new Date().toISOString(), durationMs },
      features: { ...declared, ...(result?.features || {}) },
    });
    _putCache(Number(host.id), envelope, SUCCESS_TTL_MS);
    metrics.recordProviderProbe?.(adapter.type, 'reachable', durationMs);
    metrics.setProviderCapabilityUnknown?.(adapter.type,
      Object.values(envelope.features).filter(item => item.state === 'unknown').length);
    return envelope;
  } catch (err) {
    const durationMs = Date.now() - started;
    const safeError = _sanitizeProbeError(err);
    const envelope = buildEnvelope({
      host,
      provider: result?.provider || { type: adapter.type, product: adapter.type },
      probe: {
        status: 'unreachable', checkedAt: new Date().toISOString(), durationMs,
        error: safeError,
      },
      features: declared,
    });
    _putCache(Number(host.id), envelope, ERROR_TTL_MS);
    metrics.recordProviderProbe?.(adapter.type, 'unreachable', durationMs);
    metrics.setProviderCapabilityUnknown?.(adapter.type,
      Object.values(envelope.features).filter(item => item.state === 'unknown').length);
    log.warn('Provider capability probe failed', {
      hostId: Number(host.id), provider: adapter.type, code: safeError.code,
    });
    return envelope;
  }
}

async function capabilitiesForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new ProviderAdapterError('Valid provider host required', 'INVALID_HOST');
  const hostId = Number(host.id);
  const adapter = getAdapter(host.daemon_type);
  const cached = cache.get(hostId);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) {
    metrics.recordProviderCapabilityCache?.('hit');
    return _cloneWithCache(cached.envelope, true);
  }
  metrics.recordProviderCapabilityCache?.(cached ? 'stale' : 'miss');
  if (inFlight.has(hostId)) return _cloneWithCache(await inFlight.get(hostId), false);
  const promise = _probe(host, adapter);
  inFlight.set(hostId, promise);
  try { return _cloneWithCache(await promise, false); }
  finally { inFlight.delete(hostId); }
}

function invalidateHost(hostId) {
  const id = Number(hostId);
  cache.delete(id);
  // An in-flight network request is allowed to finish, but its result must not
  // be reused after an explicit invalidation. Delete it again on completion.
  const pending = inFlight.get(id);
  if (pending) Promise.resolve(pending).finally(() => cache.delete(id)).catch(() => {});
}

function clear() {
  cache.clear();
  inFlight.clear();
}

for (const adapter of [
  require('./adapters/proxmox'),
  require('./adapters/vsphere'),
  require('./adapters/xen'),
]) register(adapter);

module.exports = {
  ProviderAdapterError,
  register,
  getAdapter,
  capabilitiesForHost,
  invalidateHost,
  _internals: {
    adapters, cache, inFlight, clear, _sanitizeProbeError,
    SUCCESS_TTL_MS, ERROR_TTL_MS, MAX_CACHE_ENTRIES,
  },
};
