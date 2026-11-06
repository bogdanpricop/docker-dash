'use strict';

const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const registry = require('./registry');
const provenanceParser = require('./registry-provenance');
const ociCompose = require('./oci-compose');
const { ForemanClient, ForemanClientError, validateBaseUrl } = require('./foreman-client');

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/i;
const CHANNELS = new Set(['held', 'canary', 'stable']);
const ACTIONS = new Set(['update', 'rollback']);
const SBOM_PATTERN = /(?:sbom|spdx|cyclonedx)/i;
const SIGNATURE_PATTERN = /(?:cosign|sigstore|simplesigning|signature)/i;

class WorkstationFleetError extends Error {
  constructor(message, status = 400, code = 'WORKSTATION_FLEET_ERROR', details) {
    super(message);
    this.name = 'WorkstationFleetError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(message, status, code, details) {
  return new WorkstationFleetError(message, status, code, details);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(item => stable(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  const source = typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value);
  return crypto.createHash('sha256').update(source).digest('hex');
}

function text(value, field, max = 512, required = false) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) throw fail(`${field} is required`, 400, 'WORKSTATION_INPUT_INVALID');
  if (normalized.length > max) throw fail(`${field} is too long`, 400, 'WORKSTATION_INPUT_INVALID');
  return normalized;
}

function integer(value, field, min = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw fail(`${field} is invalid`, 400, 'WORKSTATION_INPUT_INVALID');
  return parsed;
}

function traceReference(value, field) {
  const normalized = text(value, field, 255, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,254}$/.test(normalized)) {
    throw fail(`${field} contains unsafe characters`, 400, 'WORKSTATION_INPUT_INVALID');
  }
  return normalized;
}

function digest(value, field = 'digest') {
  const normalized = String(value || '').toLowerCase();
  if (!DIGEST_RE.test(normalized)) throw fail(`${field} must be a pinned sha256 digest`, 400, 'WORKSTATION_DIGEST_REQUIRED');
  return normalized;
}

function repository(value) {
  const normalized = text(value, 'repository', 255, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/.test(normalized)
      || normalized.includes('..') || normalized.startsWith('/') || normalized.endsWith('/')) {
    throw fail('repository is invalid', 400, 'WORKSTATION_INPUT_INVALID');
  }
  return normalized;
}

function reference(value) {
  const normalized = text(value || 'latest', 'sourceRef', 255, true);
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[a-f0-9]{64})$/i.test(normalized)) {
    throw fail('sourceRef must be a valid OCI tag or sha256 digest', 400, 'WORKSTATION_INPUT_INVALID');
  }
  return normalized;
}

function canonicalImageReference(registryUrl, repositoryName, pinnedDigest) {
  let parsed;
  try { parsed = new URL(String(registryUrl || '')); }
  catch { throw fail('Registry URL is invalid', 409, 'WORKSTATION_REGISTRY_URL_INVALID'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw fail('Registry URL cannot be used as an OCI image reference', 409, 'WORKSTATION_REGISTRY_URL_INVALID');
  }
  const prefix = `${parsed.host}${parsed.pathname.replace(/^\/+|\/+$/g, '') ? `/${parsed.pathname.replace(/^\/+|\/+$/g, '')}` : ''}`;
  return `${prefix}/${repositoryName}@${digest(pinnedDigest)}`;
}

function boundedProvenance(parsed = {}, trust = {}, signerPattern = null) {
  const boundedEntries = (source, limit) => Object.fromEntries(Object.entries(source || {}).slice(0, limit)
    .filter(([key]) => String(key).length <= 255)
    .map(([key, value]) => [String(key), typeof value === 'boolean' ? value : String(value).slice(0, 2048)]));
  return {
    hasProvenance: parsed.hasProvenance === true,
    known: boundedEntries(parsed.known, 40),
    other: boundedEntries(parsed.other, 50),
    otherCount: Math.max(0, Number(parsed.otherCount) || 0),
    totalAnnotations: Math.max(0, Number(parsed.totalAnnotations) || 0),
    truncated: Object.keys(parsed.other || {}).length > 50 || Object.keys(parsed.known || {}).length > 40,
    trust: {
      policy: String(trust.policy || 'none').slice(0, 32),
      passed: trust.passed === true,
      cryptographicallyVerified: trust.cryptographicallyVerified === true,
      signer: trust.signer ? String(trust.signer).slice(0, 512) : null,
      outputHash: /^[a-f0-9]{64}$/i.test(String(trust.outputHash || '')) ? String(trust.outputHash).toLowerCase() : null,
      signerPattern: signerPattern ? String(signerPattern).slice(0, 256) : null,
    },
  };
}

function nullableBoolean(value) {
  if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return null;
}

function boolDb(value) { return value == null ? null : value ? 1 : 0; }
function boolApi(value) { return value == null ? null : value === 1; }

function safeDate(value, fallback = null) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function selectedFacts(host = {}) {
  const source = host.facts && typeof host.facts === 'object' ? host.facts : {};
  const parameters = Array.isArray(host.host_parameters) ? Object.fromEntries(host.host_parameters
    .filter(item => item && typeof item.name === 'string' && item.name.length <= 128)
    .map(item => [item.name, item.value])) : {};
  const all = { ...parameters, ...source };
  const pick = (...keys) => keys.map(key => all[key]).find(value => value !== undefined && value !== null);
  const bootcDigest = pick('bootc_digest', 'bootc.image.digest', 'bootc_image_digest', 'ostree_digest');
  const patchAge = Number(pick('patch_age_days', 'patch.age_days'));
  const errata = Number(host.content_facet_attributes?.applicable_errata
    ?? pick('applicable_errata', 'katello.applicable_errata'));
  return {
    secureBoot: nullableBoolean(pick('secure_boot', 'efi_secure_boot', 'firmware.secure_boot')),
    tpmPresent: nullableBoolean(pick('tpm_present', 'tpm', 'hardware.tpm_present')),
    diskEncrypted: nullableBoolean(pick('disk_encrypted', 'luks', 'storage.luks')),
    selinuxState: String(pick('selinux_state', 'selinux_current_mode', 'security.selinux') || 'unknown').toLowerCase(),
    bootcDigest: DIGEST_RE.test(String(bootcDigest || '')) ? String(bootcDigest).toLowerCase() : null,
    bootcVersion: text(pick('bootc_version', 'bootc.image.version', 'ostree_version') || '', 'bootcVersion', 255),
    identityRealm: text(host.realm_name || pick('identity_realm', 'realm') || '', 'identityRealm', 255),
    identityEnrolled: nullableBoolean(pick('identity_enrolled', 'freeipa_enrolled', 'realm_enrolled')),
    patchAgeDays: Number.isInteger(patchAge) && patchAge >= 0 ? patchAge : null,
    applicableErrata: Number.isInteger(errata) && errata >= 0 ? errata : null,
  };
}

function bootcEvidence({ manifest = {}, configBlob = {}, referrers = [], trust = {}, digest: pinnedDigest }) {
  const manifestAnnotations = manifest.annotations && typeof manifest.annotations === 'object' ? manifest.annotations : {};
  const config = configBlob.config && typeof configBlob.config === 'object' ? configBlob.config : {};
  const labels = config.Labels && typeof config.Labels === 'object' ? config.Labels : {};
  const annotations = { ...manifestAnnotations, ...(configBlob.annotations || {}), ...labels };
  const truthy = value => ['1', 'true', 'yes', 'bootc'].includes(String(value || '').toLowerCase());
  const bootcDetected = [
    annotations['containers.bootc'], annotations['org.containers.bootc'],
    annotations['ostree.bootable'], annotations['io.containers.bootc'],
  ].some(truthy);
  const sbomRefs = [];
  for (const key of ['org.opencontainers.image.sbom', 'org.opencontainers.image.sbom.url',
    'org.opencontainers.image.attestation.sbom']) {
    if (annotations[key]) sbomRefs.push({ kind: 'annotation', key, reference: String(annotations[key]).slice(0, 2048) });
  }
  for (const item of Array.isArray(referrers) ? referrers.slice(0, 200) : []) {
    const type = String(item.artifactType || item.mediaType || '');
    if (SBOM_PATTERN.test(type) && DIGEST_RE.test(String(item.digest || ''))) {
      sbomRefs.push({ kind: 'referrer', artifactType: type.slice(0, 255), digest: String(item.digest).toLowerCase() });
    }
  }
  const signatureRefPresent = (Array.isArray(referrers) ? referrers : [])
    .some(item => SIGNATURE_PATTERN.test(String(item.artifactType || item.mediaType || '')));
  return {
    digest: digest(pinnedDigest),
    mediaType: text(manifest.mediaType || '', 'mediaType', 255),
    bootcDetected,
    osName: text(configBlob.os || annotations['org.opencontainers.image.vendor'] || '', 'osName', 255),
    osVersion: text(annotations['org.opencontainers.image.version'] || configBlob.os_version || '', 'osVersion', 255),
    architecture: text(configBlob.architecture || '', 'architecture', 64),
    baseImage: text(annotations['org.opencontainers.image.base.name'] || '', 'baseImage', 1024),
    baseDigest: DIGEST_RE.test(String(annotations['org.opencontainers.image.base.digest'] || ''))
      ? String(annotations['org.opencontainers.image.base.digest']).toLowerCase() : null,
    sourceUrl: text(annotations['org.opencontainers.image.source'] || '', 'sourceUrl', 2048),
    revision: text(annotations['org.opencontainers.image.revision'] || '', 'revision', 255),
    sbomRefs,
    signaturePresent: signatureRefPresent || trust.signaturePresent === true,
  };
}

class WorkstationFleetService {
  constructor(dbProvider = getDb, options = {}) {
    this._dbProvider = dbProvider;
    this._clientFactory = options.clientFactory || ((connection, secret) => new ForemanClient(connection, secret, config.workstationFleet));
    this._registry = options.registry || registry;
    this._trustVerifier = options.trustVerifier || ociCompose.verifyTrust;
    this._mutationsEnabled = options.mutationsEnabled ?? config.features.workstationForemanMutations;
    this._allowedTemplates = new Set((options.allowedTemplates || config.workstationFleet.allowedRemoteJobTemplates)
      .map(value => String(value).trim()).filter(value => /^\d+$/.test(value)));
    this._evidenceMaxAgeMs = options.evidenceMaxAgeMs ?? config.workstationFleet.evidenceMaxAgeMs;
    this._jobTimeoutMs = options.jobTimeoutMs ?? config.workstationFleet.jobTimeoutMs;
    this._now = options.now || (() => Date.now());
  }

  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator role is required', 403, 'ADMIN_REQUIRED');
  }

  _connectionRow(row) {
    return row && { id: row.id, name: row.name, baseUrl: row.base_url, authType: row.auth_type,
      username: row.username, tlsVerify: row.tls_verify === 1, hasCustomCa: !!row.ca_pem,
      hasSecret: !!row.secret_encrypted, enabled: row.enabled === 1, lastSyncAt: row.last_sync_at,
      lastSyncState: row.last_sync_state, lastErrorCode: row.last_error_code,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  connections(actor) {
    this._admin(actor);
    return this._db().prepare('SELECT * FROM workstation_foreman_connections ORDER BY name').all()
      .map(row => this._connectionRow(row));
  }

  _connection(id) {
    const row = this._db().prepare('SELECT * FROM workstation_foreman_connections WHERE id=?')
      .get(integer(id, 'connectionId'));
    if (!row) throw fail('Foreman connection not found', 404, 'FOREMAN_CONNECTION_NOT_FOUND');
    return row;
  }

  _secret(connection) {
    if (!connection.secret_encrypted) return '';
    try { return decrypt(connection.secret_encrypted); }
    catch { throw fail('Foreman credential cannot be decrypted', 500, 'FOREMAN_SECRET_DECRYPT_FAILED'); }
  }

  saveConnection(body = {}, actor) {
    this._admin(actor);
    const id = body.id == null ? null : integer(body.id, 'connectionId');
    const existing = id ? this._connection(id) : null;
    const name = text(body.name ?? existing?.name, 'name', 120, true);
    const baseUrl = validateBaseUrl(body.baseUrl ?? body.base_url ?? existing?.base_url);
    if (existing && baseUrl !== existing.base_url) {
      const boundState = this._db().prepare(`SELECT 1 AS present FROM workstation_devices WHERE connection_id=? LIMIT 1`)
        .get(existing.id) || this._db().prepare(`SELECT 1 AS present FROM workstation_sync_runs WHERE connection_id=? LIMIT 1`)
        .get(existing.id);
      if (boundState) {
        throw fail('Foreman endpoint identity cannot change after inventory synchronization; create a new connection',
          409, 'FOREMAN_CONNECTION_IDENTITY_LOCKED');
      }
    }
    const authType = String(body.authType ?? body.auth_type ?? existing?.auth_type ?? 'token');
    if (!['token', 'basic'].includes(authType)) throw fail('authType must be token or basic', 400, 'WORKSTATION_INPUT_INVALID');
    const username = text(body.username ?? existing?.username ?? '', 'username', 255);
    if (authType === 'basic' && !username) throw fail('username is required for basic authentication', 400, 'WORKSTATION_INPUT_INVALID');
    const secret = body.secret == null ? null : text(body.secret, 'secret', 4096, true);
    const caPem = body.caPem == null ? existing?.ca_pem || null : text(body.caPem, 'caPem', 65_536) || null;
    const tlsVerify = body.tlsVerify == null ? existing?.tls_verify !== 0 : body.tlsVerify === true;
    const enabled = body.enabled == null ? existing?.enabled !== 0 : body.enabled === true;
    const encrypted = secret == null ? existing?.secret_encrypted || null : encrypt(secret);
    const db = this._db();
    let savedId = id;
    try {
      if (id) db.prepare(`UPDATE workstation_foreman_connections SET name=?,base_url=?,auth_type=?,username=?,
        secret_encrypted=?,ca_pem=?,tls_verify=?,enabled=?,updated_at=datetime('now') WHERE id=?`)
        .run(name, baseUrl, authType, username || null, encrypted, caPem, tlsVerify ? 1 : 0, enabled ? 1 : 0, id);
      else savedId = Number(db.prepare(`INSERT INTO workstation_foreman_connections
        (name,base_url,auth_type,username,secret_encrypted,ca_pem,tls_verify,enabled,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(name, baseUrl, authType, username || null, encrypted, caPem,
        tlsVerify ? 1 : 0, enabled ? 1 : 0, actor.id).lastInsertRowid);
    } catch (error) {
      if (String(error.code).includes('SQLITE_CONSTRAINT')) throw fail('A Foreman connection with this name already exists', 409, 'FOREMAN_CONNECTION_EXISTS');
      throw error;
    }
    return this._connectionRow(this._connection(savedId));
  }

  removeConnection(id, actor) {
    this._admin(actor);
    const connection = this._connection(id);
    this._db().prepare(`UPDATE workstation_sync_runs SET state='failed',error_code='FOREMAN_SYNC_ABANDONED',
      error_message='Stale running sync was closed during connection deletion',completed_at=datetime('now')
      WHERE connection_id=? AND state='running' AND started_at < datetime('now','-24 hours')`).run(connection.id);
    const activeSync = this._db().prepare(`SELECT id FROM workstation_sync_runs
      WHERE connection_id=? AND state='running' LIMIT 1`).get(connection.id);
    const activePlan = this._db().prepare(`SELECT p.id FROM workstation_update_plans p
      JOIN workstation_devices d ON d.id=p.device_id
      WHERE d.connection_id=? AND p.state IN ('planned','running') LIMIT 1`).get(connection.id);
    if (activeSync || activePlan) {
      throw fail('Close active synchronization and workstation plans before deleting the Foreman connection',
        409, 'FOREMAN_CONNECTION_ACTIVE_WORKFLOW');
    }
    this._db().prepare('DELETE FROM workstation_foreman_connections WHERE id=?').run(connection.id);
    return { id: connection.id, removed: true };
  }

  async testConnection(id, actor) {
    this._admin(actor);
    const connection = this._connection(id);
    return this._clientFactory(connection, this._secret(connection)).status();
  }

  saveMapping(connectionId, body = {}, actor) {
    this._admin(actor);
    const connection = this._connection(connectionId);
    const sourceKind = String(body.sourceKind || body.source_kind || '');
    if (!['location', 'host_group'].includes(sourceKind)) throw fail('sourceKind must be location or host_group', 400, 'WORKSTATION_INPUT_INVALID');
    const sourceRef = text(body.sourceRef || body.source_ref, 'sourceRef', 512, true);
    const edgeSiteId = body.edgeSiteId == null ? null : integer(body.edgeSiteId, 'edgeSiteId');
    const scopeRef = text(body.scopeRef || body.scope_ref || '', 'scopeRef', 512) || null;
    if (edgeSiteId && !this._db().prepare('SELECT id FROM edge_sites WHERE id=?').get(edgeSiteId)) {
      throw fail('Edge Site not found', 404, 'EDGE_SITE_NOT_FOUND');
    }
    this._db().prepare(`INSERT INTO workstation_foreman_mappings
      (connection_id,source_kind,source_ref,edge_site_id,scope_ref,created_by)
      VALUES (?,?,?,?,?,?) ON CONFLICT(connection_id,source_kind,source_ref) DO UPDATE SET
      edge_site_id=excluded.edge_site_id,scope_ref=excluded.scope_ref,updated_at=datetime('now')`)
      .run(connection.id, sourceKind, sourceRef, edgeSiteId, scopeRef, actor.id);
    this._refreshDeviceMappings(connection.id);
    return this._db().prepare(`SELECT id,connection_id connectionId,source_kind sourceKind,source_ref sourceRef,
      edge_site_id edgeSiteId,scope_ref scopeRef,created_at createdAt,updated_at updatedAt
      FROM workstation_foreman_mappings WHERE connection_id=? AND source_kind=? AND source_ref=?`)
      .get(connection.id, sourceKind, sourceRef);
  }

  removeMapping(mappingId, actor) {
    this._admin(actor);
    const row = this._db().prepare('SELECT * FROM workstation_foreman_mappings WHERE id=?')
      .get(integer(mappingId, 'mappingId'));
    if (!row) throw fail('Foreman mapping not found', 404, 'FOREMAN_MAPPING_NOT_FOUND');
    this._db().prepare('DELETE FROM workstation_foreman_mappings WHERE id=?').run(row.id);
    this._refreshDeviceMappings(row.connection_id);
    return { id: row.id, connectionId: row.connection_id, removed: true };
  }

  mappings(actor) {
    this._admin(actor);
    return this._db().prepare(`SELECT id,connection_id connectionId,source_kind sourceKind,source_ref sourceRef,
      edge_site_id edgeSiteId,scope_ref scopeRef,created_at createdAt,updated_at updatedAt
      FROM workstation_foreman_mappings ORDER BY connection_id,source_kind,source_ref`).all();
  }

  _mappingIndex(connectionId) {
    const rows = this._db().prepare('SELECT * FROM workstation_foreman_mappings WHERE connection_id=?').all(connectionId);
    return new Map(rows.map(row => [`${row.source_kind}:${row.source_ref}`, row]));
  }

  _refreshDeviceMappings(connectionId) {
    const mappings = this._mappingIndex(connectionId);
    const update = this._db().prepare(`UPDATE workstation_devices SET edge_site_id=?,scope_ref=?,
      source_hash=?,synced_at=datetime('now') WHERE id=?`);
    for (const row of this._db().prepare(`SELECT id,location,host_group,source_hash FROM workstation_devices
      WHERE connection_id=?`).all(connectionId)) {
      const mapping = mappings.get(`location:${row.location || ''}`)
        || mappings.get(`host_group:${row.host_group || ''}`) || null;
      const nextHash = hash({ previous: row.source_hash, edgeSiteId: mapping?.edge_site_id || null,
        scopeRef: mapping?.scope_ref || null });
      update.run(mapping?.edge_site_id || null, mapping?.scope_ref || null, nextHash, row.id);
    }
  }

  _normalizeHost(host, connectionId, mappings) {
    if (!host || typeof host !== 'object') throw fail('Foreman host entry is invalid', 502, 'FOREMAN_HOST_INVALID');
    const externalId = text(host.id ?? host.uuid, 'externalId', 128, true);
    const name = text(host.name || host.display_name, 'host.name', 255, true);
    const facts = selectedFacts(host);
    const location = text(host.location_name || host.location?.name || '', 'location', 255);
    const hostGroup = text(host.hostgroup_name || host.host_group?.name || '', 'hostGroup', 255);
    const mapping = mappings.get(`location:${location}`) || mappings.get(`host_group:${hostGroup}`) || null;
    const lastSeenAt = safeDate(host.last_report || host.last_seen_at || host.updated_at, null);
    const ageMs = lastSeenAt ? this._now() - Date.parse(lastSeenAt) : null;
    const rawStatus = String(host.status || host.global_status_label || '').toLowerCase();
    let status = host.build === true ? 'building'
      : /error|fail/.test(rawStatus) ? 'error'
        : /ok|online|ready|success/.test(rawStatus) ? 'online' : 'unknown';
    if (ageMs != null && ageMs > 7 * 86400000 && status !== 'building') status = 'offline';
    const selinux = ['enforcing', 'permissive', 'disabled'].includes(facts.selinuxState) ? facts.selinuxState : 'unknown';
    const normalized = {
      connectionId, externalId, name,
      organization: text(host.organization_name || host.organization?.name || '', 'organization', 255) || null,
      location: location || null, hostGroup: hostGroup || null,
      edgeSiteId: mapping?.edge_site_id || null, scopeRef: mapping?.scope_ref || null,
      osName: text(host.operatingsystem_name || host.operating_system?.name || '', 'osName', 255) || null,
      osVersion: text(host.operatingsystem?.major || host.os_version || '', 'osVersion', 128) || null,
      architecture: text(host.architecture_name || host.architecture?.name || '', 'architecture', 64) || null,
      ipAddress: text(host.ip || host.ip_address || '', 'ipAddress', 128) || null,
      macAddress: text(host.mac || host.mac_address || '', 'macAddress', 64) || null,
      status, lastSeenAt, bootcDigest: facts.bootcDigest, bootcVersion: facts.bootcVersion || null,
      lifecycleEnvironment: text(host.content_facet_attributes?.lifecycle_environment_name
        || host.lifecycle_environment_name || '', 'lifecycleEnvironment', 255) || null,
      contentView: text(host.content_facet_attributes?.content_view_name || host.content_view_name || '', 'contentView', 255) || null,
      identityRealm: facts.identityRealm || null,
      identityEnrolled: facts.identityEnrolled == null ? (facts.identityRealm ? true : null) : facts.identityEnrolled,
      secureBoot: facts.secureBoot, tpmPresent: facts.tpmPresent, diskEncrypted: facts.diskEncrypted,
      selinuxState: selinux, patchAgeDays: facts.patchAgeDays, applicableErrata: facts.applicableErrata,
      facts: { secureBoot: facts.secureBoot, tpmPresent: facts.tpmPresent, diskEncrypted: facts.diskEncrypted,
        selinuxState: selinux, identityEnrolled: facts.identityEnrolled },
      observedAt: safeDate(host.updated_at || host.last_report, new Date(this._now()).toISOString()),
    };
    normalized.sourceHash = hash(normalized);
    return normalized;
  }

  _upsertDevice(device) {
    this._db().prepare(`INSERT INTO workstation_devices
      (connection_id,external_id,name,organization,location,host_group,edge_site_id,scope_ref,os_name,os_version,
       architecture,ip_address,mac_address,status,last_seen_at,bootc_digest,bootc_version,lifecycle_environment,
       content_view,identity_realm,identity_enrolled,secure_boot,tpm_present,disk_encrypted,selinux_state,
       patch_age_days,applicable_errata,facts_json,source_hash,observed_at)
      VALUES (@connectionId,@externalId,@name,@organization,@location,@hostGroup,@edgeSiteId,@scopeRef,@osName,@osVersion,
       @architecture,@ipAddress,@macAddress,@status,@lastSeenAt,@bootcDigest,@bootcVersion,@lifecycleEnvironment,
       @contentView,@identityRealm,@identityEnrolled,@secureBoot,@tpmPresent,@diskEncrypted,@selinuxState,
       @patchAgeDays,@applicableErrata,@factsJson,@sourceHash,@observedAt)
      ON CONFLICT(connection_id,external_id) DO UPDATE SET name=excluded.name,organization=excluded.organization,
       location=excluded.location,host_group=excluded.host_group,edge_site_id=excluded.edge_site_id,scope_ref=excluded.scope_ref,
       os_name=excluded.os_name,os_version=excluded.os_version,architecture=excluded.architecture,ip_address=excluded.ip_address,
       mac_address=excluded.mac_address,status=excluded.status,last_seen_at=excluded.last_seen_at,bootc_digest=excluded.bootc_digest,
       bootc_version=excluded.bootc_version,lifecycle_environment=excluded.lifecycle_environment,content_view=excluded.content_view,
       identity_realm=excluded.identity_realm,identity_enrolled=excluded.identity_enrolled,secure_boot=excluded.secure_boot,
       tpm_present=excluded.tpm_present,disk_encrypted=excluded.disk_encrypted,selinux_state=excluded.selinux_state,
       patch_age_days=excluded.patch_age_days,applicable_errata=excluded.applicable_errata,facts_json=excluded.facts_json,
       source_hash=excluded.source_hash,observed_at=excluded.observed_at,synced_at=datetime('now')`)
      .run({ ...device, identityEnrolled: boolDb(device.identityEnrolled), secureBoot: boolDb(device.secureBoot),
        tpmPresent: boolDb(device.tpmPresent), diskEncrypted: boolDb(device.diskEncrypted),
        factsJson: JSON.stringify(device.facts) });
  }

  async syncConnection(id, actor) {
    this._admin(actor);
    const connection = this._connection(id);
    if (!connection.enabled) throw fail('Foreman connection is disabled', 409, 'FOREMAN_CONNECTION_DISABLED');
    const db = this._db();
    const runId = Number(db.prepare(`INSERT INTO workstation_sync_runs (connection_id,state,started_by)
      VALUES (?,'running',?)`).run(connection.id, actor.id).lastInsertRowid);
    try {
      const inventory = await this._clientFactory(connection, this._secret(connection)).inventory();
      const mappings = this._mappingIndex(connection.id);
      const devices = inventory.hosts.map(host => this._normalizeHost(host, connection.id, mappings));
      const sourceHash = hash({ organizations: inventory.organizations.map(item => item.id || item.name),
        locations: inventory.locations.map(item => item.id || item.name),
        hostGroups: inventory.hostGroups.map(item => item.id || item.name),
        devices: devices.map(item => item.sourceHash), contentViews: inventory.contentViews.map(item => item.id || item.name),
        lifecycleEnvironments: inventory.lifecycleEnvironments.map(item => item.id || item.name) });
      db.transaction(() => {
        for (const device of devices) this._upsertDevice(device);
        const externalIds = new Set(devices.map(item => item.externalId));
        for (const row of db.prepare('SELECT id,external_id,source_hash FROM workstation_devices WHERE connection_id=?').all(connection.id)) {
          if (!externalIds.has(row.external_id)) {
            const offlineHash = hash({ previous: row.source_hash, status: 'offline', syncRunId: runId });
            db.prepare("UPDATE workstation_devices SET status='offline',source_hash=?,observed_at=datetime('now'),synced_at=datetime('now') WHERE id=?")
              .run(offlineHash, row.id);
          }
        }
        const state = inventory.warnings.length ? 'partial' : 'success';
        db.prepare(`UPDATE workstation_sync_runs SET state=?,organizations_count=?,locations_count=?,host_groups_count=?,
          workstations_count=?,content_views_count=?,lifecycle_environments_count=?,source_hash=?,completed_at=datetime('now') WHERE id=?`)
          .run(state, inventory.organizations.length, inventory.locations.length, inventory.hostGroups.length, devices.length,
            inventory.contentViews.length, inventory.lifecycleEnvironments.length, sourceHash, runId);
        db.prepare(`UPDATE workstation_foreman_connections SET last_sync_at=datetime('now'),last_sync_state=?,
          last_error_code=NULL,updated_at=datetime('now') WHERE id=?`).run(state, connection.id);
      })();
      return { run: this.syncRun(runId), warnings: inventory.warnings, networkMode: 'read_only' };
    } catch (error) {
      const code = error.code || 'FOREMAN_SYNC_FAILED';
      const message = String(error.message || 'Foreman sync failed').slice(0, 300);
      db.prepare(`UPDATE workstation_sync_runs SET state='failed',error_code=?,error_message=?,completed_at=datetime('now') WHERE id=?`)
        .run(code, message, runId);
      db.prepare(`UPDATE workstation_foreman_connections SET last_sync_at=datetime('now'),last_sync_state='failed',
        last_error_code=?,updated_at=datetime('now') WHERE id=?`).run(code, connection.id);
      if (error instanceof WorkstationFleetError || error instanceof ForemanClientError) throw error;
      throw fail('Foreman inventory synchronization failed', 502, code);
    }
  }

  syncRun(id) {
    const row = this._db().prepare('SELECT * FROM workstation_sync_runs WHERE id=?').get(integer(id, 'syncRunId'));
    if (!row) throw fail('Sync run not found', 404, 'WORKSTATION_SYNC_NOT_FOUND');
    return { id: row.id, connectionId: row.connection_id, state: row.state,
      counts: { organizations: row.organizations_count, locations: row.locations_count,
        hostGroups: row.host_groups_count, workstations: row.workstations_count,
        contentViews: row.content_views_count, lifecycleEnvironments: row.lifecycle_environments_count },
      sourceHash: row.source_hash, errorCode: row.error_code, errorMessage: row.error_message,
      startedAt: row.started_at, completedAt: row.completed_at };
  }

  _promotionRow(row) {
    return row && { id: row.id, artifactId: row.artifact_id, fromChannel: row.from_channel,
      toChannel: row.to_channel, reason: row.reason, evidenceHash: row.evidence_hash,
      promotedBy: row.promoted_by, promotedAt: row.promoted_at };
  }

  _artifactRow(row, promotionCount = 0) {
    return row && { id: row.id, registryId: row.registry_id, name: row.name, repository: row.repository,
      sourceRef: row.source_ref, digest: row.digest, imageReference: row.image_reference,
      mediaType: row.media_type, osName: row.os_name,
      osVersion: row.os_version, architecture: row.architecture, bootcDetected: row.bootc_detected === 1,
      baseImage: row.base_image, baseDigest: row.base_digest, sourceUrl: row.source_url, revision: row.revision,
      sbomRefs: safeJson(row.sbom_refs_json, []), signaturePolicy: row.signature_policy,
      signatureState: row.signature_state, signer: row.signer, signerPattern: row.signer_pattern,
      verificationHash: row.verification_hash,
      channel: row.channel, provenance: safeJson(row.provenance_json, {}),
      promotionCount,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  _artifactWithPromotionCount(row) {
    if (!row) return null;
    const promotionCount = Number(this._db().prepare(`SELECT COUNT(*) AS count FROM workstation_artifact_promotions
      WHERE artifact_id=?`).get(row.id).count);
    return this._artifactRow(row, promotionCount);
  }

  artifacts(actor) {
    this._admin(actor);
    const db = this._db();
    const promotionCounts = new Map(db.prepare(`SELECT artifact_id,COUNT(*) AS count
      FROM workstation_artifact_promotions GROUP BY artifact_id`).all().map(row => [row.artifact_id, Number(row.count)]));
    return db.prepare('SELECT * FROM workstation_bootc_artifacts ORDER BY updated_at DESC,id DESC').all()
      .map(row => this._artifactRow(row, promotionCounts.get(row.id) || 0));
  }

  artifactPromotions(id, query = {}, actor) {
    this._admin(actor);
    const artifactId = integer(id, 'artifactId');
    if (!this._db().prepare('SELECT id FROM workstation_bootc_artifacts WHERE id=?').get(artifactId)) {
      throw fail('Bootc artifact not found', 404, 'BOOTC_ARTIFACT_NOT_FOUND');
    }
    const limit = query.limit == null ? 100 : integer(query.limit, 'limit');
    const offset = query.offset == null ? 0 : integer(query.offset, 'offset', 0);
    if (limit > 100 || offset > 10_000) throw fail('Promotion history bounds are invalid', 400, 'WORKSTATION_INPUT_INVALID');
    const total = Number(this._db().prepare(`SELECT COUNT(*) AS count FROM workstation_artifact_promotions
      WHERE artifact_id=?`).get(artifactId).count);
    const promotions = this._db().prepare(`SELECT * FROM workstation_artifact_promotions WHERE artifact_id=?
      ORDER BY promoted_at DESC,id DESC LIMIT ? OFFSET ?`).all(artifactId, limit, offset).map(row => this._promotionRow(row));
    return { artifactId, total, limit, offset, promotions };
  }

  async inspectRegistryArtifact(body = {}, actor) {
    this._admin(actor);
    const registryId = integer(body.registryId ?? body.registry_id, 'registryId');
    const repositoryName = repository(body.repository);
    const sourceRef = reference(body.sourceRef || body.source_ref || 'latest');
    const signerPattern = text(body.signerPattern || body.signer_pattern || '', 'signerPattern', 256) || null;
    const signaturePolicy = String(body.signaturePolicy || body.signature_policy || 'none');
    if (!['none', 'annotation', 'cosign'].includes(signaturePolicy)) throw fail('signaturePolicy is invalid', 400, 'WORKSTATION_INPUT_INVALID');
    if (signaturePolicy === 'cosign' && !signerPattern) {
      throw fail('Cosign inspection requires an explicit signer policy', 400, 'BOOTC_SIGNER_POLICY_REQUIRED');
    }
    let manifestData = await this._registry.manifest(registryId, repositoryName, sourceRef);
    if (Array.isArray(manifestData.manifest?.manifests)) {
      const descriptors = manifestData.manifest.manifests;
      const selected = descriptors.find(item => item.platform?.os === 'linux' && item.platform?.architecture === 'amd64')
        || descriptors.find(item => item.platform?.os === 'linux') || descriptors[0];
      if (!selected?.digest) throw fail('OCI image index has no usable manifest descriptor', 409, 'OCI_PLATFORM_NOT_FOUND');
      manifestData = await this._registry.manifest(registryId, repositoryName, selected.digest);
    }
    const pinnedDigest = digest(manifestData.digest || (DIGEST_RE.test(sourceRef) ? sourceRef : ''), 'manifest digest');
    const registryProfile = typeof this._registry.get === 'function' ? this._registry.get(registryId) : null;
    if (!registryProfile?.url) throw fail('Registry profile is unavailable', 404, 'WORKSTATION_REGISTRY_NOT_FOUND');
    const imageReference = canonicalImageReference(registryProfile.url, repositoryName, pinnedDigest);
    const configDigest = manifestData.manifest?.config?.digest;
    if (!DIGEST_RE.test(String(configDigest || ''))) throw fail('OCI manifest has no valid config digest', 409, 'OCI_CONFIG_MISSING');
    const [configBlob, referrerResult] = await Promise.all([
      this._registry.blob(registryId, repositoryName, configDigest),
      this._registry.referrers(registryId, repositoryName, pinnedDigest)
        .then(items => ({ items, state: 'available' })).catch(() => ({ items: [], state: 'unavailable' })),
    ]);
    const referrers = referrerResult.items;
    const parsedProvenance = provenanceParser.parse(manifestData);
    const signatureRefPresent = referrers.some(item => SIGNATURE_PATTERN.test(String(item.artifactType || item.mediaType || '')));
    if (signatureRefPresent) parsedProvenance.known = { ...parsedProvenance.known, signed: true };
    const trust = this._trustVerifier({ registryId, repository: repositoryName, digest: pinnedDigest, policy: signaturePolicy,
      signerPattern, provenance: parsedProvenance });
    if (trust.cryptographicallyVerified === true && !/^[a-f0-9]{64}$/i.test(String(trust.outputHash || ''))) {
      throw fail('Cryptographic verification did not produce a bounded evidence hash', 409, 'BOOTC_TRUST_EVIDENCE_INVALID');
    }
    const evidence = bootcEvidence({ manifest: manifestData.manifest, configBlob, referrers,
      trust: { ...trust, signaturePresent: parsedProvenance.known?.signed === true }, digest: pinnedDigest });
    if (!evidence.bootcDetected) throw fail('OCI artifact does not declare bootc compatibility', 409, 'NOT_BOOTC_IMAGE');
    const signatureState = trust.cryptographicallyVerified ? 'verified'
      : evidence.signaturePresent || parsedProvenance.known?.signed ? 'present' : 'absent';
    const provenance = { ...boundedProvenance(parsedProvenance, trust, signerPattern),
      referrerCount: referrers.length, referrerQueryState: referrerResult.state,
      inspectedAt: new Date(this._now()).toISOString() };
    const db = this._db();
    const existing = db.prepare('SELECT * FROM workstation_bootc_artifacts WHERE digest=?').get(pinnedDigest);
    db.transaction(() => {
      db.prepare(`INSERT INTO workstation_bootc_artifacts
      (registry_id,name,repository,source_ref,digest,image_reference,media_type,os_name,os_version,architecture,bootc_detected,
       base_image,base_digest,source_url,revision,sbom_refs_json,signature_policy,signature_state,signer,
       signer_pattern,verification_hash,channel,provenance_json,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(digest) DO UPDATE SET
       registry_id=excluded.registry_id,name=excluded.name,repository=excluded.repository,source_ref=excluded.source_ref,
       image_reference=excluded.image_reference,
       media_type=excluded.media_type,os_name=excluded.os_name,os_version=excluded.os_version,
       architecture=excluded.architecture,bootc_detected=excluded.bootc_detected,base_image=excluded.base_image,
       base_digest=excluded.base_digest,source_url=excluded.source_url,revision=excluded.revision,
       sbom_refs_json=excluded.sbom_refs_json,signature_policy=excluded.signature_policy,
       signature_state=excluded.signature_state,signer=excluded.signer,signer_pattern=excluded.signer_pattern,
       verification_hash=excluded.verification_hash,
       provenance_json=excluded.provenance_json,updated_at=datetime('now')`)
        .run(registryId, text(body.name || `${repositoryName}@${pinnedDigest.slice(7, 19)}`, 'name', 255, true),
        repositoryName, sourceRef, pinnedDigest, imageReference, evidence.mediaType || null, evidence.osName || null,
        evidence.osVersion || null, evidence.architecture || null, 1, evidence.baseImage || null,
        evidence.baseDigest, evidence.sourceUrl || null, evidence.revision || null, JSON.stringify(evidence.sbomRefs),
        signaturePolicy, signatureState, trust.signer || parsedProvenance.known?.signer || null,
        signerPattern, trust.outputHash || null, 'held', JSON.stringify(provenance), actor.id);
      if (existing && existing.channel !== 'held' && signatureState !== 'verified') {
        const reason = 'Automatic fail-closed demotion after trust reinspection';
        const evidenceHash = hash({ artifactId: existing.id, digest: pinnedDigest, from: existing.channel,
          to: 'held', signatureState, verificationHash: trust.outputHash || null, reason });
        db.prepare(`INSERT INTO workstation_artifact_promotions
          (artifact_id,from_channel,to_channel,reason,evidence_hash,promoted_by) VALUES (?,?,?,?,?,?)`)
          .run(existing.id, existing.channel, 'held', reason, evidenceHash, actor.id);
        db.prepare("UPDATE workstation_bootc_artifacts SET channel='held',updated_at=datetime('now') WHERE id=?")
          .run(existing.id);
      }
    })();
    return this._artifactWithPromotionCount(db.prepare('SELECT * FROM workstation_bootc_artifacts WHERE digest=?').get(pinnedDigest));
  }

  promoteArtifact(id, body = {}, actor) {
    this._admin(actor);
    const row = this._db().prepare('SELECT * FROM workstation_bootc_artifacts WHERE id=?').get(integer(id, 'artifactId'));
    if (!row) throw fail('Bootc artifact not found', 404, 'BOOTC_ARTIFACT_NOT_FOUND');
    const toChannel = String(body.channel || body.toChannel || '');
    if (!CHANNELS.has(toChannel)) throw fail('channel must be held, canary or stable', 400, 'WORKSTATION_INPUT_INVALID');
    if (toChannel === row.channel) return { ...this._artifactWithPromotionCount(row), duplicate: true };
    if (toChannel === 'stable' && row.channel !== 'canary') throw fail('Artifact must pass through canary before stable', 409, 'BOOTC_CANARY_REQUIRED');
    if (toChannel !== 'held' && row.signature_state !== 'verified') {
      throw fail('Cryptographic signature verification is required before rollout', 409, 'BOOTC_SIGNATURE_NOT_VERIFIED');
    }
    const reason = text(body.reason, 'reason', 1000, true);
    const evidenceHash = hash({ artifactId: row.id, digest: row.digest, from: row.channel, to: toChannel,
      signatureState: row.signature_state, verificationHash: row.verification_hash, reason });
    const db = this._db();
    db.transaction(() => {
      db.prepare(`INSERT INTO workstation_artifact_promotions
        (artifact_id,from_channel,to_channel,reason,evidence_hash,promoted_by) VALUES (?,?,?,?,?,?)`)
        .run(row.id, row.channel, toChannel, reason, evidenceHash, actor.id);
      db.prepare("UPDATE workstation_bootc_artifacts SET channel=?,updated_at=datetime('now') WHERE id=?")
        .run(toChannel, row.id);
    })();
    return { ...this._artifactWithPromotionCount(db.prepare('SELECT * FROM workstation_bootc_artifacts WHERE id=?').get(row.id)),
      duplicate: false, promotionEvidenceHash: evidenceHash };
  }

  _deviceRow(row, artifacts = null) {
    if (!row) return null;
    const approvedArtifacts = artifacts || this.artifacts({ id: 1, role: 'admin' });
    const device = { id: row.id, connectionId: row.connection_id, externalId: row.external_id, name: row.name,
      organization: row.organization, location: row.location, hostGroup: row.host_group, edgeSiteId: row.edge_site_id,
      scopeRef: row.scope_ref, osName: row.os_name, osVersion: row.os_version, architecture: row.architecture,
      ipAddress: row.ip_address, macAddress: row.mac_address, status: row.status, lastSeenAt: row.last_seen_at,
      bootcDigest: row.bootc_digest, bootcVersion: row.bootc_version,
      lifecycleEnvironment: row.lifecycle_environment, contentView: row.content_view,
      identityRealm: row.identity_realm, identityEnrolled: boolApi(row.identity_enrolled),
      secureBoot: boolApi(row.secure_boot), tpmPresent: boolApi(row.tpm_present),
      diskEncrypted: boolApi(row.disk_encrypted), selinuxState: row.selinux_state,
      patchAgeDays: row.patch_age_days, applicableErrata: row.applicable_errata,
      sourceHash: row.source_hash, observedAt: row.observed_at, syncedAt: row.synced_at };
    device.imageChannel = approvedArtifacts.find(item => item.digest === device.bootcDigest)?.channel || 'unapproved';
    device.posture = this._posture(device, approvedArtifacts);
    return device;
  }

  _posture(device, artifacts) {
    const check = (key, value, passWhen, failDetail) => ({ key,
      state: value == null || value === 'unknown' ? 'unknown' : passWhen(value) ? 'pass' : 'fail',
      detail: value == null ? 'evidence unavailable' : passWhen(value) ? 'meets policy' : failDetail });
    const checks = [
      check('secure_boot', device.secureBoot, value => value === true, 'Secure Boot is disabled'),
      check('tpm', device.tpmPresent, value => value === true, 'TPM is unavailable'),
      check('disk_encryption', device.diskEncrypted, value => value === true, 'Full-disk encryption is not observed'),
      check('selinux', device.selinuxState, value => value === 'enforcing', 'SELinux is not enforcing'),
      check('identity', device.identityEnrolled, value => value === true, 'Directory enrollment is not observed'),
      check('patch_age', device.patchAgeDays, value => Number(value) <= 30, 'Patch evidence is older than 30 days'),
    ];
    const stableDigests = new Set(artifacts.filter(item => item.channel === 'stable').map(item => item.digest));
    const canaryDigests = new Set(artifacts.filter(item => item.channel === 'canary').map(item => item.digest));
    const driftState = !device.bootcDigest || (!stableDigests.size && !canaryDigests.size) ? 'unknown'
      : stableDigests.has(device.bootcDigest) ? 'pass'
        : canaryDigests.has(device.bootcDigest) ? 'warning' : 'fail';
    checks.push({ key: 'image_drift', state: driftState, detail: driftState === 'pass' ? 'stable digest installed'
      : driftState === 'warning' ? 'canary digest installed' : driftState === 'fail' ? 'digest is outside approved channels' : 'digest or approved channel unavailable' });
    const known = checks.filter(item => item.state !== 'unknown');
    const score = known.length ? Math.round(known.reduce((total, item) => total + (item.state === 'pass' ? 1 : item.state === 'warning' ? 0.5 : 0), 0) / known.length * 100) : null;
    const state = checks.some(item => item.state === 'fail') ? 'fail'
      : checks.some(item => item.state === 'warning') ? 'warning'
        : known.length ? 'pass' : 'unknown';
    return { state, score, checks };
  }

  devices(filters = {}, actor) {
    this._admin(actor);
    const artifacts = this.artifacts(actor);
    let rows = this._db().prepare('SELECT * FROM workstation_devices ORDER BY name').all()
      .map(row => this._deviceRow(row, artifacts));
    const search = String(filters.search || '').trim().toLowerCase();
    if (search) rows = rows.filter(item => [item.name, item.organization, item.location, item.hostGroup,
      item.osName, item.ipAddress, item.bootcDigest].some(value => String(value || '').toLowerCase().includes(search)));
    if (filters.connectionId) rows = rows.filter(item => item.connectionId === Number(filters.connectionId));
    if (filters.siteId) rows = rows.filter(item => item.edgeSiteId === Number(filters.siteId));
    if (filters.hostGroup) rows = rows.filter(item => item.hostGroup === String(filters.hostGroup));
    if (filters.channel) rows = rows.filter(item => item.imageChannel === String(filters.channel));
    if (filters.status) rows = rows.filter(item => item.status === filters.status);
    if (filters.posture) rows = rows.filter(item => item.posture.state === filters.posture);
    if (filters.drift) rows = rows.filter(item => item.posture.checks.find(check => check.key === 'image_drift')?.state === filters.drift);
    return rows;
  }

  overview(actor) {
    this._admin(actor);
    const connections = this.connections(actor);
    const artifacts = this.artifacts(actor);
    const devices = this.devices({}, actor);
    const counts = states => Object.fromEntries(states.map(state => [state, devices.filter(item => item.posture.state === state).length]));
    return { schemaVersion: '1.0', connections, mappings: this.mappings(actor), artifacts, devices,
      plans: this.plans(actor),
      summary: { connections: connections.length, artifacts: artifacts.length, workstations: devices.length,
        online: devices.filter(item => item.status === 'online').length,
        offline: devices.filter(item => item.status === 'offline').length,
        posture: counts(['pass', 'warning', 'fail', 'unknown']),
        drifted: devices.filter(item => item.posture.checks.find(check => check.key === 'image_drift')?.state === 'fail').length },
      contract: { foremanSync: 'read_only', artifactIdentity: 'sha256_digest', promotionMutation: 'local_only',
        remoteMutationsEnabled: this._mutationsEnabled, allowedRemoteJobTemplates: [...this._allowedTemplates],
        secretMaterialReturned: false } };
  }

  _planRow(row) {
    return row && { id: row.id, deviceId: row.device_id, artifactId: row.artifact_id,
      artifactVerificationHash: row.artifact_verification_hash, action: row.action,
      targetImageRef: row.target_image_ref, targetDigest: row.target_digest,
      previousDigest: row.previous_digest, channel: row.channel,
      remoteJobTemplateId: row.remote_job_template_id, maintenanceWindowRef: row.maintenance_window_ref,
      approvalRef: row.approval_ref, deviceSourceHash: row.device_source_hash, planHash: row.plan_hash,
      idempotencyKey: row.idempotency_key, state: row.state, taskRef: row.task_ref,
      postReadDigest: row.post_read_digest, errorCode: row.error_code, errorMessage: row.error_message,
      createdAt: row.created_at, expiresAt: row.expires_at, startedAt: row.started_at,
      completedAt: row.completed_at, updatedAt: row.updated_at };
  }

  createUpdatePlan(deviceId, body = {}, actor) {
    this._admin(actor);
    const device = this._db().prepare('SELECT * FROM workstation_devices WHERE id=?').get(integer(deviceId, 'deviceId'));
    if (!device) throw fail('Workstation not found', 404, 'WORKSTATION_NOT_FOUND');
    this._assertFreshDevice(device);
    const artifact = this._db().prepare('SELECT * FROM workstation_bootc_artifacts WHERE id=?')
      .get(integer(body.artifactId, 'artifactId'));
    if (!artifact) throw fail('Bootc artifact not found', 404, 'BOOTC_ARTIFACT_NOT_FOUND');
    if (artifact.bootc_detected !== 1 || artifact.signature_state !== 'verified'
        || !/^[a-f0-9]{64}$/i.test(String(artifact.verification_hash || ''))) {
      throw fail('Only verified bootc artifacts can be used for workstation workflows', 409, 'BOOTC_ARTIFACT_NOT_APPROVED');
    }
    if (!['canary', 'stable'].includes(artifact.channel)) throw fail('Held artifacts cannot be deployed', 409, 'BOOTC_ARTIFACT_HELD');
    const action = String(body.action || 'update');
    if (!ACTIONS.has(action)) throw fail('action must be update or rollback', 400, 'WORKSTATION_INPUT_INVALID');
    const previousDigest = digest(device.bootc_digest, 'current workstation digest');
    const targetDigest = digest(artifact.digest, 'target artifact digest');
    if (targetDigest === previousDigest) throw fail('Workstation already reports the target digest', 409, 'WORKSTATION_ALREADY_AT_TARGET');
    const remoteJobTemplateId = text(body.remoteJobTemplateId, 'remoteJobTemplateId', 128, true);
    if (!/^\d+$/.test(remoteJobTemplateId)) {
      throw fail('remoteJobTemplateId must be an exact numeric Foreman template id', 400, 'FOREMAN_JOB_TEMPLATE_ID_INVALID');
    }
    const maintenanceWindowRef = traceReference(body.maintenanceWindowRef, 'maintenanceWindowRef');
    const approvalRef = traceReference(body.approvalRef, 'approvalRef');
    const idempotencyKey = text(body.idempotencyKey, 'idempotencyKey', 128, true);
    if (!/^[a-zA-Z0-9_.:-]{8,128}$/.test(idempotencyKey)) throw fail('idempotencyKey format is invalid', 400, 'WORKSTATION_INPUT_INVALID');
    const sameRequest = row => row.device_id === device.id && row.artifact_id === artifact.id
      && row.artifact_verification_hash === artifact.verification_hash && row.action === action
      && row.target_image_ref === artifact.image_reference && row.target_digest === targetDigest
      && row.previous_digest === previousDigest && row.channel === artifact.channel
      && row.remote_job_template_id === remoteJobTemplateId
      && row.maintenance_window_ref === maintenanceWindowRef && row.approval_ref === approvalRef
      && row.device_source_hash === device.source_hash;
    const existing = this._db().prepare('SELECT * FROM workstation_update_plans WHERE idempotency_key=?').get(idempotencyKey);
    if (existing) {
      if (sameRequest(existing)) return { ...this._planRow(existing), duplicate: true };
      throw fail('Idempotency key is already bound to a different workstation plan', 409, 'WORKSTATION_IDEMPOTENCY_CONFLICT');
    }
    const expiresAt = new Date(this._now() + 15 * 60_000).toISOString();
    const normalized = { deviceId: device.id, externalId: device.external_id, artifactId: artifact.id,
      artifactVerificationHash: artifact.verification_hash,
      action, targetImageRef: artifact.image_reference, targetDigest, previousDigest,
      channel: artifact.channel, remoteJobTemplateId,
      maintenanceWindowRef, approvalRef, deviceSourceHash: device.source_hash, idempotencyKey, expiresAt };
    const planHash = hash(normalized);
    let planId;
    try {
      planId = Number(this._db().prepare(`INSERT INTO workstation_update_plans
        (device_id,artifact_id,artifact_verification_hash,action,target_image_ref,target_digest,previous_digest,channel,remote_job_template_id,
         maintenance_window_ref,approval_ref,device_source_hash,plan_hash,idempotency_key,requested_by,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(device.id, artifact.id, artifact.verification_hash,
        action, artifact.image_reference, targetDigest, previousDigest, artifact.channel, remoteJobTemplateId,
        maintenanceWindowRef, approvalRef, device.source_hash,
        planHash, idempotencyKey, actor.id, expiresAt).lastInsertRowid);
    } catch (error) {
      if (String(error.code).includes('SQLITE_CONSTRAINT')) {
        const duplicate = this._db().prepare('SELECT * FROM workstation_update_plans WHERE plan_hash=? OR idempotency_key=?')
          .get(planHash, idempotencyKey);
        if (duplicate && sameRequest(duplicate)) return { ...this._planRow(duplicate), duplicate: true };
        if (duplicate) throw fail('Idempotency key is already bound to a different workstation plan', 409, 'WORKSTATION_IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
    return { ...this._planRow(this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(planId)),
      duplicate: false, applyAvailable: this._mutationsEnabled && this._allowedTemplates.has(remoteJobTemplateId) };
  }

  plans(actor) {
    this._admin(actor);
    return this._db().prepare('SELECT * FROM workstation_update_plans ORDER BY created_at DESC,id DESC LIMIT 200').all()
      .map(row => this._planRow(row));
  }

  cancelPlan(id, body = {}, actor) {
    this._admin(actor);
    const row = this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(integer(id, 'planId'));
    if (!row) throw fail('Workstation update plan not found', 404, 'WORKSTATION_PLAN_NOT_FOUND');
    if (row.state === 'cancelled') return { ...this._planRow(row), duplicate: true, networkCallsStarted: 0 };
    if (row.state !== 'planned') {
      throw fail('Only unsubmitted planned workflows can be cancelled locally', 409, 'WORKSTATION_PLAN_STATE');
    }
    const reason = text(body.reason, 'reason', 500, true);
    this._db().prepare(`UPDATE workstation_update_plans SET state='cancelled',
      error_code='WORKSTATION_PLAN_CANCELLED',error_message=?,completed_at=datetime('now'),updated_at=datetime('now')
      WHERE id=?`).run(reason, row.id);
    return { ...this._planRow(this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(row.id)),
      duplicate: false, networkCallsStarted: 0 };
  }

  planPreflight(id, actor) {
    this._admin(actor);
    const row = this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(integer(id, 'planId'));
    if (!row) throw fail('Workstation update plan not found', 404, 'WORKSTATION_PLAN_NOT_FOUND');
    const checks = [];
    const add = (key, passed, code, message) => checks.push({ key, state: passed ? 'pass' : 'block', code, message });
    const device = this._db().prepare('SELECT * FROM workstation_devices WHERE id=?').get(row.device_id);
    const artifact = this._db().prepare('SELECT * FROM workstation_bootc_artifacts WHERE id=?').get(row.artifact_id);
    const connection = device ? this._db().prepare('SELECT * FROM workstation_foreman_connections WHERE id=?').get(device.connection_id) : null;
    const observed = Date.parse(device?.observed_at || '');
    const evidenceAge = this._now() - observed;
    add('plan_state', row.state === 'planned', 'WORKSTATION_PLAN_STATE', 'Plan must still be in planned state');
    add('mutation_flag', this._mutationsEnabled, 'WORKSTATION_MUTATIONS_DISABLED', 'Foreman mutations are disabled');
    add('template_allowlist', this._allowedTemplates.has(row.remote_job_template_id), 'FOREMAN_JOB_TEMPLATE_DENIED', 'Remote job template is not allowlisted');
    add('plan_expiry', Date.parse(row.expires_at) > this._now(), 'WORKSTATION_PLAN_EXPIRED', 'Plan has expired');
    add('device_present', !!device, 'WORKSTATION_NOT_FOUND', 'Workstation evidence is unavailable');
    add('device_online', device?.status === 'online', 'WORKSTATION_NOT_ONLINE', 'Workstation must be online');
    add('device_evidence', !!device && device.source_hash === row.device_source_hash,
      'WORKSTATION_EVIDENCE_CHANGED', 'Workstation evidence changed after planning');
    add('device_freshness', !!device && Number.isFinite(observed) && evidenceAge <= this._evidenceMaxAgeMs && evidenceAge >= -5 * 60_000,
      'WORKSTATION_EVIDENCE_STALE', 'Workstation evidence is stale');
    add('numeric_host_identity', !!device && /^\d+$/.test(String(device.external_id || '')),
      'FOREMAN_HOST_ID_UNSAFE', 'Remote execution requires an exact numeric Foreman host id');
    add('target_not_installed', !!device && device.bootc_digest !== row.target_digest,
      'WORKSTATION_ALREADY_AT_TARGET', 'Workstation already reports the target digest');
    add('artifact_present', !!artifact, 'BOOTC_ARTIFACT_NOT_FOUND', 'Target artifact is unavailable');
    add('artifact_identity', !!artifact && artifact.digest === row.target_digest && artifact.image_reference === row.target_image_ref,
      'WORKSTATION_ARTIFACT_EVIDENCE_CHANGED', 'Artifact digest or canonical image reference changed');
    add('artifact_trust', !!artifact && artifact.signature_state === 'verified'
      && artifact.verification_hash === row.artifact_verification_hash,
    'WORKSTATION_ARTIFACT_EVIDENCE_CHANGED', 'Artifact cryptographic trust evidence changed');
    add('artifact_channel', !!artifact && artifact.channel === row.channel && ['canary', 'stable'].includes(artifact.channel),
      'WORKSTATION_ARTIFACT_EVIDENCE_CHANGED', 'Artifact release channel changed');
    add('connection_enabled', !!connection && connection.enabled === 1,
      'FOREMAN_CONNECTION_DISABLED', 'Foreman connection is disabled');
    add('foreman_tls', !!connection && connection.tls_verify === 1,
      'FOREMAN_TLS_REQUIRED_FOR_MUTATION', 'Verified Foreman TLS is required');
    const blockers = checks.filter(item => item.state === 'block').map(({ code, message, key }) => ({ key, code, message }));
    return { plan: this._planRow(row), ready: blockers.length === 0, checks, blockers,
      requirements: { planHash: row.plan_hash, typedConfirmation: device?.name || null },
      networkCallsStarted: 0, credentialsReturned: false };
  }

  _assertFreshDevice(device) {
    if (device.status !== 'online') throw fail('Workstation must be online for a guarded workflow', 409, 'WORKSTATION_NOT_ONLINE');
    const observed = Date.parse(device.observed_at || '');
    const age = this._now() - observed;
    if (!Number.isFinite(observed) || age > this._evidenceMaxAgeMs || age < -5 * 60_000) {
      throw fail('Workstation evidence is stale; synchronize Foreman again', 409, 'WORKSTATION_EVIDENCE_STALE');
    }
  }

  async executePlan(id, body = {}, actor) {
    this._admin(actor);
    const row = this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(integer(id, 'planId'));
    if (!row) throw fail('Workstation update plan not found', 404, 'WORKSTATION_PLAN_NOT_FOUND');
    if (['running', 'succeeded'].includes(row.state)) {
      return { ...this._planRow(row), duplicate: true, submissionPending: row.state === 'running' && !row.task_ref };
    }
    if (row.state !== 'planned') throw fail('Only planned workflows can be executed', 409, 'WORKSTATION_PLAN_STATE');
    if (!this._mutationsEnabled) throw fail('Foreman mutations are disabled', 409, 'WORKSTATION_MUTATIONS_DISABLED');
    if (!this._allowedTemplates.has(row.remote_job_template_id)) throw fail('Remote job template is not allowlisted', 403, 'FOREMAN_JOB_TEMPLATE_DENIED');
    if (Date.parse(row.expires_at) <= this._now()) throw fail('Workstation update plan expired', 409, 'WORKSTATION_PLAN_EXPIRED');
    if (text(body.planHash, 'planHash', 64, true) !== row.plan_hash) throw fail('Plan hash mismatch', 409, 'WORKSTATION_PLAN_HASH_MISMATCH');
    const device = this._db().prepare('SELECT * FROM workstation_devices WHERE id=?').get(row.device_id);
    if (!device || device.source_hash !== row.device_source_hash) throw fail('Workstation evidence changed; create a new plan', 409, 'WORKSTATION_EVIDENCE_CHANGED');
    this._assertFreshDevice(device);
    const artifact = this._db().prepare('SELECT * FROM workstation_bootc_artifacts WHERE id=?').get(row.artifact_id);
    if (!artifact || artifact.digest !== row.target_digest || artifact.image_reference !== row.target_image_ref
        || artifact.signature_state !== 'verified'
        || artifact.verification_hash !== row.artifact_verification_hash || artifact.channel !== row.channel
        || !['canary', 'stable'].includes(artifact.channel)) {
      throw fail('Artifact trust or channel evidence changed; create a new plan', 409, 'WORKSTATION_ARTIFACT_EVIDENCE_CHANGED');
    }
    if (text(body.confirmation, 'confirmation', 255, true) !== device.name) throw fail('Typed workstation confirmation does not match', 409, 'WORKSTATION_CONFIRMATION_MISMATCH');
    const connection = this._connection(device.connection_id);
    if (connection.enabled !== 1) throw fail('Foreman connection is disabled', 409, 'FOREMAN_CONNECTION_DISABLED');
    if (connection.tls_verify !== 1) {
      throw fail('Verified Foreman TLS is required for remote jobs', 409, 'FOREMAN_TLS_REQUIRED_FOR_MUTATION');
    }
    if (!/^\d+$/.test(String(device.external_id || ''))) {
      throw fail('Remote jobs require an exact numeric Foreman host id', 409, 'FOREMAN_HOST_ID_UNSAFE');
    }
    const client = this._clientFactory(connection, this._secret(connection));
    const templateContract = await client.jobTemplateContract(row.remote_job_template_id);
    if (!templateContract.valid) {
      throw fail('Foreman job template is missing required Docker Dash inputs', 409,
        'FOREMAN_JOB_TEMPLATE_CONTRACT_INVALID', { missingInputs: templateContract.missingInputs });
    }
    const claimed = this._db().prepare(`UPDATE workstation_update_plans SET state='running',started_at=datetime('now'),
      error_code=NULL,error_message=NULL,updated_at=datetime('now') WHERE id=? AND state='planned'`).run(row.id);
    if (claimed.changes !== 1) {
      const current = this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(row.id);
      if (['running', 'succeeded'].includes(current?.state)) {
        return { ...this._planRow(current), duplicate: true, submissionPending: current.state === 'running' && !current.task_ref };
      }
      throw fail('Only planned workflows can be executed', 409, 'WORKSTATION_PLAN_STATE');
    }
    try {
      const result = await client.runRemoteJob({
        templateId: row.remote_job_template_id, externalId: device.external_id, action: row.action,
        targetImageRef: row.target_image_ref, targetDigest: row.target_digest, idempotencyKey: row.idempotency_key,
        planHash: row.plan_hash, approvalRef: row.approval_ref, maintenanceWindowRef: row.maintenance_window_ref,
      });
      this._db().prepare(`UPDATE workstation_update_plans SET task_ref=?,updated_at=datetime('now') WHERE id=?`)
        .run(result.taskRef, row.id);
      return { ...this._planRow(this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(row.id)),
        duplicate: false, credentialsReturned: false, remoteOutputStored: false };
    } catch (error) {
      this._db().prepare(`UPDATE workstation_update_plans SET state='failed',error_code=?,error_message=?,
        completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(error.code || 'FOREMAN_JOB_SUBMIT_FAILED', String(error.message || 'Remote job submit failed').slice(0, 300), row.id);
      throw error;
    }
  }

  async reconcilePlan(id, actor) {
    this._admin(actor);
    const row = this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(integer(id, 'planId'));
    if (!row) throw fail('Workstation update plan not found', 404, 'WORKSTATION_PLAN_NOT_FOUND');
    if (['succeeded', 'failed', 'verification_failed', 'cancelled'].includes(row.state)) {
      return { ...this._planRow(row), duplicate: true };
    }
    if (row.state !== 'running') throw fail('Workflow has no active Foreman task', 409, 'WORKSTATION_PLAN_STATE');
    const startedAt = Date.parse(row.started_at || '');
    if (Number.isFinite(startedAt) && this._now() - startedAt >= this._jobTimeoutMs) {
      const errorCode = row.task_ref ? 'FOREMAN_JOB_TIMEOUT' : 'FOREMAN_JOB_SUBMISSION_TIMEOUT';
      const errorMessage = row.task_ref ? 'Foreman remote job exceeded the configured timeout'
        : 'Foreman job submission did not produce a task identity before timeout';
      this._db().prepare(`UPDATE workstation_update_plans SET state='failed',error_code=?,
        error_message=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(errorCode, errorMessage, row.id);
      return { ...this._planRow(this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(row.id)),
        timedOut: true, networkCallsStarted: 0 };
    }
    if (!row.task_ref) return { ...this._planRow(row), submissionPending: true, networkCallsStarted: 0 };
    const device = this._db().prepare('SELECT * FROM workstation_devices WHERE id=?').get(row.device_id);
    if (!device) throw fail('Workstation evidence is unavailable for reconciliation', 409, 'WORKSTATION_NOT_FOUND');
    const connection = this._connection(device.connection_id);
    if (connection.enabled !== 1) throw fail('Foreman connection is disabled', 409, 'FOREMAN_CONNECTION_DISABLED');
    if (connection.tls_verify !== 1) {
      throw fail('Verified Foreman TLS is required for remote-job reconciliation', 409, 'FOREMAN_TLS_REQUIRED_FOR_MUTATION');
    }
    const client = this._clientFactory(connection, this._secret(connection));
    const task = await client.job(row.task_ref);
    if (task.state === 'running' || task.state === 'unknown') return { ...this._planRow(row), taskState: task.state };
    if (task.state === 'failed') {
      this._db().prepare(`UPDATE workstation_update_plans SET state='failed',error_code='FOREMAN_JOB_FAILED',
        error_message='Foreman remote job reported failure',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(row.id);
      return this._planRow(this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(row.id));
    }
    const host = await client.host(device.external_id);
    const normalized = this._normalizeHost(host, connection.id, this._mappingIndex(connection.id));
    this._upsertDevice(normalized);
    const verified = normalized.bootcDigest === row.target_digest;
    this._db().prepare(`UPDATE workstation_update_plans SET state=?,post_read_digest=?,error_code=?,error_message=?,
      completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
      .run(verified ? 'succeeded' : 'verification_failed', normalized.bootcDigest,
        verified ? null : 'WORKSTATION_POST_READ_MISMATCH', verified ? null : 'Post-read did not observe the target digest', row.id);
    return { ...this._planRow(this._db().prepare('SELECT * FROM workstation_update_plans WHERE id=?').get(row.id)),
      postReadVerified: verified, remoteOutputStored: false };
  }
}

module.exports = new WorkstationFleetService();
module.exports.WorkstationFleetService = WorkstationFleetService;
module.exports.WorkstationFleetError = WorkstationFleetError;
module.exports._internals = { stable, hash, selectedFacts, bootcEvidence, canonicalImageReference, DIGEST_RE };
