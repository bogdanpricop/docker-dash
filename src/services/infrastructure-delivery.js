'use strict';

const crypto = require('crypto');
const YAML = require('yaml');
const { getDb } = require('../db');
const { encrypt, decrypt, generateToken, hmacSign, sha256 } = require('../utils/crypto');
const automation = require('./infrastructure-automation');
const procedures = require('./procedures');

const API_VERSION = 'docker-dash.io/v1alpha1';
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,299}$/;
const SENSITIVE_KEY = /password|secret|token|credential|private.?key|authorization|cookie/i;

class InfrastructureDeliveryError extends Error {
  constructor(message, status = 400, code = 'INFRASTRUCTURE_DELIVERY_ERROR', details) {
    super(message); this.name = 'InfrastructureDeliveryError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new InfrastructureDeliveryError(message, status, code, details);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const string = (value, key, max = 300, pattern) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`);
  return result;
};
const optionalString = (value, key, max = 300, pattern) => value == null || value === '' ? null : string(value, key, max, pattern);
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`);
  return result;
};
function bounded(value, key = 'document', max = MAX_DOCUMENT_BYTES) {
  let encoded; try { encoded = JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'INFRASTRUCTURE_DOCUMENT_TOO_LARGE');
}
function secretFree(value, path = 'document') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw fail(`${path}.${key} may not contain secret material`, 400, 'INFRASTRUCTURE_SECRET_FIELD');
    secretFree(child, `${path}.${key}`);
  }
}
function stringList(value, key, max = 100) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw fail(`${key} must contain at most ${max} values`);
  return [...new Set(value.map((item, index) => string(item, `${key}[${index}]`, 300, SAFE_REF)))].sort();
}
function tags(value) {
  const entries = Object.entries(object(value));
  if (entries.length > 64) throw fail('spec.tags supports at most 64 entries');
  return Object.fromEntries(entries.map(([key, value]) => [string(key, 'spec.tags.key', 64, SAFE_NAME),
    string(value, `spec.tags.${key}`, 240)]).sort());
}
function versions(value) {
  const entries = Object.entries(object(value));
  if (entries.length > 200) throw fail('resourceVersions supports at most 200 entries');
  return Object.fromEntries(entries.map(([key, value]) => [string(key, 'resourceVersions.key', 300, SAFE_REF),
    string(value, `resourceVersions.${key}`, 300)]).sort());
}
function flatten(value, prefix = '', output = new Map()) {
  if (Array.isArray(value)) { if (!value.length) output.set(prefix, []); value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, output)); return output; }
  if (value && typeof value === 'object') { const entries = Object.entries(value); if (!entries.length) output.set(prefix, {});
    entries.forEach(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key, output)); return output; }
  output.set(prefix, value); return output;
}
function rowResource(row) { return row && { id: row.id, source: 'resource', kind: row.manifest_kind, name: row.name,
  providerHostId: row.provider_host_id, resourceId: row.resource_id, revision: row.revision, ownershipMode: row.ownership_mode,
  owner: row.owner, deletionProtection: !!row.deletion_protection, document: parse(row.document_json, {}), documentHash: row.document_hash,
  resourceVersions: parse(row.resource_versions_json, {}), enabled: !!row.enabled, createdAt: row.created_at, updatedAt: row.updated_at }; }
function rowController(row) { return row && { id: row.id, name: row.name, manifestSource: row.manifest_source, manifestId: row.manifest_id,
  scopeType: row.scope_type, scopeKey: row.scope_key, mode: row.mode, intervalSeconds: row.interval_seconds,
  conflictPolicy: row.conflict_policy, enabled: !!row.enabled, state: row.state, pauseReason: row.pause_reason,
  lastStateHash: row.last_state_hash, lastPlanHash: row.last_plan_hash, lastCheckedAt: row.last_checked_at,
  nextCheckAt: row.next_check_at, createdAt: row.created_at }; }
function rowRun(row) { return row && { id: row.id, controllerId: row.controller_id, manifestSource: row.manifest_source,
  manifestId: row.manifest_id, triggerKind: row.trigger_kind, planHash: row.plan_hash, stateHash: row.state_hash,
  documentHash: row.document_hash, status: row.status, actions: parse(row.actions_json, []), blocked: parse(row.blocked_json, []),
  summary: parse(row.summary_json, {}), resourceVersions: parse(row.resource_versions_json, {}), evidence: parse(row.evidence_json, {}),
  commitSha: row.commit_sha, approvedAt: row.approved_at, createdAt: row.created_at }; }
function rowExternal(row) { return row && { id: row.id, sourceKind: row.source_kind, externalRef: row.external_ref,
  artifactHash: row.artifact_hash, status: row.status, plan: parse(row.normalized_plan_json, {}), policy: parse(row.policy_json, {}),
  cost: parse(row.cost_json, {}), blastRadius: parse(row.blast_radius_json, {}), approvedAt: row.approved_at, createdAt: row.created_at }; }

class InfrastructureDeliveryService {
  constructor(dbProvider = getDb, options = {}) { this._dbProvider = dbProvider; this._procedures = options.procedureRunner || procedures;
    this._automation = options.automationService || automation; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  normalizeResourceManifest(document, actor) {
    this._admin(actor); bounded(document, 'document', 256 * 1024); secretFree(document);
    if (document?.apiVersion !== API_VERSION) throw fail(`apiVersion must be ${API_VERSION}`);
    if (!['StorageResource', 'NetworkResource'].includes(document?.kind)) throw fail('kind must be StorageResource or NetworkResource');
    const metadata = object(document.metadata); const ownership = object(metadata.ownership);
    const ownershipMode = ownership.mode || 'external';
    if (!['managed', 'shared', 'external'].includes(ownershipMode)) throw fail('metadata.ownership.mode is invalid');
    const common = { name: string(metadata.name, 'metadata.name', 120, SAFE_NAME),
      providerHostId: integer(metadata.providerHostId ?? 0, 'metadata.providerHostId'),
      resourceId: optionalString(metadata.resourceId, 'metadata.resourceId', 120, /^ddr_(storage|network)_[a-f0-9]{26}$/),
      ownership: { mode: ownershipMode, owner: string(ownership.owner, 'metadata.ownership.owner', 120, SAFE_REF),
        deletionProtection: ownership.deletionProtection !== false } };
    const spec = object(document.spec); const policies = stringList(spec.policies, 'spec.policies'); const normalizedTags = tags(spec.tags);
    let normalizedSpec;
    if (document.kind === 'StorageResource') {
      const storageType = spec.storageType || 'datastore';
      if (!['block', 'file', 'object', 'datastore'].includes(storageType)) throw fail('spec.storageType is invalid');
      const deletionPolicy = spec.deletionPolicy || 'retain';
      if (!['retain', 'delete'].includes(deletionPolicy)) throw fail('spec.deletionPolicy is invalid');
      normalizedSpec = { storageType, capacityBytes: spec.capacityBytes == null ? null
        : integer(spec.capacityBytes, 'spec.capacityBytes', 1024 * 1024), classRef: optionalString(spec.classRef, 'spec.classRef', 300, SAFE_REF),
      shared: spec.shared === true, policies, tags: normalizedTags, deletionPolicy };
    } else {
      const networkType = spec.networkType || 'logical';
      if (!['bridge', 'vlan', 'overlay', 'logical'].includes(networkType)) throw fail('spec.networkType is invalid');
      const deletionPolicy = spec.deletionPolicy || 'retain';
      if (!['retain', 'delete'].includes(deletionPolicy)) throw fail('spec.deletionPolicy is invalid');
      normalizedSpec = { networkType, cidrs: stringList(spec.cidrs, 'spec.cidrs', 32), vlanId: spec.vlanId == null ? null
        : integer(spec.vlanId, 'spec.vlanId', 1, 4094), mtu: spec.mtu == null ? null : integer(spec.mtu, 'spec.mtu', 576, 9216),
      policies, tags: normalizedTags, deletionPolicy };
    }
    if (normalizedSpec.deletionPolicy === 'delete' && (ownershipMode !== 'managed' || common.ownership.deletionProtection)) {
      throw fail('delete policy requires managed ownership and deletionProtection=false', 409, 'DELETION_SAFEGUARD_REQUIRED');
    }
    return { apiVersion: API_VERSION, kind: document.kind, metadata: common, spec: normalizedSpec };
  }
  saveResourceManifest(body = {}, actor) {
    const document = this.normalizeResourceManifest(body.document || body, actor); const metadata = document.metadata;
    const kind = document.kind === 'StorageResource' ? 'storage' : 'network'; const documentHash = hash(document);
    const resourceVersions = versions(body.resourceVersions); const db = this._db();
    const existing = db.prepare(`SELECT * FROM infrastructure_resource_manifests
      WHERE manifest_kind=? AND provider_host_id=? AND name=?`).get(kind, metadata.providerHostId, metadata.name);
    if (existing?.document_hash === documentHash && existing.resource_versions_json === stable(resourceVersions)) {
      return { ...rowResource(existing), deduplicated: true };
    }
    if (existing) {
      db.prepare(`UPDATE infrastructure_resource_manifests SET resource_id=?,revision=revision+1,ownership_mode=?,owner=?,
        deletion_protection=?,document_json=?,document_hash=?,resource_versions_json=?,updated_by=?,updated_at=datetime('now') WHERE id=?`)
        .run(metadata.resourceId, metadata.ownership.mode, metadata.ownership.owner, metadata.ownership.deletionProtection ? 1 : 0,
          stable(document), documentHash, stable(resourceVersions), actor.id, existing.id);
      return { ...rowResource(db.prepare('SELECT * FROM infrastructure_resource_manifests WHERE id=?').get(existing.id)), deduplicated: false };
    }
    const result = db.prepare(`INSERT INTO infrastructure_resource_manifests
      (manifest_kind,name,provider_host_id,resource_id,ownership_mode,owner,deletion_protection,document_json,document_hash,
       resource_versions_json,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(kind, metadata.name,
      metadata.providerHostId, metadata.resourceId, metadata.ownership.mode, metadata.ownership.owner,
      metadata.ownership.deletionProtection ? 1 : 0, stable(document), documentHash, stable(resourceVersions), actor.id, actor.id);
    return { ...rowResource(db.prepare('SELECT * FROM infrastructure_resource_manifests WHERE id=?').get(result.lastInsertRowid)), deduplicated: false };
  }
  resourceManifests(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_resource_manifests ORDER BY updated_at DESC,id DESC').all().map(rowResource); }
  _manifest(source, id, actor) {
    const manifestId = integer(id, 'manifestId', 1);
    if (source === 'core') {
      const item = this._automation.manifest(manifestId, actor);
      return { ...item, source: 'core', ownershipMode: item.authoritative ? 'managed' : 'shared', deletionProtection: true };
    }
    if (source !== 'resource') throw fail('manifestSource must be core or resource');
    this._admin(actor); const item = rowResource(this._db().prepare('SELECT * FROM infrastructure_resource_manifests WHERE id=?').get(manifestId));
    if (!item) throw fail('Resource manifest not found', 404, 'MANIFEST_NOT_FOUND'); return item;
  }
  importLiveResource(body = {}, actor) {
    this._admin(actor); const document = body.document;
    if (!document) throw fail('A normalized live resource document is required');
    let normalized;
    if (['StorageResource', 'NetworkResource'].includes(document.kind)) normalized = this.normalizeResourceManifest(document, actor);
    else normalized = this._automation.validateManifest(document, actor).normalized;
    const resourceVersions = versions(body.resourceVersions); const documentHash = hash(normalized);
    return { apiVersion: API_VERSION, document: normalized, yaml: YAML.stringify(normalized, { lineWidth: 0 }), documentHash,
      resourceVersions, imported: true, secretFree: true, deterministic: stable(normalized) === stable(canonical(normalized)), persisted: false };
  }
  drift(input = {}, actor) {
    const manifest = this._manifest(input.manifestSource || 'core', input.manifestId, actor);
    const liveState = canonical(object(input.liveState?.spec || input.liveState)); bounded(liveState, 'liveState', 256 * 1024); secretFree(liveState, 'liveState');
    const currentVersions = versions(input.resourceVersions); const desired = manifest.document.spec;
    const desiredFlat = flatten(desired); const liveFlat = flatten(liveState); const paths = [...new Set([...desiredFlat.keys(), ...liveFlat.keys()])].sort();
    const actions = []; const blocked = [];
    for (const path of paths) {
      const hasDesired = desiredFlat.has(path); const hasLive = liveFlat.has(path); const before = liveFlat.get(path); const after = desiredFlat.get(path);
      if (hasDesired && hasLive && stable(before) === stable(after)) actions.push({ operation: 'unchanged', path });
      else if (hasDesired && !hasLive) actions.push({ operation: 'create', path, after });
      else if (hasDesired) actions.push({ operation: 'update', path, before, after });
      else if (manifest.ownershipMode !== 'managed') actions.push({ operation: 'unchanged', path, reason: 'outside managed ownership boundary' });
      else if (manifest.deletionProtection || manifest.document.spec.deletionPolicy !== 'delete') blocked.push({ operation: 'delete', path,
        reason: 'deletion requires managed ownership, deletionPolicy=delete and deletionProtection=false' });
      else actions.push({ operation: 'delete', path, before });
    }
    const summary = { create: 0, update: 0, delete: 0, unchanged: 0, blocked: blocked.length };
    actions.forEach(action => { summary[action.operation] += 1; });
    const stateHash = hash(liveState); const versionsHash = hash(currentVersions); const planHash = hash({ documentHash: manifest.documentHash,
      manifestRevision: manifest.revision, stateHash, versionsHash, actions, blocked });
    return { manifest: { source: manifest.source, id: manifest.id, kind: manifest.kind, name: manifest.name, revision: manifest.revision,
      owner: manifest.owner || null, ownershipMode: manifest.ownershipMode, deletionProtection: manifest.deletionProtection },
    documentHash: manifest.documentHash, stateHash, versionsHash, planHash, resourceVersions: currentVersions, actions, blocked, summary,
    drifted: summary.create + summary.update + summary.delete + summary.blocked > 0, providerMutationsScheduled: 0 };
  }
  createManualReconcile(body = {}, actor) {
    this._admin(actor); const plan = this.drift(body, actor); const commitSha = optionalString(body.commitSha, 'commitSha', 64, /^[a-fA-F0-9]{7,64}$/);
    const status = plan.blocked.length ? 'blocked' : plan.drifted ? 'planned' : 'in_sync';
    const result = this._db().prepare(`INSERT INTO infrastructure_reconcile_runs
      (manifest_source,manifest_id,trigger_kind,plan_hash,state_hash,document_hash,status,actions_json,blocked_json,summary_json,
       resource_versions_json,evidence_json,commit_sha,created_by) VALUES (?,?, 'manual',?,?,?,?,?,?,?,?,?,?,?)`).run(
      plan.manifest.source, plan.manifest.id, plan.planHash, plan.stateHash, plan.documentHash, status, stable(plan.actions), stable(plan.blocked),
      stable(plan.summary), stable(plan.resourceVersions), stable({ reviewedDiff: true,
        observedState: canonical(object(body.liveState?.spec || body.liveState)), providerMutationsScheduled: 0 }), commitSha, actor.id);
    return rowRun(this._db().prepare('SELECT * FROM infrastructure_reconcile_runs WHERE id=?').get(result.lastInsertRowid));
  }
  reconcileRuns(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_reconcile_runs ORDER BY created_at DESC,id DESC LIMIT 500').all().map(rowRun); }
  approveReconcile(runId, body = {}, actor) {
    this._admin(actor); const db = this._db(); const row = db.prepare('SELECT * FROM infrastructure_reconcile_runs WHERE id=?').get(integer(runId, 'runId', 1));
    if (!row) throw fail('Reconcile run not found', 404, 'RECONCILE_NOT_FOUND'); if (row.status !== 'planned') throw fail(`Reconcile run is ${row.status}`, 409, 'RECONCILE_NOT_PENDING');
    if (!body.planHash || !timingEqual(body.planHash, row.plan_hash)) throw fail('Reconcile plan is stale', 409, 'STALE_RECONCILE_PLAN');
    if (!body.liveState || typeof body.liveState !== 'object') throw fail('Fresh liveState evidence is required', 400, 'FRESH_STATE_REQUIRED');
    const fresh = this.drift({ manifestSource: row.manifest_source, manifestId: row.manifest_id,
      liveState: body.liveState, resourceVersions: body.resourceVersions }, actor);
    if (!timingEqual(fresh.planHash, row.plan_hash) || !timingEqual(fresh.stateHash, row.state_hash)) {
      db.prepare("UPDATE infrastructure_reconcile_runs SET status='stale' WHERE id=?").run(row.id);
      throw fail('Reconcile plan is stale; create and review a new plan', 409, 'STALE_RECONCILE_PLAN', {
        stateChanged: fresh.stateHash !== row.state_hash, versionsChanged: stable(fresh.resourceVersions) !== row.resource_versions_json,
        manifestChanged: fresh.documentHash !== row.document_hash,
      });
    }
    const summary = parse(row.summary_json, {}); const manifest = this._manifest(row.manifest_source, row.manifest_id, actor);
    if (summary.delete > 0 && body.confirmation !== `DELETE ${manifest.kind} ${manifest.name}`) {
      throw fail(`Deletion requires confirmation: DELETE ${manifest.kind} ${manifest.name}`, 409, 'DELETE_CONFIRMATION_REQUIRED');
    }
    db.prepare("UPDATE infrastructure_reconcile_runs SET status='approved',approved_by=?,approved_at=datetime('now') WHERE id=?").run(actor.id, row.id);
    return rowRun(db.prepare('SELECT * FROM infrastructure_reconcile_runs WHERE id=?').get(row.id));
  }
  applyReconcile(runId, body = {}, actor) {
    this._admin(actor); const db = this._db(); const row = db.prepare('SELECT * FROM infrastructure_reconcile_runs WHERE id=?').get(integer(runId, 'runId', 1));
    if (!row) throw fail('Reconcile run not found', 404, 'RECONCILE_NOT_FOUND'); if (row.status !== 'approved') throw fail('Reconcile run must be approved', 409, 'RECONCILE_NOT_APPROVED');
    if (!body.planHash || !timingEqual(body.planHash, row.plan_hash)) throw fail('Reconcile plan is stale', 409, 'STALE_RECONCILE_PLAN');
    const operations = [...new Set((Array.isArray(body.operationIds) ? body.operationIds : []).map(value => string(value, 'operationId', 80, /^op_[a-f0-9]{26}$/)))];
    const summary = parse(row.summary_json, {}); const mutations = Number(summary.create || 0) + Number(summary.update || 0) + Number(summary.delete || 0);
    if (mutations && !operations.length) throw fail('Provider mutations require existing allowlisted durable operation IDs', 409, 'DURABLE_OPERATION_REQUIRED');
    const manifest = this._manifest(row.manifest_source, row.manifest_id, actor); const evidence = [];
    for (const operationId of operations) {
      const operation = db.prepare('SELECT id,host_id,state,retry_policy,native_task_state,idempotency_key_hash,lock_scopes_json FROM provider_operations WHERE id=?').get(operationId);
      if (!operation) throw fail(`Provider operation ${operationId} not found`, 404, 'OPERATION_NOT_FOUND');
      if (manifest.providerHostId > 0 && operation.host_id !== manifest.providerHostId) throw fail('Provider operation host does not match manifest host', 409, 'OPERATION_HOST_MISMATCH');
      evidence.push({ operationId, state: operation.state, retryPolicy: operation.retry_policy, nativeTaskState: operation.native_task_state,
        idempotencyProtected: !!operation.idempotency_key_hash, lockScopes: parse(operation.lock_scopes_json, []) });
    }
    const status = evidence.every(item => item.state === 'succeeded') ? 'applied' : 'apply_authorized';
    db.prepare('UPDATE infrastructure_reconcile_runs SET status=?,evidence_json=? WHERE id=?').run(status,
      stable({ operations: evidence, externalExecutionStarted: false, note: 'Only pre-existing durable provider operations are referenced.' }), row.id);
    return { ...rowRun(db.prepare('SELECT * FROM infrastructure_reconcile_runs WHERE id=?').get(row.id)), externalExecutionStarted: false };
  }
  configureController(body = {}, actor) {
    this._admin(actor); const source = body.manifestSource || 'core'; const manifest = this._manifest(source, body.manifestId, actor);
    const name = string(body.name, 'name', 120, SAFE_NAME); const scopeType = body.scopeType || 'resource';
    if (!['resource', 'host', 'fabric'].includes(scopeType)) throw fail('scopeType is invalid');
    const mode = body.mode || 'observe'; if (!['observe', 'continuous'].includes(mode)) throw fail('mode is invalid');
    const observation = canonical(object(body.liveState?.spec || body.liveState)); bounded(observation, 'liveState', 256 * 1024); secretFree(observation, 'liveState');
    const currentVersions = versions(body.resourceVersions); const interval = integer(body.intervalSeconds ?? 900, 'intervalSeconds', 60, 86400);
    const result = this._db().prepare(`INSERT INTO infrastructure_reconcile_controllers
      (name,manifest_source,manifest_id,scope_type,scope_key,mode,interval_seconds,enabled,observation_json,
       observation_versions_json,next_check_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),?)`).run(name, source,
      manifest.id, scopeType, string(body.scopeKey || `${source}:${manifest.id}`, 'scopeKey', 300, SAFE_REF), mode, interval,
      body.enabled === true ? 1 : 0, stable(observation), stable(currentVersions), actor.id);
    return rowController(this._db().prepare('SELECT * FROM infrastructure_reconcile_controllers WHERE id=?').get(result.lastInsertRowid));
  }
  controllers(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_reconcile_controllers ORDER BY name').all().map(rowController); }
  updateControllerObservation(id, body = {}, actor) {
    this._admin(actor); const controllerId = integer(id, 'controllerId', 1); const observation = canonical(object(body.liveState?.spec || body.liveState));
    bounded(observation, 'liveState', 256 * 1024); secretFree(observation, 'liveState'); const currentVersions = versions(body.resourceVersions);
    const result = this._db().prepare(`UPDATE infrastructure_reconcile_controllers SET observation_json=?,observation_versions_json=?,
      state=CASE WHEN state IN ('paused','conflict') THEN state ELSE 'idle' END,updated_at=datetime('now') WHERE id=?`)
      .run(stable(observation), stable(currentVersions), controllerId);
    if (!result.changes) throw fail('Controller not found', 404, 'CONTROLLER_NOT_FOUND'); return this.runController(controllerId, actor);
  }
  resumeController(id, actor) {
    this._admin(actor); const result = this._db().prepare(`UPDATE infrastructure_reconcile_controllers SET state='idle',pause_reason=NULL,
      next_check_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(integer(id, 'controllerId', 1));
    if (!result.changes) throw fail('Controller not found', 404, 'CONTROLLER_NOT_FOUND');
    return rowController(this._db().prepare('SELECT * FROM infrastructure_reconcile_controllers WHERE id=?').get(Number(id)));
  }
  runController(id, actor) { this._admin(actor); return this._runController(integer(id, 'controllerId', 1), actor); }
  _runController(id, actor) {
    const db = this._db(); const raw = db.prepare('SELECT * FROM infrastructure_reconcile_controllers WHERE id=?').get(id);
    if (!raw) throw fail('Controller not found', 404, 'CONTROLLER_NOT_FOUND');
    if (['paused', 'conflict'].includes(raw.state)) throw fail('Controller is paused; resolve conflict and resume explicitly', 409, 'CONTROLLER_PAUSED');
    const plan = this.drift({ manifestSource: raw.manifest_source, manifestId: raw.manifest_id,
      liveState: parse(raw.observation_json, {}), resourceVersions: parse(raw.observation_versions_json, {}) }, actor);
    const pending = db.prepare("SELECT id,state_hash FROM infrastructure_reconcile_runs WHERE controller_id=? AND status='planned' ORDER BY id DESC LIMIT 1").get(id);
    if (pending && pending.state_hash === plan.stateHash && raw.last_plan_hash === plan.planHash) {
      const next = new Date(Date.now() + raw.interval_seconds * 1000).toISOString();
      db.prepare("UPDATE infrastructure_reconcile_controllers SET last_checked_at=datetime('now'),next_check_at=?,updated_at=datetime('now') WHERE id=?")
        .run(next, id);
      return { controller: rowController(db.prepare('SELECT * FROM infrastructure_reconcile_controllers WHERE id=?').get(id)),
        run: rowRun(db.prepare('SELECT * FROM infrastructure_reconcile_runs WHERE id=?').get(pending.id)), deduplicated: true,
        providerMutationsScheduled: 0 };
    }
    if (pending && raw.last_state_hash && raw.last_state_hash !== plan.stateHash) {
      db.prepare("UPDATE infrastructure_reconcile_runs SET status='conflict' WHERE id=?").run(pending.id);
      db.prepare(`UPDATE infrastructure_reconcile_controllers SET state='conflict',pause_reason=?,last_checked_at=datetime('now'),
        updated_at=datetime('now') WHERE id=?`).run('Live state changed while a prior reconcile plan was pending', id);
      return { controller: rowController(db.prepare('SELECT * FROM infrastructure_reconcile_controllers WHERE id=?').get(id)), conflict: true,
        providerMutationsScheduled: 0 };
    }
    const status = plan.blocked.length ? 'blocked' : plan.drifted ? 'planned' : 'in_sync';
    const result = db.prepare(`INSERT INTO infrastructure_reconcile_runs
      (controller_id,manifest_source,manifest_id,trigger_kind,plan_hash,state_hash,document_hash,status,actions_json,blocked_json,
       summary_json,resource_versions_json,evidence_json,created_by) VALUES (?,?,?,'continuous',?,?,?,?,?,?,?,?,?,?)`).run(id,
      raw.manifest_source, raw.manifest_id, plan.planHash, plan.stateHash, plan.documentHash, status, stable(plan.actions), stable(plan.blocked),
      stable(plan.summary), stable(plan.resourceVersions), stable({ mode: raw.mode, providerMutationsScheduled: 0 }), raw.created_by);
    const next = new Date(Date.now() + raw.interval_seconds * 1000).toISOString(); const state = status === 'in_sync' ? 'in_sync' : status === 'blocked' ? 'paused' : 'drifted';
    db.prepare(`UPDATE infrastructure_reconcile_controllers SET state=?,pause_reason=?,last_state_hash=?,last_plan_hash=?,
      last_checked_at=datetime('now'),next_check_at=?,updated_at=datetime('now') WHERE id=?`).run(state,
      status === 'blocked' ? 'Drift contains blocked ownership/deletion actions' : null, plan.stateHash, plan.planHash, next, id);
    return { controller: rowController(db.prepare('SELECT * FROM infrastructure_reconcile_controllers WHERE id=?').get(id)),
      run: rowRun(db.prepare('SELECT * FROM infrastructure_reconcile_runs WHERE id=?').get(result.lastInsertRowid)), providerMutationsScheduled: 0 };
  }
  runDueControllers() {
    const db = this._db(); const rows = db.prepare(`SELECT * FROM infrastructure_reconcile_controllers WHERE enabled=1
      AND mode='continuous' AND state NOT IN ('paused','conflict') AND (next_check_at IS NULL OR datetime(next_check_at)<=datetime('now')) LIMIT 25`).all();
    const results = [];
    for (const row of rows) {
      const actor = { id: row.created_by || 0, role: 'admin', username: 'infrastructure-controller' };
      try { results.push(this._runController(row.id, actor)); }
      catch (error) { db.prepare("UPDATE infrastructure_reconcile_controllers SET state='error',pause_reason=?,updated_at=datetime('now') WHERE id=?")
        .run(String(error.message).slice(0, 500), row.id); results.push({ controllerId: row.id, error: error.message }); }
    }
    return results;
  }
  previewPullRequest(body = {}, actor) {
    this._admin(actor); const plan = this.drift(body, actor); const externalRef = string(body.externalRef, 'externalRef', 200, SAFE_REF);
    const rates = object(body.monthlyRates); const desired = this._manifest(body.manifestSource || 'core', body.manifestId, actor).document.spec;
    const live = object(body.liveState?.spec || body.liveState); const deltas = {
      cpu: numericDelta(desired.hardware?.cpuCount, live.hardware?.cpuCount),
      memoryGiB: numericDelta(desired.hardware?.memoryBytes, live.hardware?.memoryBytes, 1024 ** 3),
      storageGiB: numericDelta(desired.capacityBytes, live.capacityBytes, 1024 ** 3),
    };
    const rateValues = { cpu: finiteRate(rates.cpuPerMonth), memoryGiB: finiteRate(rates.memoryGiBPerMonth), storageGiB: finiteRate(rates.storageGiBPerMonth) };
    const known = Object.values(rateValues).some(value => value != null); const monthlyDelta = known
      ? Object.entries(deltas).reduce((sum, [key, value]) => sum + value * (rateValues[key] || 0), 0) : null;
    const policy = { passed: plan.blocked.length === 0, findings: plan.blocked, deletionApprovalRequired: plan.summary.delete > 0,
      ownershipMode: plan.manifest.ownershipMode };
    const cost = { currency: string(body.currency || 'USD', 'currency', 3, /^[A-Z]{3}$/), monthlyDeltaEstimate: monthlyDelta,
      deltas, confidence: known ? 'operator-rate-estimate' : 'unknown', externalBillingQueryPerformed: false };
    const blastRadius = { changedPaths: plan.actions.filter(item => item.operation !== 'unchanged').length,
      destructivePaths: plan.summary.delete + plan.summary.blocked, scope: `${plan.manifest.source}:${plan.manifest.id}`,
      risk: plan.summary.delete + plan.summary.blocked > 0 ? 'high' : plan.summary.update > 5 ? 'medium' : 'low' };
    const normalized = { planHash: plan.planHash, manifest: plan.manifest, summary: plan.summary, actions: plan.actions, blocked: plan.blocked };
    return this._saveExternal('pull_request', externalRef, normalized, policy, cost, blastRadius, actor.id);
  }
  terraformImportMappings(body = {}, actor) {
    this._admin(actor); const resources = Array.isArray(body.resources) ? body.resources : [];
    if (!resources.length || resources.length > 500) throw fail('resources must contain 1-500 entries'); bounded(resources, 'resources'); secretFree(resources, 'resources');
    const mappings = resources.map((item, index) => { const address = string(item.address, `resources[${index}].address`, 300,
      /^(?:module\.[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\[[^\]\r\n]+\])?$/);
    const canonicalId = string(item.canonicalId, `resources[${index}].canonicalId`, 120, /^ddr_[a-z]+_[a-f0-9]{26}$/);
    return { address, type: string(item.type, `resources[${index}].type`, 100, SAFE_REF), canonicalId,
      command: `terraform import ${shellQuote(address)} ${shellQuote(canonicalId)}` }; });
    return { mappings, stateOwnershipTaken: false, providerQueriesPerformed: 0, generatedAt: new Date().toISOString() };
  }
  ingestTerraformPlan(body = {}, actor) {
    this._admin(actor); const artifact = object(body.plan || body.artifact); bounded(artifact, 'terraformPlan');
    const changes = Array.isArray(artifact.resource_changes) ? artifact.resource_changes : [];
    if (changes.length > 500) throw fail('Terraform plan supports at most 500 resource changes');
    const normalizedChanges = changes.map((item, index) => {
      const address = string(item.address, `resource_changes[${index}].address`, 300,
        /^(?:module\.[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\[[^\]\r\n]+\])?$/);
      const actions = stringList(item.change?.actions, `resource_changes[${index}].change.actions`, 4);
      if (!actions.every(action => ['create', 'read', 'update', 'delete', 'no-op'].includes(action))) throw fail(`resource_changes[${index}] contains an unsupported action`);
      return { address, type: string(item.type, `resource_changes[${index}].type`, 100, SAFE_REF), actions,
        sensitiveValuesRedacted: containsTrue(item.change?.before_sensitive) || containsTrue(item.change?.after_sensitive) };
    });
    const summary = { create: 0, update: 0, delete: 0, replace: 0, noOp: 0 };
    normalizedChanges.forEach(item => { if (item.actions.includes('delete') && item.actions.includes('create')) summary.replace += 1;
      else if (item.actions.includes('delete')) summary.delete += 1; else if (item.actions.includes('create')) summary.create += 1;
      else if (item.actions.includes('update')) summary.update += 1; else summary.noOp += 1; });
    const destructive = summary.delete + summary.replace; const policy = { passed: destructive === 0,
      findings: destructive ? [{ code: 'DESTRUCTIVE_TERRAFORM_CHANGE', count: destructive }] : [], sensitiveValuesStored: false };
    const normalized = { formatVersion: optionalString(artifact.format_version, 'format_version', 40, SAFE_REF), terraformVersion:
      optionalString(artifact.terraform_version, 'terraform_version', 40, SAFE_REF), summary, resourceChanges: normalizedChanges };
    return this._saveExternal('terraform', string(body.externalRef, 'externalRef', 200, SAFE_REF), normalized, policy,
      { confidence: 'not-calculated', externalBillingQueryPerformed: false }, { changedResources: normalizedChanges.length,
        destructiveResources: destructive, risk: destructive ? 'high' : normalizedChanges.length > 20 ? 'medium' : 'low' }, actor.id, hash(artifact));
  }
  _saveExternal(kind, reference, plan, policy, cost, blastRadius, userId,
    artifactHash = hash({ kind, reference, plan, policy, cost, blastRadius })) {
    const db = this._db(); const existing = db.prepare('SELECT * FROM infrastructure_external_plans WHERE artifact_hash=?').get(artifactHash);
    if (existing) return { ...rowExternal(existing), deduplicated: true };
    const status = policy.passed ? 'reviewed' : 'blocked';
    const result = db.prepare(`INSERT INTO infrastructure_external_plans
      (source_kind,external_ref,artifact_hash,status,normalized_plan_json,policy_json,cost_json,blast_radius_json,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(kind, reference, artifactHash, status, stable(plan), stable(policy), stable(cost), stable(blastRadius), userId);
    return { ...rowExternal(db.prepare('SELECT * FROM infrastructure_external_plans WHERE id=?').get(result.lastInsertRowid)), deduplicated: false };
  }
  authorizeExternalPlan(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const row = db.prepare('SELECT * FROM infrastructure_external_plans WHERE id=?').get(integer(id, 'planId', 1));
    if (!row) throw fail('External plan not found', 404, 'EXTERNAL_PLAN_NOT_FOUND'); if (!['reviewed', 'blocked'].includes(row.status)) throw fail(`External plan is ${row.status}`, 409);
    const phrase = row.source_kind === 'terraform' ? `AUTHORIZE TERRAFORM ${row.id}` : `APPROVE PREVIEW ${row.id}`;
    if (body.confirmation !== phrase) throw fail(`Confirmation must be: ${phrase}`, 409, 'EXTERNAL_PLAN_CONFIRMATION_REQUIRED');
    const policy = parse(row.policy_json, {}); if (!policy.passed && body.allowPolicyOverride !== true) throw fail('Blocked policy requires explicit override', 409, 'POLICY_OVERRIDE_REQUIRED');
    db.prepare("UPDATE infrastructure_external_plans SET status='apply_authorized',approved_by=?,approved_at=datetime('now') WHERE id=?").run(actor.id, row.id);
    return { ...rowExternal(db.prepare('SELECT * FROM infrastructure_external_plans WHERE id=?').get(row.id)), externalExecutionStarted: false,
      note: 'Authorization is recorded; Docker Dash does not run Terraform or merge the pull request.' };
  }
  externalPlans(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_external_plans ORDER BY created_at DESC,id DESC LIMIT 500').all().map(rowExternal); }
  ansibleInventory(actor) {
    this._admin(actor); const db = this._db(); const hosts = db.prepare('SELECT id,name,daemon_type,environment,is_active FROM docker_hosts ORDER BY name').all();
    const variables = {}; const groups = { all: { hosts: [], children: [] } };
    const add = (group, host) => { if (!groups[group]) groups[group] = { hosts: [] }; if (!groups[group].hosts.includes(host)) groups[group].hosts.push(host); };
    for (const host of hosts) { const alias = safeGroup(host.name); groups.all.hosts.push(alias); add(`provider_${safeGroup(host.daemon_type || 'docker')}`, alias);
      add(`environment_${safeGroup(host.environment || 'development')}`, alias); variables[alias] = { docker_dash_host_id: host.id,
        docker_dash_name: host.name, docker_dash_provider: host.daemon_type || 'docker', docker_dash_active: !!host.is_active,
        docker_dash_secret_ref: `existing-host/${host.name}` }; }
    const resourceRows = db.prepare('SELECT * FROM infrastructure_resource_manifests WHERE enabled=1 ORDER BY name').all().map(rowResource);
    for (const manifest of resourceRows) { const group = `${manifest.kind}_${safeGroup(manifest.owner)}`; groups[group] = groups[group] || { hosts: [] };
      const host = hosts.find(item => item.id === manifest.providerHostId); if (host) add(group, safeGroup(host.name)); }
    groups.all.children = Object.keys(groups).filter(key => key !== 'all').sort(); Object.values(groups).forEach(group => group.hosts?.sort());
    const inventory = { _meta: { hostvars: variables }, ...Object.fromEntries(Object.entries(groups).sort()) };
    return { inventory, yaml: YAML.stringify(inventory, { lineWidth: 0 }), secretValuesIncluded: false,
      secretReferenceScheme: 'existing-host/<name>', generatedAt: new Date().toISOString() };
  }
  createWebhookTrigger(body = {}, actor) {
    this._admin(actor); const db = this._db(); const procedureId = integer(body.procedureId, 'procedureId', 1);
    const procedure = db.prepare('SELECT id,is_active FROM procedures WHERE id=?').get(procedureId);
    if (!procedure) throw fail('Procedure not found', 404, 'PROCEDURE_NOT_FOUND'); if (!procedure.is_active) throw fail('Procedure is disabled', 409, 'PROCEDURE_DISABLED');
    const events = stringList(body.events, 'events', 20); if (!events.length) throw fail('At least one allowlisted event is required');
    const token = generateToken(24); const secret = generateToken(32); const result = db.prepare(`INSERT INTO infrastructure_webhook_triggers
      (name,token_hash,token_prefix,secret_enc,procedure_id,event_allowlist_json,timestamp_skew_seconds,enabled,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(string(body.name, 'name', 120, SAFE_NAME), sha256(token), token.slice(0, 8), encrypt(secret), procedureId,
      stable(events), integer(body.timestampSkewSeconds ?? 300, 'timestampSkewSeconds', 30, 900), body.enabled === false ? 0 : 1, actor.id);
    return { trigger: this._publicTrigger(db.prepare('SELECT * FROM infrastructure_webhook_triggers WHERE id=?').get(result.lastInsertRowid)), token, secret,
      signatureInput: '<timestamp>.<nonce>.<event>.<raw-body>', shownOnce: true };
  }
  _publicTrigger(row) { return row && { id: row.id, name: row.name, tokenPrefix: row.token_prefix, procedureId: row.procedure_id,
    events: parse(row.event_allowlist_json, []), timestampSkewSeconds: row.timestamp_skew_seconds, enabled: !!row.enabled,
    createdAt: row.created_at, endpoint: `/api/automation/webhooks/${row.token_prefix}…` }; }
  webhookTriggers(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_webhook_triggers ORDER BY name').all().map(row => this._publicTrigger(row)); }
  receiveWebhook(token, headers = {}, rawBody = '') {
    const db = this._db(); const value = string(token, 'token', 96, /^[a-f0-9]{48}$/); const row = db.prepare('SELECT * FROM infrastructure_webhook_triggers WHERE token_hash=?').get(sha256(value));
    if (!row || !row.enabled) throw fail('Webhook trigger not found', 404, 'WEBHOOK_NOT_FOUND');
    const timestamp = Number(headers['x-docker-dash-timestamp']); const nonce = string(headers['x-docker-dash-nonce'], 'nonce', 128, /^[a-zA-Z0-9_.:-]{16,128}$/);
    const event = string(headers['x-docker-dash-event'], 'event', 80, SAFE_REF); const signature = string(headers['x-docker-dash-signature'], 'signature', 80, /^sha256=[a-f0-9]{64}$/);
    if (!Number.isInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > row.timestamp_skew_seconds) throw fail('Webhook timestamp is outside the accepted window', 401, 'WEBHOOK_TIMESTAMP_INVALID');
    if (!parse(row.event_allowlist_json, []).includes(event)) throw fail('Webhook event is not allowlisted', 403, 'WEBHOOK_EVENT_DENIED');
    const body = String(rawBody || ''); if (Buffer.byteLength(body) > 256 * 1024) throw fail('Webhook body exceeds 256 KiB', 413, 'WEBHOOK_BODY_TOO_LARGE');
    const expected = `sha256=${hmacSign(`${timestamp}.${nonce}.${event}.${body}`, decrypt(row.secret_enc))}`;
    if (!timingEqual(signature, expected)) throw fail('Webhook signature is invalid', 401, 'WEBHOOK_SIGNATURE_INVALID');
    let deliveryId;
    try { deliveryId = Number(db.prepare(`INSERT INTO infrastructure_webhook_deliveries
      (trigger_id,nonce_hash,event_type,payload_hash,status) VALUES (?,?,?,?, 'accepted')`).run(row.id, sha256(nonce), event, sha256(body)).lastInsertRowid); }
    catch (error) { if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Webhook nonce was already used', 409, 'WEBHOOK_REPLAY'); throw error; }
    try {
      const run = this._procedures.run(row.procedure_id, { userId: row.created_by, username: `webhook:${row.name}`, isAdmin: true });
      db.prepare("UPDATE infrastructure_webhook_deliveries SET status='started',procedure_run_id=? WHERE id=?").run(run.id, deliveryId);
      return { accepted: true, deliveryId, procedureRunId: run.id, event, replayProtected: true };
    } catch (error) {
      db.prepare("UPDATE infrastructure_webhook_deliveries SET status='failed',reason=? WHERE id=?").run(String(error.message).slice(0, 500), deliveryId);
      throw fail('Allowlisted procedure could not be started', error.status || 500, 'WEBHOOK_PROCEDURE_FAILED');
    }
  }
  overview(actor) {
    this._admin(actor); return { capabilities: { storageNetworkManifest: true, liveImport: true,
      declarativeDrift: true, manualGitOpsReconcile: true, continuousGitOpsReconcile: true, pullRequestPreview: true,
      terraformImport: true, terraformRunIntegration: true, ansibleInventory: true, webhookRunbooks: true },
    resourceManifests: this.resourceManifests(actor), controllers: this.controllers(actor), reconcileRuns: this.reconcileRuns(actor),
    externalPlans: this.externalPlans(actor), webhookTriggers: this.webhookTriggers(actor),
    boundaries: { continuousProviderMutations: false, terraformExecution: false, pullRequestMerge: false, secretsReturned: false,
      fleetGitOpsEngineReused: true } };
  }
}

function timingEqual(left, right) { if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
function numericDelta(desired, live, divisor = 1) { const after = Number(desired); const before = Number(live);
  return Number.isFinite(after) && Number.isFinite(before) ? (after - before) / divisor : 0; }
function finiteRate(value) { const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : null; }
function containsTrue(value) { if (value === true) return true; if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsTrue); }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function safeGroup(value) { return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([^a-z_])/, '_$1').slice(0, 100); }

const service = new InfrastructureDeliveryService();
module.exports = service;
module.exports.InfrastructureDeliveryService = InfrastructureDeliveryService;
module.exports.InfrastructureDeliveryError = InfrastructureDeliveryError;
module.exports._internals = { canonical, stable, hash, flatten, timingEqual, containsTrue, shellQuote, safeGroup };
