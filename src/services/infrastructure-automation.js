'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const API_VERSION = 'docker-dash.io/v1alpha1';
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_STEPS = 50;
const SENSITIVE_KEY = /password|secret|token|credential|private.?key|authorization|cookie/i;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,299}$/;
const SAFE_ACTION = /^[a-z][a-z0-9_.-]{1,79}$/;

class InfrastructureAutomationError extends Error {
  constructor(message, status = 400, code = 'INFRASTRUCTURE_AUTOMATION_ERROR', details) {
    super(message); this.name = 'InfrastructureAutomationError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new InfrastructureAutomationError(message, status, code, details);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`);
  return result;
};
const string = (value, key, max = 300, pattern) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`);
  return result;
};
const optionalString = (value, key, max = 300, pattern) => value == null || value === '' ? null : string(value, key, max, pattern);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function stable(value) { return JSON.stringify(canonical(value)); }
function hash(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex'); }
function assertBounded(value, key = 'document') {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > MAX_DOCUMENT_BYTES) throw fail(`${key} exceeds ${MAX_DOCUMENT_BYTES} bytes`, 413, 'AUTOMATION_DOCUMENT_TOO_LARGE');
}
function assertSecretFree(value, path = 'document') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw fail(`${path}.${key} may not contain secret material; use an external secret reference in a later broker workflow`, 400, 'MANIFEST_SECRET_FIELD');
    assertSecretFree(child, `${path}.${key}`);
  }
}
function stringList(value, key, max = 64) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw fail(`${key} must be an array with at most ${max} entries`);
  const result = [...new Set(value.map((item, index) => string(item, `${key}[${index}]`, 300, SAFE_REF)))];
  return result.sort();
}
function tags(value, key = 'spec.tags') {
  const input = object(value); const entries = Object.entries(input);
  if (entries.length > 64) throw fail(`${key} supports at most 64 entries`);
  return Object.fromEntries(entries.map(([name, item]) => [string(name, `${key}.key`, 64, SAFE_NAME), string(item, `${key}.${name}`, 240)]).sort());
}
function versions(value) {
  const input = object(value); const entries = Object.entries(input);
  if (entries.length > 200) throw fail('resourceVersions supports at most 200 entries');
  return Object.fromEntries(entries.map(([key, item]) => [string(key, 'resourceVersions.key', 300, SAFE_REF),
    string(item, `resourceVersions.${key}`, 300)]).sort());
}
function normalizeMetadata(document, expectedKind) {
  if (document.apiVersion !== API_VERSION) throw fail(`apiVersion must be ${API_VERSION}`);
  if (document.kind !== expectedKind) throw fail(`kind must be ${expectedKind}`);
  const metadata = object(document.metadata); const providerHostId = integer(metadata.providerHostId ?? 0, 'metadata.providerHostId');
  const resourceId = optionalString(metadata.resourceId, 'metadata.resourceId', 120, /^ddr_(vm|host|cluster)_[a-f0-9]{26}$/);
  return { name: string(metadata.name, 'metadata.name', 120, SAFE_NAME), providerHostId, resourceId,
    authoritative: metadata.authoritative === true };
}
function normalizeVm(document) {
  const metadata = normalizeMetadata(document, 'VirtualMachine'); const spec = object(document.spec);
  const hardware = object(spec.hardware); const image = object(spec.image);
  const cpuCount = integer(hardware.cpuCount, 'spec.hardware.cpuCount', 1, 1024);
  const memoryBytes = integer(hardware.memoryBytes, 'spec.hardware.memoryBytes', 128 * 1024 * 1024, Number.MAX_SAFE_INTEGER);
  const artifactId = optionalString(image.artifactId, 'spec.image.artifactId', 120, /^dda_art_[a-f0-9]{26}$/);
  const imageRef = optionalString(image.imageRef, 'spec.image.imageRef', 300, SAFE_REF);
  if ((artifactId ? 1 : 0) + (imageRef ? 1 : 0) !== 1) throw fail('spec.image requires exactly one artifactId or imageRef');
  const networkRows = Array.isArray(spec.networks) ? spec.networks : [];
  if (networkRows.length > 32) throw fail('spec.networks supports at most 32 entries');
  const networks = networkRows.map((row, index) => ({ networkRef: string(row?.networkRef, `spec.networks[${index}].networkRef`, 300, SAFE_REF),
    model: optionalString(row?.model, `spec.networks[${index}].model`, 60, SAFE_NAME), connected: row?.connected !== false }))
    .sort((left, right) => left.networkRef.localeCompare(right.networkRef));
  const storageRows = Array.isArray(spec.storage) ? spec.storage : [];
  if (storageRows.length > 64) throw fail('spec.storage supports at most 64 entries');
  const storage = storageRows.map((row, index) => ({ name: string(row?.name, `spec.storage[${index}].name`, 120, SAFE_NAME),
    sizeBytes: integer(row?.sizeBytes, `spec.storage[${index}].sizeBytes`, 1024 * 1024),
    storageRef: optionalString(row?.storageRef, `spec.storage[${index}].storageRef`, 300, SAFE_REF), boot: row?.boot === true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (storage.filter(row => row.boot).length > 1) throw fail('spec.storage may contain at most one boot disk');
  const desiredPowerState = spec.desiredPowerState || 'unchanged';
  if (!['unchanged', 'running', 'stopped'].includes(desiredPowerState)) throw fail('spec.desiredPowerState is invalid');
  return { apiVersion: API_VERSION, kind: 'VirtualMachine', metadata, spec: { hardware: { cpuCount, memoryBytes },
    image: artifactId ? { artifactId } : { imageRef }, networks, storage, policies: stringList(spec.policies, 'spec.policies'),
    tags: tags(spec.tags), desiredPowerState } };
}
function normalizeHost(document) {
  const metadata = normalizeMetadata(document, 'Host'); const spec = object(document.spec);
  const maintenanceMode = spec.maintenanceMode || 'normal';
  if (!['normal', 'maintenance'].includes(maintenanceMode)) throw fail('spec.maintenanceMode is invalid');
  return { apiVersion: API_VERSION, kind: 'Host', metadata, spec: { maintenanceMode, tags: tags(spec.tags),
    policies: stringList(spec.policies, 'spec.policies'), fabricRefs: stringList(spec.fabricRefs, 'spec.fabricRefs') } };
}
function normalizeFabric(document) {
  const metadata = normalizeMetadata(document, 'Fabric'); const spec = object(document.spec);
  const maintenanceMode = spec.maintenanceMode || 'normal';
  if (!['normal', 'maintenance', 'draining'].includes(maintenanceMode)) throw fail('spec.maintenanceMode is invalid');
  return { apiVersion: API_VERSION, kind: 'Fabric', metadata, spec: { maintenanceMode, tags: tags(spec.tags),
    policies: stringList(spec.policies, 'spec.policies'), memberRefs: stringList(spec.memberRefs, 'spec.memberRefs', 500) } };
}
function flatten(value, prefix = '', output = new Map()) {
  if (Array.isArray(value)) {
    if (!value.length) output.set(prefix, []);
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, output)); return output;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) output.set(prefix, {});
    for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, output);
    return output;
  }
  output.set(prefix, value); return output;
}
function rowManifest(row) { return row && { id: row.id, kind: row.manifest_kind, name: row.name, providerHostId: row.provider_host_id,
  resourceId: row.resource_id, revision: row.revision, authoritative: !!row.authoritative, document: parse(row.document_json, {}),
  documentHash: row.document_hash, resourceVersions: parse(row.resource_versions_json, {}), enabled: !!row.enabled,
  createdAt: row.created_at, updatedAt: row.updated_at }; }
function rowPlan(row) { return row && { id: row.id, manifestId: row.manifest_id, manifestRevision: row.manifest_revision,
  manifestHash: row.manifest_hash, stateHash: row.state_hash, versionsHash: row.versions_hash, planHash: row.plan_hash,
  status: row.status, actions: parse(row.actions_json, []), blocked: parse(row.blocked_json, []), summary: parse(row.summary_json, {}),
  resourceVersions: parse(row.resource_versions_json, {}), expiresAt: row.expires_at, acceptedAt: row.accepted_at, createdAt: row.created_at }; }
function rowWorkflow(row) { return row && { id: row.id, name: row.name, version: row.version, description: row.description,
  steps: parse(row.steps_json, []), definitionHash: row.definition_hash, enabled: !!row.enabled, createdAt: row.created_at }; }

class InfrastructureAutomationService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  normalizeManifest(document, actor) {
    this._admin(actor); assertBounded(document); assertSecretFree(document);
    if (document?.kind === 'VirtualMachine') return normalizeVm(document);
    if (document?.kind === 'Host') return normalizeHost(document);
    if (document?.kind === 'Fabric') return normalizeFabric(document);
    throw fail('kind must be VirtualMachine, Host or Fabric');
  }
  validateManifest(document, actor) {
    const normalized = this.normalizeManifest(document, actor);
    return { valid: true, normalized, documentHash: hash(normalized), secretFree: true };
  }
  saveManifest(body = {}, actor) {
    const document = this.normalizeManifest(body.document || body, actor); const db = this._db(); const metadata = document.metadata;
    const kind = { VirtualMachine: 'vm', Host: 'host', Fabric: 'fabric' }[document.kind]; const documentHash = hash(document);
    const resourceVersions = versions(body.resourceVersions); const existing = db.prepare(`SELECT * FROM infrastructure_manifests
      WHERE manifest_kind=? AND provider_host_id=? AND name=?`).get(kind, metadata.providerHostId, metadata.name);
    if (existing?.document_hash === documentHash && existing.resource_versions_json === stable(resourceVersions)) {
      return { ...rowManifest(existing), deduplicated: true };
    }
    if (existing) {
      db.prepare(`UPDATE infrastructure_manifests SET resource_id=?,revision=revision+1,authoritative=?,document_json=?,document_hash=?,
        resource_versions_json=?,updated_by=?,updated_at=datetime('now') WHERE id=?`).run(metadata.resourceId, metadata.authoritative ? 1 : 0,
        stable(document), documentHash, stable(resourceVersions), actor.id, existing.id);
      return { ...rowManifest(db.prepare('SELECT * FROM infrastructure_manifests WHERE id=?').get(existing.id)), deduplicated: false };
    }
    const result = db.prepare(`INSERT INTO infrastructure_manifests
      (manifest_kind,name,provider_host_id,resource_id,authoritative,document_json,document_hash,resource_versions_json,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(kind, metadata.name, metadata.providerHostId, metadata.resourceId,
      metadata.authoritative ? 1 : 0, stable(document), documentHash, stable(resourceVersions), actor.id, actor.id);
    return { ...rowManifest(db.prepare('SELECT * FROM infrastructure_manifests WHERE id=?').get(result.lastInsertRowid)), deduplicated: false };
  }
  manifests(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_manifests ORDER BY updated_at DESC,id DESC').all().map(rowManifest); }
  manifest(id, actor) { this._admin(actor); const row = rowManifest(this._db().prepare('SELECT * FROM infrastructure_manifests WHERE id=?').get(integer(id, 'manifestId', 1)));
    if (!row) throw fail('Manifest not found', 404, 'MANIFEST_NOT_FOUND'); return row; }
  createPlan(manifestId, body = {}, actor) {
    const manifest = this.manifest(manifestId, actor); const liveState = object(body.liveState?.spec || body.liveState);
    assertBounded(liveState, 'liveState'); assertSecretFree(liveState, 'liveState'); const currentVersions = versions(body.resourceVersions);
    const desired = manifest.document.spec; const desiredFlat = flatten(desired); const liveFlat = flatten(canonical(liveState));
    const paths = [...new Set([...desiredFlat.keys(), ...liveFlat.keys()])].sort(); const actions = []; const blocked = [];
    for (const path of paths) {
      const hasDesired = desiredFlat.has(path); const hasLive = liveFlat.has(path); const before = liveFlat.get(path); const after = desiredFlat.get(path);
      if (hasDesired && hasLive && stable(before) === stable(after)) actions.push({ operation: 'unchanged', path });
      else if (hasDesired && !hasLive) actions.push({ operation: 'create', path, after });
      else if (hasDesired) actions.push({ operation: 'update', path, before, after });
      else if (!manifest.authoritative) actions.push({ operation: 'unchanged', path, reason: 'outside non-authoritative ownership boundary' });
      else if (/^(storage|networks|image)(\[|\.|$)/.test(path)) blocked.push({ operation: 'delete', path,
        reason: 'storage/network deletion safeguards are deferred to B236; remove is blocked' });
      else actions.push({ operation: 'delete', path, before });
    }
    const summary = { create: 0, update: 0, delete: 0, unchanged: 0, blocked: blocked.length };
    for (const action of actions) summary[action.operation] += 1;
    const stateHash = hash(liveState); const versionsHash = hash(currentVersions); const planHash = hash({ manifestHash: manifest.documentHash,
      revision: manifest.revision, stateHash, versionsHash, actions, blocked });
    const existing = this._db().prepare('SELECT * FROM infrastructure_change_plans WHERE plan_hash=?').get(planHash);
    if (existing) return { ...rowPlan(existing), deduplicated: true };
    const ttlMinutes = integer(body.ttlMinutes ?? 30, 'ttlMinutes', 5, 1440);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
    const result = this._db().prepare(`INSERT INTO infrastructure_change_plans
      (manifest_id,manifest_revision,manifest_hash,state_hash,versions_hash,plan_hash,actions_json,blocked_json,summary_json,
       resource_versions_json,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(manifest.id, manifest.revision,
      manifest.documentHash, stateHash, versionsHash, planHash, stable(actions), stable(blocked), stable(summary), stable(currentVersions), expiresAt, actor.id);
    return { ...rowPlan(this._db().prepare('SELECT * FROM infrastructure_change_plans WHERE id=?').get(result.lastInsertRowid)), deduplicated: false };
  }
  plans(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_change_plans ORDER BY created_at DESC,id DESC LIMIT 1000').all().map(rowPlan); }
  revalidatePlan(planId, body = {}, actor) {
    this._admin(actor); const db = this._db(); const id = integer(planId, 'planId', 1);
    const raw = db.prepare('SELECT * FROM infrastructure_change_plans WHERE id=?').get(id);
    if (!raw) throw fail('Plan not found', 404, 'PLAN_NOT_FOUND'); const plan = rowPlan(raw);
    if (plan.status !== 'planned') throw fail(`Plan is ${plan.status}`, 409, 'PLAN_NOT_PENDING');
    const manifest = db.prepare('SELECT * FROM infrastructure_manifests WHERE id=?').get(plan.manifestId);
    const liveState = object(body.liveState?.spec || body.liveState); assertBounded(liveState, 'liveState'); assertSecretFree(liveState, 'liveState');
    const currentVersions = versions(body.resourceVersions); const evidence = { expired: Date.parse(plan.expiresAt) <= Date.now(),
      manifestChanged: !manifest || manifest.document_hash !== plan.manifestHash || manifest.revision !== plan.manifestRevision,
      stateChanged: hash(liveState) !== plan.stateHash, versionsChanged: hash(currentVersions) !== plan.versionsHash };
    if (Object.values(evidence).some(Boolean)) {
      db.prepare("UPDATE infrastructure_change_plans SET status='stale' WHERE id=?").run(id);
      throw fail('Infrastructure plan is stale; create and review a new plan', 409, 'STALE_INFRASTRUCTURE_PLAN', evidence);
    }
    if (plan.blocked.length) throw fail('Infrastructure plan contains blocked changes', 409, 'INFRASTRUCTURE_PLAN_BLOCKED', { blocked: plan.blocked });
    db.prepare("UPDATE infrastructure_change_plans SET status='accepted',accepted_by=?,accepted_at=datetime('now') WHERE id=?").run(actor.id, id);
    return { ...rowPlan(db.prepare('SELECT * FROM infrastructure_change_plans WHERE id=?').get(id)), providerMutationsScheduled: 0,
      note: 'Plan acceptance records reviewed intent only; provider-specific execution is linked through allowlisted durable operations.' };
  }
  _normalizeSteps(value) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_STEPS) throw fail(`steps must contain 1-${MAX_STEPS} entries`);
    assertBounded(value, 'steps'); assertSecretFree(value, 'steps');
    const steps = value.map((raw, index) => {
      const id = string(raw?.id, `steps[${index}].id`, 64, SAFE_NAME); const stage = integer(raw.stage ?? index + 1, `steps[${index}].stage`, 1, MAX_STEPS);
      const needs = stringList(raw.needs, `steps[${index}].needs`, MAX_STEPS); const actionKey = string(raw.actionKey, `steps[${index}].actionKey`, 80, SAFE_ACTION);
      const lockScopes = stringList(raw.lockScopes, `steps[${index}].lockScopes`, 8);
      let compensation = null;
      if (raw.compensation != null) { const item = object(raw.compensation); const strategy = item.strategy || 'best_effort';
        if (!['best_effort', 'required'].includes(strategy)) throw fail(`steps[${index}].compensation.strategy is invalid`);
        compensation = { actionKey: string(item.actionKey, `steps[${index}].compensation.actionKey`, 80, SAFE_ACTION), strategy,
          input: canonical(object(item.input)) }; }
      return { id, stage, needs, actionKey, input: canonical(object(raw.input)), lockScopes, compensation,
        compensationRequired: raw.compensationRequired === true };
    });
    const byId = new Map(); for (const step of steps) { if (byId.has(step.id)) throw fail(`Duplicate workflow step ${step.id}`); byId.set(step.id, step); }
    for (const step of steps) for (const dependencyId of step.needs) {
      const dependency = byId.get(dependencyId); if (!dependency) throw fail(`Workflow dependency ${dependencyId} is missing`);
      if (dependency.stage > step.stage) throw fail(`Workflow dependency ${dependencyId} is in a later stage`);
    }
    const visiting = new Set(); const visited = new Set(); const visit = id => { if (visiting.has(id)) throw fail(`Workflow dependency cycle at ${id}`);
      if (visited.has(id)) return; visiting.add(id); for (const dependency of byId.get(id).needs) visit(dependency); visiting.delete(id); visited.add(id); };
    for (const step of steps) visit(step.id); return steps;
  }
  createWorkflow(body = {}, actor) {
    this._admin(actor); const steps = this._normalizeSteps(body.steps); const name = string(body.name, 'name', 120, SAFE_NAME);
    const version = string(body.version, 'version', 40, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}$/); const definitionHash = hash(steps);
    try {
      const result = this._db().prepare(`INSERT INTO infrastructure_workflows
        (name,version,description,steps_json,definition_hash,created_by) VALUES (?,?,?,?,?,?)`).run(name, version,
        String(body.description || '').trim().slice(0, 1000), stable(steps), definitionHash, actor.id);
      return rowWorkflow(this._db().prepare('SELECT * FROM infrastructure_workflows WHERE id=?').get(result.lastInsertRowid));
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Workflow name and version already exist', 409, 'WORKFLOW_VERSION_EXISTS');
      throw error;
    }
  }
  workflows(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_workflows ORDER BY created_at DESC,id DESC').all().map(rowWorkflow); }
  compensationPlan(workflowId, body = {}, actor) {
    this._admin(actor); const workflow = rowWorkflow(this._db().prepare('SELECT * FROM infrastructure_workflows WHERE id=?').get(integer(workflowId, 'workflowId', 1)));
    if (!workflow) throw fail('Workflow not found', 404, 'WORKFLOW_NOT_FOUND');
    const completed = new Set(stringList(body.completedStepIds, 'completedStepIds', MAX_STEPS));
    const unknown = [...completed].filter(id => !workflow.steps.some(step => step.id === id)); if (unknown.length) throw fail('completedStepIds contains unknown steps');
    const ordered = workflow.steps.map((step, index) => ({ ...step, index })).filter(step => completed.has(step.id))
      .sort((left, right) => right.stage - left.stage || right.index - left.index);
    const actions = ordered.filter(step => step.compensation).map(step => ({ stepId: step.id, stage: step.stage,
      actionKey: step.compensation.actionKey, strategy: step.compensation.strategy, input: step.compensation.input,
      lockScopes: step.lockScopes }));
    const manual = ordered.filter(step => step.compensationRequired && !step.compensation).map(step => ({ stepId: step.id,
      reason: 'required compensation action is not declared' }));
    return { workflowId: workflow.id, definitionHash: workflow.definitionHash, actions, manual,
      canAutomaticallyCompensate: manual.length === 0, executionOrder: 'reverse-stage-reverse-definition', providerMutationsScheduled: 0 };
  }
  linkJob(planId, body = {}, actor) {
    this._admin(actor); const db = this._db(); const plan = db.prepare(`SELECT p.*,m.provider_host_id FROM infrastructure_change_plans p
      JOIN infrastructure_manifests m ON m.id=p.manifest_id WHERE p.id=?`).get(integer(planId, 'planId', 1));
    if (!plan) throw fail('Plan not found', 404, 'PLAN_NOT_FOUND'); if (plan.status !== 'accepted') throw fail('Plan must be accepted before linking a job', 409, 'PLAN_NOT_ACCEPTED');
    const operationId = string(body.operationId, 'operationId', 80, /^op_[a-f0-9]{26}$/); const operation = db.prepare('SELECT * FROM provider_operations WHERE id=?').get(operationId);
    if (!operation) throw fail('Provider operation not found', 404, 'OPERATION_NOT_FOUND');
    if (plan.provider_host_id > 0 && operation.host_id !== plan.provider_host_id) throw fail('Provider operation host does not match manifest host', 409, 'OPERATION_HOST_MISMATCH');
    const relation = body.relation || 'executes'; if (!['executes', 'verifies', 'compensates'].includes(relation)) throw fail('relation is invalid');
    db.prepare(`INSERT OR IGNORE INTO infrastructure_plan_jobs (plan_id,operation_id,step_id,relation,linked_by)
      VALUES (?,?,?,?,?)`).run(plan.id, operationId, optionalString(body.stepId, 'stepId', 64, SAFE_NAME), relation, actor.id);
    return { planId: plan.id, operationId, relation, state: operation.state, hasNativeTask: !!operation.native_task_ref_enc,
      nativeTaskState: operation.native_task_state || null, retryPolicy: operation.retry_policy,
      idempotencyProtected: !!operation.idempotency_key_hash, lockScopes: parse(operation.lock_scopes_json, []) };
  }
  overview(actor) {
    this._admin(actor); const db = this._db();
    const operationStates = Object.fromEntries(db.prepare('SELECT state,COUNT(*) count FROM provider_operations GROUP BY state').all().map(row => [row.state, row.count]));
    const links = db.prepare(`SELECT j.*,o.state,o.retry_policy,o.native_task_state,o.native_task_ref_enc,o.idempotency_key_hash,
      o.lock_scopes_json,p.plan_hash FROM infrastructure_plan_jobs j JOIN provider_operations o ON o.id=j.operation_id
      JOIN infrastructure_change_plans p ON p.id=j.plan_id ORDER BY j.id DESC LIMIT 500`).all().map(row => ({ id: row.id,
      planId: row.plan_id, operationId: row.operation_id, stepId: row.step_id, relation: row.relation, state: row.state,
      retryPolicy: row.retry_policy, hasNativeTask: !!row.native_task_ref_enc, nativeTaskState: row.native_task_state,
      idempotencyProtected: !!row.idempotency_key_hash, lockScopes: parse(row.lock_scopes_json, []), planHash: row.plan_hash,
      linkedAt: row.linked_at }));
    return { capabilities: { persistentJobEngine: true, providerTaskBridge: true, idempotencyKeys: true, resourceLocks: true,
      dependencyDag: true, compensationFramework: true, changePlans: true, stalePlanRejection: true,
      vmManifest: true, hostFabricManifest: true }, operationEngine: { states: operationStates,
      activeLocks: db.prepare("SELECT COUNT(*) count FROM provider_operation_locks WHERE lease_expires_at>datetime('now')").get().count,
      idempotencyProtectedJobs: db.prepare('SELECT COUNT(*) count FROM provider_operations WHERE idempotency_key_hash IS NOT NULL').get().count,
      nativeTaskJobs: db.prepare('SELECT COUNT(*) count FROM provider_operations WHERE native_task_ref_enc IS NOT NULL').get().count },
    manifests: this.manifests(actor), plans: this.plans(actor), workflows: this.workflows(actor), jobLinks: links };
  }
}

const service = new InfrastructureAutomationService();
module.exports = service;
module.exports.InfrastructureAutomationService = InfrastructureAutomationService;
module.exports.InfrastructureAutomationError = InfrastructureAutomationError;
module.exports.API_VERSION = API_VERSION;
module.exports._internals = { canonical, stable, hash, flatten, normalizeVm, normalizeHost, normalizeFabric };
