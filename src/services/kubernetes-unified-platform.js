'use strict';

const crypto = require('crypto');
const YAML = require('yaml');
const { getDb } = require('../db');
const { fromHostRow } = require('./kubernetes');

const EVIDENCE_KINDS = new Set(['topology', 'metrics', 'policy', 'gitops', 'lifecycle']);
const SOURCE_KINDS = new Set(['flux', 'argo', 'repository']);
const DNS = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,499}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SECRET_KEY = /password|token|private.?key|user.?data|network.?data|secret(?!.*ref)|credential(?!.*ref)|authorization|cookie/i;

class KubernetesUnifiedPlatformError extends Error {
  constructor(message, status = 400, code = 'KUBERNETES_UNIFIED_ERROR', details) {
    super(message); this.name = 'KubernetesUnifiedPlatformError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new KubernetesUnifiedPlatformError(message, status, code, details);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const withoutObservationTimestamp = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized = { ...value }; delete normalized.observedAt; return normalized;
};
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const safeName = (value, key) => { const result = String(value ?? '').trim();
  if (!DNS.test(result) || result.length > 253) throw fail(`${key} is invalid`); return result; };
const safeText = (value, key, max = 500, pattern) => { const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`); return result; };
const integer = (value, key, min, max) => { const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`); return result; };
function bounded(value, key, max = 1024 * 1024) {
  let text; try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(text) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'DOCUMENT_TOO_LARGE');
}
function secretFree(value, path = 'document') {
  if (!value || typeof value !== 'object') return;
  if (SECRET_KEY.test(String(value.name || '')) && value.value != null && value.value !== '') {
    throw fail(`${path}.value contains inline secret material`, 400, 'INLINE_SECRET_MATERIAL');
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && !/ref(erence)?$/i.test(key) && child != null && child !== '') {
      throw fail(`${path}.${key} contains inline secret material`, 400, 'INLINE_SECRET_MATERIAL');
    }
    secretFree(child, `${path}.${key}`);
  }
}
function safeHttpsUrl(value, key) {
  let url; try { url = new URL(String(value || '')); } catch { throw fail(`${key} must be a valid URL`); }
  if (url.protocol !== 'https:' || url.username || url.password
    || [...url.searchParams.keys()].some(name => SECRET_KEY.test(name) || /signature|auth/i.test(name))) {
    throw fail(`${key} must be a credential-free HTTPS URL`, 400, 'UNSAFE_SOURCE_URL');
  }
  return url.toString();
}
function safeDate(value, key) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) throw fail(`${key} must be an ISO timestamp`); return date.toISOString();
}
function sanitizeVm(value) {
  const result = JSON.parse(JSON.stringify(value || {})); delete result.status;
  if (result.metadata) for (const key of ['managedFields','resourceVersion','uid','creationTimestamp','generation','selfLink']) delete result.metadata[key];
  return result;
}
function parseVmManifest(value) {
  let manifest = value;
  if (typeof value === 'string') {
    bounded(value, 'manifest', 512 * 1024); const docs = YAML.parseAllDocuments(value, { uniqueKeys: true, maxAliasCount: 0 });
    if (docs.length !== 1 || docs[0].errors.length) throw fail('Manifest must be one valid YAML document', 400, 'INVALID_VM_MANIFEST');
    manifest = docs[0].toJS({ maxAliasCount: 0 });
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw fail('manifest must be an object');
  if (manifest.apiVersion !== 'kubevirt.io/v1' || manifest.kind !== 'VirtualMachine') {
    throw fail('Only kubevirt.io/v1 VirtualMachine manifests are supported', 400, 'INVALID_VM_MANIFEST');
  }
  if (!manifest.metadata?.namespace || !manifest.metadata?.name || !manifest.spec?.template?.spec?.domain) {
    throw fail('VirtualMachine identity and domain are required', 400, 'INVALID_VM_MANIFEST');
  }
  if (manifest.status != null) throw fail('status is server-owned', 400, 'INVALID_VM_MANIFEST');
  const result = sanitizeVm(manifest); secretFree(result, 'manifest'); bounded(result, 'manifest'); return canonical(result);
}
function gitOpsPlanRow(row) { return row && { id: row.id, hostId: row.host_id, namespace: row.namespace,
  vmName: row.vm_name, sourceKind: row.source_kind, repositoryUrl: row.repository_url,
  repositoryPath: row.repository_path, revision: row.revision, manifest: parse(row.manifest_json, {}),
  desiredHash: row.desired_hash, liveHash: row.live_hash, state: row.state, dryRun: parse(row.dry_run_json, {}),
  controllerStatus: parse(row.controller_status_json, {}), planHash: row.plan_hash,
  providerMutationsStarted: 0, createdAt: row.created_at }; }

class KubernetesUnifiedPlatformService {
  constructor(dbProvider = getDb, clientFactory = fromHostRow) { this._dbProvider = dbProvider; this._clientFactory = clientFactory; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  _host(row) { if (!row?.id || row.daemon_type !== 'kubernetes') throw fail('A registered Kubernetes host is required', 400, 'KUBERNETES_HOST_REQUIRED'); }
  _client(row) { this._host(row); return this._clientFactory(row); }

  async liveEvidence(row, kind, namespace) {
    if (!EVIDENCE_KINDS.has(kind)) throw fail('Evidence kind is invalid'); const client = this._client(row);
    const scope = namespace ? safeName(namespace, 'namespace') : undefined;
    if (kind === 'topology') return client.unifiedWorkloadTopology(scope);
    if (kind === 'metrics') return client.unifiedWorkloadMetrics(scope);
    if (kind === 'policy') return client.unifiedPolicyEvidence(scope);
    if (kind === 'gitops') return client.gitOpsControllerStatus(scope);
    return client.clusterLifecycleDashboard();
  }
  async refreshEvidence(row, kind, namespace, actor) {
    this._admin(actor); const evidence = await this.liveEvidence(row, kind, namespace); bounded(evidence, 'evidence', 3 * 1024 * 1024);
    const evidenceHash = hash(withoutObservationTimestamp(evidence)); const scope = namespace || null;
    const snapshotHash = hash({ hostId: row.id, kind, scope, evidenceHash }); const db = this._db();
    const existing = db.prepare('SELECT * FROM kubernetes_unified_evidence_snapshots WHERE snapshot_hash=?').get(snapshotHash);
    if (existing) return { id: existing.id, hostId: row.id, kind, namespace: scope, evidence,
      evidenceHash, snapshotHash, duplicate: true, createdAt: existing.created_at };
    const saved = db.prepare(`INSERT INTO kubernetes_unified_evidence_snapshots
      (host_id,evidence_kind,namespace_scope,evidence_json,evidence_hash,snapshot_hash,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, kind, scope, stable(evidence), evidenceHash, snapshotHash, actor.id);
    const createdAt = db.prepare('SELECT created_at FROM kubernetes_unified_evidence_snapshots WHERE id=?').get(saved.lastInsertRowid).created_at;
    return { id: Number(saved.lastInsertRowid), hostId: row.id, kind, namespace: scope, evidence,
      evidenceHash, snapshotHash, duplicate: false, createdAt };
  }
  snapshots(hostId, actor) {
    this._admin(actor); const id = integer(hostId, 'hostId', 1, Number.MAX_SAFE_INTEGER);
    return this._db().prepare(`SELECT * FROM kubernetes_unified_evidence_snapshots WHERE host_id=? ORDER BY id DESC LIMIT 100`)
      .all(id).map(row => ({ id: row.id, hostId: row.host_id, kind: row.evidence_kind,
        namespace: row.namespace_scope, evidence: parse(row.evidence_json, {}), evidenceHash: row.evidence_hash,
        snapshotHash: row.snapshot_hash, createdAt: row.created_at }));
  }

  async planVmGitOps(row, body = {}, actor) {
    this._admin(actor); const client = this._client(row); const manifest = parseVmManifest(body.manifest);
    const namespace = safeName(manifest.metadata.namespace, 'metadata.namespace'); const vmName = safeName(manifest.metadata.name, 'metadata.name');
    const sourceKind = String(body.sourceKind || 'repository'); if (!SOURCE_KINDS.has(sourceKind)) throw fail('sourceKind is invalid');
    const repositoryUrl = safeHttpsUrl(body.repositoryUrl, 'repositoryUrl'); const repositoryPath = safeText(body.repositoryPath,
      'repositoryPath', 400, /^[a-zA-Z0-9][a-zA-Z0-9._/+-]{0,399}$/);
    if (repositoryPath.startsWith('/') || repositoryPath.split(/[\\/]+/).includes('..')) throw fail('repositoryPath must be a safe relative path');
    const revision = safeText(body.revision || 'main', 'revision', 160, /^[a-zA-Z0-9][a-zA-Z0-9._/@+-]{0,159}$/);
    let live = null; let state = 'missing';
    try { live = sanitizeVm(await client.getKubeVirtVirtualMachine(namespace, vmName)); state = hash(live) === hash(manifest) ? 'in_sync' : 'drift'; }
    catch (error) { if (error.status !== 404) throw error; }
    let response;
    try { response = live ? await client.dryRunKubeVirtVirtualMachine(namespace, vmName, YAML.stringify(manifest, { lineWidth: 0 }))
      : await client.dryRunCreateKubeVirtVirtualMachine(namespace, manifest); }
    catch (error) { throw fail('Kubernetes rejected the GitOps dry-run', error.status || 422, 'SERVER_DRY_RUN_REJECTED',
      { reason: error.kubernetesResponse?.reason || null, message: String(error.kubernetesResponse?.message || error.message).slice(0, 800) }); }
    const dryRun = { accepted: true, dryRun: 'All', namespace: response?.metadata?.namespace || namespace,
      name: response?.metadata?.name || vmName, kind: response?.kind || 'VirtualMachine' };
    const controllerStatus = await client.gitOpsControllerStatus(namespace);
    const desiredHash = hash(manifest); const liveHash = live ? hash(live) : null;
    const planHash = hash({ hostId: row.id, namespace, vmName, sourceKind, repositoryUrl,
      repositoryPath, revision, desiredHash, liveHash, state, dryRun,
      controllerStatus: withoutObservationTimestamp(controllerStatus) }); const db = this._db();
    const existing = db.prepare('SELECT * FROM kubernetes_vm_gitops_plans WHERE plan_hash=?').get(planHash);
    if (existing) return { ...gitOpsPlanRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO kubernetes_vm_gitops_plans
      (host_id,namespace,vm_name,source_kind,repository_url,repository_path,revision,manifest_json,desired_hash,
       live_hash,state,dry_run_json,controller_status_json,plan_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, namespace, vmName, sourceKind, repositoryUrl, repositoryPath, revision, stable(manifest), desiredHash,
        liveHash, state, stable(dryRun), stable(controllerStatus), planHash, actor.id);
    return { ...gitOpsPlanRow(db.prepare('SELECT * FROM kubernetes_vm_gitops_plans WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  gitOpsPlans(hostId, actor) {
    this._admin(actor); const id = integer(hostId, 'hostId', 1, Number.MAX_SAFE_INTEGER);
    return this._db().prepare('SELECT * FROM kubernetes_vm_gitops_plans WHERE host_id=? ORDER BY id DESC LIMIT 100').all(id).map(gitOpsPlanRow);
  }

  admissionPolicies(actor) {
    this._admin(actor); return this._db().prepare('SELECT * FROM kubernetes_vm_admission_policies WHERE enabled=1 ORDER BY id')
      .all().map(row => ({ id: row.id, slug: row.slug, name: row.name, category: row.category,
        description: row.description, version: row.version, enabled: !!row.enabled }));
  }
  evaluateAdmission(row, body = {}, actor) {
    this._admin(actor); if (row) this._host(row); const manifest = parseVmManifest(body.manifest);
    const profile = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile) ? body.profile : {};
    secretFree(profile, 'profile'); bounded(profile, 'profile', 64 * 1024);
    const trustedImages = Array.isArray(profile.trustedImagePrefixes) ? profile.trustedImagePrefixes.map((value, index) =>
      safeText(value, `trustedImagePrefixes[${index}]`, 300)) : [];
    const allowedNetworks = Array.isArray(profile.allowedNetworks) ? profile.allowedNetworks.map((value, index) =>
      safeText(value, `allowedNetworks[${index}]`, 300, SAFE_REF)) : [];
    const maxCpu = integer(profile.maxCpu ?? 64, 'maxCpu', 1, 1024); const maxMemoryGiB = integer(profile.maxMemoryGiB ?? 256, 'maxMemoryGiB', 1, 65536);
    const domain = manifest.spec.template.spec.domain; const firmware = domain.firmware || {};
    const secureBoot = firmware.bootloader?.efi && firmware.bootloader.efi.secureBoot !== false && domain.features?.smm?.enabled === true;
    const images = [];
    for (const volume of manifest.spec.template.spec.volumes || []) if (volume.containerDisk?.image) images.push(volume.containerDisk.image);
    for (const template of manifest.spec.dataVolumeTemplates || []) {
      const source = template.spec?.source || {}; if (source.registry?.url) images.push(source.registry.url); if (source.http?.url) images.push(source.http.url);
    }
    const untrusted = trustedImages.length ? images.filter(image => !trustedImages.some(prefix => image.startsWith(prefix))) : images;
    const cpuText = String(domain.cpu?.cores || domain.resources?.requests?.cpu || '0');
    const cpu = /^\d+(?:\.\d+)?m$/.test(cpuText) ? Number(cpuText.slice(0, -1)) / 1000 : Number(cpuText);
    const memoryText = String(domain.memory?.guest || domain.resources?.requests?.memory || '');
    const memoryMatch = memoryText.match(/^(\d+(?:\.\d+)?)(Mi|Gi|Ti)$/); const memoryGiB = memoryMatch
      ? Number(memoryMatch[1]) * ({ Mi: 1 / 1024, Gi: 1, Ti: 1024 }[memoryMatch[2]]) : null;
    const resourcesPass = cpu > 0 && cpu <= maxCpu && memoryGiB != null && memoryGiB > 0 && memoryGiB <= maxMemoryGiB;
    const networks = (manifest.spec.template.spec.networks || []).filter(item => item.multus).map(item => item.multus.networkName).filter(Boolean);
    const disallowedNetworks = allowedNetworks.length ? networks.filter(name => !allowedNetworks.includes(name)) : networks;
    const labels = manifest.metadata.labels || {}; const requiredLabels = profile.requiredLabels ||
      ['app.kubernetes.io/name','app.kubernetes.io/part-of','docker-dash.io/owner','docker-dash.io/environment'];
    if (!Array.isArray(requiredLabels) || requiredLabels.length > 20) throw fail('requiredLabels is invalid');
    const missingLabels = requiredLabels.filter(key => !labels[key]);
    const results = [
      { policy: 'secure-boot-required', outcome: secureBoot ? 'pass' : 'fail', evidence: { efi: !!firmware.bootloader?.efi, smm: domain.features?.smm?.enabled === true } },
      { policy: 'trusted-image-source', outcome: !images.length || untrusted.length ? 'fail' : 'pass', evidence: { imageCount: images.length, untrusted } },
      { policy: 'bounded-resources', outcome: resourcesPass ? 'pass' : 'fail', evidence: { cpu, memoryGiB, maxCpu, maxMemoryGiB } },
      { policy: 'approved-networks', outcome: disallowedNetworks.length ? 'fail' : 'pass', evidence: { networks, disallowed: disallowedNetworks } },
      { policy: 'ownership-labels', outcome: missingLabels.length ? 'fail' : 'pass', evidence: { requiredLabels, missing: missingLabels } },
    ];
    const failures = results.filter(result => result.outcome === 'fail').length;
    const decision = failures ? 'fail' : results.some(result => result.outcome === 'warn') ? 'warn' : 'pass';
    const namespace = safeName(manifest.metadata.namespace, 'metadata.namespace'); const vmName = safeName(manifest.metadata.name, 'metadata.name');
    const manifestHash = hash(manifest); const normalizedProfile = canonical({ trustedImagePrefixes: trustedImages,
      allowedNetworks, maxCpu, maxMemoryGiB, requiredLabels }); const evaluationHash = hash({ hostId: row?.id || null,
      namespace, vmName, manifestHash, profile: normalizedProfile, results }); const db = this._db();
    const existing = db.prepare('SELECT * FROM kubernetes_vm_admission_evaluations WHERE evaluation_hash=?').get(evaluationHash);
    if (existing) return { id: existing.id, hostId: existing.host_id, namespace, vmName, manifestHash,
      profile: parse(existing.profile_json, {}), results: parse(existing.results_json, []), decision: existing.decision,
      evaluationHash, enforced: false, duplicate: true, createdAt: existing.created_at };
    const saved = db.prepare(`INSERT INTO kubernetes_vm_admission_evaluations
      (host_id,namespace,vm_name,manifest_hash,profile_json,results_json,decision,evaluation_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(row?.id || null, namespace, vmName, manifestHash,
      stable(normalizedProfile), stable(results), decision, evaluationHash, actor.id);
    const createdAt = db.prepare('SELECT created_at FROM kubernetes_vm_admission_evaluations WHERE id=?').get(saved.lastInsertRowid).created_at;
    return { id: Number(saved.lastInsertRowid), hostId: row?.id || null, namespace, vmName, manifestHash,
      profile: normalizedProfile, results, decision, evaluationHash, enforced: false, duplicate: false, createdAt };
  }

  clusterCatalog(actor) {
    this._admin(actor); return this._db().prepare('SELECT * FROM kubernetes_cluster_provisioning_catalog WHERE enabled=1 ORDER BY id')
      .all().map(row => ({ id: row.id, slug: row.slug, name: row.name, provider: row.provider,
        parameters: parse(row.parameters_json, []), stages: parse(row.stages_json, []), curated: !!row.curated,
        executionSupported: false }));
  }
  planCluster(body = {}, actor) {
    this._admin(actor); const slug = safeName(body.catalogSlug, 'catalogSlug'); const db = this._db();
    const catalog = db.prepare('SELECT * FROM kubernetes_cluster_provisioning_catalog WHERE slug=? AND enabled=1').get(slug);
    if (!catalog) throw fail('Cluster catalog workflow not found', 404, 'CATALOG_NOT_FOUND');
    const allowed = parse(catalog.parameters_json, []); const values = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters) ? body.parameters : {};
    const unknown = Object.keys(values).filter(key => !allowed.includes(key)); const missing = allowed.filter(key => values[key] == null || values[key] === '');
    if (unknown.length || missing.length) throw fail('Cluster parameters do not match the curated workflow', 400, 'INVALID_CLUSTER_PARAMETERS', { unknown, missing });
    const normalized = {};
    for (const key of allowed) {
      if (key === 'nodeCount') normalized[key] = integer(values[key], key, 1, 500);
      else normalized[key] = safeText(values[key], key, 300, SAFE_REF);
      if (/ref$/i.test(key) && !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{2,299}$/.test(normalized[key])) throw fail(`${key} must be an opaque registered reference`);
    }
    secretFree(normalized, 'parameters'); const stages = parse(catalog.stages_json, []);
    const prechecks = stages.filter(stage => stage.startsWith('validate_')).map(stage => ({ stage, state: 'required', evidence: 'not_collected' }));
    const state = prechecks.length ? 'blocked' : 'planned'; const planName = safeName(body.planName || normalized.clusterName, 'planName');
    const planHash = hash({ catalog: catalog.slug, planName, parameters: normalized, stages, prechecks });
    const existing = db.prepare('SELECT * FROM kubernetes_cluster_provisioning_plans WHERE plan_hash=?').get(planHash);
    if (existing) return { id: existing.id, catalogSlug: catalog.slug, planName: existing.plan_name,
      parameters: parse(existing.parameters_json, {}), stages, prechecks: parse(existing.prechecks_json, []),
      planHash, state: existing.state, executionSupported: false, providerMutationsStarted: 0, duplicate: true };
    const saved = db.prepare(`INSERT INTO kubernetes_cluster_provisioning_plans
      (catalog_id,plan_name,parameters_json,prechecks_json,plan_hash,state,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(catalog.id, planName, stable(normalized), stable(prechecks), planHash, state, actor.id);
    return { id: Number(saved.lastInsertRowid), catalogSlug: catalog.slug, planName, parameters: normalized, stages,
      prechecks, planHash, state, executionSupported: false, providerMutationsStarted: 0, duplicate: false };
  }
  clusterPlans(actor) {
    this._admin(actor); return this._db().prepare(`SELECT p.*,c.slug AS catalog_slug,c.stages_json FROM kubernetes_cluster_provisioning_plans p
      JOIN kubernetes_cluster_provisioning_catalog c ON c.id=p.catalog_id ORDER BY p.id DESC LIMIT 100`).all().map(row => ({
      id: row.id, catalogSlug: row.catalog_slug, planName: row.plan_name, parameters: parse(row.parameters_json, {}),
      stages: parse(row.stages_json, []), prechecks: parse(row.prechecks_json, []), planHash: row.plan_hash,
      state: row.state, executionSupported: false, providerMutationsStarted: 0, createdAt: row.created_at }));
  }

  createModernizationMap(body = {}, actor) {
    this._admin(actor); const name = safeText(body.name, 'name', 160); const sourceVmRef = safeText(body.sourceVmRef, 'sourceVmRef', 500, SAFE_REF);
    const targetPlatform = safeText(body.targetPlatform || 'kubernetes', 'targetPlatform', 100, SAFE_REF);
    if (!Array.isArray(body.dependencies) || body.dependencies.length > 200) throw fail('dependencies must contain at most 200 entries');
    const dependencyKinds = new Set(['database','api','file','message_queue','dns','identity','storage','external']);
    const dependencies = body.dependencies.map((item, index) => {
      const kind = String(item?.kind || ''); if (!dependencyKinds.has(kind)) throw fail(`dependencies[${index}].kind is invalid`);
      return { id: safeName(item.id || `dependency-${index + 1}`, `dependencies[${index}].id`), kind,
        ref: safeText(item.ref, `dependencies[${index}].ref`, 500, SAFE_REF), protocol: safeText(item.protocol || 'unknown', `dependencies[${index}].protocol`, 40, SAFE_REF),
        port: item.port == null ? null : integer(item.port, `dependencies[${index}].port`, 1, 65535),
        criticality: ['low','medium','high','critical'].includes(item.criticality) ? item.criticality : 'medium',
        state: ['known','unknown','blocked'].includes(item.state) ? item.state : 'unknown',
        targetRef: item.targetRef ? safeText(item.targetRef, `dependencies[${index}].targetRef`, 500, SAFE_REF) : null };
    });
    const stageNames = ['discovery','baseline','containerize','data_migration','parallel_validation','cutover','rollback_validation'];
    const supplied = body.stages && typeof body.stages === 'object' && !Array.isArray(body.stages) ? body.stages : {};
    const stages = stageNames.map(stage => ({ stage, state: ['pending','ready','complete','blocked'].includes(supplied[stage]) ? supplied[stage] : 'pending' }));
    const blockers = [];
    if (dependencies.some(item => item.state !== 'known')) blockers.push('Dependencies remain unknown or blocked');
    if (dependencies.some(item => ['database','storage','file'].includes(item.kind) && !item.targetRef)) blockers.push('Stateful dependency lacks a target mapping');
    if (!body.owner) blockers.push('Application owner is missing');
    if (stages.find(stage => stage.stage === 'rollback_validation').state !== 'complete') blockers.push('Rollback validation is incomplete');
    const readinessScore = Math.max(0, 100 - blockers.length * 20 - stages.filter(stage => stage.state === 'pending').length * 5);
    const normalized = { name, sourceVmRef, targetPlatform, owner: body.owner ? safeText(body.owner, 'owner', 200, SAFE_REF) : null,
      dependencies, stages, blockers, readinessScore }; const mapHash = hash(normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM virtualization_modernization_maps WHERE map_hash=?').get(mapHash);
    if (existing) return { ...this._modernizationRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO virtualization_modernization_maps
      (name,source_vm_ref,target_platform,dependencies_json,stages_json,blockers_json,readiness_score,map_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(name, sourceVmRef, targetPlatform, stable(dependencies), stable(stages),
        stable(blockers), readinessScore, mapHash, actor.id);
    return { ...this._modernizationRow(db.prepare('SELECT * FROM virtualization_modernization_maps WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _modernizationRow(row) { return row && { id: row.id, name: row.name, sourceVmRef: row.source_vm_ref,
    targetPlatform: row.target_platform, dependencies: parse(row.dependencies_json, []), stages: parse(row.stages_json, []),
    blockers: parse(row.blockers_json, []), readinessScore: row.readiness_score, mapHash: row.map_hash,
    providerMutationsStarted: 0, createdAt: row.created_at }; }
  modernizationMaps(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM virtualization_modernization_maps ORDER BY id DESC LIMIT 100').all().map(row => this._modernizationRow(row)); }

  ingestImageProvenance(body = {}, actor) {
    this._admin(actor); const imageKind = String(body.imageKind || ''); if (!['oci','vm'].includes(imageKind)) throw fail('imageKind must be oci or vm');
    const imageRef = safeText(body.imageRef, 'imageRef', 500, SAFE_REF); const digest = String(body.digest || '').toLowerCase();
    if (!DIGEST.test(digest)) throw fail('digest must use sha256:<64 lowercase hex>'); const sourceUrl = safeHttpsUrl(body.sourceUrl, 'sourceUrl');
    const sbomInput = body.sbom && typeof body.sbom === 'object' && !Array.isArray(body.sbom) ? body.sbom : {};
    const sbom = { format: sbomInput.format ? safeText(sbomInput.format, 'sbom.format', 80, SAFE_REF) : null,
      digest: sbomInput.digest ? String(sbomInput.digest).toLowerCase() : null,
      url: sbomInput.url ? safeHttpsUrl(sbomInput.url, 'sbom.url') : null,
      packageCount: sbomInput.packageCount == null ? null : integer(sbomInput.packageCount, 'sbom.packageCount', 0, 10_000_000),
      generatedAt: sbomInput.generatedAt ? safeDate(sbomInput.generatedAt, 'sbom.generatedAt') : null };
    if (sbom.digest && !DIGEST.test(sbom.digest)) throw fail('sbom.digest is invalid');
    if (!Array.isArray(body.signatures) || body.signatures.length > 50) throw fail('signatures must contain at most 50 entries');
    const signatures = body.signatures.map((item, index) => ({ type: safeText(item?.type || 'unknown', `signatures[${index}].type`, 80, SAFE_REF),
      signer: item?.signer ? safeText(item.signer, `signatures[${index}].signer`, 300, SAFE_REF) : null,
      digest: item?.digest ? String(item.digest).toLowerCase() : null,
      verified: item?.verified === true, verifier: item?.verified ? safeText(item.verifier, `signatures[${index}].verifier`, 200, SAFE_REF) : null,
      verifiedAt: item?.verified ? safeDate(item.verifiedAt, `signatures[${index}].verifiedAt`) : null }));
    if (signatures.some(item => item.digest && !DIGEST.test(item.digest))) throw fail('signature digest is invalid');
    if (signatures.some(item => item.verified && (!item.verifiedAt || Number.isNaN(Date.parse(item.verifiedAt))))) throw fail('verified signatures require verifiedAt');
    if (!Array.isArray(body.links) || body.links.length > 100) throw fail('links must contain at most 100 entries');
    const links = body.links.map((item, index) => ({ kind: safeText(item?.kind, `links[${index}].kind`, 80, SAFE_REF),
      ref: safeText(item?.ref, `links[${index}].ref`, 500, SAFE_REF) }));
    secretFree({ sbom, signatures, links }, 'provenance'); const trustState = signatures.some(item => item.verified)
      ? 'externally_verified' : signatures.length ? 'unverified' : 'unknown';
    const normalized = { imageKind, imageRef, digest, sourceUrl, sbom, signatures, links, trustState };
    const evidenceHash = hash(normalized); const db = this._db(); const existing = db.prepare('SELECT * FROM shared_image_provenance WHERE evidence_hash=?').get(evidenceHash);
    if (existing) return { ...this._provenanceRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO shared_image_provenance
      (image_kind,image_ref,digest,source_url,sbom_json,signatures_json,links_json,trust_state,evidence_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(imageKind, imageRef, digest, sourceUrl, stable(sbom), stable(signatures),
        stable(links), trustState, evidenceHash, actor.id);
    return { ...this._provenanceRow(db.prepare('SELECT * FROM shared_image_provenance WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  _provenanceRow(row) { return row && { id: row.id, imageKind: row.image_kind, imageRef: row.image_ref,
    digest: row.digest, sourceUrl: row.source_url, sbom: parse(row.sbom_json, {}), signatures: parse(row.signatures_json, []),
    links: parse(row.links_json, []), trustState: row.trust_state, evidenceHash: row.evidence_hash, createdAt: row.created_at }; }
  imageProvenance(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM shared_image_provenance ORDER BY id DESC LIMIT 200').all().map(row => this._provenanceRow(row)); }

  saveApplicationEnvironment(body = {}, actor) {
    this._admin(actor); const slug = safeName(body.slug, 'slug'); const name = safeText(body.name, 'name', 160);
    const environment = String(body.environment || 'other'); if (!['development','test','staging','production','other'].includes(environment)) throw fail('environment is invalid');
    const owner = safeText(body.owner, 'owner', 200, SAFE_REF); if (!Array.isArray(body.components) || !body.components.length || body.components.length > 200) throw fail('components must contain 1-200 entries');
    const types = new Set(['compose_stack','kubernetes_workload','kubevirt_vm','oci_image','vm_image']);
    const components = body.components.map((item, index) => { const type = String(item?.type || ''); if (!types.has(type)) throw fail(`components[${index}].type is invalid`);
      return { id: safeName(item.id, `components[${index}].id`), type,
        ref: safeText(item.ref, `components[${index}].ref`, 500, SAFE_REF),
        hostId: item.hostId == null ? null : integer(item.hostId, `components[${index}].hostId`, 1, Number.MAX_SAFE_INTEGER),
        namespace: item.namespace ? safeName(item.namespace, `components[${index}].namespace`) : null };
    });
    for (const component of components.filter(item => item.hostId)) {
      const host = this._db().prepare('SELECT daemon_type FROM docker_hosts WHERE id=?').get(component.hostId);
      if (!host) throw fail(`Component host ${component.hostId} was not found`, 404, 'HOST_NOT_FOUND');
      if (['kubernetes_workload','kubevirt_vm'].includes(component.type) && host.daemon_type !== 'kubernetes') {
        throw fail(`Component ${component.id} requires a Kubernetes host`, 409, 'COMPONENT_HOST_MISMATCH');
      }
    }
    const ids = new Set(components.map(item => item.id)); if (ids.size !== components.length) throw fail('component ids must be unique');
    if (!Array.isArray(body.relationships) || body.relationships.length > 500) throw fail('relationships must contain at most 500 entries');
    const relationKinds = new Set(['depends_on','connects_to','uses_image','observed_as','replaces']);
    const relationships = body.relationships.map((item, index) => {
      if (!ids.has(item?.from) || !ids.has(item?.to) || !relationKinds.has(item?.kind)) throw fail(`relationships[${index}] is invalid`);
      return { from: item.from, to: item.to, kind: item.kind };
    });
    const normalized = { slug, name, environment, owner, components, relationships }; const environmentHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO unified_application_environments
      (slug,name,environment,owner,components_json,relationships_json,environment_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name,environment=excluded.environment,
      owner=excluded.owner,components_json=excluded.components_json,relationships_json=excluded.relationships_json,
      environment_hash=excluded.environment_hash,updated_at=datetime('now')`).run(slug, name, environment, owner,
        stable(components), stable(relationships), environmentHash, actor.id);
    return this.applicationEnvironment(slug, actor);
  }
  applicationEnvironment(slugValue, actor) {
    this._admin(actor); const slug = safeName(slugValue, 'slug'); const row = this._db().prepare('SELECT * FROM unified_application_environments WHERE slug=?').get(slug);
    if (!row) throw fail('Application environment not found', 404, 'ENVIRONMENT_NOT_FOUND');
    const components = parse(row.components_json, []); const provenance = this.imageProvenance(actor);
    const modernization = this.modernizationMaps(actor);
    return { id: row.id, slug: row.slug, name: row.name, environment: row.environment, owner: row.owner,
      components: components.map(component => ({ ...component,
        provenance: ['oci_image','vm_image'].includes(component.type) ? provenance.filter(item => item.imageRef === component.ref) : [],
        modernization: component.type === 'kubevirt_vm' ? modernization.filter(item => item.sourceVmRef === component.ref) : [] })),
      relationships: parse(row.relationships_json, []), environmentHash: row.environment_hash,
      coverage: { liveRefreshRequired: components.some(component => component.hostId), provenanceRecords: provenance.length,
        modernizationMaps: modernization.length }, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  applicationEnvironments(actor) {
    this._admin(actor); return this._db().prepare('SELECT slug FROM unified_application_environments ORDER BY name').all()
      .map(row => this.applicationEnvironment(row.slug, actor));
  }
}

const service = new KubernetesUnifiedPlatformService();
module.exports = service;
module.exports.KubernetesUnifiedPlatformService = KubernetesUnifiedPlatformService;
module.exports.KubernetesUnifiedPlatformError = KubernetesUnifiedPlatformError;
module.exports._internals = { canonical, stable, hash, secretFree, parseVmManifest, sanitizeVm, safeHttpsUrl,
  withoutObservationTimestamp };
