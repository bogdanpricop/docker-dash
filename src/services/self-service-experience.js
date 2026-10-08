'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const governanceSingleton = require('./governance');
const selfServiceSingleton = require('./self-service');
const telemetry = require('./telemetry');

const PROVIDERS = new Set(['proxmox', 'vsphere', 'xen', 'incus', 'kubernetes', 'nomad', 'docker', 'unknown']);
const ACTIONS = new Set(['provision', 'start', 'shutdown', 'reboot', 'snapshot', 'console', 'power']);
const VERSION_GUIDANCE = {
  proxmox: { testedFamily: '8.x/9.x', note: 'Cluster task locks, guest-agent state and storage capabilities remain authoritative.' },
  vsphere: { testedFamily: '8.x/9.x', note: 'vCenter task state, VM connection state and VMware Tools remain authoritative.' },
  xen: { testedFamily: 'XO/XAPI/xl', note: 'Capabilities vary by the active management plane and pool-master state.' },
  incus: { testedFamily: '6.x LTS/rolling', note: 'Project and instance capabilities must be read from the connected endpoint.' },
  kubernetes: { testedFamily: 'KubeVirt discovery', note: 'CRD discovery and namespace authorization remain authoritative.' },
  nomad: { testedFamily: '1.x', note: 'Job and allocation capabilities remain namespace and ACL scoped.' },
  docker: { testedFamily: 'Engine 26+', note: 'Engine API negotiation and host permissions remain authoritative.' },
  unknown: { testedFamily: 'unverified', note: 'Refresh provider capability evidence before any request.' },
};

class SelfServiceExperienceError extends Error {
  constructor(message, status = 400, code = 'SELF_SERVICE_EXPERIENCE_ERROR', details) {
    super(message); this.name = 'SelfServiceExperienceError'; this.status = status; this.code = code; this.details = details;
  }
}

function fail(message, status = 400, code = 'SELF_SERVICE_EXPERIENCE_ERROR', details) {
  throw new SelfServiceExperienceError(message, status, code, details);
}
function integer(value, field, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`${field} is invalid`, 400, 'INVALID_INPUT');
  return parsed;
}
function clean(value, field, max = 240, required = true) {
  const result = String(value || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!result && required) fail(`${field} is required`, 400, 'INVALID_INPUT');
  if (result.length > max) fail(`${field} is too long`, 400, 'INVALID_INPUT');
  return result || null;
}
function json(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function safeUrl(value, field, { relative = false } = {}) {
  const input = clean(value, field, 500, false); if (!input) return null;
  if (relative && /^\/(?!\/)[A-Za-z0-9/_?&=.%#-]+$/.test(input)) return input;
  try { const url = new URL(input); if (url.protocol !== 'https:') fail(`${field} must use HTTPS`, 400, 'UNSAFE_URL'); return url.toString(); }
  catch (error) { if (error instanceof SelfServiceExperienceError) throw error; fail(`${field} is invalid`, 400, 'INVALID_URL'); }
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

class SelfServiceExperienceService {
  constructor(options = {}) {
    this._dbProvider = options.dbProvider || getDb;
    this.governance = options.governance || governanceSingleton;
    this.selfService = options.selfService || selfServiceSingleton;
    this.telemetry = options.telemetry || telemetry;
  }
  _db() { return this._dbProvider(); }
  _admin(actor) { if (!actor?.id || actor.role !== 'admin') fail('Administrator access required', 403, 'ADMIN_REQUIRED'); }
  _project(projectId, actor, permission = null) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const project = this.governance.getProject(integer(projectId, 'projectId'), actor);
    if (permission && actor.role !== 'admin' && !new Set(project.permissions || []).has(permission)) {
      fail(`Project permission ${permission} is required`, 403, 'PROJECT_PERMISSION_REQUIRED', { permission });
    }
    return project;
  }

  getBranding(projectId, actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const project = projectId == null ? null : this._project(projectId, actor);
    const db = this._db();
    const row = project ? db.prepare('SELECT * FROM portal_branding_profiles WHERE scope_key=?').get(`project:${project.id}`) : null;
    const organization = db.prepare("SELECT * FROM portal_branding_profiles WHERE scope_key='organization'").get();
    const selected = row || organization || { scope_key: 'default', display_name: 'Infrastructure Self-Service', accent_color: '#4f8cff' };
    return { branding: { scope: selected.scope_key, projectId: selected.tenant_id || null, displayName: selected.display_name,
      logoUrl: selected.logo_url || null, accentColor: selected.accent_color, supportUrl: selected.support_url || null,
      helpUrl: selected.help_url || null, inherited: !!project && !row } };
  }

  saveBranding(input, actor) {
    this._admin(actor); const projectId = input.projectId == null ? null : integer(input.projectId, 'projectId');
    if (projectId != null) this._project(projectId, actor);
    const scopeKey = projectId == null ? 'organization' : `project:${projectId}`;
    const displayName = clean(input.displayName, 'displayName', 100);
    const color = String(input.accentColor || '#4f8cff').trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color)) fail('accentColor must be a six-digit hex color', 400, 'INVALID_COLOR');
    const db = this._db();
    db.prepare(`INSERT INTO portal_branding_profiles
      (scope_key,tenant_id,display_name,logo_url,accent_color,support_url,help_url,updated_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(scope_key) DO UPDATE SET tenant_id=excluded.tenant_id,
      display_name=excluded.display_name,logo_url=excluded.logo_url,accent_color=excluded.accent_color,
      support_url=excluded.support_url,help_url=excluded.help_url,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(scopeKey, projectId, displayName, safeUrl(input.logoUrl, 'logoUrl', { relative: true }), color,
        safeUrl(input.supportUrl, 'supportUrl', { relative: true }), safeUrl(input.helpUrl, 'helpUrl', { relative: true }), actor.id);
    return this.getBranding(projectId, actor);
  }

  contextualHelp(input, actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    if (input.projectId != null) this._project(input.projectId, actor, 'portal.support.read');
    const provider = String(input.providerType || 'unknown').toLowerCase();
    let action = String(input.action || 'provision').toLowerCase();
    if (!PROVIDERS.has(provider)) fail('providerType is invalid', 400, 'INVALID_PROVIDER');
    if (!ACTIONS.has(action)) fail('action is invalid', 400, 'INVALID_ACTION');
    if (['start', 'shutdown', 'reboot'].includes(action)) action = 'power';
    const rows = this._db().prepare(`SELECT * FROM self_service_help_topics
      WHERE action_key=? AND provider_type IN (?, '*') ORDER BY CASE WHEN provider_type=? THEN 0 ELSE 1 END,title`).all(action, provider, provider);
    const version = clean(input.providerVersion, 'providerVersion', 80, false);
    return { context: { providerType: provider, providerVersion: version, action,
      versionGuidance: { ...VERSION_GUIDANCE[provider], evaluatedVersion: version || 'not reported' } },
    topics: rows.map(row => ({ key: row.topic_key, title: row.title, summary: row.summary,
      caveats: json(row.caveats_json, []), nextSafeTest: row.next_safe_test, providerType: row.provider_type, action: row.action_key })) };
  }

  troubleshoot(requestId, actor) {
    const { request } = this.selfService.getRequest(integer(requestId, 'requestId'), actor);
    this._project(request.tenantId, actor, 'portal.support.read');
    let operation = null;
    if (request.providerOperationId) {
      try { const found = this.selfService.operations.get(request.providerOperationId); operation = found ? { id: found.id, state: found.state, updatedAt: found.updated_at || found.updatedAt || null } : null; }
      catch { operation = null; }
    }
    const checklist = [
      { key: 'project-access', status: 'pass', evidence: `Project ${request.tenantId} is accessible to the current user.` },
      { key: 'approval', status: request.approvalRequestId ? (['approved', 'running', 'validated'].includes(request.state) ? 'pass' : 'attention') : 'pass', evidence: request.approvalRequestId ? `Approval is bound to request state ${request.state}.` : 'No approval is required for this action.' },
      { key: 'timeline', status: request.events.length ? 'pass' : 'attention', evidence: `${request.events.length} ordered timeline event(s) are available.` },
      { key: 'provider-operation', status: operation ? (operation.state === 'failed' ? 'attention' : 'pass') : request.providerOperationId ? 'attention' : 'pending', evidence: operation ? `Durable operation is ${operation.state}.` : request.providerOperationId ? 'The operation identity exists but no current state was returned.' : 'No provider operation has been submitted.' },
    ];
    const bundle = { schemaVersion: 1, generatedAt: new Date().toISOString(), applicationVersion: require('../version'),
      request: { key: request.requestKey, tenantId: request.tenantId, kind: request.requestKind, action: request.actionKey,
        risk: request.risk, state: request.state, createdAt: request.createdAt, updatedAt: request.updatedAt },
      timeline: request.events.map(event => ({ sequence: event.sequence, type: event.type, state: event.state, createdAt: event.createdAt,
        evidenceKeys: Object.keys(event.evidence || {}).filter(key => !/url|token|secret|credential/i.test(key)).sort() })),
      operation, exclusions: ['request values', 'resource references', 'usernames', 'URLs', 'credentials', 'error text', 'stack traces'] };
    const nextSafeTest = request.state === 'running'
      ? { kind: 'read_only_status', label: 'Refresh the durable operation and provider task state.', mutating: false }
      : ['failed', 'expired', 'rejected'].includes(request.state)
        ? { kind: 'read_only_preflight', label: 'Refresh inventory, quota and capability evidence before creating a new request.', mutating: false }
        : { kind: 'review_timeline', label: 'Review approval and timeline evidence; no provider call is needed yet.', mutating: false };
    const hash = digest(bundle); const key = `sst_${crypto.randomBytes(13).toString('hex')}`;
    const result = this._db().prepare(`INSERT INTO self_service_troubleshooting_sessions
      (session_key,tenant_id,request_id,checklist_json,support_bundle_json,bundle_hash,next_safe_test_json,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(key, request.tenantId, request.id, JSON.stringify(checklist), JSON.stringify(bundle), hash, JSON.stringify(nextSafeTest), actor.id);
    return { session: { id: Number(result.lastInsertRowid), key, requestId: request.id, checklist, supportBundle: bundle,
      bundleHash: hash, nextSafeTest } };
  }

  recommendations(projectId, actor) {
    this._project(projectId, actor, 'portal.support.read');
    const dashboard = this.selfService.projectDashboard(projectId, actor); const items = [];
    for (const alert of dashboard.alerts || []) items.push({ key: `quota-${alert.metric}`, title: 'Request temporary quota headroom',
      reason: alert.message, evidence: [{ source: 'project-quota', metric: alert.metric, usage: alert.usage, limit: alert.limit }],
      confidence: { score: 0.98, level: 'high', basis: 'Direct quota and usage comparison' },
      impact: 'Avoids a hard-quota rejection while preserving approval and automatic expiry.',
      action: { kind: 'quota_request', projectId: dashboard.project.id, mutating: false, requiresApproval: true },
      undo: 'The approved temporary grant expires automatically at its requested deadline.' });
    const failed = (this.selfService.listRequests(actor, { tenantId: projectId, limit: 100 }).requests || [])
      .filter(item => ['failed', 'expired', 'rejected'].includes(item.state));
    if (failed.length) items.push({ key: 'troubleshoot-failures', title: 'Build a privacy-safe troubleshooting bundle',
      reason: `${failed.length} recent request(s) need evidence before retry.`, evidence: failed.slice(0, 5).map(item => ({ requestKey: item.requestKey, state: item.state })),
      confidence: { score: 1, level: 'high', basis: 'Durable request terminal states' },
      impact: 'Prevents blind retries and gives support a deterministic checklist.',
      action: { kind: 'troubleshoot', requestId: failed[0].id, mutating: false }, undo: 'No infrastructure state is changed.' });
    const pending = Number(dashboard.requests?.counts?.requested || 0);
    if (pending) items.push({ key: 'review-pending', title: 'Review pending approvals', reason: `${pending} request(s) are waiting for a decision.`,
      evidence: [{ source: 'request-state-count', state: 'requested', count: pending }], confidence: { score: 1, level: 'high', basis: 'Durable request state' },
      impact: 'Reduces request lead time without bypassing policy.', action: { kind: 'open_approval_inbox', mutating: false }, undo: 'Approval decisions remain separately confirmed and audited.' });
    if (!items.length) items.push({ key: 'no-action', title: 'No immediate self-service action', reason: 'Quota and request evidence has no active finding.',
      evidence: [{ source: 'project-dashboard', alerts: 0, pendingRequests: 0 }], confidence: { score: 0.9, level: 'high', basis: 'Current project dashboard snapshot' },
      impact: 'Continue monitoring; do not create work without evidence.', action: { kind: 'none', mutating: false }, undo: 'Not applicable.' });
    return { advisoryOnly: true, generatedAt: new Date().toISOString(), projectId: Number(projectId),
      recommendations: items.map(item => ({ ...item, evidenceHash: digest(item.evidence) })) };
  }

  listIncidents(actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    const projects = this.governance.listProjects(actor); const ids = projects.map(project => project.id);
    const incidents = [];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = this._db().prepare(`SELECT r.id,r.request_key,r.tenant_id,r.action_key,r.state,r.provider_operation_id,
        r.created_at,r.updated_at,t.name AS project_name FROM self_service_requests r JOIN tenants t ON t.id=r.tenant_id
        WHERE r.tenant_id IN (${placeholders}) AND r.state IN ('running','failed','rejected','expired')
        ORDER BY CASE r.state WHEN 'failed' THEN 0 WHEN 'expired' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,r.updated_at DESC LIMIT 100`).all(...ids);
      for (const row of rows) incidents.push({ key: `request:${row.id}`, source: 'self_service_request', sourceId: row.id,
        projectId: row.tenant_id, projectName: row.project_name, title: `${row.action_key} · ${row.request_key}`,
        state: row.state, severity: row.state === 'failed' ? 'critical' : row.state === 'running' ? 'info' : 'warning',
        jobStatus: row.provider_operation_id ? { operationId: row.provider_operation_id, state: row.state } : null,
        createdAt: row.created_at, updatedAt: row.updated_at, destructiveActions: [] });
    }
    if (actor.role === 'admin') {
      const alerts = this._db().prepare(`SELECT e.id,e.message,e.severity,e.triggered_at,e.acknowledged_at,r.name AS rule_name
        FROM alert_events e JOIN alert_rules r ON r.id=e.rule_id WHERE e.resolved_at IS NULL ORDER BY e.triggered_at DESC LIMIT 50`).all();
      for (const row of alerts) incidents.push({ key: `alert:${row.id}`, source: 'alert', sourceId: row.id, projectId: null,
        projectName: null, title: row.rule_name, summary: row.message, state: row.acknowledged_at ? 'acknowledged' : 'active',
        severity: row.severity, jobStatus: null, createdAt: row.triggered_at, updatedAt: row.triggered_at, destructiveActions: [] });
    }
    const states = new Map(this._db().prepare('SELECT * FROM self_service_incident_states WHERE user_id=?').all(actor.id).map(row => [row.incident_key, row]));
    return { safeActions: ['acknowledge', 'pause_notifications'], destructiveDefaults: false,
      incidents: incidents.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(item => {
        const state = states.get(item.key); return { ...item, acknowledgedAt: state?.acknowledged_at || null,
          pausedUntil: state?.paused_until || null, note: state?.note || null };
      }) };
  }

  updateIncident(key, input, actor) {
    const incidentKey = clean(key, 'incidentKey', 100); const incident = this.listIncidents(actor).incidents.find(item => item.key === incidentKey);
    if (!incident) fail('Incident not found or not accessible', 404, 'INCIDENT_NOT_FOUND');
    const action = String(input.action || '').toLowerCase(); if (!['acknowledge', 'pause_notifications'].includes(action)) fail('Only safe incident actions are allowed', 400, 'UNSAFE_INCIDENT_ACTION');
    if (incident.projectId != null) this._project(incident.projectId, actor, 'portal.incident.manage'); else this._admin(actor);
    const note = clean(input.note, 'note', 240, false); const acknowledgedAt = action === 'acknowledge' ? new Date().toISOString() : null;
    const pausedUntil = action === 'pause_notifications' ? new Date(Date.now() + integer(input.minutes || 30, 'minutes', 5, 1440) * 60_000).toISOString() : null;
    this._db().prepare(`INSERT INTO self_service_incident_states (user_id,incident_key,acknowledged_at,paused_until,note,updated_at)
      VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_id,incident_key) DO UPDATE SET
      acknowledged_at=COALESCE(excluded.acknowledged_at,self_service_incident_states.acknowledged_at),
      paused_until=COALESCE(excluded.paused_until,self_service_incident_states.paused_until),note=excluded.note,updated_at=excluded.updated_at`)
      .run(actor.id, incidentKey, acknowledgedAt, pausedUntil, note);
    return { incident: this.listIncidents(actor).incidents.find(item => item.key === incidentKey), action, infrastructureMutated: false };
  }

  feedbackPreference(actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    return { preference: this.telemetry.preference(this._db(), actor.id), payload: this.telemetry.describePayload(this._db(), 'standalone', actor.id) };
  }
  saveFeedbackPreference(input, actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    try { return { preference: this.telemetry.setPreference(this._db(), actor.id, input), payload: this.telemetry.describePayload(this._db(), 'standalone', actor.id) }; }
    catch (error) { fail(error.message, 400, 'INVALID_FEEDBACK_PREFERENCE'); }
  }
  recordFeedback(input, actor) {
    if (!actor?.id) fail('Authentication required', 401, 'AUTH_REQUIRED');
    try { return this.telemetry.record(this._db(), actor.id, input.eventKey, { outcome: input.outcome, providerType: input.providerType }); }
    catch (error) { fail(error.message, 400, 'INVALID_FEEDBACK_EVENT'); }
  }
  feedbackSummary(actor) {
    this._admin(actor); try { return this.telemetry.summary(this._db(), actor, 30); }
    catch (error) { fail(error.message, 403, 'ADMIN_REQUIRED'); }
  }
}

const service = new SelfServiceExperienceService();
module.exports = service;
module.exports.SelfServiceExperienceService = SelfServiceExperienceService;
module.exports.SelfServiceExperienceError = SelfServiceExperienceError;
module.exports._internals = { safeUrl, stable, digest, VERSION_GUIDANCE, PROVIDERS, ACTIONS };
