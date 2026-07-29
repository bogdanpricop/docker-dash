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
const RUNBOOKS = new Set(['collect_inventory','restart_managed_service','rotate_logs','validate_backup','network_diagnostics']);
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
  _siteTrustRoots(site) { return new Set(parse(site.trust_roots_json, [])); }
  _siteRow(row) {
    if (!row) return null; const db = this._db(); const policy = db.prepare('SELECT * FROM edge_connectivity_policies WHERE site_id=?').get(row.id);
    const last = db.prepare('SELECT * FROM edge_heartbeats WHERE site_id=? ORDER BY observed_at DESC,id DESC LIMIT 1').get(row.id);
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
      health, expectedDisconnect: !!expected, createdAt: row.created_at, updatedAt: row.updated_at };
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
    this._admin(actor); secretFree(body, 'intent'); const site = this._site(siteId); const db = this._db(); const policy = db.prepare('SELECT * FROM edge_connectivity_policies WHERE site_id=?').get(site.id);
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
    if (!row) throw fail('Offline intent not found', 404, 'EDGE_INTENT_NOT_FOUND'); if (row.state === 'cancelled') throw fail('Offline intent is cancelled', 409);
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
    if (!agent || agent.state !== 'active') throw fail('Active edge agent profile not found', 409, 'EDGE_AGENT_NOT_ACTIVE');
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
      transport: 'authenticated_admin_ingest_until_zero_touch_enrollment', evidenceHash };
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
    if (!agent) throw fail('Edge agent not found', 404, 'EDGE_AGENT_NOT_FOUND'); const site = this._site(agent.site_id); const roots = this._siteTrustRoots(site);
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
    if (!adapter || adapter.state !== 'active') throw fail('Active site-local vault adapter not found', 409, 'EDGE_VAULT_NOT_ACTIVE');
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
    this._admin(actor); secretFree(body, 'remoteHands'); const site = this._site(siteId); const db = this._db(); const targetRef = reference(body.targetRef, 'targetRef');
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
    if (!row) throw fail('Remote-hands plan not found', 404, 'EDGE_REMOTE_HANDS_NOT_FOUND'); if (row.state !== 'pending_approval') throw fail('Remote-hands plan is not pending approval', 409, 'EDGE_REMOTE_HANDS_CLOSED');
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
    if (!endpoint || endpoint.state !== 'active') throw fail('Active BMC endpoint not found', 409, 'EDGE_BMC_NOT_ACTIVE'); const actionKey = String(body.actionKey || '');
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
    if (!row) throw fail('BMC recovery plan not found', 404, 'EDGE_BMC_RECOVERY_NOT_FOUND'); if (row.state !== 'pending_approval') throw fail('BMC recovery plan is not pending approval', 409, 'EDGE_BMC_RECOVERY_BLOCKED');
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
    const pendingEvents = db.prepare('SELECT COUNT(*) count,COALESCE(SUM(compressed_bytes),0) bytes FROM edge_event_buffer WHERE delivered_at IS NULL').get();
    return { sites, intents, agents, syncPlans, runbooks, updates, bootstraps, mirrors, cache, residencyPolicies,
      residencyEvaluations, identityGrants, vaultAdapters, secretPlans, singleNodeAssessments, quorum, reservations,
      consoleProfiles, remoteHands, bmcEndpoints, bmcInventory, bmcRecovery,
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
        readyBmcRecovery: bmcRecovery.filter(item => item.state === 'ready_for_edge_agent').length },
      capabilities: { offlineActions: [...OFFLINE_ACTIONS], runbooks: [...RUNBOOKS], eventCategories: CATEGORIES,
        heartbeatTransport: 'authenticated_admin_ingest_until_B350', centralIntentExecution: false,
        centralRunbookExecution: false, updateApplySupported: false, mirrorSyncSupported: false,
        residencyFailClosed: true, identityTokensReturned: false, siteLocalSecretResolution: true,
        consoleLaunchSupported: false, centralRemoteHandsExecution: false, centralBmcExecution: false,
        fourEyesRecovery: true } };
  }
}

const service = new EdgePlatformService();
module.exports = service;
module.exports.EdgePlatformService = EdgePlatformService;
module.exports.EdgePlatformError = EdgePlatformError;
module.exports._internals = { canonical, stable, hash, secretFree, timestamp, OFFLINE_ACTIONS, RUNBOOKS, CATEGORIES,
  RESIDENCY_CATEGORIES, IDENTITY_SCOPES, BMC_ACTIONS };
