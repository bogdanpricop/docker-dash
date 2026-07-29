'use strict';

const crypto = require('crypto');
const cron = require('node-cron');
const { getDb } = require('../db');
const config = require('../config');
const automation = require('./infrastructure-automation');

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const SAFE_ACTION = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,299}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie/i;

class InfrastructureOperationsError extends Error {
  constructor(message, status = 400, code = 'INFRASTRUCTURE_OPERATIONS_ERROR', details) {
    super(message); this.name = 'InfrastructureOperationsError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new InfrastructureOperationsError(message, status, code, details);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const stable = value => JSON.stringify(canonical(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const string = (value, key, max = 300, pattern) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`);
  return result;
};
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`);
  return result;
};
function bounded(value, key, max = 256 * 1024) {
  let encoded; try { encoded = JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'AUTOMATION_EVIDENCE_TOO_LARGE');
}
function secretFree(value, path = 'payload') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw fail(`${path}.${key} may not contain secret material`, 400, 'AUTOMATION_SECRET_FIELD');
    secretFree(child, `${path}.${key}`);
  }
}
function uniqueStrings(value, key, max = 100, pattern = SAFE_REF) {
  if (!Array.isArray(value) || value.length > max) throw fail(`${key} must contain at most ${max} values`);
  return [...new Set(value.map((item, index) => string(item, `${key}[${index}]`, 300, pattern)))].sort();
}
function timezone(value) {
  const result = string(value, 'timezone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: result }).format(); } catch { throw fail('timezone is not a supported IANA timezone'); }
  return result;
}
function zonedParts(date, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour),
    minute: Number(parts.minute), weekday: weekdays[parts.weekday], date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}` };
}
function fieldMatches(expression, value, min, max, sunday = false) {
  return expression.split(',').some(segment => {
    const [base, stepRaw] = segment.split('/'); const step = stepRaw == null ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return false;
    let start = min; let end = max;
    if (base !== '*') {
      const range = base.split('-').map(Number);
      if (range.some(item => !Number.isInteger(item))) return false;
      start = range[0]; end = range.length === 1 ? range[0] : range[1];
    }
    const normalized = sunday && value === 0 && start === 7 ? 7 : value;
    return normalized >= start && normalized <= end && (normalized - start) % step === 0;
  });
}
function cronMatches(expression, parts) {
  const fields = expression.trim().split(/\s+/); if (fields.length !== 5) return false;
  const dayOfMonth = fieldMatches(fields[2], parts.day, 1, 31);
  const dayOfWeek = fieldMatches(fields[4], parts.weekday, 0, 7, true)
    || (parts.weekday === 0 && fieldMatches(fields[4], 7, 0, 7, true));
  const dayMatches = fields[2] === '*' || fields[4] === '*' ? dayOfMonth && dayOfWeek : dayOfMonth || dayOfWeek;
  return fieldMatches(fields[0], parts.minute, 0, 59) && fieldMatches(fields[1], parts.hour, 0, 23)
    && fieldMatches(fields[3], parts.month, 1, 12) && dayMatches;
}
function normalizeBlackouts(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50) throw fail('blackoutWindows must contain at most 50 entries');
  return value.map((item, index) => ({ name: string(item?.name, `blackoutWindows[${index}].name`, 120, SAFE_NAME),
    weekdays: [...new Set((item?.weekdays || []).map(day => integer(day, `blackoutWindows[${index}].weekdays`, 0, 6)))].sort(),
    start: string(item?.start, `blackoutWindows[${index}].start`, 5, TIME),
    end: string(item?.end, `blackoutWindows[${index}].end`, 5, TIME) }));
}
function inWindow(time, window) {
  if (window.start === window.end) return true;
  return window.start < window.end ? time >= window.start && time < window.end : time >= window.start || time < window.end;
}
function scheduleRow(row) { return row && { id: row.id, name: row.name, workflowId: row.workflow_id,
  cron: row.cron_expression, timezone: row.timezone, holidays: parse(row.holidays_json, []),
  blackoutWindows: parse(row.blackout_windows_json, []), enabled: !!row.enabled,
  lastEvaluatedAt: row.last_evaluated_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function approvalRow(row) { return row && { id: row.id, actionKey: row.action_key, targetType: row.target_type,
  targetId: row.target_id, payloadHash: row.payload_hash, state: row.state, dueAt: row.due_at,
  assigneeUserId: row.assignee_user_id, escalationUserId: row.escalation_user_id,
  escalationCount: row.escalation_count, escalationGraceMinutes: row.escalation_grace_minutes,
  decisionReason: row.decision_reason, decidedAt: row.decided_at, createdAt: row.created_at }; }
function templateRow(row) { return row && { id: row.id, slug: row.slug, version: row.version, category: row.category,
  description: row.description, parameters: parse(row.parameters_json, []), steps: parse(row.steps_json, []),
  curated: !!row.curated, enabled: !!row.enabled }; }

class InfrastructureOperationsService {
  constructor(dbProvider = getDb, options = {}) {
    this._dbProvider = dbProvider; this._automation = options.automationService || automation;
    this._dryRunAdapters = options.dryRunAdapters || {};
    this._secretAdapters = options.secretAdapters || { environment: async reference => {
      if (!/^DD_BROKER_SECRET_[A-Z0-9_]{1,100}$/.test(reference)) throw fail('Environment secret reference is not allowlisted', 400, 'SECRET_REFERENCE_INVALID');
      const value = process.env[reference]; if (!value) throw fail('Referenced environment secret is unavailable', 424, 'SECRET_UNAVAILABLE');
      return value;
    } };
  }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  saveSchedule(body = {}, actor) {
    this._admin(actor); const name = string(body.name, 'name', 120, SAFE_NAME);
    const workflowId = integer(body.workflowId, 'workflowId', 1); const db = this._db();
    if (!db.prepare('SELECT 1 FROM infrastructure_workflows WHERE id=? AND enabled=1').get(workflowId)) throw fail('Enabled workflow not found', 404, 'WORKFLOW_NOT_FOUND');
    const expression = string(body.cron, 'cron', 100); if (!cron.validate(expression) || expression.trim().split(/\s+/).length !== 5) throw fail('cron must be a valid five-field expression');
    const zone = timezone(body.timezone || 'UTC'); const holidays = uniqueStrings(body.holidays || [], 'holidays', 366, DATE);
    const blackouts = normalizeBlackouts(body.blackoutWindows); const enabled = body.enabled === true ? 1 : 0;
    try {
      const result = db.prepare(`INSERT INTO infrastructure_schedule_triggers
        (name,workflow_id,cron_expression,timezone,holidays_json,blackout_windows_json,enabled,created_by)
        VALUES (?,?,?,?,?,?,?,?)`).run(name, workflowId, expression, zone, stable(holidays), stable(blackouts), enabled, actor.id);
      return scheduleRow(db.prepare('SELECT * FROM infrastructure_schedule_triggers WHERE id=?').get(result.lastInsertRowid));
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Schedule name already exists', 409, 'SCHEDULE_EXISTS');
      throw error;
    }
  }
  schedules(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_schedule_triggers ORDER BY name').all().map(scheduleRow); }
  evaluateSchedule(id, at = new Date(), actor) {
    this._admin(actor); const row = this._db().prepare('SELECT * FROM infrastructure_schedule_triggers WHERE id=?').get(integer(id, 'scheduleId', 1));
    if (!row) throw fail('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    const instant = at instanceof Date ? at : new Date(at); if (Number.isNaN(instant.getTime())) throw fail('at must be an ISO timestamp');
    const parts = zonedParts(instant, row.timezone); const holidays = parse(row.holidays_json, []);
    const blackout = parse(row.blackout_windows_json, []).find(window => (!window.weekdays.length || window.weekdays.includes(parts.weekday)) && inWindow(parts.time, window));
    let decision = 'ready'; let reason = 'schedule is eligible';
    if (!row.enabled) { decision = 'disabled'; reason = 'schedule is disabled'; }
    else if (holidays.includes(parts.date)) { decision = 'holiday_suppressed'; reason = `holiday ${parts.date}`; }
    else if (blackout) { decision = 'blackout_suppressed'; reason = `blackout ${blackout.name}`; }
    return { schedule: scheduleRow(row), at: instant.toISOString(), local: parts, matchesCron: cronMatches(row.cron_expression, parts),
      decision, reason, workflowExecutionStarted: false };
  }
  runDueSchedules(at = new Date()) {
    const actor = { id: -1, role: 'admin' }; const db = this._db(); const results = [];
    for (const row of db.prepare('SELECT * FROM infrastructure_schedule_triggers WHERE enabled=1 ORDER BY id').all()) {
      const evaluation = this.evaluateSchedule(row.id, at, actor); if (!evaluation.matchesCron) continue;
      const scheduledFor = new Date(Math.floor(new Date(at).getTime() / 60000) * 60000).toISOString();
      const result = db.prepare(`INSERT OR IGNORE INTO infrastructure_schedule_runs
        (schedule_id,scheduled_for,decision,reason,evidence_json) VALUES (?,?,?,?,?)`).run(row.id, scheduledFor,
        evaluation.decision, evaluation.reason, stable({ timezone: row.timezone, local: evaluation.local, workflowId: row.workflow_id }));
      db.prepare("UPDATE infrastructure_schedule_triggers SET last_evaluated_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(row.id);
      if (result.changes) results.push({ scheduleId: row.id, scheduledFor, decision: evaluation.decision,
        reason: evaluation.reason, workflowExecutionStarted: false });
    }
    return results;
  }
  scheduleRuns(actor) { this._admin(actor); return this._db().prepare(`SELECT * FROM infrastructure_schedule_runs
    ORDER BY scheduled_for DESC,id DESC LIMIT 500`).all().map(row => ({ id: row.id, scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for, decision: row.decision, reason: row.reason, evidence: parse(row.evidence_json, {}) })); }
  createApproval(body = {}, actor) {
    this._admin(actor); const payload = object(body.payload); bounded(payload, 'payload'); secretFree(payload);
    const dueMinutes = integer(body.dueMinutes ?? 60, 'dueMinutes', 1, 10080);
    const grace = integer(body.escalationGraceMinutes ?? 30, 'escalationGraceMinutes', 1, 1440);
    const assignee = body.assigneeUserId == null ? null : integer(body.assigneeUserId, 'assigneeUserId', 1);
    const escalation = body.escalationUserId == null ? null : integer(body.escalationUserId, 'escalationUserId', 1);
    const due = new Date(Date.now() + dueMinutes * 60000).toISOString(); const db = this._db();
    for (const userId of [assignee, escalation].filter(Boolean)) if (!db.prepare("SELECT 1 FROM users WHERE id=? AND is_active=1 AND role='admin'").get(userId)) throw fail(`Active administrator ${userId} not found`, 404, 'APPROVER_NOT_FOUND');
    const result = db.prepare(`INSERT INTO infrastructure_approval_requests
      (action_key,target_type,target_id,payload_hash,due_at,assignee_user_id,escalation_user_id,escalation_grace_minutes,requested_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(string(body.actionKey, 'actionKey', 160, SAFE_ACTION),
      string(body.targetType, 'targetType', 80, SAFE_NAME), string(body.targetId, 'targetId', 300, SAFE_REF), hash(payload), due,
      assignee, escalation, grace, actor.id);
    return { ...approvalRow(db.prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(result.lastInsertRowid)),
      applyStarted: false };
  }
  approvals(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_approval_requests ORDER BY created_at DESC,id DESC LIMIT 500').all().map(approvalRow); }
  sweepApprovals(at = new Date()) {
    const now = new Date(at); if (Number.isNaN(now.getTime())) throw fail('at must be a timestamp'); const db = this._db(); const changed = [];
    const due = db.prepare("SELECT * FROM infrastructure_approval_requests WHERE state IN ('pending','escalated') AND datetime(due_at)<=datetime(?) ORDER BY id").all(now.toISOString());
    for (const row of due) {
      if (row.state === 'pending' && row.escalation_user_id) {
        const nextDue = new Date(now.getTime() + row.escalation_grace_minutes * 60000).toISOString();
        db.prepare(`UPDATE infrastructure_approval_requests SET state='escalated',assignee_user_id=escalation_user_id,
          escalation_count=escalation_count+1,due_at=?,updated_at=datetime('now') WHERE id=?`).run(nextDue, row.id);
      } else db.prepare("UPDATE infrastructure_approval_requests SET state='expired',decision_reason='approval deadline expired',decided_at=?,updated_at=datetime('now') WHERE id=?").run(now.toISOString(), row.id);
      changed.push(approvalRow(db.prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(row.id)));
    }
    return changed.map(item => ({ ...item, applyStarted: false }));
  }
  decideApproval(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const approvalId = integer(id, 'approvalId', 1);
    let approval = db.prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(approvalId);
    if (!approval) throw fail('Approval not found', 404, 'APPROVAL_NOT_FOUND');
    if (['pending', 'escalated'].includes(approval.state) && Date.parse(approval.due_at) <= Date.now()) {
      this.sweepApprovals(new Date()); approval = db.prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(approvalId);
    }
    if (!['pending', 'escalated'].includes(approval.state)) throw fail('Approval is no longer pending', 409, 'APPROVAL_CLOSED');
    if (body.payloadHash !== approval.payload_hash) throw fail('payloadHash confirmation does not match', 409, 'APPROVAL_PAYLOAD_MISMATCH');
    if (approval.assignee_user_id && approval.assignee_user_id !== actor.id) throw fail('Approval is assigned to another user', 403, 'APPROVAL_ASSIGNEE_REQUIRED');
    const decision = body.decision; if (!['approved', 'rejected'].includes(decision)) throw fail('decision must be approved or rejected');
    db.prepare(`UPDATE infrastructure_approval_requests SET state=?,decided_by=?,decision_reason=?,decided_at=datetime('now'),
      updated_at=datetime('now') WHERE id=?`).run(decision, actor.id, String(body.reason || '').trim().slice(0, 600), approval.id);
    return { ...approvalRow(db.prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(approval.id)), applyStarted: false };
  }
  async dryRun(body = {}, actor) {
    this._admin(actor); const providerType = string(body.providerType, 'providerType', 80, SAFE_NAME).toLowerCase();
    const adapterKey = string(body.adapterKey || 'native', 'adapterKey', 80, SAFE_NAME); const actionKey = string(body.actionKey, 'actionKey', 160, SAFE_ACTION);
    const targetRef = string(body.targetRef, 'targetRef', 300, SAFE_REF); const request = object(body.request);
    bounded(request, 'request'); secretFree(request); const adapter = this._dryRunAdapters[`${providerType}:${adapterKey}`] || this._dryRunAdapters[providerType];
    let status = 'unsupported'; let result = { supported: false, reason: `No ${adapterKey} validate/simulate adapter is registered for ${providerType}` };
    if (adapter) {
      try {
        result = object(await adapter({ providerType, actionKey, targetRef, request: canonical(request) }));
        status = result.supported === false ? 'unsupported' : result.valid === false ? 'invalid' : 'valid';
      } catch (error) { status = 'error'; result = { supported: true, valid: false, error: String(error.message || error).slice(0, 600) }; }
    }
    bounded(result, 'result'); secretFree(result, 'result'); const db = this._db();
    const saved = db.prepare(`INSERT INTO infrastructure_dry_run_evidence
      (provider_type,adapter_key,action_key,target_ref,request_hash,status,result_json,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(providerType, adapterKey, actionKey, targetRef, hash(request), status, stable(result), actor.id);
    return { id: Number(saved.lastInsertRowid), providerType, adapterKey, actionKey, targetRef, status, result,
      providerMutationStarted: false, createdAt: db.prepare('SELECT created_at FROM infrastructure_dry_run_evidence WHERE id=?').get(saved.lastInsertRowid).created_at };
  }
  dryRuns(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_dry_run_evidence ORDER BY id DESC LIMIT 500').all()
    .map(row => ({ id: row.id, providerType: row.provider_type, adapterKey: row.adapter_key, actionKey: row.action_key,
      targetRef: row.target_ref, requestHash: row.request_hash, status: row.status, result: parse(row.result_json, {}), createdAt: row.created_at })); }
  saveSecretBroker(body = {}, actor) {
    this._admin(actor); const kind = body.providerKind || 'environment';
    if (!['environment', 'vault', 'aws_secrets_manager', 'azure_key_vault'].includes(kind)) throw fail('providerKind is invalid');
    const purposes = uniqueStrings(body.allowedPurposes || [], 'allowedPurposes', 50, SAFE_ACTION); if (!purposes.length) throw fail('allowedPurposes is required');
    const reference = string(body.secretReference, 'secretReference', 300, SAFE_REF);
    if (kind === 'environment' && !/^DD_BROKER_SECRET_[A-Z0-9_]{1,100}$/.test(reference)) throw fail('Environment references must start with DD_BROKER_SECRET_');
    try {
      const result = this._db().prepare(`INSERT INTO infrastructure_secret_broker_profiles
        (name,provider_kind,secret_reference,allowed_purposes_json,max_lease_seconds,enabled,created_by) VALUES (?,?,?,?,?,?,?)`)
        .run(string(body.name, 'name', 120, SAFE_NAME), kind, reference, stable(purposes),
          integer(body.maxLeaseSeconds ?? 60, 'maxLeaseSeconds', 1, 300), body.enabled === false ? 0 : 1, actor.id);
      return this._secretProfile(this._db().prepare('SELECT * FROM infrastructure_secret_broker_profiles WHERE id=?').get(result.lastInsertRowid));
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Secret broker name already exists', 409, 'SECRET_BROKER_EXISTS');
      throw error;
    }
  }
  _secretProfile(row) { return row && { id: row.id, name: row.name, providerKind: row.provider_kind,
    secretReference: row.secret_reference, allowedPurposes: parse(row.allowed_purposes_json, []),
    maxLeaseSeconds: row.max_lease_seconds, enabled: !!row.enabled, createdAt: row.created_at }; }
  secretBrokers(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_secret_broker_profiles ORDER BY name').all().map(row => this._secretProfile(row)); }
  secretAccessEvents(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_secret_access_events ORDER BY id DESC LIMIT 500').all()
    .map(row => ({ id: row.id, profileId: row.profile_id, purpose: row.purpose, outcome: row.outcome,
      leaseSeconds: row.lease_seconds, secretFingerprint: row.secret_fingerprint, reason: row.reason,
      accessedBy: row.accessed_by, accessedAt: row.accessed_at })); }
  async withSecretLease(profileId, purposeValue, actor, consumer) {
    this._admin(actor); const db = this._db(); const profile = db.prepare('SELECT * FROM infrastructure_secret_broker_profiles WHERE id=?').get(integer(profileId, 'profileId', 1));
    if (!profile) throw fail('Secret broker profile not found', 404, 'SECRET_BROKER_NOT_FOUND');
    const purpose = string(purposeValue, 'purpose', 160, SAFE_ACTION); const allowed = parse(profile.allowed_purposes_json, []);
    const record = (outcome, fingerprint, reason) => db.prepare(`INSERT INTO infrastructure_secret_access_events
      (profile_id,purpose,outcome,lease_seconds,secret_fingerprint,reason,accessed_by) VALUES (?,?,?,?,?,?,?)`)
      .run(profile.id, purpose, outcome, profile.max_lease_seconds, fingerprint, reason || null, actor.id);
    if (!profile.enabled || !allowed.includes(purpose)) {
      record('denied', null, profile.enabled ? 'purpose is not allowlisted' : 'profile is disabled');
      throw fail('Secret lease is not allowed', 403, 'SECRET_LEASE_DENIED');
    }
    const adapter = this._secretAdapters[profile.provider_kind];
    if (!adapter) { record('failed', null, 'provider adapter is unavailable'); throw fail('Secret provider adapter is unavailable', 501, 'SECRET_PROVIDER_UNSUPPORTED'); }
    let buffer;
    try {
      const value = await adapter(profile.secret_reference, { purpose, leaseSeconds: profile.max_lease_seconds });
      buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value));
      if (!buffer.length) throw fail('Secret provider returned an empty value', 424, 'SECRET_UNAVAILABLE');
      const fingerprint = crypto.createHmac('sha256', config.security.encryptionKey)
        .update(`${profile.id}:${purpose}:`).update(buffer).digest('hex').slice(0, 16);
      const result = await consumer(buffer, { expiresAt: new Date(Date.now() + profile.max_lease_seconds * 1000).toISOString(), fingerprint });
      record('granted', fingerprint, null); return result;
    } catch (error) {
      if (error.code !== 'SECRET_LEASE_DENIED') record('failed', null, String(error.message || error).slice(0, 300));
      throw error;
    } finally { if (buffer) buffer.fill(0); }
  }
  async probeSecretBroker(id, purpose, actor) {
    return this.withSecretLease(id, purpose, actor, async (secret, lease) => ({ available: secret.length > 0,
      fingerprint: lease.fingerprint, expiresAt: lease.expiresAt, secretReturned: false }));
  }
  workflowTemplates(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM infrastructure_workflow_templates WHERE enabled=1 ORDER BY category,slug').all().map(templateRow); }
  instantiateTemplate(id, body = {}, actor) {
    this._admin(actor); const template = templateRow(this._db().prepare('SELECT * FROM infrastructure_workflow_templates WHERE id=? AND enabled=1').get(integer(id, 'templateId', 1)));
    if (!template) throw fail('Workflow template not found', 404, 'WORKFLOW_TEMPLATE_NOT_FOUND');
    const values = object(body.parameters); secretFree(values, 'parameters');
    const unknown = Object.keys(values).filter(key => !template.parameters.includes(key)); if (unknown.length) throw fail('Unknown workflow template parameters', 400, 'WORKFLOW_TEMPLATE_PARAMETERS', { unknown });
    const missing = template.parameters.filter(key => values[key] == null || values[key] === ''); if (missing.length) throw fail('Missing workflow template parameters', 400, 'WORKFLOW_TEMPLATE_PARAMETERS', { missing });
    const normalized = Object.fromEntries(template.parameters.map(key => [key, string(values[key], `parameters.${key}`, 300, SAFE_REF)]));
    const replace = value => Array.isArray(value) ? value.map(replace) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]))
      : typeof value === 'string' ? value.replace(/\$\{([a-zA-Z0-9_.-]+)\}/g, (_, key) => normalized[key] ?? '') : value;
    const workflow = this._automation.createWorkflow({ name: body.name || `${template.slug}-${Date.now()}`,
      version: body.version || template.version, description: `${template.description} Curated template: ${template.slug}@${template.version}.`,
      steps: replace(template.steps) }, actor);
    return { workflow, template: { id: template.id, slug: template.slug, version: template.version },
      parameters: normalized, executionStarted: false };
  }
  overview(actor) {
    this._admin(actor); return { capabilities: { calendarSchedules: true, approvalEscalation: true,
      implicitApplyOnApproval: false, providerDryRunAdapters: true, secretBrokerJit: true, secretReturnedByApi: false,
      curatedWorkflowTemplates: true }, schedules: this.schedules(actor), scheduleRuns: this.scheduleRuns(actor),
    approvals: this.approvals(actor), dryRuns: this.dryRuns(actor), secretBrokers: this.secretBrokers(actor),
    secretAccessEvents: this.secretAccessEvents(actor), workflowTemplates: this.workflowTemplates(actor) };
  }
}

const service = new InfrastructureOperationsService();
module.exports = service;
module.exports.InfrastructureOperationsService = InfrastructureOperationsService;
module.exports.InfrastructureOperationsError = InfrastructureOperationsError;
module.exports._internals = { canonical, stable, hash, zonedParts, cronMatches, normalizeBlackouts, inWindow };
