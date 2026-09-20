'use strict';

const path = require('path').posix;
const config = require('../../config');
const { getDb } = require('../../db');
const { generateToken, sha256 } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');

const SCHEMA_VERSION = '1.0';
const PLAN_TTL_MS = 5 * 60 * 1000;
const SAFE_POINT_ID = /^ddr_rp_[a-f0-9]{26}$/;
const SAFE_POLICY_ID = /^prpl_[a-f0-9]{26}$/;
const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_STORAGE_ID = /^ddr_storage_[a-f0-9]{26}$/;
const KINDS = new Set(['file_download', 'file_restore', 'instant', 'differential', 'cross_site_copy']);
const MODES = new Set(['async', 'near_sync', 'sync']);
const CAPABILITIES = {
  file_download: 'backup.restore.file', file_restore: 'backup.restore.file',
  instant: 'backup.restore.instant', differential: 'backup.restore.differential',
  cross_site_copy: 'backup.copy.cross_site',
};

class RestoreReplicationDepthError extends Error {
  constructor(message, code = 'RESTORE_REPLICATION_DEPTH_ERROR', status = 400, details = null) {
    super(message); this.name = 'RestoreReplicationDepthError'; this.code = code;
    this.status = status; this.details = details;
  }
}

function _database(options = {}) { return options.database || getDb(); }
function _registry(options = {}) { return options.registry || registrySingleton; }
function _enabled(options = {}) {
  return options.enabled === undefined ? config.features.providerRestoreReplicationDepth : options.enabled === true;
}
function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function _json(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || null;
}
function _integer(value, label, min, max, fallback = null) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new RestoreReplicationDepthError(
    `${label} must be an integer between ${min} and ${max}`, 'INVALID_RESTORE_REPLICATION_DEPTH');
  return number;
}
function _host(database, id) {
  const hostId = Number(id);
  const row = Number.isInteger(hostId) && hostId > 0
    ? database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(hostId) : null;
  if (!row) throw new RestoreReplicationDepthError('Provider endpoint was not found', 'PROVIDER_ENDPOINT_NOT_FOUND', 404);
  return row;
}
function _point(database, hostId, pointIdInput) {
  const pointId = String(pointIdInput || '');
  if (!SAFE_POINT_ID.test(pointId)) throw new RestoreReplicationDepthError(
    'Recovery point was not found', 'RECOVERY_POINT_NOT_FOUND', 404);
  const row = database.prepare(`SELECT canonical_id,host_id,provider_type,recovery_point_json,observed_at
    FROM provider_recovery_points WHERE canonical_id=? AND host_id=?`).get(pointId, Number(hostId));
  if (!row) throw new RestoreReplicationDepthError('Recovery point was not found', 'RECOVERY_POINT_NOT_FOUND', 404);
  return row;
}
function _timestamp(value, label = 'Timestamp') {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) throw new RestoreReplicationDepthError(
    `${label} is invalid`, 'INVALID_RESTORE_REPLICATION_DEPTH');
  return date.toISOString();
}
function _safePath(value) {
  const raw = String(value || '');
  if (!raw || raw.length > 2048 || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)
    || !raw.startsWith('/') || raw.split('/').includes('..')) throw new RestoreReplicationDepthError(
    'Catalog paths must be absolute POSIX paths without traversal segments', 'UNSAFE_RECOVERY_FILE_PATH');
  const normalized = path.normalize(raw);
  if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('/../')) {
    throw new RestoreReplicationDepthError('Catalog path escapes the recovery root', 'UNSAFE_RECOVERY_FILE_PATH');
  }
  return normalized;
}
function _entry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RestoreReplicationDepthError(
    'File catalog entry is invalid', 'INVALID_RECOVERY_FILE_CATALOG');
  const entryPath = _safePath(input.path);
  const type = String(input.type || 'file');
  if (!['file', 'directory', 'symlink'].includes(type)) throw new RestoreReplicationDepthError(
    'File catalog entry type is invalid', 'INVALID_RECOVERY_FILE_CATALOG');
  const sizeBytes = input.sizeBytes === null || input.sizeBytes === undefined ? null
    : _integer(input.sizeBytes, 'File size', 0, Number.MAX_SAFE_INTEGER);
  const checksum = _text(input.checksum, 160);
  if (checksum && !/^[A-Za-z0-9:+._-]{8,160}$/.test(checksum)) throw new RestoreReplicationDepthError(
    'File checksum evidence is invalid', 'INVALID_RECOVERY_FILE_CATALOG');
  return {
    path: entryPath, parentPath: entryPath === '/' ? '/' : path.dirname(entryPath),
    name: entryPath === '/' ? '/' : path.basename(entryPath), type, sizeBytes,
    modifiedAt: input.modifiedAt ? _timestamp(input.modifiedAt, 'File modification timestamp') : null,
    checksum, metadata: { sparse: input.sparse === true, encrypted: input.encrypted === true,
      application: _text(input.application, 80) },
  };
}
function _publicCatalog(row) {
  return row ? { schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id),
    recoveryPointId: row.recovery_point_id, state: row.state, source: row.source,
    entryCount: Number(row.entry_count), manifestHash: row.manifest_hash,
    observedAt: row.observed_at, updatedAt: row.updated_at } : null;
}

function importFileCatalog(host, pointId, input = {}, options = {}) {
  if (!_enabled(options)) throw new RestoreReplicationDepthError(
    'Restore-depth control plane is disabled by release policy', 'RESTORE_REPLICATION_DEPTH_DISABLED', 404);
  const database = _database(options); _point(database, host.id, pointId);
  const rawEntries = input.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length > 5000) throw new RestoreReplicationDepthError(
    'File catalog requires an entries array with at most 5000 items', 'INVALID_RECOVERY_FILE_CATALOG');
  const entries = rawEntries.map(_entry); const paths = new Set();
  for (const item of entries) {
    if (paths.has(item.path)) throw new RestoreReplicationDepthError(
      'File catalog paths must be unique', 'INVALID_RECOVERY_FILE_CATALOG');
    paths.add(item.path);
  }
  const state = String(input.state || 'complete');
  if (!['complete', 'partial', 'stale'].includes(state)) throw new RestoreReplicationDepthError(
    'File catalog state is invalid', 'INVALID_RECOVERY_FILE_CATALOG');
  const source = input.source === 'provider' ? 'provider' : 'imported_evidence';
  const observedAt = _timestamp(input.observedAt || new Date().toISOString(), 'Catalog observation timestamp');
  const manifestHash = sha256(_canonical({ recoveryPointId: pointId, state, source, observedAt, entries }));
  const existing = database.prepare(`SELECT id FROM provider_recovery_file_catalogs
    WHERE host_id=? AND recovery_point_id=?`).get(Number(host.id), String(pointId));
  const id = existing?.id || `prfc_${generateToken(13)}`;
  database.transaction(() => {
    database.prepare(`INSERT INTO provider_recovery_file_catalogs
      (id,host_id,recovery_point_id,state,source,entry_count,manifest_hash,observed_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(host_id,recovery_point_id) DO UPDATE SET
      state=excluded.state,source=excluded.source,entry_count=excluded.entry_count,
      manifest_hash=excluded.manifest_hash,observed_at=excluded.observed_at,updated_at=datetime('now')`)
      .run(id, Number(host.id), String(pointId), state, source, entries.length, manifestHash,
        observedAt, options.createdBy || null);
    database.prepare('DELETE FROM provider_recovery_file_entries WHERE catalog_id=?').run(id);
    const insert = database.prepare(`INSERT INTO provider_recovery_file_entries
      (catalog_id,path,parent_path,name,entry_type,size_bytes,modified_at,checksum,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const item of entries) insert.run(id, item.path, item.parentPath, item.name, item.type,
      item.sizeBytes, item.modifiedAt, item.checksum, JSON.stringify(item.metadata));
  })();
  return { created: !existing, catalog: _publicCatalog(database.prepare(
    'SELECT * FROM provider_recovery_file_catalogs WHERE id=?').get(id)) };
}

function listFileEntries(hostId, pointId, filters = {}, options = {}) {
  if (!_enabled(options)) throw new RestoreReplicationDepthError(
    'Restore-depth control plane is disabled by release policy', 'RESTORE_REPLICATION_DEPTH_DISABLED', 404);
  const database = _database(options); _point(database, hostId, pointId);
  const catalogRow = database.prepare(`SELECT * FROM provider_recovery_file_catalogs
    WHERE host_id=? AND recovery_point_id=?`).get(Number(hostId), String(pointId));
  if (!catalogRow) return { schemaVersion: SCHEMA_VERSION, catalog: null, count: 0, items: [],
    limitations: ['No provider or imported file-index evidence is available for this recovery point.'] };
  const limit = _integer(filters.limit, 'File result limit', 1, 500, 200);
  const query = _text(filters.query, 120); const parent = filters.parent ? _safePath(filters.parent) : null;
  const clauses = ['catalog_id=?']; const values = [catalogRow.id];
  if (parent) { clauses.push('parent_path=?'); values.push(parent); }
  if (query) { clauses.push('(lower(name) LIKE ? OR lower(path) LIKE ?)'); const like = `%${query.toLowerCase()}%`; values.push(like, like); }
  values.push(limit);
  const rows = database.prepare(`SELECT * FROM provider_recovery_file_entries WHERE ${clauses.join(' AND ')}
    ORDER BY CASE entry_type WHEN 'directory' THEN 0 ELSE 1 END,name COLLATE NOCASE LIMIT ?`).all(...values);
  return { schemaVersion: SCHEMA_VERSION, catalog: _publicCatalog(catalogRow), count: rows.length,
    items: rows.map(row => ({ path: row.path, parentPath: row.parent_path, name: row.name,
      type: row.entry_type, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      modifiedAt: row.modified_at, checksum: row.checksum, metadata: _json(row.metadata_json, {}) })),
    limitations: ['Catalog entries are metadata evidence only; Docker Dash never stores backup file content.'] };
}

function _normalizeDepthRequest(database, host, pointId, input) {
  const kind = String(input.kind || '');
  if (!KINDS.has(kind)) throw new RestoreReplicationDepthError(
    'Restore-depth kind is invalid', 'INVALID_RESTORE_DEPTH_KIND');
  const request = { kind };
  if (kind === 'file_download' || kind === 'file_restore') {
    request.paths = [...new Set((Array.isArray(input.paths) ? input.paths : []).map(_safePath))];
    if (!request.paths.length || request.paths.length > 100) throw new RestoreReplicationDepthError(
      'File restore planning requires 1-100 safe catalog paths', 'INVALID_RESTORE_DEPTH_REQUEST');
    request.targetPath = kind === 'file_restore' ? _safePath(input.targetPath) : null;
    request.overwrite = false;
  } else if (kind === 'instant') {
    request.networkIsolation = input.networkIsolation === true;
    request.hydrationStorageId = input.hydrationStorageId ? String(input.hydrationStorageId) : null;
  } else if (kind === 'differential') {
    request.baseRecoveryPointId = String(input.baseRecoveryPointId || '');
    if (!SAFE_POINT_ID.test(request.baseRecoveryPointId)) throw new RestoreReplicationDepthError(
      'Differential restore requires a canonical base recovery point', 'INVALID_RESTORE_DEPTH_REQUEST');
    _point(database, host.id, request.baseRecoveryPointId);
    request.baseChecksum = _text(input.baseChecksum, 160);
    request.targetIsolated = input.targetIsolated === true;
  } else {
    request.targetHostId = Number(input.targetHostId);
    _host(database, request.targetHostId);
    if (request.targetHostId === Number(host.id)) throw new RestoreReplicationDepthError(
      'Cross-site copy target must differ from the source endpoint', 'INVALID_RESTORE_DEPTH_REQUEST');
    request.bandwidthLimitMbps = _integer(input.bandwidthLimitMbps, 'Bandwidth limit', 1, 1000000, 100);
    request.resume = input.resume !== false; request.verifyChecksum = input.verifyChecksum !== false;
  }
  return request;
}

async function preflightDepthForHost(host, pointId, input = {}, options = {}) {
  if (!_enabled(options)) throw new RestoreReplicationDepthError(
    'Restore-depth control plane is disabled by release policy', 'RESTORE_REPLICATION_DEPTH_DISABLED', 404);
  const database = _database(options); const stored = _point(database, host.id, pointId);
  const request = _normalizeDepthRequest(database, host, pointId, input);
  const capabilities = await _registry(options).capabilitiesForHost(host);
  const capabilityKey = CAPABILITIES[request.kind];
  const capability = capabilities.features?.[capabilityKey]
    || { state: 'unsupported', reason: `${capabilityKey} has no provider capability contract`, constraints: {} };
  const blockers = [];
  if (options.canOperate !== true) blockers.push({ code: 'PERMISSION_BLOCKED', reason: 'Operate permission is required' });
  if (!['supported', 'conditional'].includes(capability.state)) blockers.push({
    code: 'CAPABILITY_UNAVAILABLE', reason: capability.reason || `${capabilityKey} is unavailable`,
    capability: capabilityKey, state: capability.state,
  });
  const catalog = database.prepare(`SELECT * FROM provider_recovery_file_catalogs
    WHERE host_id=? AND recovery_point_id=?`).get(Number(host.id), String(pointId));
  if (request.kind.startsWith('file_') && !catalog) blockers.push({
    code: 'FILE_CATALOG_REQUIRED', reason: 'Import or collect a bounded file catalog before planning file recovery',
  });
  if (request.kind === 'instant' && !request.networkIsolation) blockers.push({
    code: 'NETWORK_ISOLATION_REQUIRED', reason: 'Instant restore requires an explicitly isolated network',
  });
  if (request.kind === 'differential' && (!request.baseChecksum || !request.targetIsolated)) blockers.push({
    code: 'BASE_INTEGRITY_REQUIRED', reason: 'Differential restore requires a base checksum and isolated target',
  });
  blockers.push({ code: 'EXECUTION_ADAPTER_UNAVAILABLE',
    reason: 'This release records a bounded plan but has no conformance-tested provider mutation adapter for this operation' });
  const evidence = { recoveryPoint: { id: stored.canonical_id, observedAt: stored.observed_at },
    capability: { key: capabilityKey, state: capability.state, reason: capability.reason || null,
      constraints: capability.constraints || {} }, catalog: catalog ? { id: catalog.id, manifestHash: catalog.manifest_hash,
      state: catalog.state, observedAt: catalog.observed_at } : null,
    safety: { overwrite: false, providerMutation: false, rawBackupContentStored: false } };
  const semantic = { schemaVersion: SCHEMA_VERSION, hostId: Number(host.id), recoveryPointId: String(pointId),
    request, evidence, blockers };
  const planHash = sha256(_canonical(semantic)); const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString();
  const id = `prdp_${generateToken(13)}`;
  database.prepare(`INSERT INTO provider_restore_depth_plans
    (id,host_id,recovery_point_id,restore_kind,request_json,evidence_json,plan_hash,allowed,created_by,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, Number(host.id), String(pointId), request.kind,
    JSON.stringify(request), JSON.stringify(evidence), planHash, 0, options.createdBy || null, expiresAt);
  return { ...semantic, id, planHash, allowed: false, expiresAt,
    limitations: ['Plan-only: no file data is served and no provider mutation is submitted.'] };
}

function _publicPolicy(row) {
  return row ? { schemaVersion: row.schema_version || SCHEMA_VERSION, id: row.id,
    sourceHostId: Number(row.source_host_id), targetHostId: Number(row.target_host_id), name: row.name,
    mode: row.mode, enabled: row.enabled === 1, revision: Number(row.revision),
    rpoTargetSeconds: Number(row.rpo_target_seconds), schedule: row.schedule,
    bandwidthLimitMbps: row.bandwidth_limit_mbps === null ? null : Number(row.bandwidth_limit_mbps),
    workloadIds: _json(row.workload_ids_json, []), storageMappings: _json(row.storage_mappings_json, []),
    capability: _json(row.capability_json, {}), policyHash: row.policy_hash,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}
function listReplicationPolicies(hostId, options = {}) {
  if (!_enabled(options)) throw new RestoreReplicationDepthError(
    'Restore-depth control plane is disabled by release policy', 'RESTORE_REPLICATION_DEPTH_DISABLED', 404);
  const limit = _integer(options.limit, 'Replication policy limit', 1, 200, 100);
  return _database(options).prepare(`SELECT * FROM provider_replication_policies
    WHERE source_host_id=? AND deleted_at IS NULL ORDER BY lower(name) LIMIT ?`).all(Number(hostId), limit).map(_publicPolicy);
}
function _identity(database, hostId, id, kind, regex) {
  const value = String(id || '');
  if (!regex.test(value) || !database.prepare(`SELECT canonical_id FROM provider_resource_identities
    WHERE canonical_id=? AND host_id=? AND resource_kind=?`).get(value, Number(hostId), kind)) {
    throw new RestoreReplicationDepthError(`Canonical ${kind} is outside the expected endpoint`,
      'REPLICATION_RESOURCE_SCOPE_MISMATCH', 409);
  }
  return value;
}
async function upsertReplicationPolicy(host, input = {}, options = {}) {
  if (!_enabled(options)) throw new RestoreReplicationDepthError(
    'Restore-depth control plane is disabled by release policy', 'RESTORE_REPLICATION_DEPTH_DISABLED', 404);
  const database = _database(options); const existing = input.id ? database.prepare(`SELECT * FROM provider_replication_policies
    WHERE id=? AND source_host_id=? AND deleted_at IS NULL`).get(String(input.id), Number(host.id)) : null;
  if (input.id && (!SAFE_POLICY_ID.test(String(input.id)) || !existing)) throw new RestoreReplicationDepthError(
    'Replication policy was not found', 'REPLICATION_POLICY_NOT_FOUND', 404);
  const name = _text(input.name ?? existing?.name, 100);
  if (!name || /[<>]/.test(name)) throw new RestoreReplicationDepthError(
    'Replication policy name is invalid', 'INVALID_REPLICATION_POLICY');
  const targetHostId = Number(input.targetHostId ?? existing?.target_host_id); _host(database, targetHostId);
  const mode = String(input.mode ?? existing?.mode ?? 'async');
  if (!MODES.has(mode)) throw new RestoreReplicationDepthError('Replication mode is invalid', 'INVALID_REPLICATION_POLICY');
  const rpoTargetSeconds = _integer(input.rpoTargetSeconds ?? existing?.rpo_target_seconds,
    'RPO target', 5, 31536000, 3600);
  if ((mode === 'sync' && rpoTargetSeconds > 60) || (mode === 'near_sync' && rpoTargetSeconds > 300)) {
    throw new RestoreReplicationDepthError('Replication mode and RPO target are inconsistent', 'INVALID_REPLICATION_POLICY');
  }
  const workloadInput = input.workloadIds ?? _json(existing?.workload_ids_json, []);
  if (!Array.isArray(workloadInput) || !workloadInput.length || workloadInput.length > 200) throw new RestoreReplicationDepthError(
    'Replication policy requires 1-200 workloads', 'INVALID_REPLICATION_POLICY');
  const workloadIds = [...new Set(workloadInput.map(id => _identity(database, host.id, id,
    'virtualMachine', SAFE_VM_ID)))];
  const mappingInput = input.storageMappings ?? _json(existing?.storage_mappings_json, []);
  if (!Array.isArray(mappingInput) || mappingInput.length > 64) throw new RestoreReplicationDepthError(
    'Storage mappings are invalid', 'INVALID_REPLICATION_POLICY');
  const storageMappings = mappingInput.map(item => ({
    sourceStorageId: _identity(database, host.id, item?.sourceStorageId, 'storage', SAFE_STORAGE_ID),
    targetStorageId: _identity(database, targetHostId, item?.targetStorageId, 'storage', SAFE_STORAGE_ID),
  }));
  const capabilities = await _registry(options).capabilitiesForHost(host);
  const capability = capabilities.features?.['replication.configure']
    || { state: 'unsupported', reason: 'Provider capability evidence is unavailable', constraints: {} };
  const enabled = input.enabled === undefined ? existing?.enabled === 1 : input.enabled === true;
  if (enabled) throw new RestoreReplicationDepthError(
    'Replication execution cannot be enabled until a conformance-tested provider mutation adapter is installed',
    'REPLICATION_EXECUTION_UNAVAILABLE', 409, { capability });
  const normalized = { sourceHostId: Number(host.id), targetHostId, name, mode, enabled: false,
    rpoTargetSeconds, schedule: _text(input.schedule ?? existing?.schedule, 120),
    bandwidthLimitMbps: input.bandwidthLimitMbps === null ? null : _integer(
      input.bandwidthLimitMbps ?? existing?.bandwidth_limit_mbps, 'Bandwidth limit', 1, 1000000, 100),
    workloadIds, storageMappings, capability: { key: 'replication.configure', state: capability.state,
      reason: capability.reason || null, constraints: capability.constraints || {} } };
  const policyHash = sha256(_canonical(normalized)); const id = existing?.id || `prpl_${generateToken(13)}`;
  database.prepare(`INSERT INTO provider_replication_policies
    (id,source_host_id,target_host_id,name,mode,enabled,revision,rpo_target_seconds,schedule,
      bandwidth_limit_mbps,workload_ids_json,storage_mappings_json,capability_json,policy_hash,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      target_host_id=excluded.target_host_id,name=excluded.name,mode=excluded.mode,enabled=0,
      revision=provider_replication_policies.revision+1,rpo_target_seconds=excluded.rpo_target_seconds,
      schedule=excluded.schedule,bandwidth_limit_mbps=excluded.bandwidth_limit_mbps,
      workload_ids_json=excluded.workload_ids_json,storage_mappings_json=excluded.storage_mappings_json,
      capability_json=excluded.capability_json,policy_hash=excluded.policy_hash,updated_at=datetime('now')`)
    .run(id, normalized.sourceHostId, targetHostId, name, mode, 0, 1, rpoTargetSeconds,
      normalized.schedule, normalized.bandwidthLimitMbps, JSON.stringify(workloadIds),
      JSON.stringify(storageMappings), JSON.stringify(normalized.capability), policyHash, options.createdBy || null);
  return { created: !existing, policy: _publicPolicy(database.prepare(
    'SELECT * FROM provider_replication_policies WHERE id=?').get(id)),
    limitations: ['Draft-only: provider replication configuration remains fail-closed.'] };
}
function removeReplicationPolicy(hostId, policyId, options = {}) {
  if (!_enabled(options)) throw new RestoreReplicationDepthError(
    'Restore-depth control plane is disabled by release policy', 'RESTORE_REPLICATION_DEPTH_DISABLED', 404);
  const database = _database(options);
  if (!SAFE_POLICY_ID.test(String(policyId || ''))) throw new RestoreReplicationDepthError(
    'Replication policy was not found', 'REPLICATION_POLICY_NOT_FOUND', 404);
  const row = database.prepare(`SELECT * FROM provider_replication_policies
    WHERE id=? AND source_host_id=? AND deleted_at IS NULL`).get(String(policyId), Number(hostId));
  if (!row) throw new RestoreReplicationDepthError('Replication policy was not found', 'REPLICATION_POLICY_NOT_FOUND', 404);
  database.prepare(`UPDATE provider_replication_policies SET enabled=0,deleted_at=datetime('now'),
    updated_at=datetime('now') WHERE id=?`).run(row.id);
  return _publicPolicy(row);
}

module.exports = {
  RestoreReplicationDepthError, importFileCatalog, listFileEntries, preflightDepthForHost,
  listReplicationPolicies, upsertReplicationPolicy, removeReplicationPolicy,
};
