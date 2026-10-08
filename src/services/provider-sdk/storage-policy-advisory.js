'use strict';

// Operator-supplied policy checks are intentionally evaluated as a transient,
// read-only projection. Docker Dash neither persists the choices nor alters a
// provider target; the result is evidence for review, not an execution grant.

const registry = require('./registry');

const SCHEMA_VERSION = '1.0';
const MAX_MIN_FREE_BYTES = 64 * 1024 * 1024 * 1024 * 1024;
const CAPABILITY_STATES = new Set(['supported', 'conditional', 'unsupported', 'unknown']);

class StoragePolicyAdvisoryError extends Error {
  constructor(message, code = 'STORAGE_POLICY_ADVISORY_UNAVAILABLE', status = 400) {
    super(message);
    this.name = 'StoragePolicyAdvisoryError';
    this.code = code;
    this.status = status;
  }
}

function _capability(capabilities) {
  const item = capabilities?.features?.['storage.policy.read'] || {};
  return { state: CAPABILITY_STATES.has(item.state) ? item.state : 'unknown', reason: item.reason || 'No capability evidence was provided' };
}

function _policy(input = {}) {
  const minFreeBytes = input.minFreeBytes === undefined || input.minFreeBytes === null || input.minFreeBytes === ''
    ? null : Number(input.minFreeBytes);
  if (minFreeBytes !== null && (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0 || minFreeBytes > MAX_MIN_FREE_BYTES)) {
    throw new StoragePolicyAdvisoryError('Minimum free capacity must be an integer between 0 and 64 TiB', 'INVALID_MIN_FREE_BYTES');
  }
  const requireShared = input.requireShared === undefined || input.requireShared === null || input.requireShared === ''
    ? false : input.requireShared;
  if (typeof requireShared !== 'boolean') throw new StoragePolicyAdvisoryError('Shared-storage requirement must be true or false', 'INVALID_REQUIRE_SHARED');
  return { requireAccessible: true, minFreeBytes, requireShared };
}

function assessStoragePolicy(storage, policy) {
  const signals = [];
  if (storage.status?.accessible === true) signals.push({ key: 'accessibility', state: 'pass', reason: 'Provider reports this storage as accessible' });
  else if (storage.status?.accessible === false) signals.push({ key: 'accessibility', state: 'fail', reason: 'Provider reports this storage as inaccessible' });
  else signals.push({ key: 'accessibility', state: 'unknown', reason: 'Provider did not report storage accessibility' });
  if (policy.minFreeBytes !== null) {
    const freeBytes = Number(storage.status?.freeBytes);
    if (!Number.isFinite(freeBytes) || freeBytes < 0) signals.push({ key: 'minFreeBytes', state: 'unknown', reason: 'Provider did not report free capacity', expected: policy.minFreeBytes });
    else if (freeBytes < policy.minFreeBytes) signals.push({ key: 'minFreeBytes', state: 'fail', reason: 'Reported free capacity is below the policy minimum', expected: policy.minFreeBytes, actual: freeBytes });
    else signals.push({ key: 'minFreeBytes', state: 'pass', reason: 'Reported free capacity meets the policy minimum', expected: policy.minFreeBytes, actual: freeBytes });
  }
  if (policy.requireShared) {
    if (storage.spec?.shared === true) signals.push({ key: 'shared', state: 'pass', reason: 'Provider reports this storage as shared' });
    else if (storage.spec?.shared === false) signals.push({ key: 'shared', state: 'fail', reason: 'Provider reports this storage as local' });
    else signals.push({ key: 'shared', state: 'unknown', reason: 'Provider did not report shared-storage state' });
  }
  const state = signals.some(signal => signal.state === 'fail') ? 'noncompliant'
    : (signals.some(signal => signal.state === 'unknown') ? 'unknown' : 'compliant');
  return {
    id: storage.id, displayName: storage.displayName, type: storage.spec?.type || null,
    shared: storage.spec?.shared ?? null, freeBytes: Number.isFinite(Number(storage.status?.freeBytes)) ? Number(storage.status.freeBytes) : null,
    state, signals,
  };
}

async function advisoryForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new StoragePolicyAdvisoryError('Valid provider host required', 'INVALID_HOST');
  const policy = _policy(options);
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  if (capabilities.probe?.status !== 'reachable') throw new StoragePolicyAdvisoryError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  const capability = _capability(capabilities);
  if (!['supported', 'conditional'].includes(capability.state)) throw new StoragePolicyAdvisoryError(capability.reason || 'Storage policy evidence is unavailable for this provider');
  const inventory = await registry.resourcesForHost(host, 'storages', { limit: 500, database: options.database });
  const storages = inventory.items.map(storage => assessStoragePolicy(storage, policy));
  return {
    schemaVersion: SCHEMA_VERSION, provider: inventory.provider, observedAt: inventory.observedAt, capability, policy,
    summary: {
      compliantCount: storages.filter(item => item.state === 'compliant').length,
      noncompliantCount: storages.filter(item => item.state === 'noncompliant').length,
      unknownCount: storages.filter(item => item.state === 'unknown').length,
    },
    storages,
    limitations: [
      'This is a point-in-time, read-only assessment of the policy values entered for this view.',
      'Policy choices are not persisted and the result does not reserve capacity or authorize a storage mutation.',
      'Missing provider evidence remains unknown, never compliant.',
    ],
  };
}

module.exports = { SCHEMA_VERSION, MAX_MIN_FREE_BYTES, StoragePolicyAdvisoryError, assessStoragePolicy, advisoryForHost, _internals: { _policy } };
