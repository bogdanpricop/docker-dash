'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const ENVIRONMENTS = new Set(['any', 'production', 'nonproduction']);

class ApprovalError extends Error {
  constructor(message, status = 400, code = 'APPROVAL_ERROR', details) {
    super(message);
    this.name = 'ApprovalError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(message, status, code, details) {
  throw new ApprovalError(message, status, code, details);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stable(value[key]);
      return result;
    }, {});
  }
  return value;
}

function payloadHash(actionKey, payload) {
  return crypto.createHash('sha256').update(`${actionKey}\n${JSON.stringify(stable(payload || {}))}`).digest('hex');
}

function clean(value, field, max = 240) {
  const result = String(value || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!result) fail(`${field} is required`);
  if (result.length > max) fail(`${field} is too long`);
  return result;
}

function integer(value, field, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${field} is invalid`);
  return result;
}

function timestamp(value, field, future = false) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) fail(`${field} must be a valid timestamp`);
  if (future && ms <= Date.now()) fail(`${field} must be in the future`);
  return new Date(ms).toISOString();
}

function globMatches(pattern, value) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function row(record) {
  if (!record) return record;
  const result = { ...record };
  for (const field of ['summary_json']) {
    if (field in result) {
      try { result[field.replace('_json', '')] = JSON.parse(result[field] || '{}'); } catch { result[field.replace('_json', '')] = {}; }
      delete result[field];
    }
  }
  return result;
}

class GovernanceApprovalsService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  available() { return tableExists(this._db(), 'governance_approval_policies'); }

  listPolicies() {
    return this._db().prepare('SELECT * FROM governance_approval_policies ORDER BY enabled DESC, name').all();
  }

  savePolicy(id, input, actor) {
    if (actor?.role !== 'admin') fail('Administrator access required', 403, 'ADMIN_REQUIRED');
    const name = clean(input.name, 'name', 100);
    const actionPattern = clean(input.actionPattern, 'actionPattern', 200);
    const environment = input.environment || 'any';
    if (!ENVIRONMENTS.has(environment)) fail('environment is invalid');
    const minimumRisk = integer(input.minimumRisk ?? 1, 'minimumRisk', 1, 4);
    const approvalsRequired = integer(input.approvalsRequired ?? 1, 'approvalsRequired', 1, 2);
    const scopeId = input.scopeId == null || input.scopeId === '' ? null : integer(input.scopeId, 'scopeId');
    const requesterCannotApprove = input.requesterCannotApprove === false ? 0 : 1;
    const enabled = input.enabled === false ? 0 : 1;
    const db = this._db();
    if (scopeId && !db.prepare('SELECT 1 FROM governance_scopes WHERE id = ?').get(scopeId)) fail('Scope not found', 404);
    if (id) {
      const policyId = integer(id, 'id');
      const result = db.prepare(`UPDATE governance_approval_policies SET name=?, scope_id=?, action_pattern=?,
        environment=?, minimum_risk=?, approvals_required=?, requester_cannot_approve=?, enabled=?, updated_at=datetime('now') WHERE id=?`)
        .run(name, scopeId, actionPattern, environment, minimumRisk, approvalsRequired, requesterCannotApprove, enabled, policyId);
      if (!result.changes) fail('Approval policy not found', 404);
      return db.prepare('SELECT * FROM governance_approval_policies WHERE id = ?').get(policyId);
    }
    const result = db.prepare(`INSERT INTO governance_approval_policies
      (name,scope_id,action_pattern,environment,minimum_risk,approvals_required,requester_cannot_approve,enabled,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(name, scopeId, actionPattern, environment, minimumRisk, approvalsRequired,
      requesterCannotApprove, enabled, actor.id);
    return db.prepare('SELECT * FROM governance_approval_policies WHERE id = ?').get(result.lastInsertRowid);
  }

  deletePolicy(id, actor) {
    if (actor?.role !== 'admin') fail('Administrator access required', 403, 'ADMIN_REQUIRED');
    const result = this._db().prepare('DELETE FROM governance_approval_policies WHERE id = ?').run(integer(id, 'id'));
    if (!result.changes) fail('Approval policy not found', 404);
    return { deleted: true };
  }

  _matchingPolicy(actionKey, environment, risk, scopeId) {
    const scopeChain = this._scopeChainIds(scopeId);
    return this._db().prepare(`SELECT * FROM governance_approval_policies
      WHERE enabled=1 AND (environment='any' OR environment=?) AND minimum_risk <= ?
      ORDER BY approvals_required DESC, minimum_risk DESC, id ASC`).all(environment, risk)
      .find(policy => (policy.scope_id == null || scopeChain.has(policy.scope_id)) && globMatches(policy.action_pattern, actionKey));
  }

  _scopeChainIds(scopeId) {
    const ids = new Set();
    let current = scopeId ? this._db().prepare('SELECT id,parent_id FROM governance_scopes WHERE id=?').get(scopeId) : null;
    while (current && !ids.has(current.id)) {
      ids.add(current.id);
      current = current.parent_id == null ? null
        : this._db().prepare('SELECT id,parent_id FROM governance_scopes WHERE id=?').get(current.parent_id);
    }
    return ids;
  }

  createRequest(input, actor, options = {}) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const actionKey = clean(input.actionKey, 'actionKey', 200);
    const environment = input.environment === 'nonproduction' ? 'nonproduction' : 'production';
    const risk = integer(input.risk ?? 2, 'risk', 1, 4);
    const scopeId = input.scopeId == null ? null : integer(input.scopeId, 'scopeId');
    const tenantId = input.tenantId == null ? null : integer(input.tenantId, 'tenantId');
    const policy = this._matchingPolicy(actionKey, environment, risk, scopeId);
    if (!policy && !options.fallbackApprovals) fail('No approval policy matches this action', 422, 'NO_APPROVAL_POLICY');
    const approvalsRequired = policy?.approvals_required || integer(options.fallbackApprovals, 'fallbackApprovals', 1, 2);
    const requesterCannotApprove = policy?.requester_cannot_approve ?? 1;
    const ttlMinutes = integer(input.ttlMinutes ?? 60, 'ttlMinutes', 5, 1440);
    const reason = clean(input.reason, 'reason', 500);
    const summary = input.summary && typeof input.summary === 'object' ? input.summary : {};
    const hash = payloadHash(actionKey, input.payload);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
    const result = this._db().prepare(`INSERT INTO governance_approval_requests
      (policy_id,scope_id,tenant_id,action_key,environment,risk,payload_hash,summary_json,state,
       approvals_required,requester_cannot_approve,requested_by,reason,expires_at)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`).run(policy?.id || null, scopeId, tenantId, actionKey,
      environment, risk, hash, JSON.stringify(summary), approvalsRequired, requesterCannotApprove, actor.id, reason, expiresAt);
    return this.getRequest(result.lastInsertRowid);
  }

  getRequest(id) {
    const request = this._db().prepare(`SELECT r.*, u.username AS requester_username,
      (SELECT COUNT(*) FROM governance_approval_decisions d WHERE d.request_id=r.id AND d.decision='approve') AS approvals
      FROM governance_approval_requests r JOIN users u ON u.id=r.requested_by WHERE r.id=?`).get(integer(id, 'id'));
    if (!request) fail('Approval request not found', 404);
    return row(request);
  }

  listRequests({ state, limit = 100 } = {}) {
    this._expire();
    const safeLimit = integer(limit, 'limit', 1, 500);
    const params = [];
    const where = state ? 'WHERE r.state=?' : '';
    if (state) params.push(clean(state, 'state', 20));
    return this._db().prepare(`SELECT r.*, u.username AS requester_username,
      (SELECT COUNT(*) FROM governance_approval_decisions d WHERE d.request_id=r.id AND d.decision='approve') AS approvals
      FROM governance_approval_requests r JOIN users u ON u.id=r.requested_by ${where}
      ORDER BY r.created_at DESC LIMIT ?`).all(...params, safeLimit).map(row);
  }

  decisions(id) {
    return this._db().prepare(`SELECT d.*, u.username FROM governance_approval_decisions d
      JOIN users u ON u.id=d.approver_id WHERE d.request_id=? ORDER BY d.created_at`).all(integer(id, 'id'));
  }

  decide(id, decision, comment, actor) {
    if (!actor?.id || !['admin', 'operator'].includes(actor.role)) fail('Approver access required', 403, 'APPROVER_REQUIRED');
    if (!['approve', 'reject'].includes(decision)) fail('decision must be approve or reject');
    const db = this._db();
    const transaction = db.transaction(() => {
      const request = db.prepare('SELECT * FROM governance_approval_requests WHERE id=?').get(integer(id, 'id'));
      if (!request) fail('Approval request not found', 404);
      if (request.state !== 'pending') fail('Approval request is not pending', 409, 'APPROVAL_NOT_PENDING');
      if (Date.parse(request.expires_at) <= Date.now()) {
        db.prepare("UPDATE governance_approval_requests SET state='expired',updated_at=datetime('now') WHERE id=?").run(request.id);
        fail('Approval request has expired', 409, 'APPROVAL_EXPIRED');
      }
      if (request.requester_cannot_approve && request.requested_by === actor.id) {
        fail('Requester cannot approve this request', 403, 'SEPARATION_OF_DUTIES');
      }
      try {
        db.prepare('INSERT INTO governance_approval_decisions (request_id,approver_id,decision,comment) VALUES (?,?,?,?)')
          .run(request.id, actor.id, decision, comment ? clean(comment, 'comment', 500) : null);
      } catch (error) {
        if (/UNIQUE/.test(error.message)) fail('This approver already decided', 409, 'DUPLICATE_APPROVER');
        throw error;
      }
      if (decision === 'reject') {
        db.prepare("UPDATE governance_approval_requests SET state='rejected',updated_at=datetime('now') WHERE id=?").run(request.id);
      } else {
        const count = db.prepare("SELECT COUNT(*) AS c FROM governance_approval_decisions WHERE request_id=? AND decision='approve'").get(request.id).c;
        if (count >= request.approvals_required) {
          db.prepare("UPDATE governance_approval_requests SET state='approved',updated_at=datetime('now') WHERE id=?").run(request.id);
        }
      }
      return this.getRequest(request.id);
    });
    return transaction();
  }

  _expire() {
    this._db().prepare("UPDATE governance_approval_requests SET state='expired',updated_at=datetime('now') WHERE state IN ('pending','approved') AND datetime(expires_at)<=datetime('now')").run();
  }

  listBlackouts() {
    return this._db().prepare('SELECT * FROM governance_blackout_windows ORDER BY starts_at DESC').all();
  }

  saveBlackout(id, input, actor) {
    if (actor?.role !== 'admin') fail('Administrator access required', 403, 'ADMIN_REQUIRED');
    const name = clean(input.name, 'name', 100);
    const actionPattern = clean(input.actionPattern || '*', 'actionPattern', 200);
    const environment = input.environment || 'any';
    if (!ENVIRONMENTS.has(environment)) fail('environment is invalid');
    const startsAt = timestamp(input.startsAt, 'startsAt');
    const endsAt = timestamp(input.endsAt, 'endsAt', true);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) fail('endsAt must be after startsAt');
    const reason = clean(input.reason, 'reason', 500);
    const scopeId = input.scopeId == null || input.scopeId === '' ? null : integer(input.scopeId, 'scopeId');
    const emergency = input.allowEmergencyOverride ? 1 : 0;
    const enabled = input.enabled === false ? 0 : 1;
    const db = this._db();
    if (id) {
      const windowId = integer(id, 'id');
      const result = db.prepare(`UPDATE governance_blackout_windows SET name=?,scope_id=?,action_pattern=?,environment=?,
        starts_at=?,ends_at=?,reason=?,allow_emergency_override=?,enabled=?,updated_at=datetime('now') WHERE id=?`)
        .run(name, scopeId, actionPattern, environment, startsAt, endsAt, reason, emergency, enabled, windowId);
      if (!result.changes) fail('Blackout window not found', 404);
      return db.prepare('SELECT * FROM governance_blackout_windows WHERE id=?').get(windowId);
    }
    const result = db.prepare(`INSERT INTO governance_blackout_windows
      (name,scope_id,action_pattern,environment,starts_at,ends_at,reason,allow_emergency_override,enabled,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(name, scopeId, actionPattern, environment, startsAt, endsAt, reason, emergency, enabled, actor.id);
    return db.prepare('SELECT * FROM governance_blackout_windows WHERE id=?').get(result.lastInsertRowid);
  }

  deleteBlackout(id, actor) {
    if (actor?.role !== 'admin') fail('Administrator access required', 403, 'ADMIN_REQUIRED');
    const result = this._db().prepare('DELETE FROM governance_blackout_windows WHERE id=?').run(integer(id, 'id'));
    if (!result.changes) fail('Blackout window not found', 404);
    return { deleted: true };
  }

  _activeBlackout(actionKey, environment, scopeId) {
    const scopeChain = this._scopeChainIds(scopeId);
    return this._db().prepare(`SELECT * FROM governance_blackout_windows WHERE enabled=1
      AND datetime(starts_at)<=datetime('now') AND datetime(ends_at)>datetime('now')
      AND (environment='any' OR environment=?) ORDER BY id`).all(environment)
      .find(window => (window.scope_id == null || scopeChain.has(window.scope_id)) && globMatches(window.action_pattern, actionKey));
  }

  _httpContext(req) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    let tenantId = Number(req.body?.tenantId || req.query?.tenantId) || null;
    const projectMatch = path.match(/^\/api\/governance\/(?:controls\/)?projects\/(\d+)/);
    const tenantMatch = path.match(/^\/api\/onboarding\/tenants\/(\d+)/);
    if (!tenantId && (projectMatch || tenantMatch)) tenantId = Number((projectMatch || tenantMatch)[1]);
    let scopeId = Number(req.body?.scopeId || req.query?.scopeId) || null;
    let environment = req.body?.environment === 'nonproduction' ? 'nonproduction' : 'production';
    if (tenantId) {
      const project = this._db().prepare(`SELECT t.usage_mode,s.id AS scope_id FROM tenants t
        LEFT JOIN governance_scopes s ON s.tenant_id=t.id AND s.scope_type='project' WHERE t.id=?`).get(tenantId);
      scopeId ||= project?.scope_id || null;
      if (project && project.usage_mode !== 'production') environment = 'nonproduction';
    }
    return { path, tenantId, scopeId, environment };
  }

  authorizeHttp(req) {
    if (!this.available() || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
    const { path, scopeId, environment } = this._httpContext(req);
    if (/^\/api\/governance\/controls\/(approval-requests|approval-policies|blackouts)/.test(path)
      || /^\/api\/governance\/controls\/projects\/\d+\/quota-requests/.test(path)) return null;
    const actionKey = `${req.method.toUpperCase()} ${path}`;
    const blackout = this._activeBlackout(actionKey, environment, scopeId);
    if (blackout) {
      const reason = String(req.headers['x-dd-emergency-override'] || '').trim();
      const ticket = String(req.headers['x-dd-emergency-ticket'] || '').trim();
      if (!(blackout.allow_emergency_override && req.user?.role === 'admin' && reason && ticket)) {
        fail(blackout.reason, 423, 'CHANGE_BLACKOUT', { windowId: blackout.id, endsAt: blackout.ends_at });
      }
      this._db().prepare(`INSERT INTO governance_blackout_exceptions
        (window_id,user_id,action_key,reason,ticket,request_hash) VALUES (?,?,?,?,?,?)`)
        .run(blackout.id, req.user.id, actionKey, clean(reason, 'emergency reason', 500), clean(ticket, 'emergency ticket', 120), payloadHash(actionKey, req.body));
    }
    const risk = integer(req.headers['x-dd-risk'] || req.body?.risk || 2, 'risk', 1, 4);
    const policy = this._matchingPolicy(actionKey, environment, risk, scopeId);
    if (!policy) return null;
    const approvalId = Number(req.headers['x-dd-approval-request']);
    if (!Number.isSafeInteger(approvalId)) fail('Approval is required', 428, 'APPROVAL_REQUIRED', { policyId: policy.id });
    const expectedHash = payloadHash(actionKey, req.body);
    const result = this._db().prepare(`UPDATE governance_approval_requests SET state='executing',executing_at=datetime('now'),updated_at=datetime('now')
      WHERE id=? AND state='approved' AND action_key=? AND payload_hash=? AND datetime(expires_at)>datetime('now')`).run(approvalId, actionKey, expectedHash);
    if (!result.changes) fail('Approval is invalid, expired, already used, or does not match this request', 409, 'APPROVAL_INVALID');
    return approvalId;
  }

  finishHttpClaim(id, status) {
    if (!id) return;
    const success = status < 400;
    this._db().prepare(`UPDATE governance_approval_requests SET state=?, outcome_status=?,
      consumed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END, updated_at=datetime('now') WHERE id=? AND state='executing'`)
      .run(success ? 'consumed' : 'approved', status, success ? 1 : 0, id);
  }
}

const service = new GovernanceApprovalsService();
module.exports = service;
module.exports.GovernanceApprovalsService = GovernanceApprovalsService;
module.exports.ApprovalError = ApprovalError;
module.exports.payloadHash = payloadHash;
module.exports.globMatches = globMatches;
