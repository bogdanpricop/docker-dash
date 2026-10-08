'use strict';

jest.mock('../services/teams', () => ({ teamsForUser: () => [] }));

const Database = require('better-sqlite3');
const migration004 = require('../db/migrations/004_alerts');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration125 = require('../db/migrations/125_governance_identity_policy');
const migration142 = require('../db/migrations/142_self_service_portal');
const migration143 = require('../db/migrations/143_self_service_experience');
const { GovernanceService } = require('../services/governance');
const { GovernanceApprovalsService } = require('../services/governance-approvals');
const { GovernanceCapacityService } = require('../services/governance-capacity');
const { SelfServiceService } = require('../services/self-service');
const { SelfServiceExperienceService } = require('../services/self-service-experience');
const telemetry = require('../services/telemetry');
const i18nGate = require('../../scripts/validate-self-service-i18n');
const a11yGate = require('../../scripts/validate-self-service-a11y');

const admin = { id: 1, username: 'admin', role: 'admin' };
const requester = { id: 2, username: 'requester', role: 'viewer' };

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT,
      email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1,
      auth_source TEXT NOT NULL DEFAULT 'local', must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT DEFAULT 'internal',
      usage_mode TEXT DEFAULT 'nonproduction', status TEXT DEFAULT 'active', is_default INTEGER DEFAULT 0, trial_expires_at TEXT,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_tenants (user_id INTEGER REFERENCES users(id), tenant_id INTEGER REFERENCES tenants(id), role TEXT DEFAULT 'viewer',
      is_owner INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE team_members (team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      is_leader INTEGER DEFAULT 0, added_by INTEGER, added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(team_id,user_id));
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, is_active INTEGER DEFAULT 1);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO users (id,username,email,password_hash,role) VALUES
      (1,'admin','admin@example.test','x','admin'),(2,'requester','requester@example.test','x','viewer');
    INSERT INTO tenants (id,slug,name,usage_mode,status) VALUES (1,'payments','Payments','nonproduction','active');
    INSERT INTO user_tenants (user_id,tenant_id,role,is_owner) VALUES (2,1,'admin',0);
    INSERT INTO docker_hosts (id,name,daemon_type,is_active) VALUES (7,'pve-a','proxmox',1);
  `);
  migration004.up(db); migration124.up(db); migration125.up(db); migration142.up(db); migration143.up(db);
  db.prepare(`INSERT INTO governance_project_resources
    (tenant_id,provider_host_id,resource_type,resource_key,display_name,cpu_millicores,memory_bytes,storage_bytes,metadata_json,assigned_by)
    VALUES (1,7,'virtualMachine',?,'payments-01',2000,4294967296,42949672960,'{}',1)`).run(`ddr_vm_${'a'.repeat(26)}`);
  return db;
}

function services(db) {
  const governance = new GovernanceService(() => db); const approvals = new GovernanceApprovalsService(() => db);
  const selfService = new SelfServiceService({ dbProvider: () => db, governance, approvals, operations: { get: () => null } });
  return { governance, approvals, selfService, capacity: new GovernanceCapacityService(() => db, approvals, governance),
    experience: new SelfServiceExperienceService({ dbProvider: () => db, governance, selfService, telemetry }) };
}

function seedRequest(db, state = 'failed') {
  const result = db.prepare(`INSERT INTO self_service_requests
    (request_key,tenant_id,request_kind,action_key,request_json,normalized_diff_json,cost_preview_json,hidden_target_json,
     risk,state,requested_by,expires_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(`ssr_${state}_${Date.now()}_${Math.random()}`, 1, 'lifecycle', 'reboot', '{}', '{}', '{}', '{}', 2, state, 2, new Date(Date.now() + 86400000).toISOString());
  const id = Number(result.lastInsertRowid);
  db.prepare(`INSERT INTO self_service_request_events (request_id,sequence,state,event_type,message,evidence_json,actor_id)
    VALUES (?,1,?,'requested','Request evidence','{"providerType":"proxmox","secret":"excluded"}',2)`).run(id, state);
  return id;
}

describe('v8.69 self-service experience (B366-B375)', () => {
  let db; let experience; let capacity; let approvals;
  beforeEach(() => { db = database(); ({ experience, capacity, approvals } = services(db)); });
  afterEach(() => db.close());

  test('B366 quota increase is approval-bound, time-bound and automatically active only after approval', () => {
    const request = capacity.requestQuota(1, { limits: { cpu_millicores: { softLimit: 3000, hardLimit: 4000 } },
      durationSeconds: 3600, reason: 'temporary load test' }, requester);
    expect(request).toMatchObject({ state: 'pending', duration_seconds: 3600, approval_state: 'pending' });
    approvals.decide(request.approval_request_id, 'approve', 'capacity reviewed', admin);
    const active = capacity.syncQuotaRequest(request.approval_request_id);
    expect(active.state).toBe('active');
    expect(new Date(active.effective_until).getTime()).toBeGreaterThan(Date.now());
  });

  test('B367 project branding inherits safely and rejects insecure external URLs', () => {
    expect(experience.saveBranding({ displayName: 'All4Labels Cloud', accentColor: '#123abc', logoUrl: '/assets/logo.svg',
      helpUrl: 'https://help.example.test/portal' }, admin).branding).toMatchObject({ scope: 'organization', displayName: 'All4Labels Cloud' });
    expect(experience.getBranding(1, requester).branding).toMatchObject({ inherited: true, accentColor: '#123abc' });
    expect(() => experience.saveBranding({ displayName: 'Unsafe', logoUrl: 'http://example.test/logo.png' }, admin)).toThrow(expect.objectContaining({ code: 'UNSAFE_URL' }));
  });

  test('B368 contextual help is provider, reported-version and action specific', () => {
    const help = experience.contextualHelp({ projectId: 1, providerType: 'proxmox', providerVersion: '8.3.2', action: 'reboot' }, requester);
    expect(help.context).toMatchObject({ providerType: 'proxmox', providerVersion: '8.3.2', action: 'power',
      versionGuidance: { testedFamily: '8.x/9.x', evaluatedVersion: '8.3.2' } });
    expect(help.topics).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'proxmox-vm-power', caveats: expect.any(Array), nextSafeTest: expect.any(String) })]));
  });

  test('B369 troubleshooting persists a hash-bound support bundle without request values, refs or raw errors', () => {
    const requestId = seedRequest(db, 'failed'); const session = experience.troubleshoot(requestId, requester).session;
    expect(session.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.nextSafeTest).toMatchObject({ mutating: false, kind: 'read_only_preflight' });
    expect(session.supportBundle.exclusions).toEqual(expect.arrayContaining([
      'request values', 'resource references', 'credentials', 'error text', 'stack traces',
    ]));
    expect(JSON.stringify({ request: session.supportBundle.request, timeline: session.supportBundle.timeline,
      operation: session.supportBundle.operation })).not.toMatch(/secret|resource_ref|request_json/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM self_service_troubleshooting_sessions').get().count).toBe(1);
  });

  test('B370 recommendations expose reason, evidence, confidence, impact and undo without executing', () => {
    db.prepare("INSERT INTO governance_project_quotas (tenant_id,metric,soft_limit,hard_limit) VALUES (1,'cpu_millicores',1000,10000)").run();
    const result = experience.recommendations(1, requester); const item = result.recommendations.find(entry => entry.key === 'quota-cpu_millicores');
    expect(result.advisoryOnly).toBe(true);
    expect(item).toMatchObject({ reason: expect.any(String), evidence: expect.any(Array), evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      confidence: { score: expect.any(Number), basis: expect.any(String) }, impact: expect.any(String), undo: expect.any(String), action: { mutating: false } });
  });

  test('B371 VM operation UI has semantic keyboard navigation and guarded button actions', () => {
    expect(a11yGate.validate()).toMatchObject({ uiChecks: 8, cssChecks: 5 });
  });

  test('B372 mobile incident view offers acknowledge/pause only and never destructive defaults', () => {
    const id = seedRequest(db, 'running'); const list = experience.listIncidents(requester);
    expect(list).toMatchObject({ safeActions: ['acknowledge', 'pause_notifications'], destructiveDefaults: false });
    expect(list.incidents.find(item => item.sourceId === id).destructiveActions).toEqual([]);
    expect(experience.updateIncident(`request:${id}`, { action: 'pause_notifications', minutes: 30 }, requester))
      .toMatchObject({ action: 'pause_notifications', infrastructureMutated: false, incident: { pausedUntil: expect.any(String) } });
  });

  test('B373 localization gate covers provider, action and safety copy in all 11 languages', () => {
    expect(i18nGate.validate()).toMatchObject({ languages: expect.arrayContaining(['en', 'ro', 'de', 'ja', 'ko', 'zh']), requiredKeys: 19, checkedValues: 209 });
  });

  test('B374 accessibility conformance pack covers focus, contrast, labels, live regions, motion and mobile targets', () => {
    const result = a11yGate.validate(); expect(result.uiChecks + result.cssChecks).toBe(13);
  });

  test('B375 feedback is off by default and records only allowlisted anonymous local aggregates after opt-in', () => {
    expect(experience.recordFeedback({ eventKey: 'catalog.view' }, requester)).toEqual({ recorded: false, reason: 'opt_in_required' });
    const preference = experience.saveFeedbackPreference({ enabled: true, usageEnabled: true, failureEnabled: true }, requester);
    expect(preference).toMatchObject({ preference: { enabled: true }, payload: { networkTransmission: false, excluded: expect.arrayContaining(['username', 'ip']) } });
    expect(experience.recordFeedback({ eventKey: 'catalog.view', outcome: 'success', providerType: 'proxmox' }, requester)).toMatchObject({ recorded: true });
    expect(db.prepare('SELECT event_key,outcome,provider_type,event_count FROM product_feedback_daily').get())
      .toEqual({ event_key: 'catalog.view', outcome: 'success', provider_type: 'proxmox', event_count: 1 });
  });
});
