'use strict';

const { getDb } = require('../../db');
const { encrypt, sha256 } = require('../../utils/crypto');

const ARTIFACT_SCHEMA_VERSION = '1.0';
const ARTIFACT_KINDS = Object.freeze([
  'vmTemplate', 'iso', 'containerTemplate', 'diskImage', 'contentLibraryItem',
]);
const KIND_SET = new Set(ARTIFACT_KINDS);
const SAFE_ID = /^dda_art_[a-f0-9]{26}$/;
const SAFE_PROVIDER = /^[a-z][a-z0-9_-]{1,39}$/;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _number(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function _timestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function _bool(value) { return typeof value === 'boolean' ? value : null; }

function _labels(raw) {
  const labels = {};
  const source = raw?.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)
    ? raw.labels : {};
  for (const [key, value] of Object.entries(source).slice(0, 48)) {
    const safeKey = _text(key, 64);
    const safeValue = _text(value, 160);
    if (/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(safeKey || '') && safeValue) labels[safeKey] = safeValue;
  }
  for (const [index, tag] of (Array.isArray(raw?.tags) ? raw.tags : []).slice(0, 48 - Object.keys(labels).length).entries()) {
    const value = _text(tag, 160);
    if (value) labels[`tag${index}`] = value;
  }
  return labels;
}

function _publicArtifact({ id, host, providerType, raw, observedAt, stability, uuid }) {
  const artifact = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    kind: raw.kind,
    id,
    displayName: _text(raw.name ?? raw.displayName ?? uuid ?? id, 240),
    description: _text(raw.description, 1000),
    observedAt,
    createdAt: _timestamp(raw.createdAt),
    provider: { type: providerType, endpointId: Number(host.id) },
    identity: { uuid, stability },
    provenance: {
      source: _text(raw.source, 80) || 'provider-inventory',
      node: _text(raw.node, 160),
      storage: _text(raw.storage, 160),
      pool: _text(raw.pool, 160),
      library: _text(raw.library, 160),
    },
    spec: {
      osType: _text(raw.osType ?? raw.guestOS, 240),
      architecture: _text(raw.architecture, 80),
      version: _text(raw.version, 120),
      format: _text(raw.format, 80),
      sizeBytes: _number(raw.sizeBytes ?? raw.size),
      cpuCount: _number(raw.cpuCount ?? raw.cpus ?? raw.numCPU),
      memoryBytes: _number(raw.memoryBytes ?? (raw.memoryMB == null ? null : Number(raw.memoryMB) * 1024 * 1024)),
      default: _bool(raw.default),
    },
    labels: _labels(raw),
  };
  artifact.provenance = Object.fromEntries(Object.entries(artifact.provenance).filter(([, value]) => value !== null));
  artifact.spec = Object.fromEntries(Object.entries(artifact.spec).filter(([, value]) => value !== null));
  validateArtifact(artifact);
  return artifact;
}

function normalizeAndRemember({ host, providerType, raw, observedAt, database }) {
  const db = database || getDb();
  const hostId = Number(host?.id);
  const provider = String(providerType || '').toLowerCase();
  if (!Number.isInteger(hostId) || hostId <= 0 || !SAFE_PROVIDER.test(provider)) {
    throw new Error('Artifact catalog context is invalid');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !KIND_SET.has(raw.kind)) {
    throw new Error('Provider artifact is invalid');
  }
  const nativeRef = _text(raw.nativeRef ?? raw.ref ?? raw.moref ?? raw.volid ?? raw.id ?? raw.uuid, 2048);
  if (!nativeRef) throw new Error('Provider artifact has no usable identity');
  const uuid = _text(raw.uuid, 512);
  const stability = uuid ? 'stable' : 'derived';
  const refHash = sha256(`${hostId}|${raw.kind}|${nativeRef}`);
  const derivedId = `dda_art_${sha256(`${hostId}|${raw.kind}|${uuid || nativeRef}`).slice(0, 26)}`;
  const existing = (uuid ? db.prepare(`SELECT canonical_id FROM provider_artifact_catalog
    WHERE host_id = ? AND artifact_kind = ? AND provider_uuid = ?`).get(hostId, raw.kind, uuid) : null)
    || db.prepare(`SELECT canonical_id FROM provider_artifact_catalog
      WHERE host_id = ? AND artifact_kind = ? AND native_ref_hash = ?`).get(hostId, raw.kind, refHash);
  const id = existing?.canonical_id || derivedId;
  const artifact = _publicArtifact({ id, host, providerType: provider, raw, observedAt, stability, uuid });
  const json = JSON.stringify(artifact);
  if (Buffer.byteLength(json) > MAX_ARTIFACT_BYTES) throw new Error('Normalized provider artifact is too large');
  db.prepare(`INSERT INTO provider_artifact_catalog
    (canonical_id, host_id, provider_type, artifact_kind, provider_uuid, native_ref_hash,
     native_ref_enc, display_name, artifact_json, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_id) DO UPDATE SET
      provider_type = excluded.provider_type,
      provider_uuid = COALESCE(excluded.provider_uuid, provider_artifact_catalog.provider_uuid),
      native_ref_hash = excluded.native_ref_hash,
      native_ref_enc = excluded.native_ref_enc,
      display_name = excluded.display_name,
      artifact_json = excluded.artifact_json,
      observed_at = excluded.observed_at,
      last_seen_at = datetime('now')`).run(
    id, hostId, provider, raw.kind, uuid, refHash, encrypt(nativeRef), artifact.displayName, json, observedAt
  );
  return artifact;
}

function validateArtifact(artifact) {
  const errors = [];
  if (artifact?.schemaVersion !== ARTIFACT_SCHEMA_VERSION) errors.push('schemaVersion');
  if (!KIND_SET.has(artifact?.kind)) errors.push('kind');
  if (!SAFE_ID.test(artifact?.id || '')) errors.push('id');
  if (!artifact?.displayName) errors.push('displayName');
  if (Number.isNaN(Date.parse(artifact?.observedAt))) errors.push('observedAt');
  if (!Number.isInteger(artifact?.provider?.endpointId) || !SAFE_PROVIDER.test(artifact?.provider?.type || '')) errors.push('provider');
  if (!['stable', 'derived'].includes(artifact?.identity?.stability)) errors.push('identity');
  if (errors.length) throw new Error(`Invalid normalized artifact: ${errors.join(', ')}`);
  return true;
}

module.exports = {
  ARTIFACT_SCHEMA_VERSION, ARTIFACT_KINDS, MAX_CATALOG_BYTES,
  normalizeAndRemember, validateArtifact,
  _internals: { SAFE_ID, _text, _timestamp },
};
