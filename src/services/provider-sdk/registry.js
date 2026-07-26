'use strict';

const log = require('../../utils/logger')('provider-sdk');
const metrics = require('../metrics');
const { getDb } = require('../../db');
const config = require('../../config');
const { buildEnvelope } = require('./schema');
const { resolveResourceKind } = require('./resource-catalog');
const { normalizeResource, RESOURCE_SCHEMA_VERSION, MAX_INVENTORY_BYTES } = require('./resource-schema');
const resourceSnapshots = require('./resource-snapshots');
const providerResilience = require('../provider-conformance/resilience');
const artifactCatalog = require('./artifact-catalog');
const recoveryPointCatalog = require('./recovery-point-catalog');
const identityStore = require('./identity-store');
const { normalizeVmHardware } = require('./vm-hardware');

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
    result = await providerResilience.run(Number(host.id), () => adapter.probe(host), { operation: 'probe' });
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

function _resourceSortKey(row) {
  return String(row?.uuid ?? row?.hostUuid ?? row?.ref ?? row?.moref ?? row?.id
    ?? row?.vmid ?? row?.node ?? row?.storage ?? row?.name ?? '');
}

function _retrySqliteBusy(write, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return write(); }
    catch (err) {
      lastError = err;
      // WAL readers can lose the race to a concurrent writer while upgrading
      // their snapshot. A fresh transaction is the correct bounded recovery.
      if (!/^SQLITE_BUSY(?:_|$)/.test(String(err?.code || '')) || attempt === attempts) throw err;
    }
  }
  throw lastError;
}

async function resourcesForHost(host, kindInput, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new ProviderAdapterError('Valid provider host required', 'INVALID_HOST');
  const kindInfo = resolveResourceKind(kindInput);
  if (!kindInfo) throw new ProviderAdapterError('Unknown provider resource kind', 'INVALID_RESOURCE_KIND', 400);
  const requestedLimit = options.limit === undefined ? 200 : Number(options.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
    throw new ProviderAdapterError('Resource limit must be an integer between 1 and 500', 'INVALID_RESOURCE_LIMIT', 400);
  }

  const adapter = getAdapter(host.daemon_type);
  const capabilities = await capabilitiesForHost(host);
  if (capabilities.probe.status !== 'reachable') {
    throw new ProviderAdapterError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  }
  const evidence = capabilities.features[kindInfo.capability];
  if (!evidence || !['supported', 'conditional'].includes(evidence.state)) {
    throw new ProviderAdapterError(evidence?.reason || 'Resource inventory is unavailable for this provider',
      'PROVIDER_RESOURCE_UNAVAILABLE', 400);
  }
  if (typeof adapter.listResources !== 'function') {
    throw new ProviderAdapterError('Resource inventory adapter is unavailable', 'PROVIDER_RESOURCE_UNAVAILABLE', 400);
  }

  let rows;
  try {
    rows = await providerResilience.run(Number(host.id), () => adapter.listResources(kindInfo.kind, host), { operation: `inventory.${kindInfo.kind}` });
  } catch (err) {
    log.warn('Provider inventory read failed', {
      hostId: Number(host.id), provider: adapter.type, kind: kindInfo.kind,
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'PROVIDER_READ_FAILED',
    });
    throw new ProviderAdapterError('Provider resource inventory could not be read', 'PROVIDER_RESOURCE_READ_FAILED', 502);
  }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new ProviderAdapterError('Provider returned an invalid resource inventory', 'INVALID_PROVIDER_RESOURCE_RESPONSE', 502);
  }

  const totalObserved = rows.length;
  const selected = [...rows].sort((a, b) => _resourceSortKey(a).localeCompare(_resourceSortKey(b))).slice(0, requestedLimit);
  const observedAt = new Date().toISOString();
  let items;
  try {
    const database = options.database || getDb();
    const write = database.transaction(() => {
      const normalized = selected.map(raw => normalizeResource({
        host, providerType: adapter.type, kind: kindInfo.kind, raw, observedAt, database,
      }));
      resourceSnapshots.rememberMany(normalized, database);
      return normalized;
    });
    items = _retrySqliteBusy(write);
  } catch (err) {
    log.error('Provider resource normalization failed', {
      hostId: Number(host.id), provider: adapter.type, kind: kindInfo.kind,
      error: err?.name || 'Error',
      code: /^SQLITE_[A-Z_]+$/.test(String(err?.code || '')) ? err.code : 'RESOURCE_WRITE_FAILED',
    });
    throw new ProviderAdapterError('Provider resource inventory could not be normalized', 'RESOURCE_NORMALIZATION_FAILED', 500);
  }

  const envelope = {
    schemaVersion: RESOURCE_SCHEMA_VERSION,
    kind: kindInfo.kind,
    provider: { type: adapter.type, endpointId: Number(host.id) },
    observedAt,
    count: items.length,
    totalObserved,
    truncated: totalObserved > items.length,
    items,
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_INVENTORY_BYTES) {
    throw new ProviderAdapterError('Provider resource inventory exceeds the response size limit', 'RESOURCE_RESPONSE_TOO_LARGE', 502);
  }
  return envelope;
}

async function artifactsForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new ProviderAdapterError('Valid provider host required', 'INVALID_HOST');
  const requestedLimit = options.limit === undefined ? 200 : Number(options.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
    throw new ProviderAdapterError('Artifact limit must be an integer between 1 and 500', 'INVALID_ARTIFACT_LIMIT', 400);
  }
  const kind = options.kind === undefined || options.kind === '' ? null : String(options.kind);
  if (kind && !artifactCatalog.ARTIFACT_KINDS.includes(kind)) {
    throw new ProviderAdapterError('Unknown provider artifact kind', 'INVALID_ARTIFACT_KIND', 400);
  }
  const query = String(options.query || '').trim().toLowerCase();
  if (query.length > 120) throw new ProviderAdapterError('Artifact search is limited to 120 characters', 'INVALID_ARTIFACT_QUERY', 400);

  const adapter = getAdapter(host.daemon_type);
  const capabilities = await capabilitiesForHost(host);
  if (capabilities.probe.status !== 'reachable') {
    throw new ProviderAdapterError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  }
  const evidence = capabilities.features['inventory.image'];
  if (!evidence || !['supported', 'conditional'].includes(evidence.state) || typeof adapter.listArtifacts !== 'function') {
    throw new ProviderAdapterError(evidence?.reason || 'Artifact inventory is unavailable for this provider', 'PROVIDER_ARTIFACT_UNAVAILABLE', 400);
  }

  let rows;
  try {
    rows = await providerResilience.run(Number(host.id), () => adapter.listArtifacts(host), { operation: 'inventory.image' });
  } catch (err) {
    log.warn('Provider artifact inventory read failed', {
      hostId: Number(host.id), provider: adapter.type,
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'PROVIDER_READ_FAILED',
    });
    throw new ProviderAdapterError('Provider artifact inventory could not be read', 'PROVIDER_ARTIFACT_READ_FAILED', 502);
  }
  if (!Array.isArray(rows) || rows.length > 5000 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new ProviderAdapterError('Provider returned an invalid artifact inventory', 'INVALID_PROVIDER_ARTIFACT_RESPONSE', 502);
  }

  const observedAt = new Date().toISOString();
  let normalized;
  try {
    const database = options.database || getDb();
    const write = database.transaction(() => rows.map(raw => artifactCatalog.normalizeAndRemember({
      host, providerType: adapter.type, raw, observedAt, database,
    })));
    normalized = _retrySqliteBusy(write);
  } catch (err) {
    log.error('Provider artifact normalization failed', {
      hostId: Number(host.id), provider: adapter.type, error: err?.name || 'Error',
      code: /^SQLITE_[A-Z_]+$/.test(String(err?.code || '')) ? err.code : 'ARTIFACT_WRITE_FAILED',
    });
    throw new ProviderAdapterError('Provider artifact inventory could not be normalized', 'ARTIFACT_NORMALIZATION_FAILED', 500);
  }
  const filtered = normalized.filter(item => (!kind || item.kind === kind)
    && (!query || `${item.displayName} ${item.description || ''} ${item.spec?.osType || ''} ${Object.values(item.labels || {}).join(' ')}`.toLowerCase().includes(query)))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.displayName.localeCompare(b.displayName));
  const items = filtered.slice(0, requestedLimit);
  const envelope = {
    schemaVersion: artifactCatalog.ARTIFACT_SCHEMA_VERSION,
    provider: { type: adapter.type, endpointId: Number(host.id) },
    observedAt, count: items.length, totalObserved: filtered.length,
    truncated: filtered.length > items.length, filters: { kind, query: query || null }, items,
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > artifactCatalog.MAX_CATALOG_BYTES) {
    throw new ProviderAdapterError('Provider artifact catalog exceeds the response size limit', 'ARTIFACT_RESPONSE_TOO_LARGE', 502);
  }
  return envelope;
}

function _recoveryTimestamp(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ProviderAdapterError(`${field} must be an ISO-8601 timestamp`, 'INVALID_RECOVERY_POINT_TIME', 400);
  }
  return date.toISOString();
}

async function recoveryPointsForHost(host, options = {}) {
  if (!config.features.providerRecoveryPointInventory) {
    throw new ProviderAdapterError('Recovery-point inventory is disabled by release policy', 'RECOVERY_POINT_INVENTORY_DISABLED', 404);
  }
  if (!host || !Number.isInteger(Number(host.id))) throw new ProviderAdapterError('Valid provider host required', 'INVALID_HOST');
  const requestedLimit = options.limit === undefined ? 200 : Number(options.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
    throw new ProviderAdapterError('Recovery-point limit must be an integer between 1 and 500', 'INVALID_RECOVERY_POINT_LIMIT', 400);
  }
  const query = String(options.query || '').trim().toLowerCase();
  if (query.length > 120) throw new ProviderAdapterError('Recovery-point search is limited to 120 characters', 'INVALID_RECOVERY_POINT_QUERY', 400);
  const repositoryId = options.repositoryId ? String(options.repositoryId) : null;
  if (repositoryId && !recoveryPointCatalog._internals.SAFE_REPOSITORY_ID.test(repositoryId)) {
    throw new ProviderAdapterError('Invalid recovery-point repository ID', 'INVALID_RECOVERY_POINT_REPOSITORY', 400);
  }
  const workloadId = options.workloadId ? String(options.workloadId) : null;
  if (workloadId && !/^ddr_vm_[a-f0-9]{26}$/.test(workloadId)) {
    throw new ProviderAdapterError('Invalid recovery-point workload ID', 'INVALID_RECOVERY_POINT_WORKLOAD', 400);
  }
  const recoveryPointId = options.recoveryPointId ? String(options.recoveryPointId) : null;
  if (recoveryPointId && !recoveryPointCatalog._internals.SAFE_POINT_ID.test(recoveryPointId)) {
    throw new ProviderAdapterError('Invalid recovery-point ID', 'INVALID_RECOVERY_POINT_ID', 400);
  }
  const verification = options.verification ? String(options.verification).toLowerCase() : null;
  if (verification && !recoveryPointCatalog.VERIFICATION_STATES.includes(verification)) {
    throw new ProviderAdapterError('Invalid recovery-point verification state', 'INVALID_RECOVERY_POINT_VERIFICATION', 400);
  }
  const from = _recoveryTimestamp(options.from, 'from');
  const to = _recoveryTimestamp(options.to, 'to');
  if (from && to && from > to) {
    throw new ProviderAdapterError('Recovery-point time range is reversed', 'INVALID_RECOVERY_POINT_TIME', 400);
  }

  const adapter = getAdapter(host.daemon_type);
  const capabilities = await capabilitiesForHost(host);
  if (capabilities.probe.status !== 'reachable') {
    throw new ProviderAdapterError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  }
  const evidence = capabilities.features['backup.read'];
  if (!evidence || !['supported', 'conditional'].includes(evidence.state) || typeof adapter.listRecoveryPoints !== 'function') {
    throw new ProviderAdapterError(evidence?.reason || 'Recovery-point inventory is unavailable for this provider',
      'PROVIDER_RECOVERY_POINT_UNAVAILABLE', 400);
  }

  let raw;
  try {
    raw = await providerResilience.run(Number(host.id), () => adapter.listRecoveryPoints(host), { operation: 'backup.read' });
  } catch (err) {
    log.warn('Provider recovery-point inventory read failed', {
      hostId: Number(host.id), provider: adapter.type,
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'PROVIDER_READ_FAILED',
    });
    throw new ProviderAdapterError('Provider recovery-point inventory could not be read', 'PROVIDER_RECOVERY_POINT_READ_FAILED', 502);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !Array.isArray(raw.repositories) || raw.repositories.length > 500
    || !Array.isArray(raw.points) || raw.points.length > 5000
    || raw.repositories.some(item => !item || typeof item !== 'object' || Array.isArray(item))
    || raw.points.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new ProviderAdapterError('Provider returned an invalid recovery-point inventory', 'INVALID_PROVIDER_RECOVERY_POINT_RESPONSE', 502);
  }

  const observedAt = new Date().toISOString();
  let normalized;
  try {
    const database = options.database || getDb();
    const write = database.transaction(() => {
      const repositories = raw.repositories.map(item => recoveryPointCatalog.normalizeRepositoryAndRemember({
        host, providerType: adapter.type, raw: item, observedAt, database,
      }));
      const byNativeRef = new Map(repositories.map(item => [item.nativeRef, item.repository]));
      const points = raw.points.map(item => recoveryPointCatalog.normalizeRecoveryPointAndRemember({
        host, providerType: adapter.type, raw: item, observedAt, database,
        repository: byNativeRef.get(String(item.repositoryRef || '')) || null,
      }));
      return { repositories: repositories.map(item => item.repository), points };
    });
    normalized = _retrySqliteBusy(write);
  } catch (err) {
    log.error('Provider recovery-point normalization failed', {
      hostId: Number(host.id), provider: adapter.type, error: err?.name || 'Error',
      code: /^SQLITE_[A-Z_]+$/.test(String(err?.code || '')) ? err.code : 'RECOVERY_POINT_WRITE_FAILED',
    });
    throw new ProviderAdapterError('Provider recovery-point inventory could not be normalized', 'RECOVERY_POINT_NORMALIZATION_FAILED', 500);
  }

  const filteredRepositories = repositoryId
    ? normalized.repositories.filter(item => item.id === repositoryId) : normalized.repositories;
  const repositoryIds = new Set(filteredRepositories.map(item => item.id));
  const filtered = normalized.points.filter(item => (!recoveryPointId || item.id === recoveryPointId)
    && (!repositoryId || repositoryIds.has(item.repository?.id))
    && (!workloadId || item.workload?.id === workloadId)
    && (!verification || item.verification?.state === verification)
    && (!from || (item.createdAt && item.createdAt >= from))
    && (!to || (item.createdAt && item.createdAt <= to))
    && (!query || `${item.displayName} ${item.workload?.displayName || ''} ${item.repository?.displayName || ''} ${item.backup?.format || ''}`.toLowerCase().includes(query)))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.id.localeCompare(b.id));
  const items = filtered.slice(0, requestedLimit);
  const stateCounts = Object.fromEntries(recoveryPointCatalog.VERIFICATION_STATES.map(state => [
    state, filtered.filter(item => item.verification.state === state).length,
  ]));
  const dated = filtered.map(item => item.createdAt).filter(Boolean).sort();
  const envelope = {
    schemaVersion: recoveryPointCatalog.RECOVERY_POINT_SCHEMA_VERSION,
    provider: { type: adapter.type, endpointId: Number(host.id) }, observedAt,
    count: items.length, totalObserved: filtered.length, truncated: filtered.length > items.length,
    filters: { recoveryPointId, repositoryId, workloadId, verification, from, to, query: query || null },
    coverage: {
      repositoryCount: filteredRepositories.length,
      workloadCount: new Set(filtered.map(item => item.workload?.id || `missing:${item.workload?.displayName || item.id}`)).size,
      mappedWorkloadCount: new Set(filtered.map(item => item.workload?.id).filter(Boolean)).size,
      newestAt: dated.at(-1) || null, oldestAt: dated[0] || null,
      verification: stateCounts,
      protectedCount: filtered.filter(item => item.backup.protected === true).length,
      encryptedCount: filtered.filter(item => item.backup.encrypted === true).length,
    },
    repositories: filteredRepositories,
    limitations: (Array.isArray(raw.limitations) ? raw.limitations : []).slice(0, 20)
      .map(item => String(item).replace(/[\r\n\t]+/g, ' ').slice(0, 500)),
    items,
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > recoveryPointCatalog.MAX_RECOVERY_INVENTORY_BYTES) {
    throw new ProviderAdapterError('Recovery-point inventory exceeds the response size limit', 'RECOVERY_POINT_RESPONSE_TOO_LARGE', 502);
  }
  return envelope;
}

async function vmHardwareForHost(host, resource, options = {}) {
  if (!host || !Number.isInteger(Number(host.id)) || resource?.kind !== 'virtualMachine'
    || resource?.provider?.endpointId !== Number(host.id)) {
    throw new ProviderAdapterError('Valid host-scoped virtual machine required', 'INVALID_PROVIDER_RESOURCE', 400);
  }
  const adapter = getAdapter(host.daemon_type);
  const capabilities = options.capabilities || await capabilitiesForHost(host);
  const readable = ['vm.disk.read', 'vm.nic.read'].some(key =>
    ['supported', 'conditional'].includes(capabilities.features?.[key]?.state));
  if (!readable || typeof adapter.readVmHardware !== 'function') {
    throw new ProviderAdapterError('VM device inventory is unavailable for this provider', 'PROVIDER_VM_HARDWARE_UNAVAILABLE', 400);
  }
  const database = options.database || getDb();
  const identity = identityStore.resolveCanonical(resource.id, {
    hostId: Number(host.id), kind: 'virtualMachine',
  }, database);
  if (!identity || identity.providerType !== host.daemon_type) {
    throw new ProviderAdapterError('Virtual machine identity was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  }
  let raw;
  try {
    raw = await providerResilience.run(Number(host.id), () => adapter.readVmHardware(host, {
      identity, resource, capabilities,
    }), { operation: 'inventory.vmHardware' });
  } catch (err) {
    log.warn('Provider VM hardware read failed', {
      hostId: Number(host.id), provider: adapter.type,
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'PROVIDER_READ_FAILED',
    });
    throw new ProviderAdapterError('Provider VM hardware inventory could not be read', 'PROVIDER_VM_HARDWARE_READ_FAILED', 502);
  }
  try {
    return normalizeVmHardware({ host, providerType: adapter.type, resource, raw });
  } catch (err) {
    log.error('Provider VM hardware normalization failed', {
      hostId: Number(host.id), provider: adapter.type, error: err?.name || 'Error',
    });
    throw new ProviderAdapterError('Provider VM hardware inventory could not be normalized', 'VM_HARDWARE_NORMALIZATION_FAILED', 500);
  }
}

async function migrationCompatibilityForHost(host, resource, targets, options = {}) {
  if (!host || !Number.isInteger(Number(host.id)) || resource?.kind !== 'virtualMachine'
    || resource?.provider?.endpointId !== Number(host.id) || !Array.isArray(targets)
    || targets.length > 64 || targets.some(target => target?.kind !== 'host'
      || target?.provider?.endpointId !== Number(host.id))) {
    throw new ProviderAdapterError('Valid host-scoped migration context required', 'INVALID_MIGRATION_CONTEXT', 400);
  }
  const adapter = getAdapter(host.daemon_type);
  const capabilities = options.capabilities || await capabilitiesForHost(host);
  const evidence = capabilities.features?.['vm.migration.preflight'];
  if (!['supported', 'conditional'].includes(evidence?.state) || typeof adapter.migrationCompatibility !== 'function') {
    throw new ProviderAdapterError(evidence?.reason || 'Migration preflight is unavailable for this provider',
      'PROVIDER_MIGRATION_PREFLIGHT_UNAVAILABLE', 400);
  }
  const database = options.database || getDb();
  const identity = identityStore.resolveCanonical(resource.id, {
    hostId: Number(host.id), kind: 'virtualMachine',
  }, database);
  if (!identity || identity.providerType !== host.daemon_type) {
    throw new ProviderAdapterError('Virtual machine identity was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  }
  const resolvedTargets = targets.map(target => ({
    resource: target,
    identity: identityStore.resolveCanonical(target.id, {
      hostId: Number(host.id), kind: 'host',
    }, database),
  }));
  if (resolvedTargets.some(target => !target.identity || target.identity.providerType !== host.daemon_type)) {
    throw new ProviderAdapterError('Migration target identity was not found', 'PROVIDER_MIGRATION_TARGET_NOT_FOUND', 404);
  }
  let result;
  try {
    result = await providerResilience.run(Number(host.id), () => adapter.migrationCompatibility(host, {
      identity, resource, targets: resolvedTargets, capabilities,
    }), { operation: 'preflight.vmMigration' });
  } catch (err) {
    log.warn('Provider migration compatibility read failed', {
      hostId: Number(host.id), provider: adapter.type,
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'PROVIDER_READ_FAILED',
    });
    throw new ProviderAdapterError('Provider migration compatibility could not be read',
      'PROVIDER_MIGRATION_PREFLIGHT_READ_FAILED', 502);
  }
  const validTargetIds = new Set(targets.map(target => target.id));
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Array.isArray(result.candidates) || result.candidates.length > targets.length
    || result.candidates.some(candidate => !candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || !validTargetIds.has(candidate.targetId))
    || new Set(result.candidates.map(candidate => candidate.targetId)).size !== result.candidates.length) {
    throw new ProviderAdapterError('Provider returned invalid migration compatibility evidence',
      'INVALID_PROVIDER_MIGRATION_RESPONSE', 502);
  }
  return result;
}

async function placementInventoryForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) {
    throw new ProviderAdapterError('Valid provider host required', 'INVALID_HOST');
  }
  const adapter = getAdapter(host.daemon_type);
  const capabilities = options.capabilities || await capabilitiesForHost(host);
  if (capabilities.probe.status !== 'reachable') {
    throw new ProviderAdapterError('Provider endpoint is currently unreachable', 'PROVIDER_UNREACHABLE', 502);
  }
  const evidence = capabilities.features?.['placement.affinity.read'];
  if (!['supported', 'conditional'].includes(evidence?.state)) {
    return { rules: [], nativeRecommendations: [], limitations: [evidence?.reason || 'Affinity policy is unavailable'] };
  }
  if (typeof adapter.placementInventory !== 'function') {
    throw new ProviderAdapterError('Placement policy adapter is unavailable', 'PROVIDER_PLACEMENT_UNAVAILABLE', 400);
  }
  let result;
  try {
    result = await providerResilience.run(Number(host.id), () => adapter.placementInventory(host, {
      capabilities,
    }), { operation: 'inventory.placementPolicy' });
  } catch (err) {
    log.warn('Provider placement policy read failed', {
      hostId: Number(host.id), provider: adapter.type,
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'PROVIDER_READ_FAILED',
    });
    throw new ProviderAdapterError('Provider placement policy could not be read', 'PROVIDER_PLACEMENT_READ_FAILED', 502);
  }
  if (!result || !Array.isArray(result.rules) || result.rules.length > 500
    || !Array.isArray(result.nativeRecommendations || []) || (result.nativeRecommendations || []).length > 500) {
    throw new ProviderAdapterError('Provider returned invalid placement policy evidence', 'INVALID_PROVIDER_PLACEMENT_RESPONSE', 502);
  }
  return result;
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
  providerResilience.clear();
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
  resourcesForHost,
  artifactsForHost,
  recoveryPointsForHost,
  vmHardwareForHost,
  migrationCompatibilityForHost,
  placementInventoryForHost,
  invalidateHost,
  _internals: {
    adapters, cache, inFlight, clear, _sanitizeProbeError, _retrySqliteBusy,
    SUCCESS_TTL_MS, ERROR_TTL_MS, MAX_CACHE_ENTRIES,
  },
};
