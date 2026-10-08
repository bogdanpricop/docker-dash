'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const governanceSingleton = require('./governance');
const approvalsSingleton = require('./governance-approvals');
const operationsSingleton = require('./provider-operations');
const vmProvisionSingleton = require('./provider-operations/vm-provision');
const vmPowerSingleton = require('./provider-operations/vm-power');
const vmSnapshotsSingleton = require('./provider-operations/vm-snapshots');

const REQUEST_STATES = new Set(['requested', 'approved', 'rejected', 'running', 'validated', 'failed', 'cancelled', 'expired']);
const LIFECYCLE_ACTIONS = new Set(['start', 'shutdown', 'reboot', 'snapshot', 'console']);
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const SECRET_KEY = /(password|passwd|secret|token|private.?key|credential|authorization|cookie)/i;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;
const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/i;
const MAX_JSON_BYTES = 32 * 1024;

class SelfServiceError extends Error {
  constructor(message, status = 400, code = 'SELF_SERVICE_ERROR', details) {
    super(message); this.name = 'SelfServiceError'; this.status = status; this.code = code; this.details = details;
  }
}

function fail(message, status = 400, code = 'SELF_SERVICE_ERROR', details) {
  throw new SelfServiceError(message, status, code, details);
}

function integer(value, field, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`${field} is invalid`, 400, 'INVALID_INPUT');
  return number;
}

function text(value, field, max = 240) {
  const result = String(value || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!result) fail(`${field} is required`, 400, 'INVALID_INPUT');
  if (result.length > max) fail(`${field} is too long`, 400, 'INVALID_INPUT');
  return result;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function safeJson(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`, 400, 'INVALID_INPUT');
  const visit = (entry, depth = 0) => {
    if (depth > 8) fail(`${field} is too deeply nested`, 400, 'INVALID_INPUT');
    if (Array.isArray(entry)) { if (entry.length > 100) fail(`${field} has too many values`, 400, 'INVALID_INPUT'); return entry.forEach(value => visit(value, depth + 1)); }
    if (entry && typeof entry === 'object') for (const [key, child] of Object.entries(entry)) {
      if (SECRET_KEY.test(key)) fail(`${field} must not contain credentials or secrets`, 400, 'SECRET_INPUT_REJECTED');
      visit(child, depth + 1);
    }
  };
  visit(value);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) fail(`${field} is too large`, 413, 'INPUT_TOO_LARGE');
  return encoded;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => {
    out[key] = stable(value[key]); return out;
  }, {});
  return value;
}

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function requestKey() { return `ssr_${crypto.randomBytes(13).toString('hex')}`; }
function nowPlus(minutes) { return new Date(Date.now() + minutes * 60_000).toISOString(); }

function publicTarget(target) {
  if (!target || typeof target !== 'object') return null;
  return { providerType: target.providerType || null, configured: Boolean(target.hostId && target.artifactId) };
}

function catalogVersion(row, canManage = false) {
  if (!row) return null;
  const offering = parseJson(row.offering_json, {});
  const result = {
    id: row.id, itemId: row.item_id, version: row.version, state: row.state, changelog: row.changelog,
    compatibility: parseJson(row.compatibility_json, {}), formSchema: parseJson(row.form_schema_json, { fields: [] }),
    offering: { ...offering, targets: (offering.targets || []).map(publicTarget) },
    costModel: parseJson(row.cost_model_json, {}), versionHash: row.version_hash,
    createdBy: row.created_by, createdAt: row.created_at, publishedAt: row.published_at,
  };
  if (canManage) result.management = { offering };
  return result;
}

function catalogItem(row, version = null, canManage = false) {
  return {
    id: row.id, slug: row.slug, name: row.name, kind: row.kind, owner: row.owner,
    description: row.description, lifecycle: row.lifecycle, currentVersionId: row.current_version_id,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(version ? { version: catalogVersion(version, canManage) } : {}),
  };
}

function requestRow(row, events = null) {
  if (!row) return null;
  const result = {
    id: row.id, requestKey: row.request_key, tenantId: row.tenant_id, catalogVersionId: row.catalog_version_id,
    requestKind: row.request_kind, actionKey: row.action_key, resourceRef: row.resource_ref,
    request: parseJson(row.request_json, {}), diff: parseJson(row.normalized_diff_json, {}),
    costPreview: parseJson(row.cost_preview_json, {}), risk: row.risk,
    approvalRequestId: row.approval_request_id, providerOperationId: row.provider_operation_id,
    state: row.state, requestedBy: row.requested_by, requesterUsername: row.requester_username || null,
    fulfilledBy: row.fulfilled_by, expiresAt: row.expires_at, validatedAt: row.validated_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (events) result.events = events.map(event => ({
    id: event.id, sequence: event.sequence, state: event.state, type: event.event_type,
    message: event.message, evidence: parseJson(event.evidence_json, {}), actorId: event.actor_id, createdAt: event.created_at,
  }));
  return result;
}

class SelfServiceService {
  constructor(options = {}) {
    this._dbProvider = options.dbProvider || getDb;
    this.governance = options.governance || governanceSingleton;
    this.approvals = options.approvals || approvalsSingleton;
    this.operations = options.operations || operationsSingleton;
    this.vmProvision = options.vmProvision || vmProvisionSingleton;
    this.vmPower = options.vmPower || vmPowerSingleton;
    this.vmSnapshots = options.vmSnapshots || vmSnapshotsSingleton;
  }

  _db() { return this._dbProvider(); }
  _admin(actor) { if (!actor?.id || actor.role !== 'admin') fail('Administrator access required', 403, 'ADMIN_REQUIRED'); }
  _approver(actor) { if (!actor?.id || !['admin', 'operator'].includes(actor.role)) fail('Approver access required', 403, 'APPROVER_REQUIRED'); }

  _project(tenantId, actor, permission = 'self_service.read') {
    const project = this.governance.getProject(integer(tenantId, 'tenantId'), actor);
    if (actor.role !== 'admin' && !new Set(project.permissions || []).has(permission)) {
      fail(`Project permission ${permission} is required`, 403, 'PROJECT_PERMISSION_REQUIRED', { permission });
    }
    if (project.status !== 'active') fail('Project is not active', 409, 'PROJECT_INACTIVE');
    return project;
  }

  _scopeId(tenantId) {
    return this._db().prepare("SELECT id FROM governance_scopes WHERE scope_type='project' AND tenant_id=?").get(tenantId)?.id || null;
  }

  _policy(tenantId) {
    const row = this._db().prepare('SELECT * FROM self_service_project_policies WHERE tenant_id=?').get(tenantId);
    return row ? {
      tenantId: row.tenant_id, allowedItemSlugs: parseJson(row.allowed_item_slugs_json, []),
      allowedActions: parseJson(row.allowed_actions_json, []), maximumRisk: row.maximum_risk,
      requireApproval: !!row.require_approval, updatedBy: row.updated_by, updatedAt: row.updated_at,
    } : {
      tenantId, allowedItemSlugs: [], allowedActions: ['start', 'shutdown', 'reboot', 'snapshot', 'console'],
      maximumRisk: 3, requireApproval: true, inherited: true,
    };
  }

  listCatalog(actor, { includeAll = false } = {}) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const canManage = actor.role === 'admin';
    const rows = this._db().prepare(`SELECT i.*,v.id AS v_id,v.item_id AS v_item_id,v.version AS v_version,
      v.state AS v_state,v.changelog AS v_changelog,v.compatibility_json AS v_compatibility_json,
      v.form_schema_json AS v_form_schema_json,v.offering_json AS v_offering_json,v.cost_model_json AS v_cost_model_json,
      v.version_hash AS v_version_hash,v.created_by AS v_created_by,v.created_at AS v_created_at,v.published_at AS v_published_at
      FROM infrastructure_catalog_items i LEFT JOIN infrastructure_catalog_versions v ON v.id=i.current_version_id
      ${includeAll && canManage ? '' : "WHERE i.lifecycle<>'retired' AND v.state IN ('published','deprecated')"}
      ORDER BY i.kind,i.name COLLATE NOCASE`).all();
    return { items: rows.map(row => catalogItem(row, row.v_id ? {
      id: row.v_id, item_id: row.v_item_id, version: row.v_version, state: row.v_state,
      changelog: row.v_changelog, compatibility_json: row.v_compatibility_json, form_schema_json: row.v_form_schema_json,
      offering_json: row.v_offering_json, cost_model_json: row.v_cost_model_json, version_hash: row.v_version_hash,
      created_by: row.v_created_by, created_at: row.v_created_at, published_at: row.v_published_at,
    } : null, canManage)), capabilities: { versioned: true, dynamicForms: true, costPreview: true, automatedKinds: ['vm'] } };
  }

  getCatalogItem(slugOrId, actor, includeVersions = false) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const value = String(slugOrId || '');
    const row = /^\d+$/.test(value)
      ? this._db().prepare('SELECT * FROM infrastructure_catalog_items WHERE id=?').get(Number(value))
      : this._db().prepare('SELECT * FROM infrastructure_catalog_items WHERE slug=?').get(value);
    if (!row || (actor.role !== 'admin' && row.lifecycle === 'retired')) fail('Catalog item not found', 404, 'CATALOG_ITEM_NOT_FOUND');
    const versions = this._db().prepare(`SELECT * FROM infrastructure_catalog_versions WHERE item_id=?
      ${actor.role === 'admin' ? '' : "AND state IN ('published','deprecated')"} ORDER BY id DESC`).all(row.id);
    const current = versions.find(version => version.id === row.current_version_id) || null;
    return { item: catalogItem(row, current, actor.role === 'admin'), ...(includeVersions ? { versions: versions.map(version => catalogVersion(version, actor.role === 'admin')) } : {}) };
  }

  saveCatalogItem(id, input, actor) {
    this._admin(actor);
    const slug = text(input.slug, 'slug', 80).toLowerCase();
    if (!SAFE_SLUG.test(slug)) fail('slug must contain lowercase letters, digits and hyphens', 400, 'INVALID_INPUT');
    const name = text(input.name, 'name', 120); const kind = String(input.kind || '');
    if (!['vm', 'application', 'cluster'].includes(kind)) fail('kind is invalid', 400, 'INVALID_INPUT');
    const owner = text(input.owner, 'owner', 120); const description = text(input.description, 'description', 1000);
    const lifecycle = input.lifecycle || 'active';
    if (!['active', 'deprecated', 'retired'].includes(lifecycle)) fail('lifecycle is invalid', 400, 'INVALID_INPUT');
    const db = this._db();
    if (id) {
      const itemId = integer(id, 'id');
      const result = db.prepare(`UPDATE infrastructure_catalog_items SET slug=?,name=?,kind=?,owner=?,description=?,lifecycle=?,updated_at=datetime('now') WHERE id=?`)
        .run(slug, name, kind, owner, description, lifecycle, itemId);
      if (!result.changes) fail('Catalog item not found', 404, 'CATALOG_ITEM_NOT_FOUND');
      return this.getCatalogItem(itemId, actor, true);
    }
    const result = db.prepare(`INSERT INTO infrastructure_catalog_items (slug,name,kind,owner,description,lifecycle,created_by)
      VALUES (?,?,?,?,?,'active',?)`).run(slug, name, kind, owner, description, actor.id);
    return this.getCatalogItem(result.lastInsertRowid, actor, true);
  }

  createCatalogVersion(itemId, input, actor) {
    this._admin(actor);
    const item = this._db().prepare('SELECT * FROM infrastructure_catalog_items WHERE id=?').get(integer(itemId, 'itemId'));
    if (!item) fail('Catalog item not found', 404, 'CATALOG_ITEM_NOT_FOUND');
    const version = text(input.version, 'version', 60);
    if (!SAFE_VERSION.test(version)) fail('version must be semantic version syntax', 400, 'INVALID_INPUT');
    const compatibility = input.compatibility || {}; const formSchema = input.formSchema || { fields: [] };
    const offering = input.offering || {}; const costModel = input.costModel || {};
    for (const [field, value] of Object.entries({ compatibility, formSchema, offering, costModel })) safeJson(value, field);
    this._validateSchema(formSchema);
    const content = { slug: item.slug, version, compatibility, formSchema, offering, costModel };
    const result = this._db().prepare(`INSERT INTO infrastructure_catalog_versions
      (item_id,version,state,changelog,compatibility_json,form_schema_json,offering_json,cost_model_json,version_hash,created_by)
      VALUES (?,?,'draft',?,?,?,?,?,?,?)`).run(item.id, version, text(input.changelog || 'Catalog version created', 'changelog', 1000),
      JSON.stringify(compatibility), JSON.stringify(formSchema), JSON.stringify(offering), JSON.stringify(costModel), hash(content), actor.id);
    return { version: catalogVersion(this._db().prepare('SELECT * FROM infrastructure_catalog_versions WHERE id=?').get(result.lastInsertRowid), true) };
  }

  transitionCatalogVersion(itemId, versionId, state, actor) {
    this._admin(actor);
    if (!['published', 'deprecated', 'retired'].includes(state)) fail('state is invalid', 400, 'INVALID_INPUT');
    const db = this._db(); const item = db.prepare('SELECT * FROM infrastructure_catalog_items WHERE id=?').get(integer(itemId, 'itemId'));
    const version = db.prepare('SELECT * FROM infrastructure_catalog_versions WHERE id=? AND item_id=?').get(integer(versionId, 'versionId'), item?.id || 0);
    if (!item || !version) fail('Catalog version not found', 404, 'CATALOG_VERSION_NOT_FOUND');
    if (version.state === 'retired') fail('Retired versions are immutable', 409, 'CATALOG_VERSION_IMMUTABLE');
    db.transaction(() => {
      db.prepare(`UPDATE infrastructure_catalog_versions SET state=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,datetime('now')) ELSE published_at END WHERE id=?`)
        .run(state, state, version.id);
      if (state === 'published') db.prepare("UPDATE infrastructure_catalog_items SET current_version_id=?,lifecycle='active',updated_at=datetime('now') WHERE id=?").run(version.id, item.id);
      else if (item.current_version_id === version.id) db.prepare('UPDATE infrastructure_catalog_items SET lifecycle=?,updated_at=datetime(\'now\') WHERE id=?').run(state, item.id);
    })();
    return this.getCatalogItem(item.id, actor, true);
  }

  getProjectPolicy(tenantId, actor) { this._project(tenantId, actor); return { policy: this._policy(Number(tenantId)) }; }

  saveProjectPolicy(tenantId, input, actor) {
    this._admin(actor); const id = integer(tenantId, 'tenantId'); this.governance.getProject(id, actor);
    const allowedItemSlugs = Array.isArray(input.allowedItemSlugs) ? [...new Set(input.allowedItemSlugs.map(value => text(value, 'allowedItemSlug', 80).toLowerCase()))] : [];
    const allowedActions = Array.isArray(input.allowedActions) ? [...new Set(input.allowedActions.map(String))] : [...LIFECYCLE_ACTIONS];
    if (allowedActions.some(action => !LIFECYCLE_ACTIONS.has(action))) fail('allowedActions contains an unsupported action', 400, 'INVALID_INPUT');
    const maximumRisk = integer(input.maximumRisk ?? 3, 'maximumRisk', 1, 4);
    this._db().prepare(`INSERT INTO self_service_project_policies
      (tenant_id,allowed_item_slugs_json,allowed_actions_json,maximum_risk,require_approval,updated_by)
      VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET allowed_item_slugs_json=excluded.allowed_item_slugs_json,
      allowed_actions_json=excluded.allowed_actions_json,maximum_risk=excluded.maximum_risk,
      require_approval=excluded.require_approval,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(id, JSON.stringify(allowedItemSlugs), JSON.stringify(allowedActions), maximumRisk, input.requireApproval === false ? 0 : 1, actor.id);
    return { policy: this._policy(id) };
  }

  _validateSchema(schema) {
    if (!schema || typeof schema !== 'object' || !Array.isArray(schema.fields) || schema.fields.length > 50) fail('formSchema.fields must contain at most 50 fields', 400, 'INVALID_FORM_SCHEMA');
    const keys = new Set();
    for (const field of schema.fields) {
      if (!field || typeof field !== 'object' || !/^[a-z][a-zA-Z0-9_]{0,49}$/.test(String(field.key || ''))) fail('form field key is invalid', 400, 'INVALID_FORM_SCHEMA');
      if (keys.has(field.key) || SECRET_KEY.test(field.key)) fail('form field keys must be unique and secret-free', 400, 'INVALID_FORM_SCHEMA');
      keys.add(field.key);
      if (!['string', 'integer', 'boolean', 'enum'].includes(field.type)) fail('form field type is invalid', 400, 'INVALID_FORM_SCHEMA');
      if (field.type === 'enum' && (!Array.isArray(field.options) || !field.options.length || field.options.length > 50)) fail('enum fields require 1-50 options', 400, 'INVALID_FORM_SCHEMA');
      if (field.visibleWhen && (!keys.has(field.visibleWhen.field) || !Object.hasOwn(field.visibleWhen, 'equals'))) fail('visibleWhen must reference an earlier field', 400, 'INVALID_FORM_SCHEMA');
      if (field.pattern) { try { new RegExp(field.pattern); } catch { fail('form field pattern is invalid', 400, 'INVALID_FORM_SCHEMA'); } }
    }
  }

  evaluateForm(schema, valuesInput, costModel = {}) {
    this._validateSchema(schema);
    const values = valuesInput && typeof valuesInput === 'object' && !Array.isArray(valuesInput) ? valuesInput : {};
    safeJson(values, 'values');
    const normalized = {}; const errors = []; const visible = [];
    for (const field of schema.fields) {
      const isVisible = !field.visibleWhen || normalized[field.visibleWhen.field] === field.visibleWhen.equals;
      if (!isVisible) {
        if (Object.hasOwn(values, field.key)) errors.push({ field: field.key, code: 'HIDDEN_FIELD_SUPPLIED', message: `${field.label || field.key} is not available for this selection` });
        continue;
      }
      visible.push(field.key); let value = Object.hasOwn(values, field.key) ? values[field.key] : field.default;
      if (value === undefined || value === null || value === '') {
        if (field.required) errors.push({ field: field.key, code: 'REQUIRED', message: `${field.label || field.key} is required` });
        continue;
      }
      if (field.type === 'string') {
        value = String(value).trim();
        if (value.length < Number(field.minLength || 0) || value.length > Number(field.maxLength || 500)) errors.push({ field: field.key, code: 'LENGTH', message: `${field.label || field.key} has an invalid length` });
        if (field.pattern && !new RegExp(field.pattern).test(value)) errors.push({ field: field.key, code: 'PATTERN', message: `${field.label || field.key} has an invalid format` });
      } else if (field.type === 'integer') {
        value = Number(value);
        if (!Number.isSafeInteger(value) || value < Number(field.minimum ?? 0) || value > Number(field.maximum ?? Number.MAX_SAFE_INTEGER)) errors.push({ field: field.key, code: 'RANGE', message: `${field.label || field.key} is outside the allowed range` });
      } else if (field.type === 'boolean') {
        if (value !== true && value !== false) errors.push({ field: field.key, code: 'TYPE', message: `${field.label || field.key} must be true or false` });
      } else if (field.type === 'enum' && !field.options.includes(value)) errors.push({ field: field.key, code: 'OPTION', message: `${field.label || field.key} is not an allowed option` });
      normalized[field.key] = value;
    }
    for (const key of Object.keys(values)) if (!schema.fields.some(field => field.key === key)) errors.push({ field: key, code: 'UNKNOWN_FIELD', message: `${key} is not defined by this catalog version` });
    const amount = Number(costModel.base || 0) + Number(normalized.cpu || 0) * Number(costModel.perCpu || 0)
      + Number(normalized.memoryGiB || 0) * Number(costModel.perMemoryGiB || 0)
      + Number(normalized.storageGiB || 0) * Number(costModel.perStorageGiB || 0)
      + (normalized.backup ? Number(costModel.backup || 0) : 0);
    return { valid: errors.length === 0, errors, normalized, visibleFields: visible,
      costPreview: { amount: Math.round(amount * 100) / 100, currency: costModel.currency || 'EUR', period: costModel.period || 'month', estimate: true } };
  }

  previewCatalogRequest(slug, input, actor) {
    const project = this._project(input.tenantId, actor, 'self_service.request');
    const { item } = this.getCatalogItem(slug, actor);
    if (!item.version || item.version.state !== 'published' || item.lifecycle !== 'active') fail('Catalog offering is not requestable', 409, 'CATALOG_NOT_REQUESTABLE');
    const policy = this._policy(project.id);
    if (policy.allowedItemSlugs.length && !policy.allowedItemSlugs.includes(item.slug)) fail('Catalog offering is blocked by project policy', 403, 'CATALOG_POLICY_BLOCKED');
    const evaluation = this.evaluateForm(item.version.formSchema, input.values || {}, item.version.costModel);
    const projected = {
      cpu_millicores: Number(project.usage.cpu_millicores || 0) + Number(evaluation.normalized.cpu || 0) * 1000,
      memory_bytes: Number(project.usage.memory_bytes || 0) + Number(evaluation.normalized.memoryGiB || 0) * 1024 ** 3,
      storage_bytes: Number(project.usage.storage_bytes || 0) + Number(evaluation.normalized.storageGiB || 0) * 1024 ** 3,
    };
    const quotaBlockers = Object.entries(project.quotas || {}).filter(([metric, quota]) => quota.hardLimit != null && projected[metric] > quota.hardLimit)
      .map(([metric, quota]) => ({ metric, projected: projected[metric], hardLimit: quota.hardLimit }));
    const configuredTargets = (item.version.offering?.targets || []).filter(target => target.configured);
    return { project: { id: project.id, name: project.name }, item, evaluation, projectedUsage: projected, quotaBlockers,
      requestable: evaluation.valid && quotaBlockers.length === 0 && configuredTargets.length > 0,
      blockers: [...evaluation.errors, ...quotaBlockers.map(item => ({ code: 'HARD_QUOTA_EXCEEDED', ...item })),
        ...(configuredTargets.length ? [] : [{ code: 'CATALOG_TARGET_UNCONFIGURED', message: 'An administrator must bind an approved provider template' }])],
    };
  }

  createProvisionRequest(slug, input, actor) {
    const project = this._project(input.tenantId, actor, 'self_service.request');
    const itemRow = this._db().prepare('SELECT * FROM infrastructure_catalog_items WHERE slug=?').get(String(slug));
    if (!itemRow || itemRow.kind !== 'vm' || itemRow.lifecycle !== 'active') fail('VM catalog offering is not requestable', 409, 'CATALOG_NOT_REQUESTABLE');
    const versionRow = this._db().prepare("SELECT * FROM infrastructure_catalog_versions WHERE id=? AND state='published'").get(itemRow.current_version_id);
    if (!versionRow) fail('Published catalog version not found', 409, 'CATALOG_NOT_REQUESTABLE');
    const version = catalogVersion(versionRow, true); const policy = this._policy(project.id);
    if (policy.allowedItemSlugs.length && !policy.allowedItemSlugs.includes(itemRow.slug)) fail('Catalog offering is blocked by project policy', 403, 'CATALOG_POLICY_BLOCKED');
    const evaluation = this.evaluateForm(version.formSchema, input.values || {}, version.costModel);
    if (!evaluation.valid) fail('Request form validation failed', 422, 'FORM_VALIDATION_FAILED', evaluation.errors);
    const offering = version.management.offering; const targets = Array.isArray(offering.targets) ? offering.targets : [];
    const activeHosts = new Map(this._db().prepare('SELECT id,daemon_type FROM docker_hosts WHERE is_active=1').all().map(host => [host.id, host]));
    const target = targets.find(candidate => activeHosts.get(Number(candidate.hostId))?.daemon_type === candidate.providerType && candidate.artifactId);
    if (!target) fail('No active approved provider target is configured for this offering', 409, 'CATALOG_TARGET_UNCONFIGURED');
    const projected = {
      cpu_millicores: Number(project.usage.cpu_millicores || 0) + Number(evaluation.normalized.cpu || 0) * 1000,
      memory_bytes: Number(project.usage.memory_bytes || 0) + Number(evaluation.normalized.memoryGiB || 0) * 1024 ** 3,
      storage_bytes: Number(project.usage.storage_bytes || 0) + Number(evaluation.normalized.storageGiB || 0) * 1024 ** 3,
    };
    const quotaBlockers = Object.entries(project.quotas || {}).filter(([metric, quota]) => quota.hardLimit != null && projected[metric] > quota.hardLimit);
    if (quotaBlockers.length) fail('Project hard quota would be exceeded', 409, 'HARD_QUOTA_EXCEEDED', quotaBlockers.map(([metric, quota]) => ({ metric, projected: projected[metric], hardLimit: quota.hardLimit })));
    const risk = evaluation.normalized.environment === 'production' ? 3 : 2;
    if (risk > policy.maximumRisk) fail('Request risk exceeds the project self-service policy', 403, 'RISK_POLICY_BLOCKED');
    const requestPayload = { catalog: { slug: itemRow.slug, version: version.version, versionHash: version.versionHash }, values: evaluation.normalized };
    const diff = { projectUsage: project.usage, projectedUsage: projected };
    const db = this._db();
    const created = db.transaction(() => {
      const approval = policy.requireApproval ? this.approvals.createRequest({ actionKey: 'self_service.vm.provision', environment: evaluation.normalized.environment,
        risk, scopeId: this._scopeId(project.id), tenantId: project.id, ttlMinutes: 240, reason: text(input.reason, 'reason', 500), payload: requestPayload,
        summary: { project: project.name, offering: itemRow.name, version: version.version, diff, costPreview: evaluation.costPreview } }, actor, { fallbackApprovals: 1 }) : null;
      const result = db.prepare(`INSERT INTO self_service_requests
        (request_key,tenant_id,catalog_version_id,request_kind,action_key,request_json,normalized_diff_json,cost_preview_json,hidden_target_json,risk,approval_request_id,state,requested_by,expires_at)
        VALUES (?,?,?,'vm_provision','provision',?,?,?,?,?,?,?, ?,?)`).run(requestKey(), project.id, version.id,
        JSON.stringify(requestPayload), JSON.stringify(diff), JSON.stringify(evaluation.costPreview), JSON.stringify(target), risk,
        approval?.id || null, approval ? 'requested' : 'approved', actor.id, approval?.expires_at || nowPlus(240));
      this._event(result.lastInsertRowid, approval ? 'requested' : 'approved', 'request_created', approval ? 'Request submitted for approval' : 'Request approved by project policy',
        { catalogVersion: version.version, payloadHash: hash(requestPayload), costPreview: evaluation.costPreview }, actor.id);
      return result.lastInsertRowid;
    })();
    return this.getRequest(created, actor);
  }

  createLifecycleRequest(tenantId, resourceId, input, actor) {
    const project = this._project(tenantId, actor, 'self_service.request'); const action = String(input.action || '');
    if (!LIFECYCLE_ACTIONS.has(action)) fail('Lifecycle action is invalid', 400, 'INVALID_LIFECYCLE_ACTION');
    const policy = this._policy(project.id);
    if (!policy.allowedActions.includes(action)) fail('Lifecycle action is blocked by project policy', 403, 'LIFECYCLE_POLICY_BLOCKED');
    const resource = this._db().prepare(`SELECT * FROM governance_project_resources WHERE id=? AND tenant_id=?
      AND resource_type IN ('virtualMachine','virtual-machine','vm')`).get(integer(resourceId, 'resourceId'), project.id);
    if (!resource) fail('Project virtual machine not found', 404, 'PROJECT_RESOURCE_NOT_FOUND');
    if (!/^ddr_vm_[a-f0-9]{26}$/.test(resource.resource_key) || resource.provider_host_id <= 0) fail('Project resource has no durable provider identity', 409, 'RESOURCE_IDENTITY_UNAVAILABLE');
    const values = action === 'snapshot' ? { snapshotName: text(input.snapshotName || `self-service-${Date.now()}`, 'snapshotName', 80),
      description: input.description ? text(input.description, 'description', 500) : '' } : {};
    const requestPayload = { action, resource: { id: resource.id, ref: resource.resource_key, name: resource.display_name }, values };
    const risk = action === 'console' ? 1 : 2;
    if (risk > policy.maximumRisk) fail('Request risk exceeds the project self-service policy', 403, 'RISK_POLICY_BLOCKED');
    const consoleDirect = action === 'console'; const db = this._db();
    const id = db.transaction(() => {
      const approval = !consoleDirect && policy.requireApproval ? this.approvals.createRequest({ actionKey: `self_service.vm.${action}`,
        environment: project.usage_mode === 'production' ? 'production' : 'nonproduction', risk, scopeId: this._scopeId(project.id), tenantId: project.id,
        ttlMinutes: 120, reason: text(input.reason, 'reason', 500), payload: requestPayload,
        summary: { project: project.name, resource: resource.display_name, action, diff: { before: 'provider-observed', after: action } } }, actor, { fallbackApprovals: 1 }) : null;
      const state = consoleDirect ? 'validated' : approval ? 'requested' : 'approved';
      const result = db.prepare(`INSERT INTO self_service_requests
        (request_key,tenant_id,request_kind,action_key,resource_ref,request_json,normalized_diff_json,cost_preview_json,hidden_target_json,risk,approval_request_id,state,requested_by,expires_at,validated_at)
        VALUES (?,?,'lifecycle',?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='validated' THEN datetime('now') END)`)
        .run(requestKey(), project.id, action, resource.resource_key, JSON.stringify(requestPayload), JSON.stringify({ before: 'provider-observed', after: action }),
          JSON.stringify({ amount: 0, currency: 'EUR', period: 'action', estimate: true }), JSON.stringify({ hostId: resource.provider_host_id }), risk,
          approval?.id || null, state, actor.id, approval?.expires_at || nowPlus(120), state);
      this._event(result.lastInsertRowid, state, consoleDirect ? 'console_authorized' : 'request_created',
        consoleDirect ? 'Console access is available within project policy' : approval ? 'Lifecycle request submitted for approval' : 'Lifecycle request approved by project policy',
        consoleDirect ? { url: `#/virtual-machines/${encodeURIComponent(resource.resource_key)}?hostId=${resource.provider_host_id}&tab=console` } : { payloadHash: hash(requestPayload) }, actor.id);
      return result.lastInsertRowid;
    })();
    return this.getRequest(id, actor);
  }

  _event(requestId, state, type, message, evidence, actorId) {
    if (!REQUEST_STATES.has(state)) fail('Request state is invalid', 500, 'INVALID_REQUEST_STATE');
    const sequence = Number(this._db().prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM self_service_request_events WHERE request_id=?').get(requestId).next);
    this._db().prepare(`INSERT INTO self_service_request_events (request_id,sequence,state,event_type,message,evidence_json,actor_id)
      VALUES (?,?,?,?,?,?,?)`).run(requestId, sequence, state, type, message, JSON.stringify(evidence || {}), actorId || null);
  }

  _row(id) {
    const row = this._db().prepare(`SELECT r.*,u.username AS requester_username FROM self_service_requests r
      JOIN users u ON u.id=r.requested_by WHERE r.id=?`).get(integer(id, 'requestId'));
    if (!row) fail('Self-service request not found', 404, 'REQUEST_NOT_FOUND');
    return row;
  }

  _accessRequest(row, actor) { if (actor.role !== 'admin' && !['operator'].includes(actor.role)) this._project(row.tenant_id, actor); }

  _syncRequest(row) {
    let current = row;
    if (current.state === 'requested' && current.approval_request_id) {
      const approval = this.approvals.getRequest(current.approval_request_id);
      const state = approval.state === 'approved' ? 'approved' : approval.state === 'rejected' ? 'rejected' : approval.state === 'expired' ? 'expired' : null;
      if (state) {
        this._db().prepare("UPDATE self_service_requests SET state=?,updated_at=datetime('now') WHERE id=? AND state='requested'").run(state, current.id);
        this._event(current.id, state, `approval_${state}`, `Request ${state}`, { approvalRequestId: approval.id, approvals: approval.approvals }, null);
        current = this._row(current.id);
      }
    }
    if (current.state === 'running' && current.provider_operation_id) {
      const operation = this.operations.get(current.provider_operation_id);
      if (operation && TERMINAL_OPERATION_STATES.has(operation.state)) {
        const state = operation.state === 'succeeded' ? 'validated' : 'failed';
        this._db().prepare(`UPDATE self_service_requests SET state=?,validated_at=CASE WHEN ?='validated' THEN datetime('now') ELSE NULL END,
          updated_at=datetime('now') WHERE id=? AND state='running'`).run(state, state, current.id);
        this._event(current.id, state, `provider_${operation.state}`, state === 'validated' ? 'Provider operation completed and was validated' : 'Provider operation did not complete successfully',
          { operationId: operation.id, operationState: operation.state, error: operation.error || null }, null);
        current = this._row(current.id);
      }
    }
    return current;
  }

  getRequest(id, actor) {
    let row = this._row(id); this._accessRequest(row, actor); row = this._syncRequest(row);
    const events = this._db().prepare('SELECT * FROM self_service_request_events WHERE request_id=? ORDER BY sequence').all(row.id);
    return { request: requestRow(row, events) };
  }

  listRequests(actor, { tenantId, state, inbox = false, limit = 100 } = {}) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    if (inbox) this._approver(actor);
    const params = []; const clauses = [];
    if (tenantId) { const project = this._project(tenantId, actor); clauses.push('r.tenant_id=?'); params.push(project.id); }
    else if (!['admin', 'operator'].includes(actor.role)) {
      const projects = this.governance.listProjects(actor); if (!projects.length) return { requests: [] };
      clauses.push(`r.tenant_id IN (${projects.map(() => '?').join(',')})`); params.push(...projects.map(project => project.id));
    }
    if (state) { clauses.push('r.state=?'); params.push(text(state, 'state', 20)); }
    if (inbox) clauses.push("r.state='requested'");
    const rows = this._db().prepare(`SELECT r.*,u.username AS requester_username FROM self_service_requests r JOIN users u ON u.id=r.requested_by
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY r.created_at DESC LIMIT ?`).all(...params, integer(limit, 'limit', 1, 500));
    return { requests: rows.map(row => requestRow(this._syncRequest(row))) };
  }

  decideRequest(id, decision, comment, actor) {
    this._approver(actor); const row = this._syncRequest(this._row(id));
    if (row.state !== 'requested' || !row.approval_request_id) fail('Request is not awaiting approval', 409, 'REQUEST_NOT_PENDING');
    const approval = this.approvals.decide(row.approval_request_id, decision, comment, actor);
    const state = approval.state === 'approved' ? 'approved' : approval.state === 'rejected' ? 'rejected' : 'requested';
    if (state !== 'requested') {
      this._db().prepare("UPDATE self_service_requests SET state=?,updated_at=datetime('now') WHERE id=?").run(state, row.id);
      this._event(row.id, state, `approval_${decision}`, `Request ${state}: ${comment ? String(comment).slice(0, 200) : 'no comment'}`,
        { approvalRequestId: approval.id, approvals: approval.approvals, approvalsRequired: approval.approvals_required }, actor.id);
    } else this._event(row.id, 'requested', 'approval_recorded', 'Approval recorded; more approvals are required', { approvals: approval.approvals, approvalsRequired: approval.approvals_required }, actor.id);
    return this.getRequest(row.id, actor);
  }

  _fulfillmentContext(row) {
    if (row.state !== 'approved') fail('Request must be approved before fulfillment', 409, 'REQUEST_NOT_APPROVED');
    if (Date.parse(row.expires_at) <= Date.now()) {
      this._db().prepare("UPDATE self_service_requests SET state='expired',updated_at=datetime('now') WHERE id=?").run(row.id);
      this._event(row.id, 'expired', 'request_expired', 'Request expired before fulfillment', {}, null);
      fail('Request has expired', 409, 'REQUEST_EXPIRED');
    }
    const target = parseJson(row.hidden_target_json, {}); const host = this._db().prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(Number(target.hostId));
    if (!host) fail('Approved provider target is unavailable', 409, 'PROVIDER_TARGET_UNAVAILABLE');
    return { target, host, request: parseJson(row.request_json, {}) };
  }

  async preflightFulfillment(id, actor) {
    this._approver(actor); const row = this._syncRequest(this._row(id)); const context = this._fulfillmentContext(row);
    let plan;
    if (row.request_kind === 'vm_provision') {
      const values = context.request.values || {};
      plan = await this.vmProvision.preflightForHost(context.host, context.target.artifactId, {
        name: values.name, mode: context.target.mode || 'auto', storageId: context.target.storageId,
        targetNode: context.target.targetNode, customization: context.target.customization || null,
      }, { canOperate: true });
    } else if (row.action_key === 'snapshot') {
      plan = await this.vmSnapshots.preflightForHost(context.host, row.resource_ref, 'create', {
        name: context.request.values?.snapshotName, description: context.request.values?.description || '', consistency: 'crash',
      }, null, { canOperate: true });
    } else plan = await this.vmPower.preflightForHost(context.host, row.resource_ref, row.action_key, { canOperate: true });
    return { request: requestRow(row), plan, target: { providerType: context.host.daemon_type } };
  }

  async fulfillRequest(id, input, actor) {
    this._approver(actor); const row = this._syncRequest(this._row(id)); const context = this._fulfillmentContext(row);
    const preflight = await this.preflightFulfillment(row.id, actor); let result;
    const common = { planHash: input.planHash, confirm: input.confirm === true, confirmName: input.confirmName,
      idempotencyKey: text(input.idempotencyKey, 'idempotencyKey', 200) };
    if (row.request_kind === 'vm_provision') {
      const values = context.request.values || {};
      result = await this.vmProvision.submitForHost(context.host, context.target.artifactId, { ...common,
        name: values.name, mode: context.target.mode || 'auto', storageId: context.target.storageId,
        targetNode: context.target.targetNode, customization: context.target.customization || null,
      }, { canOperate: true, createdBy: actor.id });
    } else if (row.action_key === 'snapshot') {
      result = await this.vmSnapshots.submitForHost(context.host, row.resource_ref, 'create', { ...common,
        name: context.request.values?.snapshotName, description: context.request.values?.description || '', consistency: 'crash',
      }, null, { canOperate: true, createdBy: actor.id });
    } else result = await this.vmPower.submitForHost(context.host, row.resource_ref, { ...common, action: row.action_key }, { canOperate: true, createdBy: actor.id });
    this._db().prepare("UPDATE self_service_requests SET state='running',provider_operation_id=?,fulfilled_by=?,updated_at=datetime('now') WHERE id=? AND state='approved'")
      .run(result.operation.id, actor.id, row.id);
    this._event(row.id, 'running', 'provider_operation_submitted', 'Approved request submitted to the durable provider operation engine',
      { operationId: result.operation.id, planHash: preflight.plan.planHash, deduplicated: !!result.operation.deduplicated }, actor.id);
    return this.getRequest(row.id, actor);
  }

  projectDashboard(tenantId, actor) {
    const project = this._project(tenantId, actor); const requests = this.listRequests(actor, { tenantId: project.id, limit: 100 }).requests;
    const alerts = Object.entries(project.quotas || {}).filter(([, quota]) => quota.softExceeded || quota.hardExceeded).map(([metric, quota]) => ({
      type: 'quota', metric, severity: quota.hardExceeded ? 'critical' : 'warning', message: `${metric} ${quota.hardExceeded ? 'hard' : 'soft'} quota exceeded`,
    }));
    return { project: { id: project.id, name: project.name, slug: project.slug, usageMode: project.usage_mode, status: project.status },
      resources: project.resources, usage: project.usage, quotas: project.quotas, alerts,
      requests: { recent: requests.slice(0, 20), counts: requests.reduce((out, request) => { out[request.state] = (out[request.state] || 0) + 1; return out; }, {}) },
      cost: { status: 'estimate_only', message: 'Request estimates are shown in each timeline; rated project allocation remains authoritative in FinOps.' } };
  }

  addBasketItem(input, actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const kind = String(input.resourceKind || '');
    if (!['virtual-machine', 'container', 'image', 'volume', 'network'].includes(kind)) fail('resourceKind is invalid', 400, 'INVALID_INPUT');
    const resourceRef = text(input.resourceRef, 'resourceRef', 200); const hostId = input.hostId == null ? null : integer(input.hostId, 'hostId');
    const itemKey = `${kind}:${hostId || 0}:${resourceRef}`;
    const compatibility = input.compatibility && typeof input.compatibility === 'object' ? input.compatibility : {};
    safeJson(compatibility, 'compatibility');
    this._db().prepare(`INSERT INTO self_service_basket_items
      (user_id,item_key,resource_kind,host_id,resource_ref,display_name,compatibility_json) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(user_id,item_key) DO UPDATE SET display_name=excluded.display_name,compatibility_json=excluded.compatibility_json,added_at=datetime('now')`)
      .run(actor.id, itemKey, kind, hostId, resourceRef, text(input.displayName || resourceRef, 'displayName', 200), JSON.stringify(compatibility));
    return this.getBasket(actor);
  }

  removeBasketItem(id, actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const result = this._db().prepare('DELETE FROM self_service_basket_items WHERE id=? AND user_id=?').run(integer(id, 'itemId'), actor.id);
    if (!result.changes) fail('Basket item not found', 404, 'BASKET_ITEM_NOT_FOUND');
    return this.getBasket(actor);
  }

  clearBasket(actor) { if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED'); this._db().prepare('DELETE FROM self_service_basket_items WHERE user_id=?').run(actor.id); return this.getBasket(actor); }

  getBasket(actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const items = this._db().prepare('SELECT * FROM self_service_basket_items WHERE user_id=? ORDER BY added_at').all(actor.id).map(row => ({
      id: row.id, itemKey: row.item_key, resourceKind: row.resource_kind, hostId: row.host_id,
      resourceRef: row.resource_ref, displayName: row.display_name, compatibility: parseJson(row.compatibility_json, {}), addedAt: row.added_at,
    }));
    const actionSets = { 'virtual-machine': ['start', 'shutdown', 'reboot', 'snapshot', 'console'], container: ['start', 'stop', 'restart'], image: ['inspect'], volume: ['inspect'], network: ['inspect'] };
    let actions = items.length ? actionSets[items[0].resourceKind] || [] : [];
    for (const item of items.slice(1)) actions = actions.filter(action => (actionSets[item.resourceKind] || []).includes(action));
    const hosts = [...new Set(items.map(item => item.hostId).filter(Boolean))];
    const blockers = [];
    if (new Set(items.map(item => item.resourceKind)).size > 1) blockers.push({ code: 'MIXED_RESOURCE_KINDS', message: 'Bulk actions require one resource kind' });
    if (hosts.length > 1) blockers.push({ code: 'MULTIPLE_HOSTS', message: 'Mutating bulk actions require resources from one endpoint' });
    return { items, preview: { count: items.length, resourceKinds: [...new Set(items.map(item => item.resourceKind))], hostIds: hosts,
      compatibleActions: blockers.length ? actions.filter(action => action === 'inspect') : actions, blockers } };
  }

  commandPalette(query, actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const q = String(query || '').trim().toLowerCase().slice(0, 100); if (q.length < 2) return { results: [] };
    const results = [];
    for (const item of this.listCatalog(actor).items) if (`${item.name} ${item.slug} ${item.kind} ${item.description}`.toLowerCase().includes(q)) {
      const configured = (item.version?.offering?.targets || []).some(target => target.configured);
      results.push({ type: 'catalog', name: item.name, detail: `${item.kind} · v${item.version?.version || '—'}`, url: `#/self-service/catalog/${encodeURIComponent(item.slug)}`,
        action: { key: 'request', available: configured && item.kind === 'vm', reason: item.kind !== 'vm' ? 'Catalog workflow required' : configured ? null : 'Administrator target binding required' } });
    }
    for (const project of this.governance.listProjects(actor)) if (`${project.name} ${project.slug}`.toLowerCase().includes(q)) results.push({
      type: 'project', name: project.name, detail: 'Self-service project dashboard', url: `#/self-service/project/${project.id}`,
      action: { key: 'open', available: true, reason: null },
    });
    const clauses = ['(r.request_key LIKE ? OR r.action_key LIKE ? OR u.username LIKE ?)']; const like = `%${q}%`; const params = [like, like, like];
    if (actor.role !== 'admin' && actor.role !== 'operator') {
      const projects = this.governance.listProjects(actor); if (!projects.length) return { results: results.slice(0, 20) };
      clauses.push(`r.tenant_id IN (${projects.map(() => '?').join(',')})`); params.push(...projects.map(project => project.id));
    }
    const requests = this._db().prepare(`SELECT r.id,r.request_key,r.action_key,r.state,u.username FROM self_service_requests r JOIN users u ON u.id=r.requested_by
      WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC LIMIT 10`).all(...params);
    for (const request of requests) results.push({ type: 'request', name: request.request_key, detail: `${request.action_key} · ${request.state}`,
      url: `#/self-service/request/${request.id}`, action: { key: 'open', available: true, reason: null } });
    return { results: results.slice(0, 30) };
  }
}

const service = new SelfServiceService();
module.exports = service;
module.exports.SelfServiceService = SelfServiceService;
module.exports.SelfServiceError = SelfServiceError;
module.exports._internals = { safeJson, stable, hash, catalogVersion, catalogItem, requestRow };
