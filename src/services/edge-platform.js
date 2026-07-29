'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { getDb } = require('../db');

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
  constructor(dbProvider = getDb, options = {}) { this._dbProvider = dbProvider; this._secret = options.signingSecret || process.env.APP_SECRET || ''; }
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
    const maxBytes = body.maxBytes == null ? policy.max_batch_bytes : integer(body.maxBytes, 'maxBytes', 1024, policy.max_batch_bytes);
    const order = parse(policy.priority_order_json, CATEGORIES); const rank = new Map(order.map((value, index) => [value, index]));
    const pending = db.prepare('SELECT id,event_id,category,compressed_bytes,event_hash FROM edge_event_buffer WHERE site_id=? AND delivered_at IS NULL ORDER BY id LIMIT 5000').all(site.id)
      .sort((left, right) => (rank.get(left.category) - rank.get(right.category)) || left.id - right.id);
    const selected = []; let totalBytes = 0;
    for (const item of pending) if (totalBytes + item.compressed_bytes <= maxBytes) { selected.push(item); totalBytes += item.compressed_bytes; }
    if (!selected.length) throw fail('No pending event fits the synchronization budget', 409, 'EDGE_SYNC_NOTHING_FITS');
    const eventIds = selected.map(item => item.id); const firstCursor = Math.min(...eventIds); const lastCursor = Math.max(...eventIds);
    const normalized = { siteId: site.id, eventIds, eventHashes: selected.map(item => item.event_hash), maxBytes, order };
    const planHash = hash(normalized); const existing = db.prepare('SELECT * FROM edge_sync_plans WHERE plan_hash=?').get(planHash);
    if (existing) return { ...this._syncPlanRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO edge_sync_plans
      (site_id,event_ids_json,first_cursor,last_cursor,total_bytes,priority_order_json,plan_hash,state,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(site.id, stable(eventIds), firstCursor, lastCursor, totalBytes, stable(order), planHash, 'planned', actor.id);
    return { ...this._syncPlanRow(db.prepare('SELECT * FROM edge_sync_plans WHERE id=?').get(saved.lastInsertRowid)),
      estimatedTransferSeconds: Math.ceil(totalBytes * 8 / (policy.bandwidth_kbps * 1000)), duplicate: false };
  }
  _syncPlanRow(row) { return row && { id: row.id, siteId: row.site_id, eventIds: parse(row.event_ids_json, []),
    firstCursor: row.first_cursor, lastCursor: row.last_cursor, totalBytes: row.total_bytes,
    priorityOrder: parse(row.priority_order_json, []), planHash: row.plan_hash, state: row.state,
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
    const pendingEvents = db.prepare('SELECT COUNT(*) count,COALESCE(SUM(compressed_bytes),0) bytes FROM edge_event_buffer WHERE delivered_at IS NULL').get();
    return { sites, intents, agents, syncPlans, runbooks, updates, bootstraps, mirrors, cache,
      updateRings: db.prepare('SELECT * FROM edge_update_rings WHERE enabled=1 ORDER BY rollout_percent').all().map(row => ({ slug: row.slug,
        name: row.name, rolloutPercent: row.rollout_percent, requireHealthy: !!row.require_healthy, automaticRollback: !!row.automatic_rollback })),
      summary: { sites: sites.length, online: sites.filter(item => item.health === 'healthy').length,
        expectedDisconnected: sites.filter(item => item.health === 'expected_disconnected').length,
        staleCache: cache.filter(item => item.state !== 'fresh').length, queuedIntents: intents.filter(item => item.state === 'queued').length,
        readyIntents: intents.filter(item => item.state === 'ready_for_agent').length, pendingEvents: pendingEvents.count,
        pendingEventBytes: pendingEvents.bytes, activeAgents: agents.filter(item => item.state === 'active').length,
        blockedUpdates: updates.filter(item => item.state === 'blocked').length, readyBootstraps: bootstraps.filter(item => item.state === 'ready').length,
        readyMirrors: mirrors.filter(item => item.state === 'ready').length },
      capabilities: { offlineActions: [...OFFLINE_ACTIONS], runbooks: [...RUNBOOKS], eventCategories: CATEGORIES,
        heartbeatTransport: 'authenticated_admin_ingest_until_B350', centralIntentExecution: false,
        centralRunbookExecution: false, updateApplySupported: false, mirrorSyncSupported: false } };
  }
}

const service = new EdgePlatformService();
module.exports = service;
module.exports.EdgePlatformService = EdgePlatformService;
module.exports.EdgePlatformError = EdgePlatformError;
module.exports._internals = { canonical, stable, hash, secretFree, timestamp, OFFLINE_ACTIONS, RUNBOOKS, CATEGORIES };
