'use strict';

const { getDb } = require('../../db');
const { encrypt, decrypt, sha256 } = require('../../utils/crypto');

const RECOVERY_POINT_SCHEMA_VERSION = '1.0';
const MAX_RECOVERY_POINT_BYTES = 64 * 1024;
const MAX_RECOVERY_INVENTORY_BYTES = 2 * 1024 * 1024;
const SAFE_PROVIDER = /^[a-z][a-z0-9_-]{1,39}$/;
const SAFE_REPOSITORY_ID = /^ddr_repo_[a-f0-9]{26}$/;
const SAFE_POINT_ID = /^ddr_rp_[a-f0-9]{26}$/;
const SAFE_WORKLOAD_ID = /^ddr_vm_[a-f0-9]{26}$/;
const VERIFICATION_STATES = Object.freeze(['verified', 'failed', 'stale', 'unverified', 'unknown']);

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _bool(value) { return typeof value === 'boolean' ? value : null; }

function _number(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function _timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' && value < 10_000_000_000
    ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function _verification(raw) {
  if (raw === true) return { state: 'verified', checkedAt: null };
  if (raw === false) return { state: 'unverified', checkedAt: null };
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw : { state: raw };
  const value = String(source?.state ?? source?.status ?? '').toLowerCase();
  let state = 'unknown';
  if (/^(?:ok|success|verified|passed|valid)$/.test(value)) state = 'verified';
  else if (/^(?:error|failed|failure|invalid|corrupt)$/.test(value)) state = 'failed';
  else if (value === 'stale') state = 'stale';
  else if (/^(?:none|never|unverified)$/.test(value)) state = 'unverified';
  return { state, checkedAt: _timestamp(source?.checkedAt ?? source?.timestamp ?? source?.lastVerifiedAt) };
}

function _repositoryType(value) {
  const type = String(value || '').toLowerCase();
  if (['pbs', 'proxmox-backup-server'].includes(type)) return 'proxmox-backup-server';
  if (['nfs', 'cifs', 'smb', 'cephfs', 'dir', 'file', 's3', 'azure', 'gcs'].includes(type)) return type;
  if (type === 'xo' || type === 'remote') return 'xen-orchestra-remote';
  return 'unknown';
}

function _context(input) {
  const hostId = Number(input?.host?.id);
  const providerType = String(input?.providerType || '').toLowerCase();
  if (!Number.isInteger(hostId) || hostId <= 0 || !SAFE_PROVIDER.test(providerType)) {
    throw new Error('Recovery-point catalog context is invalid');
  }
  return { hostId, providerType, db: input.database || getDb() };
}

function _resolveWorkload(hostId, raw, db) {
  const providerUuid = _text(raw.workloadUuid, 512);
  if (providerUuid) {
    const byUuid = db.prepare(`SELECT canonical_id FROM provider_resource_identities
      WHERE host_id = ? AND resource_kind = 'virtualMachine' AND provider_uuid = ?`).get(hostId, providerUuid);
    if (byUuid?.canonical_id) return byUuid.canonical_id;
  }
  const aliases = [raw.workloadRef, ...(Array.isArray(raw.workloadRefs) ? raw.workloadRefs : [])]
    .map(value => _text(value, 2048)).filter(Boolean);
  const find = db.prepare(`SELECT canonical_id FROM provider_resource_identities
    WHERE host_id = ? AND resource_kind = 'virtualMachine' AND native_ref_hash = ?`);
  for (const alias of aliases) {
    const row = find.get(hostId, sha256(`${hostId}|virtualMachine|${alias}`));
    if (row?.canonical_id) return row.canonical_id;
  }
  return null;
}

function normalizeRepositoryAndRemember(input) {
  const { hostId, providerType, db } = _context(input);
  const raw = input.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Provider backup repository is invalid');
  const nativeRef = _text(raw.nativeRef ?? raw.id, 2048);
  if (!nativeRef) throw new Error('Provider backup repository has no usable identity');
  const refHash = sha256(`${hostId}|repository|${nativeRef}`);
  const existing = db.prepare(`SELECT canonical_id FROM provider_backup_repositories
    WHERE host_id = ? AND native_ref_hash = ?`).get(hostId, refHash);
  const id = existing?.canonical_id || `ddr_repo_${sha256(`${hostId}|repository|${nativeRef}`).slice(0, 26)}`;
  const observedAt = _timestamp(input.observedAt) || new Date().toISOString();
  const repository = {
    schemaVersion: RECOVERY_POINT_SCHEMA_VERSION,
    kind: 'backupRepository', id,
    displayName: _text(raw.name ?? raw.displayName ?? id, 240),
    observedAt,
    provider: { type: providerType, endpointId: hostId },
    repositoryType: _repositoryType(raw.type),
    status: {
      enabled: _bool(raw.enabled), accessible: _bool(raw.accessible),
      capacityBytes: _number(raw.capacityBytes), usedBytes: _number(raw.usedBytes),
    },
    capabilities: {
      verification: _bool(raw.supportsVerification),
      clientSideEncryption: _bool(raw.supportsClientSideEncryption),
      immutableRetention: _bool(raw.supportsImmutableRetention),
    },
  };
  repository.status = Object.fromEntries(Object.entries(repository.status).filter(([, value]) => value !== null));
  repository.capabilities = Object.fromEntries(Object.entries(repository.capabilities).filter(([, value]) => value !== null));
  validateRepository(repository);
  const json = JSON.stringify(repository);
  if (Buffer.byteLength(json) > MAX_RECOVERY_POINT_BYTES) throw new Error('Normalized backup repository is too large');
  db.prepare(`INSERT INTO provider_backup_repositories
    (canonical_id, host_id, provider_type, native_ref_hash, native_ref_enc, display_name, repository_json, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_id) DO UPDATE SET provider_type = excluded.provider_type,
      native_ref_hash = excluded.native_ref_hash, native_ref_enc = excluded.native_ref_enc,
      display_name = excluded.display_name, repository_json = excluded.repository_json,
      observed_at = excluded.observed_at, last_seen_at = datetime('now')`).run(
    id, hostId, providerType, refHash, encrypt(nativeRef), repository.displayName, json, observedAt
  );
  return { repository, nativeRef };
}

function normalizeRecoveryPointAndRemember(input) {
  const { hostId, providerType, db } = _context(input);
  const raw = input.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Provider recovery point is invalid');
  const nativeRef = _text(raw.nativeRef ?? raw.id, 2048);
  if (!nativeRef) throw new Error('Provider recovery point has no usable identity');
  const refHash = sha256(`${hostId}|recoveryPoint|${nativeRef}`);
  const existing = db.prepare(`SELECT canonical_id FROM provider_recovery_points
    WHERE host_id = ? AND native_ref_hash = ?`).get(hostId, refHash);
  const id = existing?.canonical_id || `ddr_rp_${sha256(`${hostId}|recoveryPoint|${nativeRef}`).slice(0, 26)}`;
  const repository = input.repository || null;
  const workloadId = _resolveWorkload(hostId, raw, db);
  const workloadRef = _text(raw.workloadRef, 2048);
  const observedAt = _timestamp(input.observedAt) || new Date().toISOString();
  const createdAt = _timestamp(raw.createdAt ?? raw.timestamp);
  const verification = _verification(raw.verification);
  const point = {
    schemaVersion: RECOVERY_POINT_SCHEMA_VERSION,
    kind: 'recoveryPoint', id,
    displayName: _text(raw.name ?? raw.displayName ?? raw.workloadName ?? id, 240),
    observedAt, createdAt,
    provider: { type: providerType, endpointId: hostId },
    repository: repository ? { id: repository.id, displayName: repository.displayName } : null,
    workload: {
      id: workloadId, kind: 'virtualMachine',
      displayName: _text(raw.workloadName, 240),
      guestType: _text(raw.guestType, 40), missingFromInventory: !workloadId,
    },
    backup: {
      mode: ['full', 'incremental', 'delta'].includes(String(raw.mode || '').toLowerCase())
        ? String(raw.mode).toLowerCase() : 'unknown',
      format: _text(raw.format, 80), sizeBytes: _number(raw.sizeBytes ?? raw.size),
      consistency: ['application', 'filesystem', 'crash', 'unknown'].includes(String(raw.consistency || '').toLowerCase())
        ? String(raw.consistency).toLowerCase() : 'unknown',
      includesMemory: _bool(raw.includesMemory), protected: _bool(raw.protected), encrypted: _bool(raw.encrypted),
    },
    verification,
    retention: {
      expiresAt: _timestamp(raw.expiresAt), immutableUntil: _timestamp(raw.immutableUntil),
    },
  };
  point.workload = Object.fromEntries(Object.entries(point.workload).filter(([, value]) => value !== null));
  point.backup = Object.fromEntries(Object.entries(point.backup).filter(([, value]) => value !== null));
  point.retention = Object.fromEntries(Object.entries(point.retention).filter(([, value]) => value !== null));
  validateRecoveryPoint(point);
  const json = JSON.stringify(point);
  if (Buffer.byteLength(json) > MAX_RECOVERY_POINT_BYTES) throw new Error('Normalized recovery point is too large');
  db.prepare(`INSERT INTO provider_recovery_points
    (canonical_id, host_id, provider_type, repository_id, native_ref_hash, native_ref_enc,
     workload_id, workload_ref_hash, workload_ref_enc, recovery_point_json, created_at, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_id) DO UPDATE SET provider_type = excluded.provider_type,
      repository_id = excluded.repository_id, native_ref_hash = excluded.native_ref_hash,
      native_ref_enc = excluded.native_ref_enc, workload_id = excluded.workload_id,
      workload_ref_hash = excluded.workload_ref_hash, workload_ref_enc = excluded.workload_ref_enc,
      recovery_point_json = excluded.recovery_point_json, created_at = excluded.created_at,
      observed_at = excluded.observed_at, last_seen_at = datetime('now')`).run(
    id, hostId, providerType, repository?.id || null, refHash, encrypt(nativeRef), workloadId,
    workloadRef ? sha256(`${hostId}|virtualMachine|${workloadRef}`) : null,
    workloadRef ? encrypt(workloadRef) : null, json, createdAt, observedAt
  );
  return point;
}

function validateRepository(item) {
  const errors = [];
  if (item?.schemaVersion !== RECOVERY_POINT_SCHEMA_VERSION) errors.push('schemaVersion');
  if (item?.kind !== 'backupRepository' || !SAFE_REPOSITORY_ID.test(item?.id || '')) errors.push('identity');
  if (!item?.displayName || Number.isNaN(Date.parse(item?.observedAt))) errors.push('metadata');
  if (!Number.isInteger(item?.provider?.endpointId) || !SAFE_PROVIDER.test(item?.provider?.type || '')) errors.push('provider');
  if (errors.length) throw new Error(`Invalid normalized backup repository: ${errors.join(', ')}`);
  return true;
}

function validateRecoveryPoint(item) {
  const errors = [];
  if (item?.schemaVersion !== RECOVERY_POINT_SCHEMA_VERSION) errors.push('schemaVersion');
  if (item?.kind !== 'recoveryPoint' || !SAFE_POINT_ID.test(item?.id || '')) errors.push('identity');
  if (!item?.displayName || Number.isNaN(Date.parse(item?.observedAt))) errors.push('metadata');
  if (item?.createdAt && Number.isNaN(Date.parse(item.createdAt))) errors.push('createdAt');
  if (!Number.isInteger(item?.provider?.endpointId) || !SAFE_PROVIDER.test(item?.provider?.type || '')) errors.push('provider');
  if (item?.repository && !SAFE_REPOSITORY_ID.test(item.repository.id || '')) errors.push('repository');
  if (item?.workload?.id && !SAFE_WORKLOAD_ID.test(item.workload.id)) errors.push('workload');
  if (!VERIFICATION_STATES.includes(item?.verification?.state)) errors.push('verification');
  if (errors.length) throw new Error(`Invalid normalized recovery point: ${errors.join(', ')}`);
  return true;
}

function resolveRepository(canonicalId, scope = {}, database) {
  const db = database || getDb();
  const hostId = Number(scope.hostId);
  if (!SAFE_REPOSITORY_ID.test(String(canonicalId || '')) || !Number.isInteger(hostId) || hostId <= 0) return null;
  const row = db.prepare(`SELECT canonical_id, provider_type, native_ref_enc, repository_json, observed_at
    FROM provider_backup_repositories WHERE canonical_id = ? AND host_id = ?`).get(canonicalId, hostId);
  if (!row) return null;
  return {
    id: row.canonical_id, providerType: row.provider_type,
    nativeRef: decrypt(row.native_ref_enc),
    repository: { ..._parseRepository(row.repository_json), observedAt: row.observed_at },
  };
}

function _parseRepository(value) {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

module.exports = {
  RECOVERY_POINT_SCHEMA_VERSION, MAX_RECOVERY_INVENTORY_BYTES, VERIFICATION_STATES,
  normalizeRepositoryAndRemember, normalizeRecoveryPointAndRemember,
  validateRepository, validateRecoveryPoint, resolveRepository,
  _internals: { SAFE_REPOSITORY_ID, SAFE_POINT_ID, _timestamp, _verification, _repositoryType },
};
