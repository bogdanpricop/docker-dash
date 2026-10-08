'use strict';

// This is deliberately an advisory, not a reservation or execution preflight.
// It reuses the disk lifecycle capacity headroom rule but never claims a target
// remains usable after this point; an eventual write operation must read again.

const config = require('../../config');
const registry = require('./registry');

const SCHEMA_VERSION = '1.0';
const DEFAULT_REQUESTED_BYTES = 10 * 1024 * 1024 * 1024;
const MIN_REQUESTED_BYTES = 64 * 1024 * 1024;
const MAX_REQUESTED_BYTES = 64 * 1024 * 1024 * 1024 * 1024;
const CAPABILITY_STATES = new Set(['supported', 'conditional', 'unsupported', 'unknown']);

class StoragePlacementAdvisoryError extends Error {
  constructor(message, code = 'STORAGE_PLACEMENT_ADVISORY_UNAVAILABLE', status = 400) {
    super(message);
    this.name = 'StoragePlacementAdvisoryError';
    this.code = code;
    this.status = status;
  }
}

function _capability(capabilities, key) {
  const item = capabilities?.features?.[key] || {};
  return { state: CAPABILITY_STATES.has(item.state) ? item.state : 'unknown', reason: item.reason || 'No capability evidence was provided' };
}

function _requestedBytes(value) {
  const parsed = value === undefined || value === null || value === '' ? DEFAULT_REQUESTED_BYTES : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_REQUESTED_BYTES || parsed > MAX_REQUESTED_BYTES) {
    throw new StoragePlacementAdvisoryError('Requested disk size must be an integer between 64 MiB and 64 TiB', 'INVALID_REQUESTED_BYTES');
  }
  return parsed;
}

function _maintenance(value) {
  const normalized = String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (['maintenance', 'inmaintenance', 'enteringmaintenance'].includes(normalized)) return 'maintenance';
  if (['normal', 'active', 'available'].includes(normalized)) return 'normal';
  return normalized || null;
}

function assessStoragePlacement(storage, context) {
  const signals = [];
  const content = String(storage.extensions?.contentType || '').split(',').map(item => item.trim()).filter(Boolean);
  if (storage.status?.accessible === true) signals.push({ key: 'accessibility', state: 'pass', reason: 'Provider reports this storage as accessible' });
  else if (storage.status?.accessible === false) signals.push({ key: 'accessibility', state: 'fail', reason: 'Provider reports this storage as inaccessible' });
  else signals.push({ key: 'accessibility', state: 'unknown', reason: 'Provider did not report storage accessibility' });
  const maintenance = _maintenance(storage.status?.maintenanceMode);
  if (maintenance === 'maintenance') signals.push({ key: 'maintenance', state: 'fail', reason: 'Provider reports this storage in maintenance mode' });
  else if (maintenance === 'normal') signals.push({ key: 'maintenance', state: 'pass', reason: 'Provider reports normal maintenance state' });
  else if (maintenance) signals.push({ key: 'maintenance', state: 'unknown', reason: 'Provider returned an unrecognized maintenance state' });
  else signals.push({ key: 'maintenance', state: 'unknown', reason: 'Provider did not report storage maintenance state' });
  if (context.providerType === 'proxmox') {
    if (content.includes('images')) signals.push({ key: 'content.images', state: 'pass', reason: 'Storage reports VM disk-image content support' });
    else if (content.length) signals.push({ key: 'content.images', state: 'fail', reason: 'Storage does not report VM disk-image content support' });
    else signals.push({ key: 'content.images', state: 'unknown', reason: 'Provider did not report storage content classes' });
  }
  const free = Number(storage.status?.freeBytes);
  if (!Number.isFinite(free) || free < 0) signals.push({ key: 'capacity', state: 'unknown', reason: 'Provider did not report free capacity' });
  else if (free < context.requiredBytes) signals.push({ key: 'capacity', state: 'fail', reason: 'Reported free capacity does not satisfy requested capacity plus headroom', evidence: { freeBytes: free, requiredBytes: context.requiredBytes } });
  else signals.push({ key: 'capacity', state: 'pass', reason: 'Reported free capacity satisfies requested capacity plus headroom', evidence: { freeBytes: free, requiredBytes: context.requiredBytes } });
  const state = signals.some(item => item.state === 'fail') ? 'blocked'
    : (signals.some(item => item.state === 'unknown') ? 'unknown' : 'candidate');
  return {
    id: storage.id, displayName: storage.displayName, type: storage.spec?.type || null,
    shared: storage.spec?.shared ?? null, freeBytes: Number.isFinite(free) && free >= 0 ? free : null,
    state, signals,
  };
}

async function advisoryForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new StoragePlacementAdvisoryError('Valid provider host required', 'INVALID_HOST');
  const requestedBytes = _requestedBytes(options.requestedBytes);
  const capabilities = await registry.capabilitiesForHost(host, { refresh: options.refresh === true });
  if (capabilities.probe?.status !== 'reachable') throw new StoragePlacementAdvisoryError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  const capability = _capability(capabilities, 'storage.placement.read');
  if (!['supported', 'conditional'].includes(capability.state)) throw new StoragePlacementAdvisoryError(capability.reason || 'Storage placement evidence is unavailable for this provider');
  const headroomPercent = Number(config.providerVmDisks?.capacityHeadroomPercent || 10);
  const requiredBytes = Math.ceil(requestedBytes * (1 + headroomPercent / 100));
  const inventory = await registry.resourcesForHost(host, 'storages', { limit: 500, database: options.database });
  const storages = inventory.items.map(item => assessStoragePlacement(item, { providerType: host.daemon_type, requiredBytes }));
  const summary = { candidateCount: storages.filter(item => item.state === 'candidate').length, blockedCount: storages.filter(item => item.state === 'blocked').length, unknownCount: storages.filter(item => item.state === 'unknown').length };
  return {
    schemaVersion: SCHEMA_VERSION, provider: inventory.provider, observedAt: inventory.observedAt, capability,
    requested: { bytes: requestedBytes, headroomPercent, requiredBytes }, summary, storages,
    limitations: [
      'This is read-only advisory evidence, not a capacity reservation or an execution preflight.',
      'Unknown accessibility, maintenance, content or capacity evidence never becomes a placement candidate.',
      'Any disk operation must revalidate the target immediately before provider I/O.',
    ],
  };
}

module.exports = { SCHEMA_VERSION, DEFAULT_REQUESTED_BYTES, StoragePlacementAdvisoryError, assessStoragePlacement, advisoryForHost, _internals: { _requestedBytes, _maintenance } };
