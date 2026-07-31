'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { generateToken, sha256 } = require('../../utils/crypto');
const registrySingleton = require('./registry');

const SCHEMA_VERSION = '1.0';
const PLAN_TTL_MS = 5 * 60 * 1000;
const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SAFE_RESOURCE_ID = /^ddr_(vm|host|cluster|storage|network)_[a-f0-9]{26}$/;
const SAFE_ARTIFACT_ID = /^dda_art_[a-f0-9]{26}$/;
const SAFE_KEY_PROVIDER_ID = /^pkpr_[a-f0-9]{26}$/;
const CONFIDENTIAL_MODES = new Set(['shielded', 'sev', 'sev_es', 'sev_snp', 'tdx']);
const ENCRYPTION_STATES = new Set(['encrypted', 'unencrypted', 'partial', 'unknown']);
const PACKS = Object.freeze({
  proxmox: { key: 'proxmox-security', title: 'Proxmox VE security posture', version: '1.0.0',
    checks: ['secure_boot', 'vtpm', 'disk_encryption', 'migration_encryption', 'backup_encryption', 'key_provider', 'confidential_compute', 'host_hardening'] },
  vsphere: { key: 'vmware-security', title: 'VMware vSphere security posture', version: '1.0.0',
    checks: ['secure_boot', 'vtpm', 'disk_encryption', 'saved_state_encryption', 'migration_encryption', 'backup_encryption', 'key_provider', 'host_hardening'] },
  xen: { key: 'xen-security', title: 'Xen/XCP-ng security posture', version: '1.0.0',
    checks: ['secure_boot', 'vtpm', 'disk_encryption', 'migration_encryption', 'backup_encryption', 'key_provider', 'host_hardening'] },
  hyperv: { key: 'hyperv-security', title: 'Microsoft Hyper-V security posture', version: '1.0.0',
    checks: ['secure_boot', 'vtpm', 'disk_encryption', 'saved_state_encryption', 'migration_encryption', 'backup_encryption', 'hgs', 'shielded_vm', 'host_hardening'] },
  nutanix: { key: 'nutanix-security', title: 'Nutanix AHV security posture', version: '1.0.0',
    checks: ['secure_boot', 'vtpm', 'disk_encryption', 'migration_encryption', 'backup_encryption', 'key_provider', 'confidential_compute', 'host_hardening'] },
  kubevirt: { key: 'kubevirt-security', title: 'KubeVirt security posture', version: '1.0.0',
    checks: ['secure_boot', 'vtpm', 'disk_encryption', 'migration_encryption', 'backup_encryption', 'key_provider', 'confidential_compute', 'node_hardening'] },
});

class ProviderSecurityAssuranceError extends Error {
  constructor(message, code = 'PROVIDER_SECURITY_ASSURANCE_ERROR', status = 400, details = null) {
    super(message); this.name = 'ProviderSecurityAssuranceError'; this.code = code;
    this.status = status; this.details = details;
  }
}

function _database(options = {}) { return options.database || getDb(); }
function _registry(options = {}) { return options.registry || registrySingleton; }
function _enabled(options = {}) {
  return options.enabled === undefined ? config.features.providerSecurityAssurance : options.enabled === true;
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
function _timestamp(value, label = 'Timestamp') {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) throw new ProviderSecurityAssuranceError(
    `${label} is invalid`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  return date.toISOString();
}
function _bool(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new ProviderSecurityAssuranceError(
    `${label} must be boolean or null`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  return value;
}
function _choice(value, label, choices, fallback = 'unknown') {
  const selected = value === undefined || value === null || value === '' ? fallback : String(value);
  if (!choices.has(selected)) throw new ProviderSecurityAssuranceError(
    `${label} is invalid`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  return selected;
}
function _integer(value, label, min, max, fallback = null) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new ProviderSecurityAssuranceError(
    `${label} must be an integer between ${min} and ${max}`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  return number;
}
function _pack(providerType) {
  return PACKS[String(providerType || '').toLowerCase()] || {
    key: 'generic-security', title: 'Generic provider security posture', version: '1.0.0',
    checks: ['secure_boot', 'vtpm', 'encryption', 'key_provider', 'confidential_compute', 'host_hardening'],
  };
}
function _host(database, id) {
  const hostId = Number(id);
  const row = Number.isInteger(hostId) && hostId > 0
    ? database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(hostId) : null;
  if (!row) throw new ProviderSecurityAssuranceError('Provider endpoint was not found', 'PROVIDER_ENDPOINT_NOT_FOUND', 404);
  return row;
}
function _resource(database, host, kind, idInput) {
  const kindValue = String(kind || '');
  if (kindValue === 'endpoint') return { id: `endpoint:${Number(host.id)}`, name: _text(host.name, 160) || `Endpoint ${host.id}` };
  const id = String(idInput || '');
  if (kindValue === 'artifact') {
    if (!SAFE_ARTIFACT_ID.test(id)) throw new ProviderSecurityAssuranceError(
      'Canonical security resource is invalid', 'SECURITY_RESOURCE_SCOPE_MISMATCH', 409);
    const row = database.prepare(`SELECT canonical_id,display_name FROM provider_artifact_catalog
      WHERE canonical_id=? AND host_id=?`).get(id, Number(host.id));
    if (!row) throw new ProviderSecurityAssuranceError('Artifact is outside the endpoint scope',
      'SECURITY_RESOURCE_SCOPE_MISMATCH', 409);
    return { id: row.canonical_id, name: row.display_name };
  }
  if (!['host', 'virtualMachine'].includes(kindValue) || !SAFE_RESOURCE_ID.test(id)) {
    throw new ProviderSecurityAssuranceError('Canonical security resource is invalid',
      'SECURITY_RESOURCE_SCOPE_MISMATCH', 409);
  }
  const row = database.prepare(`SELECT i.canonical_id,s.display_name FROM provider_resource_identities i
    LEFT JOIN provider_resource_snapshots s ON s.canonical_id=i.canonical_id
    WHERE i.canonical_id=? AND i.host_id=? AND i.resource_kind=?`).get(id, Number(host.id), kindValue);
  if (!row) throw new ProviderSecurityAssuranceError('Resource is outside the endpoint scope',
    'SECURITY_RESOURCE_SCOPE_MISMATCH', 409);
  return { id: row.canonical_id, name: row.display_name || row.canonical_id };
}
function _safeList(value, label, choices = null, max = 32) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new ProviderSecurityAssuranceError(
    `${label} is invalid`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  const result = [...new Set(value.map(item => String(item)))];
  if (choices && result.some(item => !choices.has(item))) throw new ProviderSecurityAssuranceError(
    `${label} contains an unsupported value`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  if (!choices && result.some(item => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(item))) {
    throw new ProviderSecurityAssuranceError(`${label} contains an unsafe value`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  }
  return result;
}
function _closedObject(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderSecurityAssuranceError(
    `${label} is invalid`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  if (Object.keys(value).some(key => !allowed.has(key))) throw new ProviderSecurityAssuranceError(
    `${label} contains an unsupported field`, 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  return value;
}
function _facts(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderSecurityAssuranceError(
    'Security evidence facts are invalid', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  const allowed = new Set(['secureBoot', 'vtpm', 'encryption', 'confidential', 'hardening']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new ProviderSecurityAssuranceError(
    'Security evidence contains an unsupported fact domain', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  const domainFields = {
    secureBoot: new Set(['capable', 'enabled', 'compliant', 'firmware']),
    vtpm: new Set(['present', 'version', 'state', 'migrationSupported', 'cloneSupported']),
    encryption: new Set(['disks', 'savedState', 'migration', 'backups', 'keyProviderId']),
    confidential: new Set(['enabled', 'mode', 'supportedModes', 'compatibleModes', 'constraints']),
    hardening: new Set(['baselineKey', 'baselineVersion', 'checks']),
  };
  for (const [domain, fields] of Object.entries(domainFields)) {
    if (input[domain] !== undefined && input[domain] !== null) _closedObject(input[domain], domain, fields);
  }
  const out = {};
  if (input.secureBoot) out.secureBoot = {
    capable: _bool(input.secureBoot.capable, 'Secure Boot capable'),
    enabled: _bool(input.secureBoot.enabled, 'Secure Boot enabled'),
    compliant: _bool(input.secureBoot.compliant, 'Secure Boot compliant'),
    firmware: _choice(input.secureBoot.firmware, 'Firmware', new Set(['bios', 'uefi', 'unknown'])),
  };
  if (input.vtpm) out.vtpm = {
    present: _bool(input.vtpm.present, 'vTPM present'),
    version: _choice(input.vtpm.version, 'vTPM version', new Set(['1.2', '2.0', 'unknown'])),
    state: _choice(input.vtpm.state, 'vTPM state', new Set(['ready', 'disabled', 'error', 'unknown'])),
    migrationSupported: _bool(input.vtpm.migrationSupported, 'vTPM migration support'),
    cloneSupported: _bool(input.vtpm.cloneSupported, 'vTPM clone support'),
  };
  if (input.encryption) {
    const disks = input.encryption.disks === undefined ? {}
      : _closedObject(input.encryption.disks, 'Encryption disks', new Set(['state', 'total', 'encrypted']));
    const total = _integer(disks.total, 'Disk count', 0, 1024, 0);
    const encrypted = _integer(disks.encrypted, 'Encrypted disk count', 0, 1024, 0);
    if (encrypted > total) throw new ProviderSecurityAssuranceError(
      'Encrypted disk count exceeds total disk count', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
    out.encryption = {
      disks: { state: _choice(disks.state, 'Disk encryption state',
        new Set(['full', 'partial', 'none', 'unknown'])), total, encrypted },
      savedState: _choice(input.encryption.savedState, 'Saved-state encryption', ENCRYPTION_STATES),
      migration: _choice(input.encryption.migration, 'Migration encryption', ENCRYPTION_STATES),
      backups: _choice(input.encryption.backups, 'Backup encryption', ENCRYPTION_STATES),
      keyProviderId: input.encryption.keyProviderId ? String(input.encryption.keyProviderId) : null,
    };
    if (out.encryption.keyProviderId && !SAFE_KEY_PROVIDER_ID.test(out.encryption.keyProviderId)) {
      throw new ProviderSecurityAssuranceError('Encryption key-provider ID is invalid', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
    }
  }
  if (input.confidential) out.confidential = {
    enabled: _bool(input.confidential.enabled, 'Confidential VM enabled'),
    mode: _choice(input.confidential.mode, 'Confidential VM mode',
      new Set(['none', 'shielded', 'sev', 'sev_es', 'sev_snp', 'tdx', 'unknown'])),
    supportedModes: _safeList(input.confidential.supportedModes, 'Supported confidential modes', CONFIDENTIAL_MODES),
    compatibleModes: _safeList(input.confidential.compatibleModes, 'Compatible confidential modes', CONFIDENTIAL_MODES),
    constraints: _safeList(input.confidential.constraints, 'Confidential VM constraints'),
  };
  if (input.hardening) {
    const checks = input.hardening.checks || [];
    if (!Array.isArray(checks) || !checks.length || checks.length > 200) throw new ProviderSecurityAssuranceError(
      'Hardening checks are invalid', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
    const seen = new Set(); const normalized = checks.map(item => {
      _closedObject(item, 'Hardening check', new Set(['id', 'state', 'evidence']));
      const id = _text(item?.id, 120); if (!id || !/^[a-z][a-z0-9_.-]{1,119}$/.test(id) || seen.has(id)) {
        throw new ProviderSecurityAssuranceError('Hardening check ID is invalid or duplicated',
          'INVALID_SECURITY_ASSURANCE_EVIDENCE');
      }
      seen.add(id); return { id, state: _choice(item.state, 'Hardening check state',
        new Set(['pass', 'fail', 'unknown'])), evidence: _text(item.evidence, 240) };
    });
    const baselineKey = _text(input.hardening.baselineKey, 120);
    const baselineVersion = _text(input.hardening.baselineVersion, 80);
    if (!baselineKey || !baselineVersion) throw new ProviderSecurityAssuranceError(
      'Hardening baseline key and version are required', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
    out.hardening = { baselineKey, baselineVersion, checks: normalized,
      summary: Object.fromEntries(['pass', 'fail', 'unknown'].map(state => [state,
        normalized.filter(item => item.state === state).length])) };
  }
  if (!Object.keys(out).length) throw new ProviderSecurityAssuranceError(
    'At least one security fact domain is required', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  const json = JSON.stringify(out);
  if (Buffer.byteLength(json) > 64 * 1024) throw new ProviderSecurityAssuranceError(
    'Security evidence is too large', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  return out;
}
function _publicEvidence(row) {
  return row ? { schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id),
    resourceKind: row.resource_kind, resourceId: row.resource_id, resourceName: row.resource_name,
    pack: { key: row.pack_key, version: row.pack_version }, source: row.source,
    facts: _json(row.facts_json, {}), evidenceHash: row.evidence_hash,
    observedAt: row.observed_at, updatedAt: row.updated_at } : null;
}
function upsertEvidence(host, input = {}, options = {}) {
  if (!_enabled(options)) throw new ProviderSecurityAssuranceError(
    'Provider security assurance is disabled by release policy', 'PROVIDER_SECURITY_ASSURANCE_DISABLED', 404);
  const database = _database(options); const resource = _resource(database, host,
    input.resourceKind, input.resourceId); const pack = _pack(host.daemon_type);
  const facts = _facts(input.facts); const observedAt = _timestamp(
    input.observedAt || new Date().toISOString(), 'Security evidence timestamp');
  if (Date.parse(observedAt) > Date.now() + 5 * 60 * 1000) throw new ProviderSecurityAssuranceError(
    'Security evidence timestamp is too far in the future', 'INVALID_SECURITY_ASSURANCE_EVIDENCE');
  const source = _choice(input.source, 'Security evidence source',
    new Set(['provider', 'imported_evidence']), 'imported_evidence');
  const evidenceHash = sha256(_canonical({ hostId: Number(host.id), resourceKind: input.resourceKind,
    resourceId: resource.id, pack, source, facts, observedAt }));
  const existing = database.prepare(`SELECT id FROM provider_security_evidence
    WHERE host_id=? AND resource_kind=? AND resource_id=? AND pack_key=?`)
    .get(Number(host.id), String(input.resourceKind), resource.id, pack.key);
  const id = existing?.id || `psec_${generateToken(13)}`;
  database.prepare(`INSERT INTO provider_security_evidence
    (id,host_id,resource_kind,resource_id,resource_name,pack_key,pack_version,source,
      facts_json,evidence_hash,observed_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(host_id,resource_kind,resource_id,pack_key) DO UPDATE SET
      resource_name=excluded.resource_name,pack_version=excluded.pack_version,source=excluded.source,
      facts_json=excluded.facts_json,evidence_hash=excluded.evidence_hash,
      observed_at=excluded.observed_at,updated_at=datetime('now')`)
    .run(id, Number(host.id), String(input.resourceKind), resource.id, resource.name,
      pack.key, pack.version, source, JSON.stringify(facts), evidenceHash, observedAt,
      options.createdBy || null);
  return { created: !existing, evidence: _publicEvidence(database.prepare(
    'SELECT * FROM provider_security_evidence WHERE id=?').get(id)), networkCallsStarted: 0 };
}
function _status(value, positive = true) {
  if (value === null || value === undefined || value === 'unknown') return 'unknown';
  return value === positive ? 'pass' : 'fail';
}
function _controls(evidence) {
  const facts = evidence.facts || {}; const controls = [];
  if (facts.secureBoot) controls.push({ id: 'secure_boot', state: facts.secureBoot.compliant === false
    || facts.secureBoot.enabled === false ? 'fail' : _status(facts.secureBoot.enabled), evidence: facts.secureBoot });
  if (facts.vtpm) controls.push({ id: 'vtpm', state: facts.vtpm.state === 'error'
    ? 'fail' : _status(facts.vtpm.present), evidence: facts.vtpm });
  if (facts.encryption) {
    controls.push({ id: 'disk_encryption', state: facts.encryption.disks.state === 'full' ? 'pass'
      : facts.encryption.disks.state === 'unknown' ? 'unknown' : 'fail', evidence: facts.encryption.disks });
    for (const key of ['savedState', 'migration', 'backups']) controls.push({
      id: `${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}_encryption`,
      state: facts.encryption[key] === 'encrypted' ? 'pass'
        : facts.encryption[key] === 'unknown' ? 'unknown' : 'fail', evidence: { state: facts.encryption[key] },
    });
  }
  if (facts.confidential) controls.push({ id: 'confidential_compute', state: facts.confidential.enabled === null
    ? 'unknown' : facts.confidential.enabled ? 'pass' : 'not_applicable', evidence: facts.confidential });
  if (facts.hardening) controls.push({ id: 'host_hardening', state: facts.hardening.summary.fail > 0
    ? 'fail' : facts.hardening.summary.unknown > 0 ? 'unknown' : 'pass', evidence: facts.hardening });
  return controls;
}
function _publicKeyProvider(row) {
  return row ? { schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id), name: row.name,
    providerKind: row.provider_kind, endpointOrigin: row.endpoint_origin,
    secretRefHash: sha256(row.secret_ref), health: { state: row.health_state,
      observedAt: row.health_observed_at, certificateExpiresAt: row.certificate_expires_at },
    affectedResourceIds: _json(row.affected_resource_ids_json, []), evidenceHash: row.evidence_hash,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}
function _scopedResourceId(database, hostId, idInput) {
  const id = String(idInput || '');
  if (SAFE_ARTIFACT_ID.test(id) && database.prepare(`SELECT canonical_id FROM provider_artifact_catalog
    WHERE canonical_id=? AND host_id=?`).get(id, Number(hostId))) return id;
  if (SAFE_RESOURCE_ID.test(id) && database.prepare(`SELECT canonical_id FROM provider_resource_identities
    WHERE canonical_id=? AND host_id=?`).get(id, Number(hostId))) return id;
  throw new ProviderSecurityAssuranceError('Affected resource is outside the endpoint scope',
    'SECURITY_RESOURCE_SCOPE_MISMATCH', 409);
}
function listKeyProviders(hostId, options = {}) {
  if (!_enabled(options)) throw new ProviderSecurityAssuranceError(
    'Provider security assurance is disabled by release policy', 'PROVIDER_SECURITY_ASSURANCE_DISABLED', 404);
  return _database(options).prepare(`SELECT * FROM provider_key_providers
    WHERE host_id=? AND deleted_at IS NULL ORDER BY lower(name)`).all(Number(hostId)).map(_publicKeyProvider);
}
function upsertKeyProvider(host, input = {}, options = {}) {
  if (!_enabled(options)) throw new ProviderSecurityAssuranceError(
    'Provider security assurance is disabled by release policy', 'PROVIDER_SECURITY_ASSURANCE_DISABLED', 404);
  const database = _database(options); const idInput = input.id ? String(input.id) : null;
  const existing = idInput && SAFE_KEY_PROVIDER_ID.test(idInput) ? database.prepare(`SELECT * FROM provider_key_providers
    WHERE id=? AND host_id=? AND deleted_at IS NULL`).get(idInput, Number(host.id)) : null;
  if (idInput && !existing) throw new ProviderSecurityAssuranceError(
    'Key provider was not found', 'KEY_PROVIDER_NOT_FOUND', 404);
  const name = _text(input.name ?? existing?.name, 100);
  if (!name || /[<>]/.test(name)) throw new ProviderSecurityAssuranceError(
    'Key-provider name is invalid', 'INVALID_KEY_PROVIDER');
  const providerKind = _choice(input.providerKind ?? existing?.provider_kind, 'Key-provider kind',
    new Set(['native_kms', 'external_kms', 'hgs', 'key_broker']), 'external_kms');
  let origin;
  try { origin = new URL(String(input.endpointOrigin ?? existing?.endpoint_origin ?? '')); } catch { /* validated below */ }
  if (!origin || origin.protocol !== 'https:' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new ProviderSecurityAssuranceError(
    'Key-provider endpoint must be a credential-free HTTPS origin', 'INVALID_KEY_PROVIDER');
  const secretRef = String(input.secretRef ?? existing?.secret_ref ?? '');
  if (!/^(?:vault|keyvault|secretsmanager|1password):\/\/[A-Za-z0-9][A-Za-z0-9._~:/@+-]{2,497}$/.test(secretRef)) {
    throw new ProviderSecurityAssuranceError('Key-provider credentials require a supported secret-manager reference',
      'INVALID_KEY_PROVIDER');
  }
  const health = input.health || (existing ? { state: existing.health_state,
    observedAt: existing.health_observed_at, certificateExpiresAt: existing.certificate_expires_at } : {});
  const healthState = _choice(health.state, 'Key-provider health',
    new Set(['healthy', 'degraded', 'unavailable', 'unknown']));
  const healthObservedAt = _timestamp(health.observedAt || new Date().toISOString(), 'Health timestamp');
  const certificateExpiresAt = health.certificateExpiresAt
    ? _timestamp(health.certificateExpiresAt, 'Certificate expiry') : null;
  const affectedInput = input.affectedResourceIds ?? _json(existing?.affected_resource_ids_json, []);
  if (!Array.isArray(affectedInput) || affectedInput.length > 500) throw new ProviderSecurityAssuranceError(
    'Affected resource list is invalid', 'INVALID_KEY_PROVIDER');
  const affectedResourceIds = [...new Set(affectedInput.map(id => _scopedResourceId(database, host.id, id)))];
  const normalized = { hostId: Number(host.id), name, providerKind, endpointOrigin: origin.origin,
    secretRefHash: sha256(secretRef), health: { state: healthState, observedAt: healthObservedAt,
      certificateExpiresAt }, affectedResourceIds };
  const evidenceHash = sha256(_canonical(normalized)); const id = existing?.id || `pkpr_${generateToken(13)}`;
  database.prepare(`INSERT INTO provider_key_providers
    (id,host_id,name,provider_kind,endpoint_origin,secret_ref,health_state,health_observed_at,
      certificate_expires_at,affected_resource_ids_json,evidence_hash,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,provider_kind=excluded.provider_kind,endpoint_origin=excluded.endpoint_origin,
      secret_ref=excluded.secret_ref,health_state=excluded.health_state,
      health_observed_at=excluded.health_observed_at,certificate_expires_at=excluded.certificate_expires_at,
      affected_resource_ids_json=excluded.affected_resource_ids_json,evidence_hash=excluded.evidence_hash,
      updated_at=datetime('now')`)
    .run(id, Number(host.id), name, providerKind, origin.origin, secretRef, healthState,
      healthObservedAt, certificateExpiresAt, JSON.stringify(affectedResourceIds), evidenceHash,
      options.createdBy || null);
  return { created: !existing, keyProvider: _publicKeyProvider(database.prepare(
    'SELECT * FROM provider_key_providers WHERE id=?').get(id)), networkCallsStarted: 0 };
}
function removeKeyProvider(hostId, idInput, options = {}) {
  if (!_enabled(options)) throw new ProviderSecurityAssuranceError(
    'Provider security assurance is disabled by release policy', 'PROVIDER_SECURITY_ASSURANCE_DISABLED', 404);
  const database = _database(options); const id = String(idInput || '');
  const row = SAFE_KEY_PROVIDER_ID.test(id) ? database.prepare(`SELECT * FROM provider_key_providers
    WHERE id=? AND host_id=? AND deleted_at IS NULL`).get(id, Number(hostId)) : null;
  if (!row) throw new ProviderSecurityAssuranceError('Key provider was not found', 'KEY_PROVIDER_NOT_FOUND', 404);
  database.prepare(`UPDATE provider_key_providers SET deleted_at=datetime('now'),updated_at=datetime('now')
    WHERE id=?`).run(id);
  return _publicKeyProvider(row);
}
async function assuranceForHost(host, options = {}) {
  if (!_enabled(options)) throw new ProviderSecurityAssuranceError(
    'Provider security assurance is disabled by release policy', 'PROVIDER_SECURITY_ASSURANCE_DISABLED', 404);
  const database = _database(options); const pack = _pack(host.daemon_type);
  const rows = database.prepare(`SELECT * FROM provider_security_evidence
    WHERE host_id=? ORDER BY resource_kind,lower(resource_name)`).all(Number(host.id));
  let capabilities;
  try { capabilities = await _registry(options).capabilitiesForHost(host); }
  catch { capabilities = { provider: { type: host.daemon_type, endpointId: Number(host.id) }, features: {} }; }
  const items = rows.map(row => { const evidence = _publicEvidence(row); return { ...evidence,
    ageMs: Math.max(0, Date.now() - Date.parse(evidence.observedAt)), controls: _controls(evidence) }; });
  const controls = items.flatMap(item => item.controls.map(control => ({ ...control,
    resourceId: item.resourceId, resourceName: item.resourceName, resourceKind: item.resourceKind })));
  const keyProviders = listKeyProviders(host.id, { ...options, database, enabled: true });
  const counts = Object.fromEntries(['pass', 'fail', 'unknown', 'not_applicable'].map(state => [state,
    controls.filter(control => control.state === state).length]));
  const coverage = Object.fromEntries(['endpoint', 'host', 'virtualMachine', 'artifact'].map(kind => [kind,
    items.filter(item => item.resourceKind === kind).length]));
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(),
    provider: capabilities.provider, pack, allPacks: Object.values(PACKS), counts, coverage,
    evidenceCount: items.length, items, keyProviders,
    capabilityEvidence: Object.fromEntries(['security.secureBoot.read', 'security.vtpm.read',
      'security.encryption.read', 'security.kms.read', 'security.confidentialVm.read',
      'security.hardening.read'].map(key => [key, capabilities.features?.[key]
        || { state: 'unknown', reason: 'Capability declaration is missing' }])),
    limitations: ['Evidence is provider-reported or explicitly imported; absence is unknown, never compliant.',
      'No endpoint, TLS, KMS, guest or host command is executed by this view.',
      'A passing plan does not authorize confidential VM creation or provider mutation.'] };
}
function _findEvidence(database, hostId, kind, resourceId) {
  const row = database.prepare(`SELECT * FROM provider_security_evidence
    WHERE host_id=? AND resource_kind=? AND resource_id=? ORDER BY observed_at DESC LIMIT 1`)
    .get(Number(hostId), kind, String(resourceId));
  return row ? _publicEvidence(row) : null;
}
async function preflightConfidentialProvisioning(host, input = {}, options = {}) {
  if (!_enabled(options)) throw new ProviderSecurityAssuranceError(
    'Provider security assurance is disabled by release policy', 'PROVIDER_SECURITY_ASSURANCE_DISABLED', 404);
  const database = _database(options); const artifact = _resource(database, host, 'artifact', input.artifactId);
  const target = _resource(database, host, 'host', input.targetHostId);
  const mode = String(input.mode || '');
  if (!CONFIDENTIAL_MODES.has(mode)) throw new ProviderSecurityAssuranceError(
    'Confidential VM mode is invalid', 'INVALID_CONFIDENTIAL_PROVISIONING_PLAN');
  const request = { artifactId: artifact.id, targetHostId: target.id, mode,
    requireEncryptedStorage: input.requireEncryptedStorage !== false,
    requireEncryptedMigration: input.requireEncryptedMigration !== false,
    requireSecureBoot: input.requireSecureBoot !== false,
    requireVtpm: input.requireVtpm !== false };
  const artifactEvidence = _findEvidence(database, host.id, 'artifact', artifact.id);
  const hostEvidence = _findEvidence(database, host.id, 'host', target.id);
  const blockers = []; const warnings = [];
  if (options.canOperate !== true) blockers.push({ code: 'PERMISSION_BLOCKED', reason: 'Operate permission is required' });
  if (!artifactEvidence) blockers.push({ code: 'TRUSTED_IMAGE_EVIDENCE_MISSING', reason: 'Template security evidence is missing' });
  if (!hostEvidence) blockers.push({ code: 'CONFIDENTIAL_HOST_EVIDENCE_MISSING', reason: 'Target host security evidence is missing' });
  const artifactFacts = artifactEvidence?.facts || {}; const hostFacts = hostEvidence?.facts || {};
  if (artifactEvidence && Date.now() - Date.parse(artifactEvidence.observedAt) > EVIDENCE_MAX_AGE_MS) blockers.push({
    code: 'TRUSTED_IMAGE_EVIDENCE_STALE', reason: 'Template security evidence is older than 24 hours' });
  if (hostEvidence && Date.now() - Date.parse(hostEvidence.observedAt) > EVIDENCE_MAX_AGE_MS) blockers.push({
    code: 'CONFIDENTIAL_HOST_EVIDENCE_STALE', reason: 'Target host security evidence is older than 24 hours' });
  if (artifactEvidence && !artifactFacts.confidential?.compatibleModes?.includes(mode)) blockers.push({
    code: 'IMAGE_CONFIDENTIAL_MODE_UNSUPPORTED', reason: 'Template evidence does not support the requested mode' });
  if (hostEvidence && !hostFacts.confidential?.supportedModes?.includes(mode)) blockers.push({
    code: 'HOST_CONFIDENTIAL_MODE_UNSUPPORTED', reason: 'Target host evidence does not support the requested mode' });
  if (request.requireSecureBoot && (artifactFacts.secureBoot?.enabled !== true || hostFacts.secureBoot?.capable !== true)) blockers.push({
    code: 'SECURE_BOOT_REQUIRED', reason: 'Template and host must prove Secure Boot readiness' });
  if (request.requireVtpm && artifactFacts.vtpm?.present !== true) blockers.push({
    code: 'VTPM_REQUIRED', reason: 'Template evidence must prove a ready vTPM' });
  if (request.requireEncryptedStorage && hostFacts.encryption?.disks?.state !== 'full') blockers.push({
    code: 'ENCRYPTED_STORAGE_REQUIRED', reason: 'Target host evidence must prove full disk encryption coverage' });
  if (request.requireEncryptedMigration && hostFacts.encryption?.migration !== 'encrypted') blockers.push({
    code: 'ENCRYPTED_MIGRATION_REQUIRED', reason: 'Target host evidence must prove encrypted migration' });
  const keyProviderId = hostFacts.encryption?.keyProviderId || artifactFacts.encryption?.keyProviderId;
  const keyProvider = keyProviderId ? database.prepare(`SELECT * FROM provider_key_providers
    WHERE id=? AND host_id=? AND deleted_at IS NULL`).get(keyProviderId, Number(host.id)) : null;
  if (!keyProvider || keyProvider.health_state !== 'healthy') blockers.push({
    code: 'HEALTHY_KEY_PROVIDER_REQUIRED', reason: 'A healthy in-scope key provider is required' });
  if (keyProvider?.certificate_expires_at && Date.parse(keyProvider.certificate_expires_at) < Date.now() + 7 * 86400000) blockers.push({
    code: 'KEY_PROVIDER_CERTIFICATE_EXPIRING', reason: 'Key-provider certificate expires within seven days' });
  let capabilities;
  try { capabilities = await _registry(options).capabilitiesForHost(host); } catch { capabilities = { features: {} }; }
  const capability = capabilities.features?.['security.confidentialVm.plan']
    || { state: 'unknown', reason: 'Provider mutation capability is not declared' };
  warnings.push({ code: 'PROVISIONING_EXECUTION_SEPARATE',
    reason: 'This compatibility plan never submits VM creation; guarded provisioning remains a separate workflow' });
  const evidence = { artifact: artifactEvidence, targetHost: hostEvidence,
    keyProvider: keyProvider ? _publicKeyProvider(keyProvider) : null,
    capability: { key: 'security.confidentialVm.plan', state: capability.state,
      reason: capability.reason || null } };
  const semantic = { schemaVersion: SCHEMA_VERSION, hostId: Number(host.id), request, evidence, blockers, warnings };
  const planHash = sha256(_canonical(semantic)); const id = `pcvp_${generateToken(13)}`;
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString(); const allowed = blockers.length === 0;
  database.prepare(`INSERT INTO provider_confidential_provisioning_plans
    (id,host_id,artifact_id,target_host_id,confidential_mode,request_json,evidence_json,
      plan_hash,allowed,created_by,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, Number(host.id), artifact.id, target.id, mode, JSON.stringify(request),
      JSON.stringify(evidence), planHash, allowed ? 1 : 0, options.createdBy || null, expiresAt);
  return { ...semantic, id, planHash, allowed, expiresAt, executionAuthorized: false };
}

module.exports = {
  ProviderSecurityAssuranceError, PACKS, upsertEvidence, assuranceForHost,
  listKeyProviders, upsertKeyProvider, removeKeyProvider, preflightConfidentialProvisioning,
  _internals: { _facts, _controls, _canonical, _pack },
};
