'use strict';

const { getDb } = require('../db');
const governance = require('./governance');
const approvals = require('./governance-approvals');
const { _EXTENDED_METRICS: EXTENDED_METRICS } = require('../db/migrations/125_governance_identity_policy');

const BASE_METRICS = governance.GOVERNANCE_QUOTA_METRICS;
const ALL_METRICS = new Set([...BASE_METRICS, ...EXTENDED_METRICS]);

class CapacityError extends Error {
  constructor(message, status = 400, code = 'CAPACITY_ERROR', details) {
    super(message); this.name = 'CapacityError'; this.status = status; this.code = code; this.details = details;
  }
}
function fail(message, status, code, details) { throw new CapacityError(message, status, code, details); }
function int(value, field, { nullable = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`${field} is invalid`);
  return parsed;
}
function clean(value, field, max = 180) {
  const result = String(value || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!result) fail(`${field} is required`);
  if (result.length > max) fail(`${field} is too long`);
  return result;
}
function json(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }

class GovernanceCapacityService {
  constructor(dbProvider = getDb, approvalService = approvals, governanceService = governance) {
    this._dbProvider = dbProvider;
    this._approvals = approvalService;
    this._governance = governanceService;
  }
  _db() { return this._dbProvider(); }
  _syncExpiry() {
    const db = this._db();
    db.prepare("UPDATE governance_approval_requests SET state='expired',updated_at=datetime('now') WHERE state IN ('pending','approved') AND datetime(expires_at)<=datetime('now')").run();
    db.prepare(`UPDATE governance_quota_requests SET state=CASE
      WHEN approval_request_id IN (SELECT id FROM governance_approval_requests WHERE state='rejected') THEN 'rejected'
      ELSE 'expired' END,updated_at=datetime('now') WHERE state IN ('pending','approved') AND approval_request_id IN
      (SELECT id FROM governance_approval_requests WHERE state IN ('rejected','expired'))`).run();
    db.prepare("UPDATE governance_quota_requests SET state='expired',updated_at=datetime('now') WHERE state='active' AND datetime(effective_until)<=datetime('now')").run();
  }
  _project(id) {
    const project = this._db().prepare(`SELECT t.*, s.id AS scope_id FROM tenants t
      JOIN governance_scopes s ON s.tenant_id=t.id AND s.scope_type='project' WHERE t.id=?`).get(int(id, 'projectId', { min: 1 }));
    if (!project) fail('Project not found', 404);
    return project;
  }
  _can(actor, project, permission) {
    if (!actor?.id) fail('Authentication required', 401);
    if (actor.role !== 'admin' && !this._governance.can(actor, project.scope_id, permission)) fail('Insufficient governance permission', 403);
  }
  _limit(input, metric) {
    const softLimit = int(input?.softLimit, `${metric}.softLimit`, { nullable: true });
    const hardLimit = int(input?.hardLimit, `${metric}.hardLimit`, { nullable: true });
    if (softLimit != null && hardLimit != null && softLimit > hardLimit) fail(`${metric} softLimit cannot exceed hardLimit`);
    return { softLimit, hardLimit };
  }

  projectCapacity(projectId, actor) {
    const project = this._project(projectId);
    this._can(actor, project, 'project.read');
    const db = this._db();
    const usageRows = db.prepare(`SELECT metric,COALESCE(SUM(amount),0) AS usage FROM governance_project_capacity_allocations
      WHERE tenant_id=? AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) GROUP BY metric`).all(project.id);
    const usage = new Map(usageRows.map(item => [item.metric, Number(item.usage)]));
    const quotaRows = db.prepare('SELECT metric,soft_limit,hard_limit FROM governance_project_extended_quotas WHERE tenant_id=?').all(project.id);
    const quotas = new Map(quotaRows.map(item => [item.metric, item]));
    const activeGrants = db.prepare(`SELECT g.metric,g.soft_limit,g.hard_limit,g.expires_at FROM governance_quota_grants g
      WHERE g.tenant_id=? AND datetime(g.expires_at)>datetime('now') ORDER BY datetime(g.expires_at) DESC`).all(project.id);
    const grants = new Map();
    for (const item of activeGrants) if (!grants.has(item.metric)) grants.set(item.metric, item);
    const metrics = Object.fromEntries(EXTENDED_METRICS.map(metric => {
      const base = quotas.get(metric) || {};
      const grant = grants.get(metric);
      const used = usage.get(metric) || 0;
      const softLimit = grant?.soft_limit ?? base.soft_limit ?? null;
      const hardLimit = grant?.hard_limit ?? base.hard_limit ?? null;
      const softExceeded = softLimit != null && used > Number(softLimit);
      const hardExceeded = hardLimit != null && used > Number(hardLimit);
      return [metric, { usage: used, softLimit: softLimit == null ? null : Number(softLimit),
        hardLimit: hardLimit == null ? null : Number(hardLimit), softExceeded, hardExceeded,
        state: hardExceeded ? 'hard-exceeded' : softExceeded ? 'soft-exceeded' : 'within-limit',
        temporaryGrantUntil: grant?.expires_at || null }];
    }));
    const allocations = db.prepare(`SELECT * FROM governance_project_capacity_allocations WHERE tenant_id=?
      ORDER BY assigned_at DESC`).all(project.id).map(item => ({ ...item, metadata: json(item.metadata_json) }));
    return { projectId: project.id, metrics, allocations };
  }

  setQuotas(projectId, definitions, actor) {
    const project = this._project(projectId);
    this._can(actor, project, 'project.capacity.manage');
    if (!definitions || typeof definitions !== 'object') fail('quotas object is required');
    const db = this._db();
    db.transaction(() => {
      for (const metric of EXTENDED_METRICS) {
        if (!Object.hasOwn(definitions, metric)) continue;
        const limits = this._limit(definitions[metric], metric);
        db.prepare(`INSERT INTO governance_project_extended_quotas (tenant_id,metric,soft_limit,hard_limit,updated_by,updated_at)
          VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(tenant_id,metric) DO UPDATE SET soft_limit=excluded.soft_limit,
          hard_limit=excluded.hard_limit,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .run(project.id, metric, limits.softLimit, limits.hardLimit, actor.id);
      }
    })();
    return this.projectCapacity(project.id, actor);
  }

  assign(projectId, input, actor) {
    const project = this._project(projectId);
    this._can(actor, project, 'project.capacity.manage');
    const metric = String(input.metric || '');
    if (!ALL_METRICS.has(metric) || BASE_METRICS.includes(metric)) fail('metric must be an extended capacity metric');
    const amount = int(input.amount, 'amount');
    const providerHostId = int(input.providerHostId ?? 0, 'providerHostId');
    const resourceType = clean(input.resourceType, 'resourceType', 80);
    const resourceKey = clean(input.resourceKey, 'resourceKey');
    let expiresAt = null;
    if (input.expiresAt) {
      const parsedExpiry = Date.parse(input.expiresAt);
      if (Number.isNaN(parsedExpiry) || parsedExpiry <= Date.now()) fail('expiresAt must be a future timestamp');
      expiresAt = new Date(parsedExpiry).toISOString();
    }
    const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
    if (JSON.stringify(metadata).length > 8000) fail('metadata is too large');
    const db = this._db();
    db.transaction(() => {
      const existing = db.prepare(`SELECT * FROM governance_project_capacity_allocations
        WHERE provider_host_id=? AND resource_type=? AND resource_key=? AND metric=?`).get(providerHostId, resourceType, resourceKey, metric);
      if (existing && existing.tenant_id !== project.id) fail('Capacity resource is assigned to another project', 409, 'CAPACITY_ALREADY_ASSIGNED');
      const state = this.projectCapacity(project.id, actor).metrics[metric];
      const projected = state.usage - Number(existing?.amount || 0) + amount;
      if (state.hardLimit != null && projected > state.hardLimit) fail(`Hard quota exceeded: ${metric}`, 409, 'HARD_QUOTA_EXCEEDED', { metric });
      db.prepare(`INSERT INTO governance_project_capacity_allocations
        (tenant_id,provider_host_id,resource_type,resource_key,metric,amount,profile,policy_key,expires_at,metadata_json,assigned_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(provider_host_id,resource_type,resource_key,metric)
        DO UPDATE SET tenant_id=excluded.tenant_id,amount=excluded.amount,profile=excluded.profile,policy_key=excluded.policy_key,
          expires_at=excluded.expires_at,metadata_json=excluded.metadata_json,assigned_by=excluded.assigned_by,updated_at=excluded.updated_at`)
        .run(project.id, providerHostId, resourceType, resourceKey, metric, amount,
          input.profile ? clean(input.profile, 'profile', 100) : null, input.policyKey ? clean(input.policyKey, 'policyKey', 100) : null,
          expiresAt, JSON.stringify(metadata), actor.id);
    })();
    return this.projectCapacity(project.id, actor);
  }

  remove(projectId, allocationId, actor) {
    const project = this._project(projectId);
    this._can(actor, project, 'project.capacity.manage');
    const result = this._db().prepare('DELETE FROM governance_project_capacity_allocations WHERE id=? AND tenant_id=?')
      .run(int(allocationId, 'allocationId', { min: 1 }), project.id);
    if (!result.changes) fail('Capacity allocation not found', 404);
    return { deleted: true };
  }

  requestQuota(projectId, input, actor) {
    const project = this._project(projectId);
    this._can(actor, project, 'quota.request');
    if (!input.limits || typeof input.limits !== 'object') fail('limits object is required');
    const limits = {};
    for (const [metric, definition] of Object.entries(input.limits)) {
      if (!ALL_METRICS.has(metric)) fail(`Unknown quota metric: ${metric}`);
      limits[metric] = this._limit(definition, metric);
    }
    if (!Object.keys(limits).length) fail('At least one quota metric is required');
    const durationSeconds = int(input.durationSeconds ?? 86400, 'durationSeconds', { min: 300, max: 2592000 });
    const environment = project.usage_mode === 'production' ? 'production' : 'nonproduction';
    const risk = int(input.risk ?? (environment === 'production' ? 3 : 2), 'risk', { min: 1, max: 4 });
    const approval = this._approvals.createRequest({ actionKey: `quota.increase:${project.id}`, environment, risk,
      scopeId: project.scope_id, tenantId: project.id, payload: { limits, durationSeconds },
      summary: { projectId: project.id, project: project.name, limits, durationSeconds }, reason: input.reason,
      ttlMinutes: input.ttlMinutes || 1440 }, actor, { fallbackApprovals: environment === 'production' || risk >= 3 ? 2 : 1 });
    const result = this._db().prepare(`INSERT INTO governance_quota_requests
      (tenant_id,approval_request_id,requested_limits_json,duration_seconds,requested_by,reason)
      VALUES (?,?,?,?,?,?)`).run(project.id, approval.id, JSON.stringify(limits), durationSeconds, actor.id, clean(input.reason, 'reason', 500));
    return this.getQuotaRequest(result.lastInsertRowid);
  }

  getQuotaRequest(id) {
    this._syncExpiry();
    const item = this._db().prepare(`SELECT q.*,a.state AS approval_state,a.approvals_required FROM governance_quota_requests q
      JOIN governance_approval_requests a ON a.id=q.approval_request_id WHERE q.id=?`).get(int(id, 'id', { min: 1 }));
    if (!item) fail('Quota request not found', 404);
    return { ...item, requestedLimits: json(item.requested_limits_json) };
  }

  listQuotaRequests(projectId, actor) {
    const project = this._project(projectId);
    this._can(actor, project, 'project.read');
    this._syncExpiry();
    return this._db().prepare(`SELECT q.*,a.state AS approval_state,a.approvals_required FROM governance_quota_requests q
      JOIN governance_approval_requests a ON a.id=q.approval_request_id WHERE q.tenant_id=? ORDER BY q.created_at DESC`).all(project.id)
      .map(item => ({ ...item, requestedLimits: json(item.requested_limits_json) }));
  }

  syncQuotaRequest(approvalRequestId) {
    const db = this._db();
    const quota = db.prepare(`SELECT q.*,a.state AS approval_state FROM governance_quota_requests q
      JOIN governance_approval_requests a ON a.id=q.approval_request_id WHERE q.approval_request_id=?`).get(approvalRequestId);
    if (!quota) return null;
    if (quota.approval_state === 'rejected') {
      db.prepare("UPDATE governance_quota_requests SET state='rejected',updated_at=datetime('now') WHERE id=?").run(quota.id);
      return this.getQuotaRequest(quota.id);
    }
    if (quota.approval_state !== 'approved' || !['pending', 'approved'].includes(quota.state)) return this.getQuotaRequest(quota.id);
    const limits = json(quota.requested_limits_json);
    const expiresAt = new Date(Date.now() + quota.duration_seconds * 1000).toISOString();
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO governance_quota_grants
        (quota_request_id,tenant_id,metric,soft_limit,hard_limit,expires_at) VALUES (?,?,?,?,?,?)`);
      for (const [metric, definition] of Object.entries(limits)) {
        insert.run(quota.id, quota.tenant_id, metric, definition.softLimit, definition.hardLimit, expiresAt);
      }
      db.prepare(`UPDATE governance_quota_requests SET state='active',applied_at=datetime('now'),effective_until=?,updated_at=datetime('now') WHERE id=?`)
        .run(expiresAt, quota.id);
    })();
    return this.getQuotaRequest(quota.id);
  }
}

const service = new GovernanceCapacityService();
module.exports = service;
module.exports.GovernanceCapacityService = GovernanceCapacityService;
module.exports.CapacityError = CapacityError;
module.exports.EXTENDED_METRICS = EXTENDED_METRICS;
