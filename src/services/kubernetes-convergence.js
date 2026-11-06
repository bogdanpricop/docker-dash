'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const { fromHostRow } = require('./kubernetes');
const infrastructureOperations = require('./infrastructure-operations');

const EVIDENCE = new Set(['datavolumes', 'templates', 'node_drain', 'csi_snapshots', 'multus', 'nmstate', 'vm_exposure']);
const DNS = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const QUANTITY = /^[1-9]\d*(?:\.\d+)?(?:[KMGTPE]i?|[numk])?$/;
const CHECKSUM = /^sha256:[a-f0-9]{64}$/;
const INLINE_SECRET = /^(password|token|privateKey|userData|userDataBase64|networkData|networkDataBase64)$/i;
const SENSITIVE_NAME = /password|token|private.?key|user.?data|network.?data|client.?secret|credential|signature|auth/i;

class KubernetesConvergenceError extends Error {
  constructor(message, status = 400, code = 'KUBERNETES_CONVERGENCE_ERROR', details) {
    super(message); this.name = 'KubernetesConvergenceError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new KubernetesConvergenceError(message, status, code, details);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const safeName = (value, key) => {
  const result = String(value ?? '').trim();
  if (!DNS.test(result) || result.length > 253) throw fail(`${key} is invalid`, 400, 'INVALID_KUBERNETES_NAME');
  return result;
};
const integer = (value, key, min, max) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`);
  return result;
};
function bounded(value, key, max = 512 * 1024) {
  let encoded; try { encoded = typeof value === 'string' ? value : JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'DOCUMENT_TOO_LARGE');
}
function inlineSecretPaths(value, path = 'manifest', result = []) {
  if (!value || typeof value !== 'object') return result;
  if (SENSITIVE_NAME.test(String(value.name || '')) && value.value != null && value.value !== '') result.push(`${path}.value`);
  for (const [key, child] of Object.entries(value)) {
    const next = `${path}.${key}`;
    if (INLINE_SECRET.test(key) && child != null && child !== '') result.push(next);
    inlineSecretPaths(child, next, result);
  }
  return result;
}
function stripServerFields(value) {
  const result = JSON.parse(JSON.stringify(value || {})); delete result.status;
  if (result.metadata) for (const key of ['managedFields', 'resourceVersion', 'uid', 'creationTimestamp', 'generation', 'selfLink']) delete result.metadata[key];
  return result;
}
function dryRunSummary(value, namespace, name) {
  return { accepted: true, dryRun: 'All', apiVersion: value?.apiVersion || null, kind: value?.kind || null,
    namespace: value?.metadata?.namespace || namespace, name: value?.metadata?.name || name };
}
function planRow(row) {
  return row && { id: row.id, hostId: row.host_id, kind: row.change_kind, namespace: row.namespace,
    resourceName: row.resource_name, manifest: parse(row.manifest_json, {}), prerequisites: parse(row.prerequisites_json, {}),
    dryRunResponse: parse(row.dry_run_response_json, {}), desiredHash: row.desired_hash, planHash: row.plan_hash,
    state: row.state, approvalId: row.approval_id, operationRef: row.operation_ref,
    executionEvidence: parse(row.execution_evidence_json, null), requestedBy: row.requested_by,
    executedBy: row.executed_by, createdAt: row.created_at, executedAt: row.executed_at, updatedAt: row.updated_at };
}
function policyRow(row) {
  return row && { id: row.id, hostId: row.host_id, name: row.name, bandwidthPerMigration: row.bandwidth_per_migration,
    parallelMigrationsPerCluster: row.parallel_migrations_per_cluster, parallelOutboundPerNode: row.parallel_outbound_per_node,
    completionTimeoutPerGiB: row.completion_timeout_per_gib, progressTimeoutSeconds: row.progress_timeout_seconds,
    allowAutoConverge: !!row.allow_auto_converge, allowPostCopy: !!row.allow_post_copy,
    policyHash: row.policy_hash, createdAt: row.created_at, updatedAt: row.updated_at };
}

class KubernetesConvergenceService {
  constructor(dbProvider = getDb, options = {}) {
    this._dbProvider = dbProvider; this._clientFactory = options.clientFactory || fromHostRow;
    this._approvals = options.approvalService || infrastructureOperations;
  }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  _host(row) {
    if (!row?.id || row.daemon_type !== 'kubernetes') throw fail('A registered Kubernetes host is required', 400, 'KUBERNETES_HOST_REQUIRED');
  }
  _client(row) { this._host(row); return this._clientFactory(row); }
  _approvalPayload(plan) {
    return { planHash: plan.planHash, desiredHash: plan.desiredHash, hostId: plan.hostId,
      kind: plan.kind, namespace: plan.namespace, resourceName: plan.resourceName };
  }
  _event(planId, operationRef, eventType, state, evidence = {}) {
    bounded(evidence, 'operation evidence', 64 * 1024);
    this._db().prepare(`INSERT INTO kubernetes_virtualization_operation_events
      (plan_id,operation_ref,event_type,state,evidence_json) VALUES (?,?,?,?,?)`)
      .run(planId, operationRef, eventType, state, stable(evidence));
  }
  _manifestFingerprint(manifest) {
    const copy = JSON.parse(JSON.stringify(manifest));
    if (copy.metadata?.annotations) delete copy.metadata.annotations['docker-dash.io/manifest-fingerprint'];
    return hash(copy);
  }
  _finalizeManifest(manifest) {
    const result = stripServerFields(manifest); result.metadata = result.metadata || {};
    result.metadata.annotations = { ...(result.metadata.annotations || {}) };
    result.metadata.annotations['docker-dash.io/manifest-fingerprint'] = this._manifestFingerprint(result);
    const secretPaths = inlineSecretPaths(result);
    if (secretPaths.length) throw fail('Inline secret material is forbidden; use Kubernetes Secret references', 400,
      'INLINE_SECRET_MATERIAL', { paths: secretPaths });
    bounded(result, 'manifest'); return canonical(result);
  }

  async dataVolumes(row, namespace) {
    const scope = namespace ? safeName(namespace, 'namespace') : undefined;
    return this._client(row).dataVolumeInventory(scope);
  }
  async templates(row, namespace) {
    const scope = namespace ? safeName(namespace, 'namespace') : undefined;
    return this._client(row).virtualizationTemplateInventory(scope);
  }
  _dataVolumeManifest(body = {}) {
    const namespace = safeName(body.namespace || 'default', 'namespace'); const name = safeName(body.name, 'name');
    const sourceType = String(body.sourceType || '');
    if (!['http', 'registry', 'pvc', 'upload'].includes(sourceType)) throw fail('sourceType must be http, registry, pvc or upload');
    const storage = body.storage && typeof body.storage === 'object' && !Array.isArray(body.storage) ? body.storage : {};
    const size = String(storage.size || '').trim(); if (!QUANTITY.test(size)) throw fail('storage.size is an invalid Kubernetes quantity');
    const storageClassName = storage.storageClassName == null || storage.storageClassName === ''
      ? undefined : safeName(storage.storageClassName, 'storage.storageClassName');
    const accessModes = Array.isArray(storage.accessModes) && storage.accessModes.length
      ? [...new Set(storage.accessModes)] : ['ReadWriteOnce'];
    if (accessModes.some(mode => !['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'].includes(mode))) {
      throw fail('storage.accessModes contains an unsupported value');
    }
    const volumeMode = storage.volumeMode || 'Filesystem';
    if (!['Filesystem', 'Block'].includes(volumeMode)) throw fail('storage.volumeMode must be Filesystem or Block');
    const source = body.source && typeof body.source === 'object' && !Array.isArray(body.source) ? body.source : {};
    let normalizedSource; const pvcSources = [];
    if (sourceType === 'http') {
      let url; try { url = new URL(String(source.url || '')); } catch { throw fail('source.url must be a valid URL'); }
      if (url.protocol !== 'https:') throw fail('HTTP imports require an https URL', 400, 'INSECURE_IMPORT_URL');
      if (url.username || url.password || [...url.searchParams.keys()].some(key => SENSITIVE_NAME.test(key))) {
        throw fail('Source URLs may not contain inline credentials or secret query parameters; use a Secret reference', 400, 'INLINE_SECRET_MATERIAL');
      }
      normalizedSource = { http: { url: url.toString() } };
    } else if (sourceType === 'registry') {
      const url = String(source.url || '').trim();
      if (!/^(docker|oci|https):\/\//i.test(url) || url.length > 2000) throw fail('registry source.url is invalid');
      let parsedUrl; try { parsedUrl = new URL(url); } catch { throw fail('registry source.url is invalid'); }
      if (parsedUrl.username || parsedUrl.password || [...parsedUrl.searchParams.keys()].some(key => SENSITIVE_NAME.test(key))) {
        throw fail('Registry URLs may not contain inline credentials; use source.secretRef', 400, 'INLINE_SECRET_MATERIAL');
      }
      normalizedSource = { registry: { url } };
      if (source.secretRef) normalizedSource.registry.secretRef = safeName(source.secretRef, 'source.secretRef');
    } else if (sourceType === 'pvc') {
      const sourceNamespace = safeName(source.namespace || namespace, 'source.namespace');
      const sourceName = safeName(source.name, 'source.name'); normalizedSource = { pvc: { namespace: sourceNamespace, name: sourceName } };
      pvcSources.push({ namespace: sourceNamespace, name: sourceName });
    } else normalizedSource = { upload: {} };
    const checksum = body.checksum == null || body.checksum === '' ? null : String(body.checksum).toLowerCase();
    if (checksum && !CHECKSUM.test(checksum)) throw fail('checksum must use sha256:<64 lowercase hex>', 400, 'INVALID_CHECKSUM');
    const annotations = checksum ? { 'docker-dash.io/source-checksum': checksum } : {};
    const manifest = this._finalizeManifest({ apiVersion: 'cdi.kubevirt.io/v1beta1', kind: 'DataVolume',
      metadata: { namespace, name, annotations }, spec: { source: normalizedSource, storage: {
        resources: { requests: { storage: size } }, accessModes, volumeMode, ...(storageClassName ? { storageClassName } : {}) } } });
    return { namespace, name, manifest, prerequisites: { namespace, storageClassNames: storageClassName ? [storageClassName] : [],
      networkAttachments: [], pvcSources }, checksum, sourceType };
  }

  _templateManifest(template, body, namespace, vmName) {
    const supplied = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters) ? body.parameters : {};
    const definitions = Array.isArray(template.parameters) ? template.parameters : [];
    const sensitiveParameters = definitions.filter(parameter => SENSITIVE_NAME.test(String(parameter.name || ''))).map(parameter => parameter.name);
    if (sensitiveParameters.length) throw fail('Templates with secret-shaped inline parameters are not accepted; use Secret references',
      400, 'INLINE_SECRET_MATERIAL', { parameters: sensitiveParameters });
    const allowed = new Set(definitions.map(parameter => parameter.name));
    const unknown = Object.keys(supplied).filter(key => !allowed.has(key));
    if (unknown.length) throw fail('Unknown template parameters', 400, 'UNKNOWN_TEMPLATE_PARAMETERS', { unknown });
    const values = {};
    for (const definition of definitions) {
      const value = supplied[definition.name] ?? definition.value;
      if (value == null || value === '') throw fail(`Template parameter ${definition.name} is required`, 400, 'MISSING_TEMPLATE_PARAMETER');
      values[definition.name] = String(value).slice(0, 1000);
    }
    const replace = value => Array.isArray(value) ? value.map(replace) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]))
      : typeof value === 'string' ? value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, key) => {
        if (!(key in values)) throw fail(`Template references unresolved parameter ${key}`, 400, 'MISSING_TEMPLATE_PARAMETER');
        return values[key];
      }) : value;
    const objects = (template.objects || []).map(replace);
    const virtualMachines = objects.filter(object => object?.apiVersion === 'kubevirt.io/v1' && object?.kind === 'VirtualMachine');
    if (virtualMachines.length !== 1) throw fail('Template must contain exactly one kubevirt.io/v1 VirtualMachine', 400, 'TEMPLATE_VM_REQUIRED');
    const manifest = virtualMachines[0]; manifest.metadata = manifest.metadata || {};
    manifest.metadata.namespace = namespace; manifest.metadata.name = vmName;
    if (!manifest.spec?.template?.spec?.domain) throw fail('Template VM domain specification is missing', 400, 'TEMPLATE_VM_INVALID');
    const storageClassNames = [];
    for (const templateValue of manifest.spec?.dataVolumeTemplates || []) {
      const storageClass = templateValue.spec?.storage?.storageClassName || templateValue.spec?.pvc?.storageClassName;
      if (storageClass) storageClassNames.push(safeName(storageClass, 'storageClassName'));
    }
    const networkAttachments = (manifest.spec?.template?.spec?.networks || []).filter(network => network.multus)
      .map(network => String(network.multus.networkName || '')).filter(Boolean);
    return { manifest: this._finalizeManifest(manifest), values, storageClassNames: [...new Set(storageClassNames)],
      networkAttachments: [...new Set(networkAttachments)] };
  }

  async _persistPlan(row, kind, namespace, name, manifest, prerequisites, dryResponse, actor, body) {
    const desiredHash = hash(manifest); const planHash = hash({ hostId: row.id, kind, namespace, name,
      desiredHash, prerequisites, dryResponse });
    const db = this._db(); const duplicate = db.prepare('SELECT * FROM kubernetes_virtualization_change_plans WHERE plan_hash=?').get(planHash);
    if (duplicate) return { ...planRow(duplicate), duplicate: true };
    let result;
    db.transaction(() => {
      const provisional = { hostId: row.id, kind, namespace, resourceName: name, desiredHash, planHash };
      const approval = this._approvals.createApproval({ actionKey: `kubevirt.${kind}`, targetType: 'kubevirt_change',
        targetId: `${row.id}:${namespace}/${name}:${planHash.slice(0, 12)}`, payload: this._approvalPayload(provisional),
        dueMinutes: body.dueMinutes || 60, assigneeUserId: body.assigneeUserId,
        escalationUserId: body.escalationUserId, escalationGraceMinutes: body.escalationGraceMinutes || 30 }, actor);
      const saved = db.prepare(`INSERT INTO kubernetes_virtualization_change_plans
        (host_id,change_kind,namespace,resource_name,manifest_json,prerequisites_json,dry_run_response_json,
         desired_hash,plan_hash,approval_id,requested_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.id, kind, namespace, name, stable(manifest), stable(prerequisites), stable(dryResponse),
          desiredHash, planHash, approval.id, actor.id);
      result = planRow(db.prepare('SELECT * FROM kubernetes_virtualization_change_plans WHERE id=?').get(saved.lastInsertRowid));
    })();
    return { ...result, duplicate: false };
  }

  async planDataVolume(row, body, actor) {
    this._admin(actor); const client = this._client(row); const value = this._dataVolumeManifest(body);
    const prerequisites = await client.virtualizationCreationPrerequisites(value.prerequisites);
    if (!prerequisites.valid) throw fail('DataVolume prerequisites are not satisfied', 409, 'PREREQUISITES_FAILED', prerequisites);
    let server;
    try { server = dryRunSummary(await client.dryRunCreateDataVolume(value.namespace, value.manifest), value.namespace, value.name); }
    catch (error) { throw fail('Kubernetes rejected the DataVolume dry-run', error.status || 422, 'SERVER_DRY_RUN_REJECTED',
      { reason: error.kubernetesResponse?.reason || null, message: String(error.kubernetesResponse?.message || error.message).slice(0, 800) }); }
    return this._persistPlan(row, 'datavolume_create', value.namespace, value.name, value.manifest,
      prerequisites, server, actor, body || {});
  }

  async planTemplateInstantiation(row, body = {}, actor) {
    this._admin(actor); const client = this._client(row); const namespace = safeName(body.namespace || 'default', 'namespace');
    const templateName = safeName(body.templateName, 'templateName'); const vmName = safeName(body.vmName, 'vmName');
    const template = await client.getVirtualizationTemplate(namespace, templateName);
    const prepared = this._templateManifest(template, body, namespace, vmName);
    const prerequisiteRequest = { namespace, storageClassNames: prepared.storageClassNames,
      networkAttachments: prepared.networkAttachments, pvcSources: [] };
    const prerequisites = await client.virtualizationCreationPrerequisites(prerequisiteRequest);
    if (!prerequisites.valid) throw fail('Template prerequisites are not satisfied', 409, 'PREREQUISITES_FAILED', prerequisites);
    let server;
    try { server = dryRunSummary(await client.dryRunCreateKubeVirtVirtualMachine(namespace, prepared.manifest), namespace, vmName); }
    catch (error) { throw fail('Kubernetes rejected the VirtualMachine dry-run', error.status || 422, 'SERVER_DRY_RUN_REJECTED',
      { reason: error.kubernetesResponse?.reason || null, message: String(error.kubernetesResponse?.message || error.message).slice(0, 800) }); }
    return this._persistPlan(row, 'template_instantiate', namespace, vmName, prepared.manifest,
      prerequisites, server, actor, body);
  }

  _findPlan(id) {
    const planId = integer(id, 'planId', 1, Number.MAX_SAFE_INTEGER);
    const row = this._db().prepare('SELECT * FROM kubernetes_virtualization_change_plans WHERE id=?').get(planId);
    if (!row) throw fail('Kubernetes change plan was not found', 404, 'PLAN_NOT_FOUND');
    return planRow(row);
  }
  plans(hostId, actor) {
    this._admin(actor); const id = integer(hostId, 'hostId', 1, Number.MAX_SAFE_INTEGER);
    return this._db().prepare(`SELECT * FROM kubernetes_virtualization_change_plans WHERE host_id=?
      ORDER BY id DESC LIMIT 100`).all(id).map(planRow);
  }
  operationEvents(planId, actor) {
    this._admin(actor); const plan = this._findPlan(planId);
    return this._db().prepare(`SELECT id,operation_ref,event_type,state,evidence_json,created_at
      FROM kubernetes_virtualization_operation_events WHERE plan_id=? ORDER BY id`).all(plan.id)
      .map(row => ({ id: row.id, operationRef: row.operation_ref, type: row.event_type, state: row.state,
        evidence: parse(row.evidence_json, {}), createdAt: row.created_at }));
  }
  async _freshValidation(client, plan) {
    const manifest = plan.manifest; const storageClassNames = [];
    const pvcSources = []; const networkAttachments = [];
    if (plan.kind === 'datavolume_create') {
      const storageClass = manifest.spec?.storage?.storageClassName || manifest.spec?.pvc?.storageClassName;
      if (storageClass) storageClassNames.push(storageClass);
      if (manifest.spec?.source?.pvc) pvcSources.push(manifest.spec.source.pvc);
    } else {
      for (const item of manifest.spec?.dataVolumeTemplates || []) {
        const storageClass = item.spec?.storage?.storageClassName || item.spec?.pvc?.storageClassName;
        if (storageClass) storageClassNames.push(storageClass);
      }
      for (const network of manifest.spec?.template?.spec?.networks || []) if (network.multus?.networkName) networkAttachments.push(network.multus.networkName);
    }
    const prerequisites = await client.virtualizationCreationPrerequisites({ namespace: plan.namespace,
      storageClassNames, pvcSources, networkAttachments });
    if (!prerequisites.valid) return { valid: false, prerequisites, reason: 'prerequisites_changed' };
    const response = plan.kind === 'datavolume_create'
      ? await client.dryRunCreateDataVolume(plan.namespace, manifest)
      : await client.dryRunCreateKubeVirtVirtualMachine(plan.namespace, manifest);
    const dryResponse = dryRunSummary(response, plan.namespace, plan.resourceName);
    const freshHash = hash({ hostId: plan.hostId, kind: plan.kind, namespace: plan.namespace,
      name: plan.resourceName, desiredHash: hash(manifest), prerequisites, dryResponse });
    return { valid: freshHash === plan.planHash, prerequisites, dryResponse, freshHash,
      reason: freshHash === plan.planHash ? null : 'evidence_changed' };
  }
  async _reconcileExecuting(client, plan) {
    let observed;
    try { observed = plan.kind === 'datavolume_create'
      ? await client.getDataVolume(plan.namespace, plan.resourceName)
      : await client.getKubeVirtVirtualMachine(plan.namespace, plan.resourceName); }
    catch (error) { if (error.status === 404) return null; throw error; }
    const fingerprint = observed?.metadata?.annotations?.['docker-dash.io/manifest-fingerprint'];
    if (fingerprint !== plan.manifest?.metadata?.annotations?.['docker-dash.io/manifest-fingerprint']) {
      throw fail('Existing resource does not match the executing plan', 409, 'RESOURCE_IDENTITY_CONFLICT');
    }
    const evidence = { reconciled: true, namespace: observed.metadata?.namespace || plan.namespace,
      name: observed.metadata?.name || plan.resourceName, uid: observed.metadata?.uid || null,
      resourceVersion: observed.metadata?.resourceVersion || null, fingerprint };
    this._db().prepare(`UPDATE kubernetes_virtualization_change_plans SET state='succeeded',execution_evidence_json=?,
      executed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(stable(evidence), plan.id);
    this._event(plan.id, plan.operationRef, 'reconciled', 'succeeded', evidence);
    return planRow(this._db().prepare('SELECT * FROM kubernetes_virtualization_change_plans WHERE id=?').get(plan.id));
  }
  async executePlan(row, id, body = {}, actor) {
    this._admin(actor); this._host(row); let plan = this._findPlan(id);
    if (plan.hostId !== row.id) throw fail('Plan belongs to another Kubernetes host', 409, 'PLAN_HOST_MISMATCH');
    const client = this._client(row);
    if (plan.state === 'succeeded') return { ...plan, deduplicated: true };
    if (plan.state === 'executing') {
      const reconciled = await this._reconcileExecuting(client, plan);
      if (reconciled) return { ...reconciled, deduplicated: true };
      throw fail('Operation is still executing and the resource is not observable', 409, 'OPERATION_IN_PROGRESS');
    }
    if (plan.state !== 'validated') throw fail(`Plan cannot execute from state ${plan.state}`, 409, 'PLAN_NOT_EXECUTABLE');
    if (String(body.confirmation || '') !== plan.resourceName) throw fail('Typed confirmation must exactly match the resource name', 409, 'CONFIRMATION_MISMATCH');
    const approvalId = integer(body.approvalId, 'approvalId', 1, Number.MAX_SAFE_INTEGER); const db = this._db();
    const approval = db.prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(approvalId);
    const expectedHash = hash(this._approvalPayload(plan));
    if (!approval || approval.id !== plan.approvalId || approval.state !== 'approved'
      || approval.action_key !== `kubevirt.${plan.kind}` || approval.payload_hash !== expectedHash) {
      throw fail('A matching approved plan is required', 409, 'APPROVAL_REQUIRED');
    }
    if (Date.parse(approval.due_at) <= Date.now()) throw fail('Approval expired; create a new plan', 409, 'APPROVAL_EXPIRED');
    if (!approval.decided_by || approval.decided_by === plan.requestedBy) throw fail('Four-eyes approval by another administrator is required', 409, 'FOUR_EYES_REQUIRED');
    const fresh = await this._freshValidation(client, plan);
    if (!fresh.valid) {
      db.prepare("UPDATE kubernetes_virtualization_change_plans SET state='stale',execution_evidence_json=?,updated_at=datetime('now') WHERE id=?")
        .run(stable(fresh), plan.id);
      const ref = `kvop_${crypto.randomBytes(13).toString('hex')}`; this._event(plan.id, ref, 'revalidation_failed', 'stale', fresh);
      throw fail('Cluster evidence changed after approval; create a new plan', 409, 'PLAN_STALE', fresh);
    }
    const operationRef = `kvop_${crypto.randomBytes(13).toString('hex')}`;
    const claimed = db.prepare(`UPDATE kubernetes_virtualization_change_plans SET state='executing',operation_ref=?,
      executed_by=?,updated_at=datetime('now') WHERE id=? AND state='validated'`).run(operationRef, actor.id, plan.id);
    if (claimed.changes !== 1) throw fail('Plan execution was claimed concurrently', 409, 'PLAN_CONFLICT');
    this._event(plan.id, operationRef, 'claimed', 'queued', { approvalId, freshPlanHash: fresh.freshHash });
    let providerCreateAccepted = false;
    try {
      this._event(plan.id, operationRef, 'provider_create_started', 'running', { kind: plan.kind,
        namespace: plan.namespace, resourceName: plan.resourceName });
      await (plan.kind === 'datavolume_create' ? client.createDataVolume(plan.namespace, plan.manifest)
        : client.createKubeVirtVirtualMachine(plan.namespace, plan.manifest));
      providerCreateAccepted = true;
      const observed = plan.kind === 'datavolume_create' ? await client.getDataVolume(plan.namespace, plan.resourceName)
        : await client.getKubeVirtVirtualMachine(plan.namespace, plan.resourceName);
      const fingerprint = observed?.metadata?.annotations?.['docker-dash.io/manifest-fingerprint'];
      if (fingerprint !== plan.manifest.metadata.annotations['docker-dash.io/manifest-fingerprint']) {
        throw fail('Created resource failed fingerprint verification', 502, 'POST_VERIFY_FAILED');
      }
      const evidence = { reconciled: false, namespace: observed.metadata?.namespace || plan.namespace,
        name: observed.metadata?.name || plan.resourceName, uid: observed.metadata?.uid || null,
        resourceVersion: observed.metadata?.resourceVersion || null, fingerprint, providerMutationStarted: true };
      db.prepare(`UPDATE kubernetes_virtualization_change_plans SET state='succeeded',execution_evidence_json=?,
        executed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(stable(evidence), plan.id);
      this._event(plan.id, operationRef, 'read_back_verified', 'succeeded', evidence);
    } catch (error) {
      const uncertain = providerCreateAccepted || !error.status || error.status >= 500;
      if (uncertain && !['POST_VERIFY_FAILED', 'RESOURCE_IDENTITY_CONFLICT'].includes(error.code)) {
        try {
          const reconciled = await this._reconcileExecuting(client, this._findPlan(plan.id));
          if (reconciled) return { ...reconciled, deduplicated: true };
        } catch (reconcileError) {
          if (['POST_VERIFY_FAILED', 'RESOURCE_IDENTITY_CONFLICT'].includes(reconcileError.code)) error = reconcileError;
          else {
            const evidence = { code: 'OPERATION_OUTCOME_UNKNOWN', message: String(error.message || 'create outcome is unknown').slice(0, 800),
              reconciliationError: String(reconcileError.message || 'read-back unavailable').slice(0, 800) };
            db.prepare("UPDATE kubernetes_virtualization_change_plans SET execution_evidence_json=?,updated_at=datetime('now') WHERE id=?")
              .run(stable(evidence), plan.id); this._event(plan.id, operationRef, 'verification_deferred', 'running', evidence);
            throw fail('Create outcome is unknown; retry this plan to reconcile read-back', 503, 'OPERATION_OUTCOME_UNKNOWN');
          }
        }
        if (!['POST_VERIFY_FAILED', 'RESOURCE_IDENTITY_CONFLICT'].includes(error.code)) {
          const evidence = { code: 'OPERATION_OUTCOME_UNKNOWN', message: String(error.message || 'create outcome is unknown').slice(0, 800) };
          db.prepare("UPDATE kubernetes_virtualization_change_plans SET execution_evidence_json=?,updated_at=datetime('now') WHERE id=?")
            .run(stable(evidence), plan.id); this._event(plan.id, operationRef, 'verification_deferred', 'running', evidence);
          throw fail('Create outcome is unknown; retry this plan to reconcile read-back', 503, 'OPERATION_OUTCOME_UNKNOWN');
        }
      }
      const evidence = { code: error.code || 'KUBERNETES_CREATE_FAILED', status: error.status || null,
        message: String(error.kubernetesResponse?.message || error.message || 'create failed').slice(0, 800) };
      db.prepare("UPDATE kubernetes_virtualization_change_plans SET state='failed',execution_evidence_json=?,executed_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
        .run(stable(evidence), plan.id); this._event(plan.id, operationRef, 'provider_create_failed', 'failed', evidence); throw error;
    }
    plan = this._findPlan(plan.id); return { ...plan, deduplicated: false };
  }

  saveMigrationPolicy(row, body = {}, actor) {
    this._admin(actor); this._host(row); const name = safeName(body.name || 'default', 'name');
    const bandwidth = String(body.bandwidthPerMigration || '').trim();
    if (!QUANTITY.test(bandwidth)) throw fail('bandwidthPerMigration is an invalid Kubernetes quantity');
    const normalized = { hostId: row.id, name, bandwidthPerMigration: bandwidth,
      parallelMigrationsPerCluster: integer(body.parallelMigrationsPerCluster ?? 5, 'parallelMigrationsPerCluster', 1, 100),
      parallelOutboundPerNode: integer(body.parallelOutboundPerNode ?? 2, 'parallelOutboundPerNode', 1, 20),
      completionTimeoutPerGiB: integer(body.completionTimeoutPerGiB ?? 800, 'completionTimeoutPerGiB', 1, 86400),
      progressTimeoutSeconds: integer(body.progressTimeoutSeconds ?? 150, 'progressTimeoutSeconds', 1, 86400),
      allowAutoConverge: body.allowAutoConverge === true, allowPostCopy: body.allowPostCopy === true };
    const policyHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO kubernetes_virtualization_migration_policies
      (host_id,name,bandwidth_per_migration,parallel_migrations_per_cluster,parallel_outbound_per_node,
       completion_timeout_per_gib,progress_timeout_seconds,allow_auto_converge,allow_post_copy,policy_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(host_id,name) DO UPDATE SET
       bandwidth_per_migration=excluded.bandwidth_per_migration,
       parallel_migrations_per_cluster=excluded.parallel_migrations_per_cluster,
       parallel_outbound_per_node=excluded.parallel_outbound_per_node,
       completion_timeout_per_gib=excluded.completion_timeout_per_gib,
       progress_timeout_seconds=excluded.progress_timeout_seconds,allow_auto_converge=excluded.allow_auto_converge,
       allow_post_copy=excluded.allow_post_copy,policy_hash=excluded.policy_hash,updated_at=datetime('now')`)
      .run(row.id, name, bandwidth, normalized.parallelMigrationsPerCluster, normalized.parallelOutboundPerNode,
        normalized.completionTimeoutPerGiB, normalized.progressTimeoutSeconds, normalized.allowAutoConverge ? 1 : 0,
        normalized.allowPostCopy ? 1 : 0, policyHash, actor.id);
    return policyRow(db.prepare('SELECT * FROM kubernetes_virtualization_migration_policies WHERE host_id=? AND name=?').get(row.id, name));
  }
  async migrationPolicies(row, actor) {
    this._admin(actor); const declared = this._db().prepare(`SELECT * FROM kubernetes_virtualization_migration_policies
      WHERE host_id=? ORDER BY name`).all(row.id).map(policyRow);
    const observed = await this._client(row).migrationConfiguration();
    return { declared, observed, applySupported: false, providerMutationsStarted: 0 };
  }

  async liveEvidence(row, kind, namespace) {
    if (!EVIDENCE.has(kind)) throw fail('Evidence kind is invalid'); const client = this._client(row);
    const scope = namespace ? safeName(namespace, 'namespace') : undefined;
    if (kind === 'datavolumes') return this.dataVolumes(row, scope);
    if (kind === 'templates') return this.templates(row, scope);
    if (kind === 'node_drain') return client.nodeDrainVirtualMachineAwareness();
    if (kind === 'csi_snapshots') return client.csiSnapshotCapabilityMap();
    if (kind === 'multus') return client.multusNetworkInventory(scope);
    if (kind === 'nmstate') return client.nmStateNetworkIntent();
    return client.virtualMachineExposure(scope);
  }
  async refreshEvidence(row, kind, namespace, actor) {
    this._admin(actor); const evidence = await this.liveEvidence(row, kind, namespace); bounded(evidence, 'evidence', 2 * 1024 * 1024);
    const evidenceHash = hash(evidence); const scope = namespace || null;
    const snapshotHash = hash({ hostId: row.id, kind, scope, evidenceHash }); const db = this._db();
    const existing = db.prepare('SELECT * FROM kubernetes_virtualization_convergence_snapshots WHERE snapshot_hash=?').get(snapshotHash);
    if (existing) return { id: existing.id, hostId: row.id, kind, namespace: scope, evidence,
      evidenceHash, snapshotHash, duplicate: true, createdAt: existing.created_at };
    const saved = db.prepare(`INSERT INTO kubernetes_virtualization_convergence_snapshots
      (host_id,evidence_kind,namespace_scope,evidence_json,evidence_hash,snapshot_hash,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, kind, scope, stable(evidence), evidenceHash, snapshotHash, actor.id);
    const created = db.prepare('SELECT created_at FROM kubernetes_virtualization_convergence_snapshots WHERE id=?').get(saved.lastInsertRowid);
    return { id: Number(saved.lastInsertRowid), hostId: row.id, kind, namespace: scope, evidence,
      evidenceHash, snapshotHash, duplicate: false, createdAt: created.created_at };
  }
  snapshots(hostId, actor) {
    this._admin(actor); const id = integer(hostId, 'hostId', 1, Number.MAX_SAFE_INTEGER);
    return this._db().prepare(`SELECT * FROM kubernetes_virtualization_convergence_snapshots
      WHERE host_id=? ORDER BY id DESC LIMIT 100`).all(id).map(row => ({ id: row.id, hostId: row.host_id,
      kind: row.evidence_kind, namespace: row.namespace_scope, evidence: parse(row.evidence_json, {}),
      evidenceHash: row.evidence_hash, snapshotHash: row.snapshot_hash, createdAt: row.created_at }));
  }
}

const service = new KubernetesConvergenceService();
module.exports = service;
module.exports.KubernetesConvergenceService = KubernetesConvergenceService;
module.exports.KubernetesConvergenceError = KubernetesConvergenceError;
module.exports._internals = { canonical, stable, hash, inlineSecretPaths, stripServerFields, dryRunSummary };
