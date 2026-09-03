'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { getDb } = require('../db');
const infrastructureOperations = require('./infrastructure-operations');

const SITE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:+/@ -]{0,499}$/;
const SAFE_VERSION = /^[v]?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const FINGERPRINT = /^(?:sha256:)?[a-f0-9]{64}$/;
const SECRET_KEY = /password|token|private.?key|user.?data|network.?data|secret(?!.*ref)|credential(?!.*ref)|authorization|cookie/i;
const OFFLINE_ACTIONS = new Set(['host.health_check','host.collect_inventory','service.restart','vm.power_on','vm.power_off']);
const RUNBOOKS = new Set(['collect_inventory','restart_managed_service','rotate_logs','validate_backup','network_diagnostics','disaster_assessment']);
const CATEGORIES = ['inventory','event','metric','artifact'];
const ARTIFACT_KINDS = new Set(['certificate','package','docs','agent','image']);
const CONTENT_KINDS = new Set(['oci','iso','template','package','docs']);
const RESIDENCY_CATEGORIES = ['inventory','logs','metrics','backups'];
const EVENT_RESIDENCY_CATEGORY = { inventory: 'inventory', event: 'logs', metric: 'metrics', artifact: 'backups' };
const IDENTITY_SCOPES = new Set(['inventory.read','events.write','health.write','runbook.report','runbook.execute']);
const VAULT_KINDS = new Set(['hashicorp_vault','cyberark','local_tpm','kubernetes']);
const VAULT_AUTH = new Set(['mtls','workload_identity','tpm_attestation','service_account']);
const CONSOLE_TRANSPORTS = new Set(['serial','text','html5']);
const BMC_ACTIONS = new Set(['power_cycle','power_on','power_off','nmi','boot_once']);
const COMPLIANCE_CONTROLS = new Set(['agent_version','connectivity','residency','backup','quorum','bmc_firmware']);
const FAULT_DOMAIN_TYPES = ['rack','power','network','storage'];

class EdgePlatformError extends Error {
  constructor(message, status = 400, code = 'EDGE_PLATFORM_ERROR', details) {
    super(message); this.name = 'EdgePlatformError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new EdgePlatformError(message, status, code, details);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => { const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`); return result; };
const text = (value, key, max = 500, pattern) => { const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`); return result; };
const slug = (value, key = 'slug') => text(value, key, 63, SITE_SLUG);
const reference = (value, key) => { const result = text(value, key, 500, SAFE_REF);
  if (result.split('/').includes('..')) throw fail(`${key} may not traverse parent directories`); return result; };
function bounded(value, key, max = 1024 * 1024) {
  let encoded; try { encoded = JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'EDGE_DOCUMENT_TOO_LARGE');
  return encoded;
}
function secretFree(value, path = 'document') {
  if (typeof value === 'string') {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)
      || /(?:https?|ssh):\/\/[^\s/@:]+:[^\s/@]+@/i.test(value)
      || /[?&](?:token|key|secret|password|signature|authorization)=[^&\s]+/i.test(value)) {
      throw fail(`${path} contains inline secret material`, 400, 'EDGE_SECRET_MATERIAL');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && !/ref(erence)?$/i.test(key) && child != null && child !== '') {
      throw fail(`${path}.${key} contains inline secret material`, 400, 'EDGE_SECRET_MATERIAL');
    }
    secretFree(child, `${path}.${key}`);
  }
}
function timestamp(value, key, options = {}) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) throw fail(`${key} must be an ISO timestamp`);
  const now = Date.now(); if (options.future && date.getTime() <= now) throw fail(`${key} must be in the future`);
  if (options.maxFutureMs && date.getTime() > now + options.maxFutureMs) throw fail(`${key} is too far in the future`);
  if (options.maxPastMs && date.getTime() < now - options.maxPastMs) throw fail(`${key} is too old`);
  return date.toISOString();
}
function safeList(value, key, max = 100, allowed) {
  if (!Array.isArray(value) || value.length > max) throw fail(`${key} must contain at most ${max} entries`);
  return [...new Set(value.map((item, index) => {
    const result = reference(item, `${key}[${index}]`); if (allowed && !allowed.has(result)) throw fail(`${key}[${index}] is not allowlisted`); return result;
  }))];
}

class EdgePlatformService {
  constructor(dbProvider = getDb, options = {}) {
    this._dbProvider = dbProvider; this._secret = options.signingSecret || process.env.APP_SECRET || '';
    this._approvals = options.approvalService || infrastructureOperations;
  }
  _db() { return this._dbProvider(); }
  _admin(actor) { if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN'); }
  _sign(kind, value) {
    if (this._secret.length < 16) throw fail('Edge signing key is unavailable', 503, 'EDGE_SIGNING_UNAVAILABLE');
    return crypto.createHmac('sha256', `${this._secret}:edge-platform:v1`).update(`${kind}\n${stable(value)}`).digest('hex');
  }
  _site(id) { const row = this._db().prepare('SELECT * FROM edge_sites WHERE id=?').get(integer(id, 'siteId', 1));
    if (!row) throw fail('Edge site not found', 404, 'EDGE_SITE_NOT_FOUND'); return row; }
  _ensureSiteMutable(siteId) {
    const declaration = this._db().prepare("SELECT id,declaration_hash FROM edge_disaster_declarations WHERE site_id=? AND state='active' ORDER BY id DESC LIMIT 1").get(siteId);
    if (declaration) throw fail('Site mutations are frozen by an active disaster declaration', 423, 'EDGE_SITE_DISASTER_FREEZE',
      { declarationId: declaration.id, declarationHash: declaration.declaration_hash });
  }
  _siteTrustRoots(site) { return new Set(parse(site.trust_roots_json, [])); }
  _siteRow(row) {
    if (!row) return null; const db = this._db(); const policy = db.prepare('SELECT * FROM edge_connectivity_policies WHERE site_id=?').get(row.id);
    const last = db.prepare('SELECT * FROM edge_heartbeats WHERE site_id=? ORDER BY observed_at DESC,id DESC LIMIT 1').get(row.id);
    const disaster = db.prepare("SELECT * FROM edge_disaster_declarations WHERE site_id=? AND state='active' ORDER BY id DESC LIMIT 1").get(row.id);
    const now = Date.now(); const maxStale = Number(policy?.max_staleness_seconds || 300);
    const ageSeconds = last ? Math.max(0, Math.floor((now - Date.parse(last.observed_at)) / 1000)) : null;
    const expected = policy?.expected_offline_until && Date.parse(policy.expected_offline_until) > now;
    let health = last && ageSeconds <= maxStale ? last.status : expected ? 'expected_disconnected' : last ? 'offline' : 'unknown';
    if (row.status === 'maintenance') health = 'maintenance';
    return { id: row.id, slug: row.slug, name: row.name, timezone: row.timezone, region: row.region,
      jurisdiction: row.jurisdiction, localOwner: row.local_owner, trustRoots: parse(row.trust_roots_json, []),
      status: row.status, configHash: row.config_hash, hosts: db.prepare(`SELECT h.id,h.name,h.daemon_type daemonType,m.role
        FROM edge_site_hosts m JOIN docker_hosts h ON h.id=m.host_id WHERE m.site_id=? ORDER BY h.name`).all(row.id),
      connectivity: policy ? { mode: policy.mode, maxStalenessSeconds: policy.max_staleness_seconds,
        cacheTtlSeconds: policy.cache_ttl_seconds, mutationMode: policy.mutation_mode,
        expectedOfflineUntil: policy.expected_offline_until, policyHash: policy.policy_hash } : null,
      heartbeat: last ? { agentId: last.agent_id, sequence: last.sequence, status: last.status, version: last.version,
        capabilities: parse(last.capabilities_json, []), observedAt: last.observed_at, ageSeconds } : null,
      health: disaster ? 'disaster' : health, expectedDisconnect: !!expected,
      disaster: disaster ? { id: disaster.id, severity: disaster.severity, ticketRef: disaster.ticket_ref,
        declarationHash: disaster.declaration_hash, mutationFreeze: true, declaredAt: disaster.declared_at } : null,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  saveSite(body = {}, actor) {
    this._admin(actor); secretFree(body, 'site'); const db = this._db(); const siteSlug = slug(body.slug); const name = text(body.name, 'name', 160);
    const timezone = text(body.timezone, 'timezone', 100, /^[a-zA-Z0-9_+\/-]+$/);
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw fail('timezone must be a valid IANA timezone'); }
    const region = reference(body.region, 'region'); const jurisdiction = reference(body.jurisdiction, 'jurisdiction');
    const localOwner = reference(body.localOwner, 'localOwner'); const trustRoots = safeList(body.trustRoots || [], 'trustRoots', 50);
    if (!trustRoots.length) throw fail('At least one trust root identity is required');
    const status = ['active','maintenance','retired'].includes(body.status) ? body.status : 'active';
    const hostInputs = Array.isArray(body.hosts) ? body.hosts : []; if (hostInputs.length > 200) throw fail('hosts contains too many entries');
    const roles = new Set(['control_plane','worker','storage','gateway','standalone','other']);
    const hosts = hostInputs.map((item, index) => ({ hostId: integer(item?.hostId, `hosts[${index}].hostId`, 1),
      role: roles.has(item?.role) ? item.role : 'other' }));
    if (new Set(hosts.map(item => item.hostId)).size !== hosts.length) throw fail('host ids must be unique');
    for (const item of hosts) if (!db.prepare('SELECT id FROM docker_hosts WHERE id=? AND is_active=1').get(item.hostId)) {
      throw fail(`Host ${item.hostId} was not found or is inactive`, 404, 'EDGE_HOST_NOT_FOUND');
    }
    const normalized = { slug: siteSlug, name, timezone, region, jurisdiction, localOwner, trustRoots, status, hosts };
    secretFree(normalized); bounded(normalized, 'site', 128 * 1024); const configHash = hash(normalized);
    const transaction = db.transaction(() => {
      db.prepare(`INSERT INTO edge_sites (slug,name,timezone,region,jurisdiction,local_owner,trust_roots_json,status,config_hash,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name,timezone=excluded.timezone,region=excluded.region,
        jurisdiction=excluded.jurisdiction,local_owner=excluded.local_owner,trust_roots_json=excluded.trust_roots_json,status=excluded.status,
        config_hash=excluded.config_hash,updated_at=datetime('now')`).run(siteSlug, name, timezone, region, jurisdiction, localOwner,
        stable(trustRoots), status, configHash, actor.id);
      const site = db.prepare('SELECT * FROM edge_sites WHERE slug=?').get(siteSlug);
      db.prepare('DELETE FROM edge_site_hosts WHERE site_id=?').run(site.id);
      const insert = db.prepare('INSERT INTO edge_site_hosts (site_id,host_id,role) VALUES (?,?,?)');
      for (const item of hosts) insert.run(site.id, item.hostId, item.role);
      const connectivity = { mode: 'intermittent', maxStalenessSeconds: 300, cacheTtlSeconds: 86400, mutationMode: 'deny' };
      db.prepare(`INSERT OR IGNORE INTO edge_connectivity_policies
        (site_id,mode,max_staleness_seconds,cache_ttl_seconds,mutation_mode,policy_hash,updated_by) VALUES (?,?,?,?,?,?,?)`)
        .run(site.id, connectivity.mode, connectivity.maxStalenessSeconds, connectivity.cacheTtlSeconds,
          connectivity.mutationMode, hash(connectivity), actor.id);
      const sync = { bandwidthKbps: 1024, maxBatchBytes: 5 * 1024 * 1024, priorityOrder: CATEGORIES };
      db.prepare(`INSERT OR IGNORE INTO edge_sync_policies
        (site_id,bandwidth_kbps,max_batch_bytes,priority_order_json,policy_hash,updated_by) VALUES (?,?,?,?,?,?)`)
        .run(site.id, sync.bandwidthKbps, sync.maxBatchBytes, stable(sync.priorityOrder), hash(sync), actor.id);
      return site.id;
    });
    try { return this._siteRow(db.prepare('SELECT * FROM edge_sites WHERE id=?').get(transaction())); }
    catch (error) { if (/UNIQUE constraint failed: edge_site_hosts\.host_id/.test(error.message)) throw fail('A host can belong to only one edge site', 409, 'EDGE_HOST_ALREADY_ASSIGNED'); throw error; }
  }

  saveConnectivity(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'connectivity'); const site = this._site(siteId); const mode = String(body.mode || 'intermittent');
    if (!['always_online','intermittent','disconnected'].includes(mode)) throw fail('mode is invalid');
    const maxStalenessSeconds = integer(body.maxStalenessSeconds ?? 300, 'maxStalenessSeconds', 30, 2_592_000);
    const cacheTtlSeconds = integer(body.cacheTtlSeconds ?? 86400, 'cacheTtlSeconds', 30, 7_776_000);
    const mutationMode = String(body.mutationMode || 'deny'); if (!['deny','queue'].includes(mutationMode)) throw fail('mutationMode is invalid');
    if (mode === 'always_online' && mutationMode === 'queue') throw fail('always_online sites may not queue offline mutations');
    const expectedOfflineUntil = body.expectedOfflineUntil ? timestamp(body.expectedOfflineUntil, 'expectedOfflineUntil', { future: true, maxFutureMs: 30 * 86400000 }) : null;
    const normalized = { mode, maxStalenessSeconds, cacheTtlSeconds, mutationMode, expectedOfflineUntil };
    const policyHash = hash(normalized); this._db().prepare(`INSERT INTO edge_connectivity_policies
      (site_id,mode,max_staleness_seconds,cache_ttl_seconds,mutation_mode,expected_offline_until,policy_hash,updated_by)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET mode=excluded.mode,max_staleness_seconds=excluded.max_staleness_seconds,
      cache_ttl_seconds=excluded.cache_ttl_seconds,mutation_mode=excluded.mutation_mode,expected_offline_until=excluded.expected_offline_until,
      policy_hash=excluded.policy_hash,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(site.id, mode, maxStalenessSeconds, cacheTtlSeconds, mutationMode, expectedOfflineUntil, policyHash, actor.id);
    return this._siteRow(site).connectivity;
  }

  recordCache(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'cache'); const site = this._site(siteId); const db = this._db(); const policy = db.prepare('SELECT * FROM edge_connectivity_policies WHERE site_id=?').get(site.id);
    const providerRef = reference(body.providerRef, 'providerRef'); const resourceKind = reference(body.resourceKind, 'resourceKind');
    const resourceRef = reference(body.resourceRef, 'resourceRef'); const observedAt = timestamp(body.observedAt || new Date().toISOString(), 'observedAt', { maxFutureMs: 5 * 60000, maxPastMs: 90 * 86400000 });
    const payload = object(body.payload); secretFree(payload, 'payload'); bounded(payload, 'payload', 512 * 1024);
    const expiresAt = new Date(Date.parse(observedAt) + Number(policy?.cache_ttl_seconds || 86400) * 1000).toISOString();
    const payloadHash = hash(payload); const entryHash = hash({ siteId: site.id, providerRef, resourceKind, resourceRef, observedAt, payloadHash });
    const existing = db.prepare('SELECT * FROM edge_read_cache_entries WHERE entry_hash=?').get(entryHash);
    if (existing) return { ...this._cacheRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_read_cache_entries
      (site_id,provider_ref,resource_kind,resource_ref,observed_at,expires_at,payload_json,payload_hash,entry_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(site.id, providerRef, resourceKind, resourceRef, observedAt, expiresAt, stable(payload), payloadHash, entryHash, actor.id);
    return { ...this._cacheRow(db.prepare('SELECT * FROM edge_read_cache_entries WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _cacheRow(row) { const now = Date.now(); const expiry = Date.parse(row.expires_at); const state = expiry > now ? 'fresh' : expiry > now - 30 * 86400000 ? 'stale' : 'expired';
    return { id: row.id, siteId: row.site_id, providerRef: row.provider_ref, resourceKind: row.resource_kind,
      resourceRef: row.resource_ref, observedAt: row.observed_at, expiresAt: row.expires_at, state,
      payload: parse(row.payload_json, {}), payloadHash: row.payload_hash, entryHash: row.entry_hash, createdAt: row.created_at }; }
  cacheEntries(siteId, actor) { this._admin(actor); const site = this._site(siteId); return this._db().prepare('SELECT * FROM edge_read_cache_entries WHERE site_id=? ORDER BY id DESC LIMIT 200').all(site.id).map(row => this._cacheRow(row)); }

  createIntent(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'intent'); const site = this._site(siteId); this._ensureSiteMutable(site.id); const db = this._db(); const policy = db.prepare('SELECT * FROM edge_connectivity_policies WHERE site_id=?').get(site.id);
    if (policy?.mutation_mode !== 'queue') throw fail('Connectivity policy denies offline mutation queueing', 409, 'EDGE_MUTATION_QUEUE_DISABLED');
    const actionKey = String(body.actionKey || ''); if (!OFFLINE_ACTIONS.has(actionKey)) throw fail('actionKey is not allowlisted');
    const targetRef = reference(body.targetRef, 'targetRef'); const payload = object(body.payload); secretFree(payload, 'payload'); bounded(payload, 'payload', 128 * 1024);
    const prerequisites = safeList(body.prerequisites || [], 'prerequisites', 50); const expiresAt = timestamp(body.expiresAt, 'expiresAt', { future: true, maxFutureMs: 7 * 86400000 });
    const payloadHash = hash(payload); const normalized = { siteId: site.id, actionKey, targetRef, payloadHash, prerequisites, expiresAt };
    const intentHash = hash(normalized); const signature = this._sign('offline-intent', normalized);
    const existing = db.prepare('SELECT * FROM edge_offline_intents WHERE intent_hash=?').get(intentHash);
    if (existing) return { ...this._intentRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_offline_intents
      (site_id,action_key,target_ref,payload_json,payload_hash,prerequisites_json,expires_at,state,intent_hash,signature,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(site.id, actionKey, targetRef, stable(payload), payloadHash, stable(prerequisites), expiresAt, 'queued', intentHash, signature, actor.id);
    return { ...this._intentRow(db.prepare('SELECT * FROM edge_offline_intents WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _intentRow(row) { const expired = Date.parse(row.expires_at) <= Date.now() && ['queued','revalidation_required'].includes(row.state);
    return { id: row.id, siteId: row.site_id, actionKey: row.action_key, targetRef: row.target_ref,
      payload: parse(row.payload_json, {}), payloadHash: row.payload_hash, prerequisites: parse(row.prerequisites_json, []),
      expiresAt: row.expires_at, state: expired ? 'expired' : row.state, intentHash: row.intent_hash, signature: row.signature,
      signatureAlgorithm: row.signature_algorithm, revalidation: parse(row.revalidation_json, null), providerMutationsStarted: 0,
      createdAt: row.created_at, updatedAt: row.updated_at }; }
  revalidateIntent(id, body = {}, actor) {
    this._admin(actor); secretFree(body, 'revalidation'); const db = this._db(); const row = db.prepare('SELECT * FROM edge_offline_intents WHERE id=?').get(integer(id, 'intentId', 1));
    if (!row) throw fail('Offline intent not found', 404, 'EDGE_INTENT_NOT_FOUND'); this._ensureSiteMutable(row.site_id); if (row.state === 'cancelled') throw fail('Offline intent is cancelled', 409);
    const normalized = { siteId: row.site_id, actionKey: row.action_key, targetRef: row.target_ref, payloadHash: row.payload_hash,
      prerequisites: parse(row.prerequisites_json, []), expiresAt: row.expires_at };
    const expected = this._sign('offline-intent', normalized); if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(row.signature))) throw fail('Offline intent signature is invalid', 409, 'EDGE_INTENT_SIGNATURE_INVALID');
    if (Date.parse(row.expires_at) <= Date.now()) { db.prepare("UPDATE edge_offline_intents SET state='expired',updated_at=datetime('now') WHERE id=?").run(row.id); return this._intentRow({ ...row, state: 'expired' }); }
    if (!Array.isArray(body.checks) || !body.checks.length || body.checks.length > 50) throw fail('checks must contain 1-50 entries');
    const checks = body.checks.map((item, index) => ({ prerequisite: reference(item?.prerequisite, `checks[${index}].prerequisite`),
      outcome: ['pass','fail','unknown'].includes(item?.outcome) ? item.outcome : 'unknown', evidenceRef: item?.evidenceRef ? reference(item.evidenceRef, `checks[${index}].evidenceRef`) : null }));
    secretFree(checks, 'checks'); const required = new Set(normalized.prerequisites); const covered = new Set(checks.filter(item => item.outcome === 'pass').map(item => item.prerequisite));
    const missing = [...required].filter(item => !covered.has(item)); const ready = missing.length === 0 && checks.every(item => item.outcome === 'pass');
    const revalidation = { checkedAt: new Date().toISOString(), checks, missing, ready };
    db.prepare("UPDATE edge_offline_intents SET state=?,revalidation_json=?,updated_at=datetime('now') WHERE id=?")
      .run(ready ? 'ready_for_agent' : 'revalidation_required', stable(revalidation), row.id);
    return this._intentRow(db.prepare('SELECT * FROM edge_offline_intents WHERE id=?').get(row.id));
  }

  registerAgent(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'agent'); const site = this._site(siteId); const db = this._db(); const agentId = slug(body.agentId, 'agentId');
    const fingerprint = String(body.certificateFingerprint || '').toLowerCase(); if (!FINGERPRINT.test(fingerprint)) throw fail('certificateFingerprint must be SHA-256');
    const runbookAllowlist = safeList(body.runbookAllowlist || [], 'runbookAllowlist', RUNBOOKS.size, RUNBOOKS);
    const updateRing = String(body.updateRing || 'held'); if (!db.prepare('SELECT slug FROM edge_update_rings WHERE slug=? AND enabled=1').get(updateRing)) throw fail('updateRing is invalid');
    const state = ['active','held','revoked'].includes(body.state) ? body.state : 'active';
    db.prepare(`INSERT INTO edge_agents (site_id,agent_id,certificate_fingerprint,runbook_allowlist_json,update_ring,state,created_by)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(site_id,agent_id) DO UPDATE SET certificate_fingerprint=excluded.certificate_fingerprint,
      runbook_allowlist_json=excluded.runbook_allowlist_json,update_ring=excluded.update_ring,state=excluded.state,updated_at=datetime('now')`)
      .run(site.id, agentId, fingerprint.replace(/^sha256:/, ''), stable(runbookAllowlist), updateRing, state, actor.id);
    return this._agentRow(db.prepare('SELECT * FROM edge_agents WHERE site_id=? AND agent_id=?').get(site.id, agentId));
  }
  _agentRow(row) { return row && { id: row.id, siteId: row.site_id, agentId: row.agent_id,
    certificateFingerprint: `sha256:${row.certificate_fingerprint}`, runbookAllowlist: parse(row.runbook_allowlist_json, []),
    updateRing: row.update_ring, state: row.state, lastSequence: row.last_sequence, lastSeenAt: row.last_seen_at,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }; }
  heartbeat(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'heartbeat'); const site = this._site(siteId); const db = this._db(); const agentId = slug(body.agentId, 'agentId');
    const agent = db.prepare('SELECT * FROM edge_agents WHERE site_id=? AND agent_id=?').get(site.id, agentId);
    if (!agent || agent.state !== 'active') throw fail('Active edge agent profile not found', 409, 'EDGE_AGENT_NOT_ACTIVE'); this._ensureSiteMutable(agent.site_id);
    const sequence = integer(body.sequence, 'sequence', 0); if (agent.last_sequence != null && sequence <= agent.last_sequence) throw fail('Heartbeat sequence is not monotonic', 409, 'EDGE_HEARTBEAT_REPLAY');
    const status = String(body.status || 'healthy'); if (!['healthy','degraded','maintenance'].includes(status)) throw fail('status is invalid');
    const version = body.version ? text(body.version, 'version', 100, SAFE_VERSION) : null;
    const capabilities = safeList(body.capabilities || [], 'capabilities', 100); const observedAt = timestamp(body.observedAt || new Date().toISOString(), 'observedAt', { maxFutureMs: 5 * 60000, maxPastMs: 30 * 86400000 });
    const normalized = { siteId: site.id, agentId, sequence, status, version, capabilities, observedAt };
    const evidenceHash = hash(normalized); const saved = db.transaction(() => {
      const result = db.prepare(`INSERT INTO edge_heartbeats
        (site_id,agent_id,sequence,status,version,capabilities_json,observed_at,evidence_hash,received_by) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(site.id, agentId, sequence, status, version, stable(capabilities), observedAt, evidenceHash, actor.id);
      db.prepare("UPDATE edge_agents SET last_sequence=?,last_seen_at=?,version=?,updated_at=datetime('now') WHERE id=?")
        .run(sequence, observedAt, version, agent.id); return result.lastInsertRowid;
    })();
    return { id: Number(saved), siteId: site.id, agentId, sequence, status, version, capabilities, observedAt,
      receivedAt: db.prepare('SELECT received_at FROM edge_heartbeats WHERE id=?').get(saved).received_at,
      transport: 'admin_ingest_or_external_mtls_gateway', evidenceHash };
  }

  saveSyncPolicy(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'syncPolicy'); const site = this._site(siteId); const bandwidthKbps = integer(body.bandwidthKbps ?? 1024, 'bandwidthKbps', 8, 10_000_000);
    const maxBatchBytes = integer(body.maxBatchBytes ?? 5 * 1024 * 1024, 'maxBatchBytes', 1024, 1024 ** 3);
    const priorityOrder = safeList(body.priorityOrder || CATEGORIES, 'priorityOrder', 4, new Set(CATEGORIES));
    if (priorityOrder.length !== 4) throw fail('priorityOrder must contain each category once');
    const normalized = { bandwidthKbps, maxBatchBytes, priorityOrder, compression: 'deflate-raw' }; const policyHash = hash(normalized);
    this._db().prepare(`INSERT INTO edge_sync_policies (site_id,bandwidth_kbps,max_batch_bytes,priority_order_json,policy_hash,updated_by)
      VALUES (?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET bandwidth_kbps=excluded.bandwidth_kbps,max_batch_bytes=excluded.max_batch_bytes,
      priority_order_json=excluded.priority_order_json,policy_hash=excluded.policy_hash,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(site.id, bandwidthKbps, maxBatchBytes, stable(priorityOrder), policyHash, actor.id);
    return { siteId: site.id, ...normalized, policyHash };
  }
  bufferEvents(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'eventBatch'); const site = this._site(siteId); const db = this._db(); const agentId = slug(body.agentId, 'agentId');
    if (!db.prepare("SELECT id FROM edge_agents WHERE site_id=? AND agent_id=? AND state='active'").get(site.id, agentId)) throw fail('Active edge agent profile not found', 409, 'EDGE_AGENT_NOT_ACTIVE');
    if (!Array.isArray(body.events) || !body.events.length || body.events.length > 500) throw fail('events must contain 1-500 entries');
    const insert = db.prepare(`INSERT OR IGNORE INTO edge_event_buffer
      (site_id,agent_id,event_id,category,occurred_at,compressed_payload,raw_bytes,compressed_bytes,payload_hash,event_hash,received_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`); const accepted = []; let duplicateCount = 0;
    const transaction = db.transaction(() => {
      for (const [index, item] of body.events.entries()) {
        const eventId = reference(item?.eventId, `events[${index}].eventId`); const category = String(item?.category || '');
        if (!CATEGORIES.includes(category)) throw fail(`events[${index}].category is invalid`);
        const occurredAt = timestamp(item.occurredAt, `events[${index}].occurredAt`, { maxFutureMs: 5 * 60000, maxPastMs: 90 * 86400000 });
        const payload = object(item.payload); secretFree(payload, `events[${index}].payload`); const encoded = Buffer.from(bounded(payload, `events[${index}].payload`, 256 * 1024));
        const compressed = zlib.deflateRawSync(encoded, { level: 6 }); const payloadHash = hash(encoded); const eventHash = hash({ siteId: site.id, agentId, eventId, category, occurredAt, payloadHash });
        const result = insert.run(site.id, agentId, eventId, category, occurredAt, compressed, encoded.length, compressed.length, payloadHash, eventHash, actor.id);
        if (!result.changes) { duplicateCount += 1; continue; }
        accepted.push({ cursor: Number(result.lastInsertRowid), eventId, category, occurredAt, rawBytes: encoded.length, compressedBytes: compressed.length, payloadHash, eventHash });
      }
    }); transaction();
    return { siteId: site.id, agentId, accepted, acceptedCount: accepted.length, duplicateCount, compression: 'deflate-raw', providerMutationsStarted: 0 };
  }
  createSyncPlan(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'syncPlan'); const site = this._site(siteId); const db = this._db(); const policy = db.prepare('SELECT * FROM edge_sync_policies WHERE site_id=?').get(site.id);
    if (!policy) throw fail('Synchronization policy is required', 409, 'EDGE_SYNC_POLICY_REQUIRED');
    const maxBytes = body.maxBytes == null ? policy.max_batch_bytes : integer(body.maxBytes, 'maxBytes', 1024, policy.max_batch_bytes);
    const order = parse(policy.priority_order_json, CATEGORIES); const rank = new Map(order.map((value, index) => [value, index]));
    const pending = db.prepare('SELECT id,event_id,category,compressed_bytes,event_hash FROM edge_event_buffer WHERE site_id=? AND delivered_at IS NULL ORDER BY id LIMIT 5000').all(site.id)
      .sort((left, right) => (rank.get(left.category) - rank.get(right.category)) || left.id - right.id);
    const selected = []; let totalBytes = 0;
    for (const item of pending) if (totalBytes + item.compressed_bytes <= maxBytes) { selected.push(item); totalBytes += item.compressed_bytes; }
    if (!selected.length) throw fail('No pending event fits the synchronization budget', 409, 'EDGE_SYNC_NOTHING_FITS');
    const residencyPolicy = db.prepare('SELECT 1 FROM edge_data_residency_policies WHERE site_id=?').get(site.id);
    const destinationJurisdiction = residencyPolicy ? reference(body.destinationJurisdiction, 'destinationJurisdiction') : null;
    const residencyEvidence = residencyPolicy ? [...new Set(selected.map(item => EVENT_RESIDENCY_CATEGORY[item.category]))]
      .map(category => this.evaluateResidency(site.id, { dataCategory: category, destinationJurisdiction }, actor)) : [];
    const blocked = residencyEvidence.filter(item => item.decision !== 'allowed');
    if (blocked.length) throw fail('Data-residency policy blocks this synchronization plan', 409, 'EDGE_RESIDENCY_BLOCKED',
      { destinationJurisdiction, categories: blocked.map(item => item.dataCategory) });
    const eventIds = selected.map(item => item.id); const firstCursor = Math.min(...eventIds); const lastCursor = Math.max(...eventIds);
    const normalized = { siteId: site.id, eventIds, eventHashes: selected.map(item => item.event_hash), maxBytes, order,
      destinationJurisdiction, residencyEvidence: residencyEvidence.map(item => ({ dataCategory: item.dataCategory,
        destinationJurisdiction: item.destinationJurisdiction, decision: item.decision, policyHash: item.policyHash })) };
    const planHash = hash(normalized); const existing = db.prepare('SELECT * FROM edge_sync_plans WHERE plan_hash=?').get(planHash);
    if (existing) return { ...this._syncPlanRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_sync_plans
      (site_id,event_ids_json,first_cursor,last_cursor,total_bytes,priority_order_json,plan_hash,state,created_by,destination_jurisdiction,residency_evidence_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(site.id, stable(eventIds), firstCursor, lastCursor, totalBytes, stable(order), planHash, 'planned', actor.id,
        destinationJurisdiction, stable(residencyEvidence));
    return { ...this._syncPlanRow(db.prepare('SELECT * FROM edge_sync_plans WHERE id=?').get(saved.lastInsertRowid)),
      estimatedTransferSeconds: Math.ceil(totalBytes * 8 / (policy.bandwidth_kbps * 1000)), duplicate: false };
  }
  _syncPlanRow(row) { return row && { id: row.id, siteId: row.site_id, eventIds: parse(row.event_ids_json, []),
    firstCursor: row.first_cursor, lastCursor: row.last_cursor, totalBytes: row.total_bytes,
    priorityOrder: parse(row.priority_order_json, []), planHash: row.plan_hash, state: row.state,
    destinationJurisdiction: row.destination_jurisdiction || null, residencyEvidence: parse(row.residency_evidence_json, []),
    acknowledgedAt: row.acknowledged_at, providerMutationsStarted: 0, createdAt: row.created_at }; }
  acknowledgeSyncPlan(id, body = {}, actor) {
    this._admin(actor); secretFree(body, 'acknowledgement'); const db = this._db(); const row = db.prepare('SELECT * FROM edge_sync_plans WHERE id=?').get(integer(id, 'syncPlanId', 1));
    if (!row) throw fail('Sync plan not found', 404, 'EDGE_SYNC_PLAN_NOT_FOUND'); if (row.state === 'acknowledged') return { ...this._syncPlanRow(row), duplicate: true };
    if (body.planHash !== row.plan_hash) throw fail('planHash does not match the selected batch', 409, 'EDGE_SYNC_ACK_MISMATCH');
    const ids = parse(row.event_ids_json, []); const placeholders = ids.map(() => '?').join(',');
    db.transaction(() => { db.prepare(`UPDATE edge_event_buffer SET delivered_at=datetime('now') WHERE delivered_at IS NULL AND id IN (${placeholders})`).run(...ids);
      db.prepare("UPDATE edge_sync_plans SET state='acknowledged',acknowledged_at=datetime('now') WHERE id=?").run(row.id); })();
    return { ...this._syncPlanRow(db.prepare('SELECT * FROM edge_sync_plans WHERE id=?').get(row.id)), duplicate: false };
  }

  createRunbookEnvelope(agentRecordId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'runbook'); const db = this._db(); const agent = db.prepare('SELECT * FROM edge_agents WHERE id=?').get(integer(agentRecordId, 'agentId', 1));
    if (!agent || agent.state !== 'active') throw fail('Active edge agent profile not found', 409, 'EDGE_AGENT_NOT_ACTIVE');
    const runbookKey = String(body.runbookKey || ''); if (!RUNBOOKS.has(runbookKey) || !parse(agent.runbook_allowlist_json, []).includes(runbookKey)) throw fail('Runbook is not allowlisted for this agent', 403, 'EDGE_RUNBOOK_NOT_ALLOWED');
    const targetRef = reference(body.targetRef, 'targetRef'); const parameters = object(body.parameters); secretFree(parameters, 'parameters'); bounded(parameters, 'parameters', 64 * 1024);
    const expiresAt = timestamp(body.expiresAt, 'expiresAt', { future: true, maxFutureMs: 24 * 3600000 });
    const normalized = { agentRecordId: agent.id, agentId: agent.agent_id, runbookKey, targetRef, parameters, expiresAt };
    const envelopeHash = hash(normalized); const signature = this._sign('runbook-envelope', normalized);
    const existing = db.prepare('SELECT * FROM edge_runbook_envelopes WHERE envelope_hash=?').get(envelopeHash);
    if (existing) return { ...this._runbookRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_runbook_envelopes
      (agent_id,runbook_key,target_ref,parameters_json,expires_at,envelope_hash,signature,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(agent.id, runbookKey, targetRef, stable(parameters), expiresAt, envelopeHash, signature, actor.id);
    return { ...this._runbookRow(db.prepare('SELECT * FROM edge_runbook_envelopes WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _runbookRow(row) { return row && { id: row.id, agentRecordId: row.agent_id, runbookKey: row.runbook_key,
    targetRef: row.target_ref, parameters: parse(row.parameters_json, {}), expiresAt: row.expires_at,
    envelopeHash: row.envelope_hash, signature: row.signature, state: Date.parse(row.expires_at) <= Date.now() && row.state === 'issued' ? 'expired' : row.state,
    providerMutationsStarted: 0, createdAt: row.created_at }; }

  planAgentUpdate(agentRecordId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'updatePlan'); const db = this._db(); const agent = db.prepare('SELECT * FROM edge_agents WHERE id=?').get(integer(agentRecordId, 'agentId', 1));
    if (!agent) throw fail('Edge agent not found', 404, 'EDGE_AGENT_NOT_FOUND'); this._ensureSiteMutable(agent.site_id); const site = this._site(agent.site_id); const roots = this._siteTrustRoots(site);
    const targetVersion = text(body.targetVersion, 'targetVersion', 100, SAFE_VERSION); const bundleInput = object(body.bundle);
    const bundle = { digest: String(bundleInput.digest || '').toLowerCase(), localRef: reference(bundleInput.localRef, 'bundle.localRef'),
      signatureIdentity: reference(bundleInput.signatureIdentity, 'bundle.signatureIdentity'), signatureVerified: bundleInput.signatureVerified === true };
    if (!DIGEST.test(bundle.digest)) throw fail('bundle.digest must use sha256');
    const rollbackInput = object(body.rollback); const rollback = { version: text(rollbackInput.version, 'rollback.version', 100, SAFE_VERSION),
      digest: String(rollbackInput.digest || '').toLowerCase(), localRef: reference(rollbackInput.localRef, 'rollback.localRef') };
    if (!DIGEST.test(rollback.digest)) throw fail('rollback.digest must use sha256'); secretFree({ bundle, rollback });
    const evidence = { ringAllowsRollout: agent.update_ring !== 'held', signatureVerified: bundle.signatureVerified,
      trustedSigner: roots.has(bundle.signatureIdentity), rollbackAvailable: true, agentActive: agent.state === 'active' };
    const state = Object.values(evidence).every(Boolean) ? 'planned' : 'blocked'; const normalized = { agentId: agent.id,
      ring: agent.update_ring, currentVersion: agent.version || null, targetVersion, bundle, rollback, evidence };
    const planHash = hash(normalized); const existing = db.prepare('SELECT * FROM edge_update_plans WHERE plan_hash=?').get(planHash);
    if (existing) return { ...this._updateRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_update_plans
      (agent_id,ring_slug,current_version,target_version,bundle_json,rollback_json,evidence_json,plan_hash,state,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(agent.id, agent.update_ring, agent.version || null, targetVersion, stable(bundle), stable(rollback), stable(evidence), planHash, state, actor.id);
    return { ...this._updateRow(db.prepare('SELECT * FROM edge_update_plans WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _updateRow(row) { return row && { id: row.id, agentRecordId: row.agent_id, ring: row.ring_slug,
    currentVersion: row.current_version, targetVersion: row.target_version, bundle: parse(row.bundle_json, {}),
    rollback: parse(row.rollback_json, {}), evidence: parse(row.evidence_json, {}), planHash: row.plan_hash,
    state: row.state, applySupported: false, providerMutationsStarted: 0, createdAt: row.created_at }; }

  _artifact(item, index, kinds, roots, key = 'artifacts') {
    const kind = String(item?.kind || ''); if (!kinds.has(kind)) throw fail(`${key}[${index}].kind is invalid`);
    const digest = String(item.digest || '').toLowerCase(); if (!DIGEST.test(digest)) throw fail(`${key}[${index}].digest must use sha256`);
    const signatureIdentity = item.signatureIdentity ? reference(item.signatureIdentity, `${key}[${index}].signatureIdentity`) : null;
    return { kind, name: reference(item.name, `${key}[${index}].name`), version: reference(item.version, `${key}[${index}].version`),
      digest, localRef: reference(item.localRef, `${key}[${index}].localRef`), byteSize: integer(item.byteSize ?? 0, `${key}[${index}].byteSize`, 0, 100 * 1024 ** 4),
      signatureIdentity, signatureVerified: item.signatureVerified === true, trustedSigner: !!signatureIdentity && roots.has(signatureIdentity) };
  }
  createBootstrapManifest(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'bootstrap'); const site = this._site(siteId); const roots = this._siteTrustRoots(site); const name = text(body.name, 'name', 160);
    const version = text(body.version, 'version', 100, SAFE_VERSION); if (!Array.isArray(body.artifacts) || !body.artifacts.length || body.artifacts.length > 200) throw fail('artifacts must contain 1-200 entries');
    const artifacts = body.artifacts.map((item, index) => this._artifact(item, index, ARTIFACT_KINDS, roots)); secretFree(artifacts); bounded(artifacts, 'artifacts');
    const expiresAt = timestamp(body.expiresAt, 'expiresAt', { future: true, maxFutureMs: 30 * 86400000 });
    const ready = artifacts.every(item => item.signatureVerified && item.trustedSigner); const normalized = { siteId: site.id, name, version, artifacts, expiresAt };
    const manifestHash = hash(normalized); const signature = this._sign('bootstrap-manifest', normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM edge_bootstrap_manifests WHERE manifest_hash=?').get(manifestHash);
    if (existing) return { ...this._bootstrapRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_bootstrap_manifests
      (site_id,name,version,artifacts_json,expires_at,manifest_hash,signature,state,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(site.id, name, version, stable(artifacts), expiresAt, manifestHash, signature, ready ? 'ready' : 'blocked', actor.id);
    return { ...this._bootstrapRow(db.prepare('SELECT * FROM edge_bootstrap_manifests WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _bootstrapRow(row) { return row && { id: row.id, siteId: row.site_id, name: row.name, version: row.version,
    artifacts: parse(row.artifacts_json, []), expiresAt: row.expires_at, manifestHash: row.manifest_hash, signature: row.signature,
    state: row.state, exportSupported: true, containsPrivateKeys: false, providerMutationsStarted: 0, createdAt: row.created_at }; }
  saveMirrorManifest(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'mirror'); const site = this._site(siteId); const roots = this._siteTrustRoots(site); const name = text(body.name, 'name', 160);
    const sourceMirrorRef = reference(body.sourceMirrorRef, 'sourceMirrorRef'); if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) throw fail('items must contain 1-500 entries');
    const items = body.items.map((item, index) => this._artifact(item, index, CONTENT_KINDS, roots, 'items')); secretFree(items); bounded(items, 'items', 2 * 1024 * 1024);
    const totalBytes = items.reduce((sum, item) => sum + item.byteSize, 0); if (totalBytes > 100 * 1024 ** 4) throw fail('mirror manifest exceeds 100 TiB');
    const ready = items.every(item => item.signatureVerified && item.trustedSigner); const normalized = { siteId: site.id, name, sourceMirrorRef, items, totalBytes };
    const manifestHash = hash(normalized); const signature = this._sign('mirror-manifest', normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM edge_content_mirror_manifests WHERE manifest_hash=?').get(manifestHash);
    if (existing) return { ...this._mirrorRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_content_mirror_manifests
      (site_id,name,source_mirror_ref,items_json,total_bytes,manifest_hash,signature,state,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(site.id, name, sourceMirrorRef, stable(items), totalBytes, manifestHash, signature, ready ? 'ready' : 'blocked', actor.id);
    return { ...this._mirrorRow(db.prepare('SELECT * FROM edge_content_mirror_manifests WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _mirrorRow(row) { return row && { id: row.id, siteId: row.site_id, name: row.name, sourceMirrorRef: row.source_mirror_ref,
    items: parse(row.items_json, []), totalBytes: row.total_bytes, manifestHash: row.manifest_hash, signature: row.signature,
    state: row.state, syncSupported: false, providerMutationsStarted: 0, createdAt: row.created_at }; }

  saveResidencyPolicy(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'residencyPolicy'); const site = this._site(siteId); const zone = reference(body.zone || site.jurisdiction, 'zone');
    const input = object(body.categoryRules); const categoryRules = {};
    for (const category of RESIDENCY_CATEGORIES) {
      const allowed = safeList(input[category], `categoryRules.${category}`, 20); if (!allowed.length) throw fail(`categoryRules.${category} is required`);
      categoryRules[category] = allowed;
    }
    const unknown = Object.keys(input).filter(key => !RESIDENCY_CATEGORIES.includes(key));
    if (unknown.length) throw fail('Unknown data-residency categories', 400, 'EDGE_RESIDENCY_CATEGORY', { unknown });
    const normalized = { siteId: site.id, zone, categoryRules, failClosed: true }; const policyHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO edge_data_residency_policies (site_id,zone,category_rules_json,fail_closed,policy_hash,updated_by)
      VALUES (?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET zone=excluded.zone,category_rules_json=excluded.category_rules_json,
      fail_closed=1,policy_hash=excluded.policy_hash,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(site.id, zone, stable(categoryRules), 1, policyHash, actor.id);
    return { siteId: site.id, zone, categoryRules, failClosed: true, policyHash };
  }
  evaluateResidency(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'residencyEvaluation'); const site = this._site(siteId); const db = this._db();
    const policy = db.prepare('SELECT * FROM edge_data_residency_policies WHERE site_id=?').get(site.id);
    if (!policy) throw fail('Data-residency policy is required', 409, 'EDGE_RESIDENCY_POLICY_REQUIRED');
    const dataCategory = String(body.dataCategory || ''); if (!RESIDENCY_CATEGORIES.includes(dataCategory)) throw fail('dataCategory is invalid');
    const destinationJurisdiction = reference(body.destinationJurisdiction, 'destinationJurisdiction');
    const allowedJurisdictions = parse(policy.category_rules_json, {})[dataCategory] || [];
    const allowed = allowedJurisdictions.some(rule => destinationJurisdiction === rule || destinationJurisdiction.startsWith(`${rule}/`));
    const reason = allowed ? `destination is inside the ${dataCategory} residency boundary` : `destination is outside the ${dataCategory} residency boundary`;
    const normalized = { siteId: site.id, dataCategory, destinationJurisdiction, decision: allowed ? 'allowed' : 'blocked',
      reason, policyHash: policy.policy_hash }; const evaluationHash = hash(normalized);
    let row = db.prepare('SELECT * FROM edge_residency_evaluations WHERE evaluation_hash=?').get(evaluationHash); let duplicate = true;
    if (!row) { const result = db.prepare(`INSERT INTO edge_residency_evaluations
      (site_id,data_category,destination_jurisdiction,decision,reason,policy_hash,evaluation_hash,evaluated_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(site.id, dataCategory, destinationJurisdiction, normalized.decision, reason, policy.policy_hash, evaluationHash, actor.id);
      row = db.prepare('SELECT * FROM edge_residency_evaluations WHERE id=?').get(result.lastInsertRowid); duplicate = false; }
    return { id: row.id, siteId: row.site_id, dataCategory: row.data_category, destinationJurisdiction: row.destination_jurisdiction,
      decision: row.decision, reason: row.reason, policyHash: row.policy_hash, evaluationHash: row.evaluation_hash,
      failClosed: true, duplicate, evaluatedAt: row.evaluated_at };
  }

  saveIdentityCachePolicy(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'identityPolicy'); const site = this._site(siteId); const issuerRef = reference(body.issuerRef, 'issuerRef');
    const normalTtlSeconds = integer(body.normalTtlSeconds ?? 600, 'normalTtlSeconds', 60, 900);
    const emergencyTtlSeconds = integer(body.emergencyTtlSeconds ?? 300, 'emergencyTtlSeconds', 60, 300);
    const normalScopes = safeList(body.normalScopes || [], 'normalScopes', 5, IDENTITY_SCOPES);
    const emergencyScopes = safeList(body.emergencyScopes || [], 'emergencyScopes', 5, IDENTITY_SCOPES);
    if (!normalScopes.length || !emergencyScopes.length) throw fail('normalScopes and emergencyScopes are required');
    const normalized = { siteId: site.id, issuerRef, normalTtlSeconds, emergencyTtlSeconds, normalScopes, emergencyScopes,
      requireFourEyesEmergency: true }; const policyHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO edge_identity_cache_policies
      (site_id,issuer_ref,normal_ttl_seconds,emergency_ttl_seconds,normal_scopes_json,emergency_scopes_json,require_four_eyes_emergency,policy_hash,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET issuer_ref=excluded.issuer_ref,normal_ttl_seconds=excluded.normal_ttl_seconds,
      emergency_ttl_seconds=excluded.emergency_ttl_seconds,normal_scopes_json=excluded.normal_scopes_json,
      emergency_scopes_json=excluded.emergency_scopes_json,require_four_eyes_emergency=1,policy_hash=excluded.policy_hash,
      updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(site.id, issuerRef, normalTtlSeconds, emergencyTtlSeconds, stable(normalScopes), stable(emergencyScopes), 1, policyHash, actor.id);
    return { ...normalized, policyHash, storesBearerTokens: false, storesPasswords: false };
  }
  issueIdentityGrant(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'identityGrant'); const site = this._site(siteId); const db = this._db();
    const policy = db.prepare('SELECT * FROM edge_identity_cache_policies WHERE site_id=?').get(site.id);
    if (!policy) throw fail('Disconnected identity policy is required', 409, 'EDGE_IDENTITY_POLICY_REQUIRED');
    const mode = body.mode || 'normal'; if (!['normal','emergency'].includes(mode)) throw fail('mode must be normal or emergency');
    const subjectRef = reference(body.subjectRef, 'subjectRef'); const assertionHash = String(body.assertionHash || '').toLowerCase();
    if (!DIGEST.test(assertionHash)) throw fail('assertionHash must use sha256'); const allowed = new Set(parse(mode === 'emergency' ? policy.emergency_scopes_json : policy.normal_scopes_json, []));
    const scopes = safeList(body.scopes || [], 'scopes', 5, allowed); if (!scopes.length) throw fail('scopes is required');
    const ttl = integer(body.ttlSeconds ?? (mode === 'emergency' ? policy.emergency_ttl_seconds : policy.normal_ttl_seconds),
      'ttlSeconds', 60, mode === 'emergency' ? policy.emergency_ttl_seconds : policy.normal_ttl_seconds);
    const reason = mode === 'emergency' ? text(body.reason, 'reason', 600) : String(body.reason || '').trim().slice(0, 600) || null;
    const ticketRef = mode === 'emergency' ? reference(body.ticketRef, 'ticketRef') : body.ticketRef ? reference(body.ticketRef, 'ticketRef') : null;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString(); const normalized = { siteId: site.id, subjectRef, assertionHash,
      scopes, mode, reason, ticketRef, expiresAt }; const grantHash = hash(normalized); const signature = this._sign('identity-grant', normalized);
    const existing = db.prepare('SELECT * FROM edge_identity_grants WHERE grant_hash=?').get(grantHash);
    if (existing) return { ...this._identityGrantRow(existing), duplicate: true };
    const result = db.prepare(`INSERT INTO edge_identity_grants
      (site_id,subject_ref,assertion_hash,scopes_json,mode,reason,ticket_ref,expires_at,grant_hash,signature,state,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(site.id, subjectRef, assertionHash, stable(scopes), mode, reason, ticketRef,
        expiresAt, grantHash, signature, 'pending_activation', actor.id);
    return { ...this._identityGrantRow(db.prepare('SELECT * FROM edge_identity_grants WHERE id=?').get(result.lastInsertRowid)), duplicate: false };
  }
  activateIdentityGrant(id, body = {}, actor) {
    this._admin(actor); secretFree(body, 'identityActivation'); const db = this._db(); const row = db.prepare('SELECT * FROM edge_identity_grants WHERE id=?').get(integer(id, 'grantId', 1));
    if (!row) throw fail('Identity grant not found', 404, 'EDGE_IDENTITY_GRANT_NOT_FOUND');
    if (Date.parse(row.expires_at) <= Date.now()) { db.prepare("UPDATE edge_identity_grants SET state='expired' WHERE id=?").run(row.id); throw fail('Identity grant expired', 409, 'EDGE_IDENTITY_GRANT_EXPIRED'); }
    if (row.state !== 'pending_activation') throw fail('Identity grant is not pending activation', 409, 'EDGE_IDENTITY_GRANT_CLOSED');
    if (row.created_by === actor.id) throw fail('Four-eyes activation by another administrator is required', 409, 'FOUR_EYES_REQUIRED');
    if (body.grantHash !== row.grant_hash || body.confirmation !== row.subject_ref) throw fail('Grant hash or typed subject confirmation does not match', 409, 'EDGE_IDENTITY_CONFIRMATION_MISMATCH');
    db.prepare("UPDATE edge_identity_grants SET state='active',activated_by=?,activated_at=datetime('now') WHERE id=?").run(actor.id, row.id);
    return this._identityGrantRow(db.prepare('SELECT * FROM edge_identity_grants WHERE id=?').get(row.id));
  }
  _identityGrantRow(row) { return row && { id: row.id, siteId: row.site_id, subjectRef: row.subject_ref,
    assertionHash: row.assertion_hash, scopes: parse(row.scopes_json, []), mode: row.mode, reason: row.reason, ticketRef: row.ticket_ref,
    expiresAt: row.expires_at, grantHash: row.grant_hash, signature: row.signature,
    state: Date.parse(row.expires_at) <= Date.now() && ['pending_activation','active'].includes(row.state) ? 'expired' : row.state,
    activatedBy: row.activated_by, tokenReturnedByApi: false, passwordStored: false, createdAt: row.created_at, activatedAt: row.activated_at }; }

  saveVaultAdapter(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'vaultAdapter'); const site = this._site(siteId); const providerKind = String(body.providerKind || '');
    if (!VAULT_KINDS.has(providerKind)) throw fail('providerKind is invalid'); const authMethod = String(body.authMethod || '');
    if (!VAULT_AUTH.has(authMethod)) throw fail('authMethod is invalid'); const certificateFingerprint = body.certificateFingerprint ? String(body.certificateFingerprint).toLowerCase() : null;
    if (certificateFingerprint && !FINGERPRINT.test(certificateFingerprint)) throw fail('certificateFingerprint must use sha256');
    const allowedPurposes = safeList(body.allowedPurposes || [], 'allowedPurposes', 30); if (!allowedPurposes.length) throw fail('allowedPurposes is required');
    const normalized = { siteId: site.id, name: text(body.name, 'name', 120), providerKind,
      endpointRef: reference(body.endpointRef, 'endpointRef'), namespaceRef: body.namespaceRef ? reference(body.namespaceRef, 'namespaceRef') : null,
      authMethod, certificateFingerprint, allowedPurposes, state: ['active','held','retired'].includes(body.state) ? body.state : 'active' };
    const configHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO edge_vault_adapters
      (site_id,name,provider_kind,endpoint_ref,namespace_ref,auth_method,certificate_fingerprint,allowed_purposes_json,state,config_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id,name) DO UPDATE SET provider_kind=excluded.provider_kind,endpoint_ref=excluded.endpoint_ref,
      namespace_ref=excluded.namespace_ref,auth_method=excluded.auth_method,certificate_fingerprint=excluded.certificate_fingerprint,
      allowed_purposes_json=excluded.allowed_purposes_json,state=excluded.state,config_hash=excluded.config_hash,updated_at=datetime('now')`)
      .run(site.id, normalized.name, providerKind, normalized.endpointRef, normalized.namespaceRef, authMethod, certificateFingerprint,
        stable(allowedPurposes), normalized.state, configHash, actor.id);
    return this._vaultRow(db.prepare('SELECT * FROM edge_vault_adapters WHERE site_id=? AND name=?').get(site.id, normalized.name));
  }
  _vaultRow(row) { return row && { id: row.id, siteId: row.site_id, name: row.name, providerKind: row.provider_kind,
    endpointRef: row.endpoint_ref, namespaceRef: row.namespace_ref, authMethod: row.auth_method,
    certificateFingerprint: row.certificate_fingerprint, allowedPurposes: parse(row.allowed_purposes_json, []), state: row.state,
    configHash: row.config_hash, credentialsStoredCentrally: false, createdAt: row.created_at }; }
  createSecretResolutionPlan(adapterId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'secretResolution'); const db = this._db(); const adapter = db.prepare('SELECT * FROM edge_vault_adapters WHERE id=?').get(integer(adapterId, 'adapterId', 1));
    if (!adapter || adapter.state !== 'active') throw fail('Active site-local vault adapter not found', 409, 'EDGE_VAULT_NOT_ACTIVE'); this._ensureSiteMutable(adapter.site_id);
    const agent = db.prepare("SELECT * FROM edge_agents WHERE id=? AND site_id=? AND state='active'").get(integer(body.agentRecordId, 'agentRecordId', 1), adapter.site_id);
    if (!agent) throw fail('Active agent at the same site is required', 409, 'EDGE_AGENT_NOT_ACTIVE'); const purpose = reference(body.purpose, 'purpose');
    if (!parse(adapter.allowed_purposes_json, []).includes(purpose)) throw fail('purpose is not allowlisted', 403, 'EDGE_SECRET_PURPOSE_DENIED');
    const secretRef = reference(body.secretRef, 'secretRef'); const expiresAt = timestamp(body.expiresAt, 'expiresAt', { future: true, maxFutureMs: 300000 });
    const normalized = { adapterId: adapter.id, agentRecordId: agent.id, agentId: agent.agent_id, secretRef, purpose, expiresAt,
      resolutionLocation: 'edge_agent' }; const planHash = hash(normalized); const signature = this._sign('secret-resolution', normalized);
    const existing = db.prepare('SELECT * FROM edge_secret_resolution_plans WHERE plan_hash=?').get(planHash);
    if (existing) return { ...this._secretPlanRow(existing), duplicate: true };
    const result = db.prepare(`INSERT INTO edge_secret_resolution_plans
      (adapter_id,agent_id,secret_ref,purpose,expires_at,plan_hash,signature,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(adapter.id, agent.id, secretRef, purpose, expiresAt, planHash, signature, actor.id);
    return { ...this._secretPlanRow(db.prepare('SELECT * FROM edge_secret_resolution_plans WHERE id=?').get(result.lastInsertRowid)), duplicate: false };
  }
  _secretPlanRow(row) { return row && { id: row.id, adapterId: row.adapter_id, agentRecordId: row.agent_id,
    secretRef: row.secret_ref, purpose: row.purpose, expiresAt: row.expires_at, planHash: row.plan_hash, signature: row.signature,
    state: Date.parse(row.expires_at) <= Date.now() && row.state === 'issued' ? 'expired' : row.state,
    resolutionLocation: 'edge_agent', secretReturnedByApi: false, providerMutationsStarted: 0, createdAt: row.created_at }; }

  saveSingleNodeProfile(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'singleNodeProfile'); const site = this._site(siteId); const normalized = { siteId: site.id,
      minimumCpuMillicores: integer(body.minimumCpuMillicores ?? 1000, 'minimumCpuMillicores', 250, 128000),
      minimumMemoryMiB: integer(body.minimumMemoryMiB ?? 2048, 'minimumMemoryMiB', 512, 1048576),
      minimumStorageGiB: integer(body.minimumStorageGiB ?? 20, 'minimumStorageGiB', 5, 1048576),
      requireExternalBackup: true, requireMaintenanceWindow: true, automaticUpgrade: false };
    const profileHash = hash(normalized); const db = this._db(); db.prepare(`INSERT INTO edge_single_node_profiles
      (site_id,minimum_cpu_millicores,minimum_memory_mib,minimum_storage_gib,require_external_backup,require_maintenance_window,automatic_upgrade,profile_hash,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET minimum_cpu_millicores=excluded.minimum_cpu_millicores,
      minimum_memory_mib=excluded.minimum_memory_mib,minimum_storage_gib=excluded.minimum_storage_gib,require_external_backup=1,
      require_maintenance_window=1,automatic_upgrade=0,profile_hash=excluded.profile_hash,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(site.id, normalized.minimumCpuMillicores, normalized.minimumMemoryMiB, normalized.minimumStorageGiB, 1, 1, 0, profileHash, actor.id);
    return { ...normalized, profileHash, haAvailable: false };
  }
  assessSingleNode(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'singleNodeAssessment'); const site = this._site(siteId); const db = this._db();
    const profile = db.prepare('SELECT * FROM edge_single_node_profiles WHERE site_id=?').get(site.id);
    if (!profile) throw fail('Single-node profile is required', 409, 'EDGE_SINGLE_NODE_PROFILE_REQUIRED');
    const observed = { nodeCount: integer(body.nodeCount, 'nodeCount', 1, 1000), cpuMillicores: integer(body.cpuMillicores, 'cpuMillicores', 1),
      memoryMiB: integer(body.memoryMiB, 'memoryMiB', 1), storageGiB: integer(body.storageGiB, 'storageGiB', 1),
      externalBackupVerified: body.externalBackupVerified === true, maintenanceWindowDeclared: body.maintenanceWindowDeclared === true };
    const checks = { exactlyOneNode: observed.nodeCount === 1, cpuReserveAvailable: observed.cpuMillicores >= profile.minimum_cpu_millicores,
      memoryReserveAvailable: observed.memoryMiB >= profile.minimum_memory_mib, storageReserveAvailable: observed.storageGiB >= profile.minimum_storage_gib,
      externalBackupVerified: observed.externalBackupVerified, maintenanceWindowDeclared: observed.maintenanceWindowDeclared };
    const state = Object.values(checks).every(Boolean) ? 'ready' : 'blocked'; const assessmentHash = hash({ siteId: site.id, observed, checks, profileHash: profile.profile_hash });
    let row = db.prepare('SELECT * FROM edge_single_node_assessments WHERE assessment_hash=?').get(assessmentHash);
    if (!row) { const saved = db.prepare(`INSERT INTO edge_single_node_assessments
      (site_id,observed_json,checks_json,state,assessment_hash,assessed_by) VALUES (?,?,?,?,?,?)`)
      .run(site.id, stable(observed), stable(checks), state, assessmentHash, actor.id); row = db.prepare('SELECT * FROM edge_single_node_assessments WHERE id=?').get(saved.lastInsertRowid); }
    return { id: row.id, siteId: row.site_id, observed: parse(row.observed_json, {}), checks: parse(row.checks_json, {}),
      state: row.state, assessmentHash: row.assessment_hash, haAvailable: false, applySupported: false, assessedAt: row.assessed_at };
  }

  recordQuorumSnapshot(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'quorumSnapshot'); const site = this._site(siteId); if (!Array.isArray(body.members) || !body.members.length || body.members.length > 31) throw fail('members must contain 1-31 entries');
    const members = body.members.map((item, index) => { const role = item?.role || 'voter'; if (!['voter','witness','learner'].includes(role)) throw fail(`members[${index}].role is invalid`);
      return { memberRef: reference(item.memberRef, `members[${index}].memberRef`), role, healthy: item.healthy === true,
        failureDomain: reference(item.failureDomain, `members[${index}].failureDomain`) }; });
    if (new Set(members.map(item => item.memberRef)).size !== members.length) throw fail('memberRef must be unique');
    const voters = members.filter(item => item.role !== 'learner'); const requiredVotes = Math.floor(voters.length / 2) + 1;
    const availableVotes = voters.filter(item => item.healthy).length; const domains = new Set(voters.map(item => item.failureDomain)); const risks = [];
    if (voters.length < 3) risks.push('fewer_than_three_votes'); if (domains.size < 2) risks.push('single_failure_domain');
    if (availableVotes === requiredVotes) risks.push('no_vote_margin'); const state = availableVotes < requiredVotes ? 'lost' : risks.length ? 'at_risk' : 'healthy';
    const observedAt = timestamp(body.observedAt, 'observedAt', { maxFutureMs: 300000, maxPastMs: 86400000 }); const clusterRef = reference(body.clusterRef, 'clusterRef');
    const evidenceHash = hash({ siteId: site.id, clusterRef, members, requiredVotes, availableVotes, risks, observedAt }); const db = this._db();
    const existing = db.prepare('SELECT * FROM edge_quorum_snapshots WHERE evidence_hash=?').get(evidenceHash);
    if (existing) return { ...this._quorumRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_quorum_snapshots
      (site_id,cluster_ref,members_json,required_votes,available_votes,risks_json,state,evidence_hash,observed_by,observed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(site.id, clusterRef, stable(members), requiredVotes, availableVotes, stable(risks), state, evidenceHash, actor.id, observedAt);
    return { ...this._quorumRow(db.prepare('SELECT * FROM edge_quorum_snapshots WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _quorumRow(row) { return row && { id: row.id, siteId: row.site_id, clusterRef: row.cluster_ref,
    members: parse(row.members_json, []), requiredVotes: row.required_votes, availableVotes: row.available_votes,
    risks: parse(row.risks_json, []), state: row.state, evidenceHash: row.evidence_hash, observedAt: row.observed_at,
    readOnlyEvidence: true, providerMutationsStarted: 0 }; }

  saveReservationPolicy(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'reservationPolicy'); const site = this._site(siteId); const normalized = { siteId: site.id,
      systemCpuMillicores: integer(body.systemCpuMillicores ?? 500, 'systemCpuMillicores', 100, 128000),
      systemMemoryMiB: integer(body.systemMemoryMiB ?? 1024, 'systemMemoryMiB', 256, 1048576),
      systemStorageGiB: integer(body.systemStorageGiB ?? 10, 'systemStorageGiB', 1, 1048576),
      maxWorkloadPercent: integer(body.maxWorkloadPercent ?? 75, 'maxWorkloadPercent', 10, 90),
      evictionFreeStoragePercent: integer(body.evictionFreeStoragePercent ?? 15, 'evictionFreeStoragePercent', 5, 50) };
    const policyHash = hash(normalized); const db = this._db(); db.prepare(`INSERT INTO edge_resource_reservation_policies
      (site_id,system_cpu_millicores,system_memory_mib,system_storage_gib,max_workload_percent,eviction_free_storage_percent,policy_hash,updated_by)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET system_cpu_millicores=excluded.system_cpu_millicores,
      system_memory_mib=excluded.system_memory_mib,system_storage_gib=excluded.system_storage_gib,max_workload_percent=excluded.max_workload_percent,
      eviction_free_storage_percent=excluded.eviction_free_storage_percent,policy_hash=excluded.policy_hash,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(site.id, normalized.systemCpuMillicores, normalized.systemMemoryMiB, normalized.systemStorageGiB,
        normalized.maxWorkloadPercent, normalized.evictionFreeStoragePercent, policyHash, actor.id);
    return { ...normalized, policyHash };
  }
  assessReservations(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'reservationAssessment'); const site = this._site(siteId); const db = this._db();
    const policy = db.prepare('SELECT * FROM edge_resource_reservation_policies WHERE site_id=?').get(site.id);
    if (!policy) throw fail('Resource reservation policy is required', 409, 'EDGE_RESERVATION_POLICY_REQUIRED');
    const capacity = { cpuMillicores: integer(body.capacity?.cpuMillicores, 'capacity.cpuMillicores', 1),
      memoryMiB: integer(body.capacity?.memoryMiB, 'capacity.memoryMiB', 1), storageGiB: integer(body.capacity?.storageGiB, 'capacity.storageGiB', 1) };
    const workload = { cpuMillicores: integer(body.workload?.cpuMillicores ?? 0, 'workload.cpuMillicores', 0),
      memoryMiB: integer(body.workload?.memoryMiB ?? 0, 'workload.memoryMiB', 0), storageGiB: integer(body.workload?.storageGiB ?? 0, 'workload.storageGiB', 0) };
    const headroom = { cpuMillicores: capacity.cpuMillicores - workload.cpuMillicores,
      memoryMiB: capacity.memoryMiB - workload.memoryMiB, storageGiB: capacity.storageGiB - workload.storageGiB,
      workloadPercent: Math.max(workload.cpuMillicores / capacity.cpuMillicores, workload.memoryMiB / capacity.memoryMiB) * 100,
      freeStoragePercent: (capacity.storageGiB - workload.storageGiB) / capacity.storageGiB * 100 };
    const checks = { systemCpuProtected: headroom.cpuMillicores >= policy.system_cpu_millicores,
      systemMemoryProtected: headroom.memoryMiB >= policy.system_memory_mib, systemStorageProtected: headroom.storageGiB >= policy.system_storage_gib,
      workloadBelowLimit: headroom.workloadPercent <= policy.max_workload_percent,
      evictionHeadroom: headroom.freeStoragePercent >= policy.eviction_free_storage_percent };
    const state = Object.values(checks).every(Boolean) ? 'compliant' : 'blocked'; const assessmentHash = hash({ siteId: site.id, capacity, workload, headroom, checks, policyHash: policy.policy_hash });
    let row = db.prepare('SELECT * FROM edge_resource_reservation_assessments WHERE assessment_hash=?').get(assessmentHash);
    if (!row) { const saved = db.prepare(`INSERT INTO edge_resource_reservation_assessments
      (site_id,capacity_json,workload_json,headroom_json,checks_json,state,assessment_hash,assessed_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(site.id, stable(capacity), stable(workload), stable(headroom), stable(checks), state, assessmentHash, actor.id);
      row = db.prepare('SELECT * FROM edge_resource_reservation_assessments WHERE id=?').get(saved.lastInsertRowid); }
    return { id: row.id, siteId: row.site_id, capacity: parse(row.capacity_json, {}), workload: parse(row.workload_json, {}),
      headroom: parse(row.headroom_json, {}), checks: parse(row.checks_json, {}), state: row.state,
      assessmentHash: row.assessment_hash, applySupported: false, assessedAt: row.assessed_at };
  }

  saveConsoleProfile(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'consoleProfile'); const site = this._site(siteId);
    const transportOrder = safeList(body.transportOrder || ['serial','text','html5'], 'transportOrder', 3, CONSOLE_TRANSPORTS);
    if (!transportOrder.length) throw fail('transportOrder is required'); const normalized = { siteId: site.id, transportOrder,
      maxBandwidthKbps: integer(body.maxBandwidthKbps ?? 256, 'maxBandwidthKbps', 8, 10000), maxFps: integer(body.maxFps ?? 5, 'maxFps', 1, 30),
      colorDepth: integer(body.colorDepth ?? 8, 'colorDepth', 8, 24), adaptiveQuality: body.adaptiveQuality !== false,
      clipboardEnabled: false, fileTransferEnabled: false, idleTtlSeconds: integer(body.idleTtlSeconds ?? 600, 'idleTtlSeconds', 60, 3600) };
    if (![8,16,24].includes(normalized.colorDepth)) throw fail('colorDepth must be 8, 16 or 24'); const profileHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO edge_console_profiles
      (site_id,transport_order_json,max_bandwidth_kbps,max_fps,color_depth,adaptive_quality,clipboard_enabled,file_transfer_enabled,idle_ttl_seconds,profile_hash,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET transport_order_json=excluded.transport_order_json,
      max_bandwidth_kbps=excluded.max_bandwidth_kbps,max_fps=excluded.max_fps,color_depth=excluded.color_depth,adaptive_quality=excluded.adaptive_quality,
      clipboard_enabled=0,file_transfer_enabled=0,idle_ttl_seconds=excluded.idle_ttl_seconds,profile_hash=excluded.profile_hash,
      updated_by=excluded.updated_by,updated_at=datetime('now')`).run(site.id, stable(transportOrder), normalized.maxBandwidthKbps,
        normalized.maxFps, normalized.colorDepth, normalized.adaptiveQuality ? 1 : 0, 0, 0, normalized.idleTtlSeconds, profileHash, actor.id);
    return { ...normalized, profileHash, launchSupported: false, sessionTokenReturned: false };
  }

  saveBmcEndpoint(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'bmcEndpoint'); const site = this._site(siteId); const db = this._db();
    const hostId = integer(body.hostId, 'hostId', 1); if (!db.prepare('SELECT 1 FROM edge_site_hosts WHERE site_id=? AND host_id=?').get(site.id, hostId)) throw fail('Host is not assigned to this site', 409, 'EDGE_BMC_HOST_SITE_MISMATCH');
    const vaultAdapterId = integer(body.vaultAdapterId, 'vaultAdapterId', 1); if (!db.prepare("SELECT 1 FROM edge_vault_adapters WHERE id=? AND site_id=? AND state='active'").get(vaultAdapterId, site.id)) throw fail('Active site-local vault adapter is required', 409, 'EDGE_VAULT_NOT_ACTIVE');
    const protocol = body.protocol; if (!['redfish','ipmi'].includes(protocol)) throw fail('protocol must be redfish or ipmi');
    const certificateFingerprint = body.certificateFingerprint ? String(body.certificateFingerprint).toLowerCase() : null;
    if (certificateFingerprint && !FINGERPRINT.test(certificateFingerprint)) throw fail('certificateFingerprint must use sha256');
    const normalized = { siteId: site.id, hostId, name: text(body.name, 'name', 120), protocol,
      endpointRef: reference(body.endpointRef, 'endpointRef'), vaultAdapterId, credentialRef: reference(body.credentialRef, 'credentialRef'),
      certificateFingerprint, owner: text(body.owner, 'owner', 160), state: ['active','held','retired'].includes(body.state) ? body.state : 'active' };
    const configHash = hash(normalized); db.prepare(`INSERT INTO edge_bmc_endpoints
      (site_id,host_id,name,protocol,endpoint_ref,vault_adapter_id,credential_ref,certificate_fingerprint,owner,state,config_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id,host_id) DO UPDATE SET name=excluded.name,protocol=excluded.protocol,
      endpoint_ref=excluded.endpoint_ref,vault_adapter_id=excluded.vault_adapter_id,credential_ref=excluded.credential_ref,
      certificate_fingerprint=excluded.certificate_fingerprint,owner=excluded.owner,state=excluded.state,config_hash=excluded.config_hash,updated_at=datetime('now')`)
      .run(site.id, hostId, normalized.name, protocol, normalized.endpointRef, vaultAdapterId, normalized.credentialRef,
        certificateFingerprint, normalized.owner, normalized.state, configHash, actor.id);
    return this._bmcRow(db.prepare('SELECT * FROM edge_bmc_endpoints WHERE site_id=? AND host_id=?').get(site.id, hostId));
  }
  _bmcRow(row) { return row && { id: row.id, siteId: row.site_id, hostId: row.host_id, name: row.name, protocol: row.protocol,
    endpointRef: row.endpoint_ref, vaultAdapterId: row.vault_adapter_id, credentialRef: row.credential_ref,
    certificateFingerprint: row.certificate_fingerprint, owner: row.owner, state: row.state, configHash: row.config_hash,
    credentialsStoredCentrally: false, createdAt: row.created_at }; }
  recordBmcInventory(endpointId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'bmcInventory'); const db = this._db(); const endpoint = db.prepare('SELECT * FROM edge_bmc_endpoints WHERE id=?').get(integer(endpointId, 'endpointId', 1));
    if (!endpoint || endpoint.state !== 'active') throw fail('Active BMC endpoint not found', 409, 'EDGE_BMC_NOT_ACTIVE'); const powerState = body.powerState || 'unknown';
    if (!['on','off','unknown'].includes(powerState)) throw fail('powerState is invalid'); const health = body.health || 'unknown';
    if (!['ok','warning','critical','unknown'].includes(health)) throw fail('health is invalid'); const firmware = object(body.firmware); const sensors = object(body.sensors);
    secretFree({ firmware, sensors }); bounded(firmware, 'firmware', 128 * 1024); bounded(sensors, 'sensors', 128 * 1024);
    const observedAt = timestamp(body.observedAt, 'observedAt', { maxFutureMs: 300000, maxPastMs: 7 * 86400000 });
    const normalized = { endpointId: endpoint.id, powerState, manufacturer: String(body.manufacturer || '').trim().slice(0, 160) || null,
      model: String(body.model || '').trim().slice(0, 160) || null, serialNumber: String(body.serialNumber || '').trim().slice(0, 160) || null,
      firmware, sensors, health, observedAt }; const evidenceHash = hash(normalized); const existing = db.prepare('SELECT * FROM edge_bmc_inventory_snapshots WHERE evidence_hash=?').get(evidenceHash);
    if (existing) return { ...this._bmcInventoryRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_bmc_inventory_snapshots
      (bmc_endpoint_id,power_state,manufacturer,model,serial_number,firmware_json,sensors_json,health,evidence_hash,observed_at,received_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(endpoint.id, powerState, normalized.manufacturer, normalized.model, normalized.serialNumber,
        stable(firmware), stable(sensors), health, evidenceHash, observedAt, actor.id);
    return { ...this._bmcInventoryRow(db.prepare('SELECT * FROM edge_bmc_inventory_snapshots WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _bmcInventoryRow(row) { return row && { id: row.id, endpointId: row.bmc_endpoint_id, powerState: row.power_state,
    manufacturer: row.manufacturer, model: row.model, serialNumber: row.serial_number, firmware: parse(row.firmware_json, {}),
    sensors: parse(row.sensors_json, {}), health: row.health, evidenceHash: row.evidence_hash, observedAt: row.observed_at,
    collectionLocation: 'edge_agent', credentialsReturned: false }; }

  _approvalPayload(planHash, targetRef, expiresAt) { return { planHash, targetRef, expiresAt }; }
  _approvedPlan(row, actionKey, targetRef, body, actor) {
    const approval = this._db().prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(integer(body.approvalId, 'approvalId', 1));
    const expectedHash = hash(this._approvalPayload(row.plan_hash, targetRef, row.expires_at));
    if (!approval || approval.id !== row.approval_id || approval.state !== 'approved' || approval.action_key !== actionKey
      || approval.payload_hash !== expectedHash) throw fail('A matching approved plan is required', 409, 'APPROVAL_REQUIRED');
    if (Date.parse(approval.due_at) <= Date.now() || Date.parse(row.expires_at) <= Date.now()) throw fail('Approval or plan expired', 409, 'APPROVAL_EXPIRED');
    if (!approval.decided_by || approval.decided_by === row.requested_by || approval.decided_by !== actor.id) throw fail('Four-eyes approval by this administrator is required', 409, 'FOUR_EYES_REQUIRED');
  }
  createRemoteHandsPlan(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'remoteHands'); const site = this._site(siteId); this._ensureSiteMutable(site.id); const db = this._db(); const targetRef = reference(body.targetRef, 'targetRef');
    const checklist = safeList(body.checklist || [], 'checklist', 30); if (!checklist.length) throw fail('checklist is required');
    const bmcEndpointId = body.bmcEndpointId == null ? null : integer(body.bmcEndpointId, 'bmcEndpointId', 1);
    if (bmcEndpointId && !db.prepare('SELECT 1 FROM edge_bmc_endpoints WHERE id=? AND site_id=?').get(bmcEndpointId, site.id)) throw fail('BMC endpoint is not at this site', 409, 'EDGE_BMC_SITE_MISMATCH');
    const consoleRef = body.consoleRef ? reference(body.consoleRef, 'consoleRef') : null;
    const expiresAt = timestamp(body.expiresAt, 'expiresAt', { future: true, maxFutureMs: 86400000 });
    const normalized = { siteId: site.id, targetRef, bmcEndpointId, checklist, consoleRef, expiresAt }; const planHash = hash(normalized); const signature = this._sign('remote-hands', normalized);
    const existing = db.prepare('SELECT * FROM edge_remote_hands_plans WHERE plan_hash=?').get(planHash); if (existing) return { ...this._remoteHandsRow(existing), duplicate: true };
    let result; db.transaction(() => { const approval = this._approvals.createApproval({ actionKey: 'edge.remote_hands.authorize', targetType: 'edge_remote_hands',
      targetId: `${site.id}:${planHash.slice(0, 12)}`, payload: this._approvalPayload(planHash, targetRef, expiresAt), dueMinutes: body.dueMinutes || 60,
      assigneeUserId: body.assigneeUserId, escalationUserId: body.escalationUserId, escalationGraceMinutes: body.escalationGraceMinutes || 30 }, actor);
      result = db.prepare(`INSERT INTO edge_remote_hands_plans
        (site_id,target_ref,bmc_endpoint_id,checklist_json,console_ref,expires_at,plan_hash,signature,approval_id,state,requested_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(site.id, targetRef, bmcEndpointId, stable(checklist), consoleRef, expiresAt, planHash, signature,
          approval.id, 'pending_approval', actor.id); })();
    return { ...this._remoteHandsRow(db.prepare('SELECT * FROM edge_remote_hands_plans WHERE id=?').get(result.lastInsertRowid)), duplicate: false };
  }
  authorizeRemoteHands(id, body = {}, actor) {
    this._admin(actor); secretFree(body, 'remoteHandsAuthorization'); const db = this._db(); const row = db.prepare('SELECT * FROM edge_remote_hands_plans WHERE id=?').get(integer(id, 'planId', 1));
    if (!row) throw fail('Remote-hands plan not found', 404, 'EDGE_REMOTE_HANDS_NOT_FOUND'); this._ensureSiteMutable(row.site_id); if (row.state !== 'pending_approval') throw fail('Remote-hands plan is not pending approval', 409, 'EDGE_REMOTE_HANDS_CLOSED');
    if (body.confirmation !== row.target_ref) throw fail('Typed confirmation must exactly match targetRef', 409, 'CONFIRMATION_MISMATCH');
    this._approvedPlan(row, 'edge.remote_hands.authorize', row.target_ref, body, actor);
    db.prepare("UPDATE edge_remote_hands_plans SET state='ready_for_local_operator',authorized_by=?,authorized_at=datetime('now') WHERE id=?").run(actor.id, row.id);
    return this._remoteHandsRow(db.prepare('SELECT * FROM edge_remote_hands_plans WHERE id=?').get(row.id));
  }
  _remoteHandsRow(row) { return row && { id: row.id, siteId: row.site_id, targetRef: row.target_ref,
    bmcEndpointId: row.bmc_endpoint_id, checklist: parse(row.checklist_json, []), consoleRef: row.console_ref, expiresAt: row.expires_at,
    planHash: row.plan_hash, signature: row.signature, approvalId: row.approval_id,
    state: Date.parse(row.expires_at) <= Date.now() && ['pending_approval','ready_for_local_operator'].includes(row.state) ? 'expired' : row.state,
    requestedBy: row.requested_by, authorizedBy: row.authorized_by, executionLocation: 'local_operator',
    centralExecutionSupported: false, providerMutationsStarted: 0, createdAt: row.created_at }; }

  createBmcRecoveryPlan(endpointId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'bmcRecovery'); const db = this._db(); const endpoint = db.prepare('SELECT * FROM edge_bmc_endpoints WHERE id=?').get(integer(endpointId, 'endpointId', 1));
    if (!endpoint || endpoint.state !== 'active') throw fail('Active BMC endpoint not found', 409, 'EDGE_BMC_NOT_ACTIVE'); this._ensureSiteMutable(endpoint.site_id); const actionKey = String(body.actionKey || '');
    if (!BMC_ACTIONS.has(actionKey)) throw fail('actionKey is invalid'); const safeguards = { targetIdentityMatched: body.safeguards?.targetIdentityMatched === true,
      fencingVerified: body.safeguards?.fencingVerified === true, quorumSafe: body.safeguards?.quorumSafe === true,
      workloadsEvacuated: body.safeguards?.workloadsEvacuated === true, recentBackupVerified: body.safeguards?.recentBackupVerified === true };
    const required = actionKey === 'power_on' || actionKey === 'boot_once' ? ['targetIdentityMatched','fencingVerified','quorumSafe'] : Object.keys(safeguards);
    const missing = required.filter(key => !safeguards[key]); const reason = text(body.reason, 'reason', 600); const ticketRef = reference(body.ticketRef, 'ticketRef');
    const expiresAt = timestamp(body.expiresAt, 'expiresAt', { future: true, maxFutureMs: 900000 }); const normalized = { endpointId: endpoint.id,
      targetRef: endpoint.endpoint_ref, actionKey, safeguards, reason, ticketRef, expiresAt }; const planHash = hash(normalized); const signature = this._sign('bmc-recovery', normalized);
    const existing = db.prepare('SELECT * FROM edge_bmc_recovery_plans WHERE plan_hash=?').get(planHash); if (existing) return { ...this._bmcRecoveryRow(existing), duplicate: true };
    let approvalId = null; let state = 'blocked'; if (!missing.length) { const approval = this._approvals.createApproval({ actionKey: `edge.bmc.${actionKey}`,
      targetType: 'edge_bmc_recovery', targetId: `${endpoint.id}:${planHash.slice(0, 12)}`, payload: this._approvalPayload(planHash, endpoint.endpoint_ref, expiresAt),
      dueMinutes: Math.min(body.dueMinutes || 15, 15), assigneeUserId: body.assigneeUserId, escalationUserId: body.escalationUserId,
      escalationGraceMinutes: body.escalationGraceMinutes || 15 }, actor); approvalId = approval.id; state = 'pending_approval'; }
    const result = db.prepare(`INSERT INTO edge_bmc_recovery_plans
      (bmc_endpoint_id,action_key,safeguards_json,reason,ticket_ref,expires_at,plan_hash,signature,approval_id,state,requested_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(endpoint.id, actionKey, stable({ ...safeguards, missing }), reason, ticketRef, expiresAt,
        planHash, signature, approvalId, state, actor.id);
    return { ...this._bmcRecoveryRow(db.prepare('SELECT * FROM edge_bmc_recovery_plans WHERE id=?').get(result.lastInsertRowid)), duplicate: false };
  }
  authorizeBmcRecovery(id, body = {}, actor) {
    this._admin(actor); secretFree(body, 'bmcRecoveryAuthorization'); const db = this._db(); const row = db.prepare(`SELECT p.*,e.endpoint_ref
      FROM edge_bmc_recovery_plans p JOIN edge_bmc_endpoints e ON e.id=p.bmc_endpoint_id WHERE p.id=?`).get(integer(id, 'planId', 1));
    if (!row) throw fail('BMC recovery plan not found', 404, 'EDGE_BMC_RECOVERY_NOT_FOUND'); this._ensureSiteMutable(db.prepare('SELECT site_id FROM edge_bmc_endpoints WHERE id=?').get(row.bmc_endpoint_id).site_id); if (row.state !== 'pending_approval') throw fail('BMC recovery plan is not pending approval', 409, 'EDGE_BMC_RECOVERY_BLOCKED');
    if (body.confirmation !== row.endpoint_ref) throw fail('Typed confirmation must exactly match the BMC endpoint reference', 409, 'CONFIRMATION_MISMATCH');
    this._approvedPlan(row, `edge.bmc.${row.action_key}`, row.endpoint_ref, body, actor);
    db.prepare("UPDATE edge_bmc_recovery_plans SET state='ready_for_edge_agent',authorized_by=?,authorized_at=datetime('now') WHERE id=?").run(actor.id, row.id);
    return this._bmcRecoveryRow(db.prepare('SELECT * FROM edge_bmc_recovery_plans WHERE id=?').get(row.id));
  }
  _bmcRecoveryRow(row) { return row && { id: row.id, endpointId: row.bmc_endpoint_id, actionKey: row.action_key,
    safeguards: parse(row.safeguards_json, {}), reason: row.reason, ticketRef: row.ticket_ref, expiresAt: row.expires_at,
    planHash: row.plan_hash, signature: row.signature, approvalId: row.approval_id,
    state: Date.parse(row.expires_at) <= Date.now() && ['pending_approval','ready_for_edge_agent'].includes(row.state) ? 'expired' : row.state,
    requestedBy: row.requested_by, authorizedBy: row.authorized_by, executionLocation: 'edge_agent', credentialResolution: 'site_local_vault',
    centralBmcExecutionSupported: false, providerMutationsStarted: 0, createdAt: row.created_at }; }

  declareDisaster(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'disaster'); const site = this._site(siteId); const db = this._db();
    if (db.prepare("SELECT 1 FROM edge_disaster_declarations WHERE site_id=? AND state='active'").get(site.id)) throw fail('Site already has an active disaster declaration', 409, 'EDGE_DISASTER_ACTIVE');
    const severity = body.severity; if (!['major','critical'].includes(severity)) throw fail('severity must be major or critical');
    const reason = text(body.reason, 'reason', 1000); const ticketRef = reference(body.ticketRef, 'ticketRef');
    if (!Array.isArray(body.notifications) || !body.notifications.length || body.notifications.length > 20) throw fail('notifications must contain 1-20 entries');
    const notifications = body.notifications.map((item, index) => { const channel = item?.channel;
      if (!['local_banner','email','sms','webhook'].includes(channel)) throw fail(`notifications[${index}].channel is invalid`);
      return { channel, recipientRef: reference(item.recipientRef, `notifications[${index}].recipientRef`) }; });
    if (!notifications.some(item => item.channel === 'local_banner')) notifications.unshift({ channel: 'local_banner', recipientRef: `site/${site.slug}` });
    const expiresAt = timestamp(body.runbookExpiresAt, 'runbookExpiresAt', { future: true, maxFutureMs: 24 * 3600000 });
    let declaration; db.transaction(() => {
      const envelope = this.createRunbookEnvelope(body.agentRecordId, { runbookKey: 'disaster_assessment', targetRef: `site/${site.slug}`,
        parameters: { severity, ticketRef }, expiresAt }, actor);
      const normalized = { siteId: site.id, severity, reason, ticketRef, notifications, runbookEnvelopeId: envelope.id,
        runbookEnvelopeHash: envelope.envelopeHash, mutationFreeze: true }; const declarationHash = hash(normalized);
      const signature = this._sign('disaster-declaration', normalized); const saved = db.prepare(`INSERT INTO edge_disaster_declarations
        (site_id,severity,reason,ticket_ref,notification_refs_json,runbook_envelope_id,declaration_hash,signature,declared_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(site.id, severity, reason, ticketRef, stable(notifications), envelope.id, declarationHash, signature, actor.id);
      const id = Number(saved.lastInsertRowid); const insert = db.prepare(`INSERT INTO edge_disaster_notification_outbox
        (declaration_id,channel,recipient_ref,payload_hash) VALUES (?,?,?,?)`);
      for (const notification of notifications) insert.run(id, notification.channel, notification.recipientRef,
        hash({ declarationHash, ...notification, severity, ticketRef }));
      declaration = this._disasterRow(db.prepare('SELECT * FROM edge_disaster_declarations WHERE id=?').get(id));
    })(); return declaration;
  }
  resolveDisaster(id, body = {}, actor) {
    this._admin(actor); secretFree(body, 'disasterResolution'); const db = this._db(); const row = db.prepare('SELECT * FROM edge_disaster_declarations WHERE id=?').get(integer(id, 'declarationId', 1));
    if (!row) throw fail('Disaster declaration not found', 404, 'EDGE_DISASTER_NOT_FOUND'); if (row.state !== 'active') return this._disasterRow(row);
    if (row.declared_by === actor.id) throw fail('A different administrator must resolve the disaster freeze', 409, 'FOUR_EYES_REQUIRED');
    const site = this._site(row.site_id); if (body.confirmation !== site.slug) throw fail('Typed confirmation must exactly match the site slug', 409, 'CONFIRMATION_MISMATCH');
    const evidence = object(body.evidence); secretFree(evidence, 'evidence'); bounded(evidence, 'evidence', 64 * 1024);
    const resolutionEvidenceHash = hash({ declarationHash: row.declaration_hash, evidence });
    db.prepare("UPDATE edge_disaster_declarations SET state='resolved',resolved_by=?,resolution_evidence_hash=?,resolved_at=datetime('now') WHERE id=?")
      .run(actor.id, resolutionEvidenceHash, row.id); return this._disasterRow(db.prepare('SELECT * FROM edge_disaster_declarations WHERE id=?').get(row.id));
  }
  _disasterRow(row) { return row && { id: row.id, siteId: row.site_id, severity: row.severity, reason: row.reason,
    ticketRef: row.ticket_ref, notifications: parse(row.notification_refs_json, []), runbookEnvelopeId: row.runbook_envelope_id,
    mutationFreeze: true, declarationHash: row.declaration_hash, signature: row.signature, state: row.state,
    declaredBy: row.declared_by, resolvedBy: row.resolved_by, resolutionEvidenceHash: row.resolution_evidence_hash,
    externalNotificationDeliveryStarted: false, declaredAt: row.declared_at, resolvedAt: row.resolved_at }; }

  createBackupSeed(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'backupSeed'); const site = this._site(siteId); this._ensureSiteMutable(site.id);
    if (!Array.isArray(body.chunks) || !body.chunks.length || body.chunks.length > 10000) throw fail('chunks must contain 1-10000 entries');
    const chunks = body.chunks.map((item, index) => { const digest = String(item?.digest || '').toLowerCase(); if (!DIGEST.test(digest)) throw fail(`chunks[${index}].digest must use sha256`);
      return { index: integer(item.index, `chunks[${index}].index`, 0, 9999), digest,
        bytes: integer(item.bytes, `chunks[${index}].bytes`, 1, 1024 ** 4), verified: item.verified === true }; });
    if (chunks.some((item, index) => item.index !== index)) throw fail('chunk indexes must be contiguous from zero');
    const baseBackupDigest = String(body.baseBackupDigest || '').toLowerCase(); if (!DIGEST.test(baseBackupDigest)) throw fail('baseBackupDigest must use sha256');
    const totalBytes = chunks.reduce((sum, item) => sum + item.bytes, 0); const expiresAt = timestamp(body.expiresAt, 'expiresAt', { future: true, maxFutureMs: 30 * 86400000 });
    const normalized = { siteId: site.id, datasetRef: reference(body.datasetRef, 'datasetRef'), baseBackupRef: reference(body.baseBackupRef, 'baseBackupRef'),
      baseBackupDigest, chunks, encryptionKeyRef: reference(body.encryptionKeyRef, 'encryptionKeyRef'), mediaRef: reference(body.mediaRef, 'mediaRef'),
      totalBytes, expiresAt }; const manifestHash = hash(normalized); const signature = this._sign('backup-seed', normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM edge_backup_seed_manifests WHERE manifest_hash=?').get(manifestHash);
    if (existing) return { ...this._backupSeedRow(existing), duplicate: true };
    const state = chunks.every(item => item.verified) ? 'ready' : 'blocked'; const saved = db.prepare(`INSERT INTO edge_backup_seed_manifests
      (site_id,dataset_ref,base_backup_ref,base_backup_digest,chunks_json,encryption_key_ref,media_ref,total_bytes,expires_at,manifest_hash,signature,state,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(site.id, normalized.datasetRef, normalized.baseBackupRef, baseBackupDigest, stable(chunks),
        normalized.encryptionKeyRef, normalized.mediaRef, totalBytes, expiresAt, manifestHash, signature, state, actor.id);
    return { ...this._backupSeedRow(db.prepare('SELECT * FROM edge_backup_seed_manifests WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  recordBackupSeedCheckpoint(seedId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'backupSeedCheckpoint'); const db = this._db(); const seed = db.prepare('SELECT * FROM edge_backup_seed_manifests WHERE id=?').get(integer(seedId, 'seedId', 1));
    if (!seed) throw fail('Backup seed not found', 404, 'EDGE_BACKUP_SEED_NOT_FOUND'); this._ensureSiteMutable(seed.site_id);
    if (seed.state === 'blocked') throw fail('Blocked backup seed cannot accept checkpoints', 409, 'EDGE_BACKUP_SEED_BLOCKED');
    const chunks = parse(seed.chunks_json, []); const last = db.prepare('SELECT * FROM edge_backup_seed_checkpoints WHERE seed_id=? ORDER BY sequence DESC LIMIT 1').get(seed.id);
    const sequence = integer(body.sequence, 'sequence', 0); if (last && sequence <= last.sequence) throw fail('Checkpoint sequence must strictly increase', 409, 'EDGE_BACKUP_CHECKPOINT_REPLAY');
    const completedChunk = integer(body.completedChunk, 'completedChunk', 0, chunks.length - 1);
    if (last && completedChunk < last.completed_chunk) throw fail('completedChunk may not move backwards', 409, 'EDGE_BACKUP_CHECKPOINT_REPLAY');
    const transferredBytes = integer(body.transferredBytes, 'transferredBytes', 0, seed.total_bytes);
    if (last && transferredBytes < last.transferred_bytes) throw fail('transferredBytes may not move backwards', 409, 'EDGE_BACKUP_CHECKPOINT_REPLAY');
    const rollingDigest = String(body.rollingDigest || '').toLowerCase(); const mediaIdentityHash = String(body.mediaIdentityHash || '').toLowerCase();
    if (!DIGEST.test(rollingDigest) || !DIGEST.test(mediaIdentityHash)) throw fail('rollingDigest and mediaIdentityHash must use sha256');
    const continuationCursor = reference(body.continuationCursor, 'continuationCursor'); const complete = completedChunk === chunks.length - 1 && transferredBytes === seed.total_bytes;
    const normalized = { seedId: seed.id, sequence, completedChunk, transferredBytes, continuationCursor, rollingDigest, mediaIdentityHash,
      state: complete ? 'complete' : 'in_progress' }; const checkpointHash = hash(normalized); const saved = db.transaction(() => {
      const result = db.prepare(`INSERT INTO edge_backup_seed_checkpoints
        (seed_id,sequence,completed_chunk,transferred_bytes,continuation_cursor,rolling_digest,media_identity_hash,state,checkpoint_hash,reported_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(seed.id, sequence, completedChunk, transferredBytes, continuationCursor, rollingDigest,
          mediaIdentityHash, normalized.state, checkpointHash, actor.id);
      if (complete) db.prepare("UPDATE edge_backup_seed_manifests SET state='complete' WHERE id=?").run(seed.id); return result.lastInsertRowid;
    })(); const row = db.prepare('SELECT * FROM edge_backup_seed_checkpoints WHERE id=?').get(saved);
    return { id: row.id, seedId: row.seed_id, sequence: row.sequence, completedChunk: row.completed_chunk,
      transferredBytes: row.transferred_bytes, continuationCursor: row.continuation_cursor, rollingDigest: row.rolling_digest,
      mediaIdentityHash: row.media_identity_hash, state: row.state, checkpointHash: row.checkpoint_hash,
      continuationSupported: true, transferPerformedByApi: false, reportedAt: row.reported_at };
  }
  _backupSeedRow(row) { return row && { id: row.id, siteId: row.site_id, datasetRef: row.dataset_ref,
    baseBackupRef: row.base_backup_ref, baseBackupDigest: row.base_backup_digest, chunks: parse(row.chunks_json, []),
    encryptionKeyRef: row.encryption_key_ref, mediaRef: row.media_ref, totalBytes: row.total_bytes, expiresAt: row.expires_at,
    manifestHash: row.manifest_hash, signature: row.signature, state: row.state, transferStarted: false, createdAt: row.created_at }; }

  saveComplianceProfile(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'complianceProfile'); const site = this._site(siteId);
    const requiredControls = safeList(body.requiredControls || [...COMPLIANCE_CONTROLS], 'requiredControls', COMPLIANCE_CONTROLS.size, COMPLIANCE_CONTROLS);
    if (!requiredControls.length) throw fail('requiredControls is required'); const maximumUnknown = integer(body.maximumUnknown ?? 0, 'maximumUnknown', 0, 100);
    const normalized = { siteId: site.id, requiredControls, maximumUnknown }; const profileHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO edge_compliance_profiles (site_id,required_controls_json,maximum_unknown,profile_hash,updated_by)
      VALUES (?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET required_controls_json=excluded.required_controls_json,
      maximum_unknown=excluded.maximum_unknown,profile_hash=excluded.profile_hash,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(site.id, stable(requiredControls), maximumUnknown, profileHash, actor.id);
    return { ...normalized, profileHash, exportsSensitiveEvidence: false };
  }
  recordComplianceSnapshot(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'complianceSnapshot'); const site = this._site(siteId); const db = this._db();
    const profile = db.prepare('SELECT * FROM edge_compliance_profiles WHERE site_id=?').get(site.id);
    if (!profile) throw fail('Compliance profile is required', 409, 'EDGE_COMPLIANCE_PROFILE_REQUIRED');
    if (!Array.isArray(body.controls) || body.controls.length > COMPLIANCE_CONTROLS.size) throw fail('controls is invalid'); const supplied = new Map();
    for (const [index, item] of body.controls.entries()) { const control = String(item?.control || ''); if (!COMPLIANCE_CONTROLS.has(control)) throw fail(`controls[${index}].control is invalid`);
      if (supplied.has(control)) throw fail(`controls[${index}].control is duplicated`); const state = item.state; if (!['pass','fail','unknown'].includes(state)) throw fail(`controls[${index}].state is invalid`);
      const evidenceDigest = String(item.evidenceDigest || '').toLowerCase(); if (!DIGEST.test(evidenceDigest)) throw fail(`controls[${index}].evidenceDigest must use sha256`); supplied.set(control, { control, state, evidenceDigest }); }
    const controls = parse(profile.required_controls_json, []).map(control => supplied.get(control) || { control, state: 'unknown', evidenceDigest: null });
    const passedCount = controls.filter(item => item.state === 'pass').length; const failedCount = controls.filter(item => item.state === 'fail').length;
    const unknownCount = controls.filter(item => item.state === 'unknown').length; const posture = failedCount ? 'non_compliant' : unknownCount > profile.maximum_unknown ? 'degraded' : unknownCount ? 'unknown' : 'compliant';
    const observedAt = timestamp(body.observedAt, 'observedAt', { maxFutureMs: 300000, maxPastMs: 7 * 86400000 });
    const sourceEvidenceDigest = `sha256:${hash(controls.map(item => item.evidenceDigest))}`; const normalized = { siteId: site.id, passedCount, failedCount,
      unknownCount, controlStates: controls.map(item => ({ control: item.control, state: item.state })), sourceEvidenceDigest, posture, observedAt };
    const snapshotHash = hash(normalized); const existing = db.prepare('SELECT * FROM edge_compliance_snapshots WHERE snapshot_hash=?').get(snapshotHash);
    if (existing) return { ...this._complianceRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_compliance_snapshots
      (site_id,passed_count,failed_count,unknown_count,control_states_json,source_evidence_digest,posture,snapshot_hash,observed_at,received_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(site.id, passedCount, failedCount, unknownCount, stable(normalized.controlStates), sourceEvidenceDigest,
        posture, snapshotHash, observedAt, actor.id); return { ...this._complianceRow(db.prepare('SELECT * FROM edge_compliance_snapshots WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _complianceRow(row) { return row && { id: row.id, siteId: row.site_id, passedCount: row.passed_count,
    failedCount: row.failed_count, unknownCount: row.unknown_count, controlStates: parse(row.control_states_json, []),
    sourceEvidenceDigest: row.source_evidence_digest, posture: row.posture, sensitiveDetailsWithheld: true,
    snapshotHash: row.snapshot_hash, observedAt: row.observed_at }; }
  fleetCompliance(actor) {
    this._admin(actor); const rows = this._db().prepare(`SELECT s.*,e.slug,e.name FROM edge_compliance_snapshots s
      JOIN edge_sites e ON e.id=s.site_id WHERE s.id IN (SELECT MAX(id) FROM edge_compliance_snapshots GROUP BY site_id) ORDER BY e.name`).all();
    const sites = rows.map(row => ({ siteId: row.site_id, siteSlug: row.slug, siteName: row.name, posture: row.posture,
      passedCount: row.passed_count, failedCount: row.failed_count, unknownCount: row.unknown_count, observedAt: row.observed_at }));
    return { summary: { sites: sites.length, compliant: sites.filter(item => item.posture === 'compliant').length,
      degraded: sites.filter(item => item.posture === 'degraded' || item.posture === 'unknown').length,
      nonCompliant: sites.filter(item => item.posture === 'non_compliant').length }, sites,
    sensitiveDetailsWithheld: true, rawEvidenceExported: false };
  }

  saveFaultDomain(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'faultDomain'); const site = this._site(siteId); const domainType = body.domainType;
    if (!FAULT_DOMAIN_TYPES.includes(domainType)) throw fail('domainType is invalid'); const domainKey = slug(body.domainKey, 'domainKey');
    if (!Array.isArray(body.hostIds) || !body.hostIds.length || body.hostIds.length > 500) throw fail('hostIds must contain 1-500 entries');
    const hostIds = [...new Set(body.hostIds.map((value, index) => integer(value, `hostIds[${index}]`, 1)))]; const db = this._db();
    const placeholders = hostIds.map(() => '?').join(','); const matched = db.prepare(`SELECT COUNT(*) count FROM edge_site_hosts WHERE site_id=? AND host_id IN (${placeholders})`).get(site.id, ...hostIds).count;
    if (matched !== hostIds.length) throw fail('Every host must belong to this site', 409, 'EDGE_FAULT_DOMAIN_HOST_MISMATCH');
    const metadata = object(body.metadata); secretFree(metadata, 'metadata'); bounded(metadata, 'metadata', 64 * 1024); const normalized = { siteId: site.id,
      domainType, domainKey, name: text(body.name, 'name', 160), owner: text(body.owner, 'owner', 160), metadata, hostIds: [...hostIds].sort((a,b) => a-b) };
    const domainHash = hash(normalized); let domainId; db.transaction(() => { db.prepare(`INSERT INTO edge_fault_domains
      (site_id,domain_type,domain_key,name,owner,metadata_json,domain_hash,created_by) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(site_id,domain_type,domain_key) DO UPDATE SET name=excluded.name,owner=excluded.owner,metadata_json=excluded.metadata_json,
      domain_hash=excluded.domain_hash,updated_at=datetime('now')`).run(site.id, domainType, domainKey, normalized.name, normalized.owner,
        stable(metadata), domainHash, actor.id); domainId = db.prepare('SELECT id FROM edge_fault_domains WHERE site_id=? AND domain_type=? AND domain_key=?').get(site.id, domainType, domainKey).id;
      for (const hostId of hostIds) db.prepare(`DELETE FROM edge_fault_domain_members WHERE host_id=? AND domain_id IN
        (SELECT id FROM edge_fault_domains WHERE site_id=? AND domain_type=? AND id<>?)`).run(hostId, site.id, domainType, domainId);
      db.prepare('DELETE FROM edge_fault_domain_members WHERE domain_id=?').run(domainId); const insert = db.prepare('INSERT INTO edge_fault_domain_members (domain_id,host_id) VALUES (?,?)');
      for (const hostId of hostIds) insert.run(domainId, hostId); })(); return { id: domainId, ...normalized, domainHash };
  }
  assessFaultDomains(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'faultDomainAssessment'); const site = this._site(siteId); const db = this._db();
    if (!Array.isArray(body.hostIds) || !body.hostIds.length || body.hostIds.length > 500) throw fail('hostIds must contain 1-500 entries');
    const hostIds = [...new Set(body.hostIds.map((value, index) => integer(value, `hostIds[${index}]`, 1)))]; const requiredReplicas = integer(body.requiredReplicas, 'requiredReplicas', 1, 1000);
    const placeholders = hostIds.map(() => '?').join(','); const rows = db.prepare(`SELECT d.domain_type,d.domain_key,m.host_id FROM edge_fault_domain_members m
      JOIN edge_fault_domains d ON d.id=m.domain_id WHERE d.site_id=? AND m.host_id IN (${placeholders})`).all(site.id, ...hostIds);
    const domainCoverage = {}; const risks = []; for (const type of FAULT_DOMAIN_TYPES) { const typeRows = rows.filter(row => row.domain_type === type);
      const domains = [...new Set(typeRows.map(row => row.domain_key))]; const coveredHosts = new Set(typeRows.map(row => row.host_id));
      domainCoverage[type] = { distinctDomains: domains.length, domains, coveredHosts: coveredHosts.size, totalHosts: hostIds.length };
      if (coveredHosts.size !== hostIds.length) risks.push(`${type}_coverage_unknown`); else if (domains.length < Math.min(requiredReplicas, hostIds.length)) risks.push(`${type}_shared_failure_domain`); }
    if (hostIds.length < requiredReplicas) risks.push('insufficient_replicas'); const state = risks.some(item => item.endsWith('_unknown')) ? 'unknown' : risks.length ? 'at_risk' : 'resilient';
    const workloadRef = reference(body.workloadRef, 'workloadRef'); const normalized = { siteId: site.id, workloadRef, hostIds: [...hostIds].sort((a,b) => a-b),
      requiredReplicas, domainCoverage, risks, state }; const assessmentHash = hash(normalized); const existing = db.prepare('SELECT * FROM edge_fault_domain_assessments WHERE assessment_hash=?').get(assessmentHash);
    if (existing) return { ...this._faultAssessmentRow(existing), duplicate: true }; const saved = db.prepare(`INSERT INTO edge_fault_domain_assessments
      (site_id,workload_ref,host_ids_json,required_replicas,domain_coverage_json,risks_json,state,assessment_hash,assessed_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(site.id, workloadRef, stable(normalized.hostIds), requiredReplicas, stable(domainCoverage), stable(risks), state, assessmentHash, actor.id);
    return { ...this._faultAssessmentRow(db.prepare('SELECT * FROM edge_fault_domain_assessments WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _faultAssessmentRow(row) { return row && { id: row.id, siteId: row.site_id, workloadRef: row.workload_ref,
    hostIds: parse(row.host_ids_json, []), requiredReplicas: row.required_replicas, domainCoverage: parse(row.domain_coverage_json, {}),
    risks: parse(row.risks_json, []), state: row.state, assessmentHash: row.assessment_hash,
    visualizationReady: true, placementMutationStarted: false, assessedAt: row.assessed_at }; }

  _hardwareClaims(value, key = 'hardware') {
    const input = object(value); const allowed = ['manufacturer','model','serialNumber','tpmEkHash']; const unknown = Object.keys(input).filter(name => !allowed.includes(name));
    if (unknown.length) throw fail(`${key} contains unknown claims`, 400, 'EDGE_HARDWARE_CLAIMS', { unknown }); const tpmEkHash = String(input.tpmEkHash || '').toLowerCase();
    if (!DIGEST.test(tpmEkHash)) throw fail(`${key}.tpmEkHash must use sha256`); return { manufacturer: text(input.manufacturer, `${key}.manufacturer`, 160),
      model: text(input.model, `${key}.model`, 160), serialNumber: reference(input.serialNumber, `${key}.serialNumber`), tpmEkHash };
  }
  createEnrollmentToken(siteId, body = {}, actor) {
    this._admin(actor); secretFree(body, 'enrollmentToken'); const site = this._site(siteId); const expectedHardware = this._hardwareClaims(body.expectedHardware, 'expectedHardware');
    const runbookAllowlist = safeList(body.runbookAllowlist || [], 'runbookAllowlist', RUNBOOKS.size, RUNBOOKS); const updateRing = body.updateRing || 'held'; const db = this._db();
    if (!db.prepare('SELECT 1 FROM edge_update_rings WHERE slug=? AND enabled=1').get(updateRing)) throw fail('Enabled update ring not found');
    const ttlSeconds = integer(body.ttlSeconds ?? 600, 'ttlSeconds', 60, 900); const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const token = `edge_enroll_${crypto.randomBytes(24).toString('base64url')}`; const tokenHash = this._sign('enrollment-token', token); const tokenFingerprint = tokenHash.slice(0, 16);
    const saved = db.prepare(`INSERT INTO edge_enrollment_tokens
      (site_id,token_hash,token_fingerprint,expected_hardware_json,runbook_allowlist_json,update_ring,expires_at,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(site.id, tokenHash, tokenFingerprint, stable(expectedHardware), stable(runbookAllowlist), updateRing, expiresAt, actor.id);
    return { id: Number(saved.lastInsertRowid), siteId: site.id, token, tokenFingerprint, expectedHardware, runbookAllowlist, updateRing,
      expiresAt, state: 'issued', tokenReturnedOnce: true, privateKeyGenerated: false };
  }
  redeemEnrollment(body = {}) {
    const rawToken = String(body.token || ''); if (!/^edge_enroll_[A-Za-z0-9_-]{32}$/.test(rawToken)) throw fail('Enrollment token is invalid', 401, 'EDGE_ENROLLMENT_TOKEN_INVALID');
    const db = this._db(); const tokenHash = this._sign('enrollment-token', rawToken); let token = db.prepare('SELECT * FROM edge_enrollment_tokens WHERE token_hash=?').get(tokenHash);
    if (!token || token.state !== 'issued') throw fail('Enrollment token is invalid or already used', 401, 'EDGE_ENROLLMENT_TOKEN_INVALID');
    if (Date.parse(token.expires_at) <= Date.now()) { db.prepare("UPDATE edge_enrollment_tokens SET state='expired' WHERE id=?").run(token.id); throw fail('Enrollment token expired', 401, 'EDGE_ENROLLMENT_TOKEN_EXPIRED'); }
    const hardwareClaims = this._hardwareClaims(body.hardwareClaims, 'hardwareClaims'); if (stable(hardwareClaims) !== stable(parse(token.expected_hardware_json, {}))) throw fail('Hardware identity does not match enrollment policy', 403, 'EDGE_HARDWARE_MISMATCH');
    const agentId = slug(body.agentId, 'agentId'); const publicKeyFingerprint = String(body.publicKeyFingerprint || '').toLowerCase();
    if (!DIGEST.test(publicKeyFingerprint)) throw fail('publicKeyFingerprint must use sha256'); const nonce = reference(body.nonce, 'nonce');
    const normalized = { tokenId: token.id, siteId: token.site_id, agentId, hardwareClaims, publicKeyFingerprint, nonce };
    const attestationHash = hash(normalized); const bootstrapSignature = this._sign('enrollment-bootstrap', normalized); let id;
    try { db.transaction(() => { const claimed = db.prepare("UPDATE edge_enrollment_tokens SET state='redeemed',redeemed_at=datetime('now') WHERE id=? AND state='issued'").run(token.id);
      if (claimed.changes !== 1) throw fail('Enrollment token is invalid or already used', 401, 'EDGE_ENROLLMENT_TOKEN_INVALID'); const saved = db.prepare(`INSERT INTO edge_enrollment_attestations
        (token_id,site_id,agent_id,hardware_claims_json,public_key_fingerprint,nonce,attestation_hash,bootstrap_signature)
        VALUES (?,?,?,?,?,?,?,?)`).run(token.id, token.site_id, agentId, stable(hardwareClaims), publicKeyFingerprint, nonce, attestationHash, bootstrapSignature); id = saved.lastInsertRowid; })(); }
    catch (error) { if (error instanceof EdgePlatformError) throw error; if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Agent identity is already enrolled or pending', 409, 'EDGE_ENROLLMENT_IDENTITY_EXISTS'); throw error; }
    return this._attestationRow(db.prepare('SELECT * FROM edge_enrollment_attestations WHERE id=?').get(id));
  }
  approveEnrollment(id, body = {}, actor) {
    this._admin(actor); secretFree(body, 'enrollmentApproval'); const db = this._db(); const row = db.prepare(`SELECT a.*,t.created_by,t.runbook_allowlist_json,t.update_ring
      FROM edge_enrollment_attestations a JOIN edge_enrollment_tokens t ON t.id=a.token_id WHERE a.id=?`).get(integer(id, 'attestationId', 1));
    if (!row) throw fail('Enrollment attestation not found', 404, 'EDGE_ENROLLMENT_NOT_FOUND'); if (row.state !== 'certificate_pending') throw fail('Enrollment is not pending certificate approval', 409, 'EDGE_ENROLLMENT_CLOSED');
    if (row.created_by === actor.id) throw fail('A different administrator must approve enrollment', 409, 'FOUR_EYES_REQUIRED');
    if (body.attestationHash !== row.attestation_hash || body.confirmation !== row.agent_id) throw fail('Attestation hash or typed agent confirmation does not match', 409, 'EDGE_ENROLLMENT_CONFIRMATION_MISMATCH');
    const certificateFingerprint = String(body.certificateFingerprint || '').toLowerCase(); if (!FINGERPRINT.test(certificateFingerprint)) throw fail('certificateFingerprint must use sha256');
    const identityHash = hash({ attestationHash: row.attestation_hash, certificateFingerprint, siteId: row.site_id, agentId: row.agent_id }); let edgeAgentId;
    try { db.transaction(() => { const saved = db.prepare(`INSERT INTO edge_agents
        (site_id,agent_id,certificate_fingerprint,runbook_allowlist_json,update_ring,state,created_by) VALUES (?,?,?,?,?,'active',?)`)
        .run(row.site_id, row.agent_id, certificateFingerprint, row.runbook_allowlist_json, row.update_ring, actor.id); edgeAgentId = Number(saved.lastInsertRowid);
      db.prepare("UPDATE edge_enrollment_attestations SET state='enrolled',approved_by=?,approved_at=datetime('now') WHERE id=?").run(actor.id, row.id);
      db.prepare(`INSERT INTO edge_enrolled_identities
        (attestation_id,edge_agent_id,certificate_fingerprint,identity_hash,created_by) VALUES (?,?,?,?,?)`)
        .run(row.id, edgeAgentId, certificateFingerprint, identityHash, actor.id); })(); }
    catch (error) { if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Agent or certificate identity already exists', 409, 'EDGE_ENROLLMENT_IDENTITY_EXISTS'); throw error; }
    return { ...this._attestationRow(db.prepare('SELECT * FROM edge_enrollment_attestations WHERE id=?').get(row.id)), edgeAgentId,
      certificateFingerprint, identityHash, certificatePrivateKeyReturned: false, state: 'enrolled' };
  }
  _attestationRow(row) { return row && { id: row.id, tokenId: row.token_id, siteId: row.site_id, agentId: row.agent_id,
    hardwareClaims: parse(row.hardware_claims_json, {}), publicKeyFingerprint: row.public_key_fingerprint, nonce: row.nonce,
    attestationHash: row.attestation_hash, bootstrapSignature: row.bootstrap_signature, state: row.state, approvedBy: row.approved_by,
    enrollmentTokenReturned: false, certificatePrivateKeyReturned: false, receivedAt: row.received_at, approvedAt: row.approved_at }; }

  overview(actor) {
    this._admin(actor); const db = this._db(); const sites = db.prepare('SELECT * FROM edge_sites ORDER BY name').all().map(row => this._siteRow(row));
    const intents = db.prepare('SELECT * FROM edge_offline_intents ORDER BY id DESC LIMIT 200').all().map(row => this._intentRow(row));
    const agents = db.prepare('SELECT * FROM edge_agents ORDER BY site_id,agent_id').all().map(row => this._agentRow(row));
    const syncPlans = db.prepare('SELECT * FROM edge_sync_plans ORDER BY id DESC LIMIT 100').all().map(row => this._syncPlanRow(row));
    const runbooks = db.prepare('SELECT * FROM edge_runbook_envelopes ORDER BY id DESC LIMIT 100').all().map(row => this._runbookRow(row));
    const updates = db.prepare('SELECT * FROM edge_update_plans ORDER BY id DESC LIMIT 100').all().map(row => this._updateRow(row));
    const bootstraps = db.prepare('SELECT * FROM edge_bootstrap_manifests ORDER BY id DESC LIMIT 100').all().map(row => this._bootstrapRow(row));
    const mirrors = db.prepare('SELECT * FROM edge_content_mirror_manifests ORDER BY id DESC LIMIT 100').all().map(row => this._mirrorRow(row));
    const cache = db.prepare('SELECT * FROM edge_read_cache_entries ORDER BY id DESC LIMIT 200').all().map(row => this._cacheRow(row));
    const residencyPolicies = db.prepare('SELECT * FROM edge_data_residency_policies ORDER BY site_id').all().map(row => ({ siteId: row.site_id,
      zone: row.zone, categoryRules: parse(row.category_rules_json, {}), failClosed: true, policyHash: row.policy_hash }));
    const residencyEvaluations = db.prepare('SELECT * FROM edge_residency_evaluations ORDER BY id DESC LIMIT 100').all().map(row => ({ id: row.id,
      siteId: row.site_id, dataCategory: row.data_category, destinationJurisdiction: row.destination_jurisdiction,
      decision: row.decision, reason: row.reason, policyHash: row.policy_hash, evaluationHash: row.evaluation_hash, evaluatedAt: row.evaluated_at }));
    const identityGrants = db.prepare('SELECT * FROM edge_identity_grants ORDER BY id DESC LIMIT 100').all().map(row => this._identityGrantRow(row));
    const vaultAdapters = db.prepare('SELECT * FROM edge_vault_adapters ORDER BY site_id,name').all().map(row => this._vaultRow(row));
    const secretPlans = db.prepare('SELECT * FROM edge_secret_resolution_plans ORDER BY id DESC LIMIT 100').all().map(row => this._secretPlanRow(row));
    const singleNodeAssessments = db.prepare('SELECT * FROM edge_single_node_assessments ORDER BY id DESC LIMIT 100').all().map(row => ({ id: row.id,
      siteId: row.site_id, observed: parse(row.observed_json, {}), checks: parse(row.checks_json, {}), state: row.state,
      assessmentHash: row.assessment_hash, haAvailable: false, applySupported: false, assessedAt: row.assessed_at }));
    const quorum = db.prepare('SELECT * FROM edge_quorum_snapshots ORDER BY id DESC LIMIT 100').all().map(row => this._quorumRow(row));
    const reservations = db.prepare('SELECT * FROM edge_resource_reservation_assessments ORDER BY id DESC LIMIT 100').all().map(row => ({ id: row.id,
      siteId: row.site_id, headroom: parse(row.headroom_json, {}), checks: parse(row.checks_json, {}), state: row.state,
      assessmentHash: row.assessment_hash, applySupported: false, assessedAt: row.assessed_at }));
    const consoleProfiles = db.prepare('SELECT * FROM edge_console_profiles ORDER BY site_id').all().map(row => ({ siteId: row.site_id,
      transportOrder: parse(row.transport_order_json, []), maxBandwidthKbps: row.max_bandwidth_kbps, maxFps: row.max_fps,
      colorDepth: row.color_depth, adaptiveQuality: !!row.adaptive_quality, clipboardEnabled: false, fileTransferEnabled: false,
      idleTtlSeconds: row.idle_ttl_seconds, profileHash: row.profile_hash, launchSupported: false }));
    const remoteHands = db.prepare('SELECT * FROM edge_remote_hands_plans ORDER BY id DESC LIMIT 100').all().map(row => this._remoteHandsRow(row));
    const bmcEndpoints = db.prepare('SELECT * FROM edge_bmc_endpoints ORDER BY site_id,name').all().map(row => this._bmcRow(row));
    const bmcInventory = db.prepare('SELECT * FROM edge_bmc_inventory_snapshots ORDER BY id DESC LIMIT 100').all().map(row => this._bmcInventoryRow(row));
    const bmcRecovery = db.prepare('SELECT * FROM edge_bmc_recovery_plans ORDER BY id DESC LIMIT 100').all().map(row => this._bmcRecoveryRow(row));
    const disasters = db.prepare('SELECT * FROM edge_disaster_declarations ORDER BY id DESC LIMIT 100').all().map(row => this._disasterRow(row));
    const disasterNotifications = db.prepare('SELECT * FROM edge_disaster_notification_outbox ORDER BY id DESC LIMIT 200').all().map(row => ({ id: row.id,
      declarationId: row.declaration_id, channel: row.channel, recipientRef: row.recipient_ref, payloadHash: row.payload_hash,
      state: row.state, externalDeliveryStarted: false, createdAt: row.created_at }));
    const backupSeeds = db.prepare('SELECT * FROM edge_backup_seed_manifests ORDER BY id DESC LIMIT 100').all().map(row => this._backupSeedRow(row));
    const compliance = this.fleetCompliance(actor);
    const faultDomains = db.prepare(`SELECT d.*,COUNT(m.host_id) host_count FROM edge_fault_domains d LEFT JOIN edge_fault_domain_members m
      ON m.domain_id=d.id GROUP BY d.id ORDER BY d.site_id,d.domain_type,d.domain_key`).all().map(row => ({ id: row.id, siteId: row.site_id,
      domainType: row.domain_type, domainKey: row.domain_key, name: row.name, owner: row.owner, metadata: parse(row.metadata_json, {}),
      hostCount: row.host_count, domainHash: row.domain_hash }));
    const faultAssessments = db.prepare('SELECT * FROM edge_fault_domain_assessments ORDER BY id DESC LIMIT 100').all().map(row => this._faultAssessmentRow(row));
    const enrollments = db.prepare('SELECT * FROM edge_enrollment_attestations ORDER BY id DESC LIMIT 100').all().map(row => this._attestationRow(row));
    const pendingEvents = db.prepare('SELECT COUNT(*) count,COALESCE(SUM(compressed_bytes),0) bytes FROM edge_event_buffer WHERE delivered_at IS NULL').get();
    return { sites, intents, agents, syncPlans, runbooks, updates, bootstraps, mirrors, cache, residencyPolicies,
      residencyEvaluations, identityGrants, vaultAdapters, secretPlans, singleNodeAssessments, quorum, reservations,
      consoleProfiles, remoteHands, bmcEndpoints, bmcInventory, bmcRecovery, disasters, disasterNotifications,
      backupSeeds, compliance, faultDomains, faultAssessments, enrollments,
      updateRings: db.prepare('SELECT * FROM edge_update_rings WHERE enabled=1 ORDER BY rollout_percent').all().map(row => ({ slug: row.slug,
        name: row.name, rolloutPercent: row.rollout_percent, requireHealthy: !!row.require_healthy, automaticRollback: !!row.automatic_rollback })),
      summary: { sites: sites.length, online: sites.filter(item => item.health === 'healthy').length,
        expectedDisconnected: sites.filter(item => item.health === 'expected_disconnected').length,
        staleCache: cache.filter(item => item.state !== 'fresh').length, queuedIntents: intents.filter(item => item.state === 'queued').length,
        readyIntents: intents.filter(item => item.state === 'ready_for_agent').length, pendingEvents: pendingEvents.count,
        pendingEventBytes: pendingEvents.bytes, activeAgents: agents.filter(item => item.state === 'active').length,
        blockedUpdates: updates.filter(item => item.state === 'blocked').length, readyBootstraps: bootstraps.filter(item => item.state === 'ready').length,
        readyMirrors: mirrors.filter(item => item.state === 'ready').length,
        blockedResidency: residencyEvaluations.filter(item => item.decision === 'blocked').length,
        activeIdentityGrants: identityGrants.filter(item => item.state === 'active').length,
        atRiskQuorum: quorum.filter(item => item.state !== 'healthy').length,
        pendingRemoteHands: remoteHands.filter(item => item.state === 'pending_approval').length,
        criticalBmc: bmcInventory.filter(item => item.health === 'critical').length,
        readyBmcRecovery: bmcRecovery.filter(item => item.state === 'ready_for_edge_agent').length,
        activeDisasters: disasters.filter(item => item.state === 'active').length,
        readyBackupSeeds: backupSeeds.filter(item => item.state === 'ready').length,
        nonCompliantSites: compliance.summary.nonCompliant,
        atRiskFaultDomains: faultAssessments.filter(item => item.state !== 'resilient').length,
        pendingEnrollments: enrollments.filter(item => item.state === 'certificate_pending').length },
      capabilities: { offlineActions: [...OFFLINE_ACTIONS], runbooks: [...RUNBOOKS], eventCategories: CATEGORIES,
        heartbeatTransport: 'admin_ingest_or_external_mtls_gateway', centralIntentExecution: false,
        centralRunbookExecution: false, updateApplySupported: false, mirrorSyncSupported: false,
        residencyFailClosed: true, identityTokensReturned: false, siteLocalSecretResolution: true,
        consoleLaunchSupported: false, centralRemoteHandsExecution: false, centralBmcExecution: false,
        fourEyesRecovery: true, disasterMutationFreeze: true, backupSeedTransferSupported: false,
        complianceRawEvidenceExported: false, faultDomainPlacementApply: false,
        zeroTouchTokenSingleUse: true, enrollmentPrivateKeysReturned: false } };
  }
}

const service = new EdgePlatformService();
module.exports = service;
module.exports.EdgePlatformService = EdgePlatformService;
module.exports.EdgePlatformError = EdgePlatformError;
module.exports._internals = { canonical, stable, hash, secretFree, timestamp, OFFLINE_ACTIONS, RUNBOOKS, CATEGORIES,
  RESIDENCY_CATEGORIES, IDENTITY_SCOPES, BMC_ACTIONS };
