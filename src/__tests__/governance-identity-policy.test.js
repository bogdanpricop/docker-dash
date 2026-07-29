'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration125 = require('../db/migrations/125_governance_identity_policy');
const { GovernanceApprovalsService, ApprovalError, payloadHash } = require('../services/governance-approvals');
const { GovernanceCapacityService } = require('../services/governance-capacity');
const { IdentityGovernanceService } = require('../services/identity-governance');
const { ScimService } = require('../services/scim');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT,
      email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1,
      auth_source TEXT NOT NULL DEFAULT 'local', must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, token_hash TEXT, user_id INTEGER REFERENCES users(id), is_valid INTEGER DEFAULT 1,
      expires_at TEXT DEFAULT (datetime('now','+1 day')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT DEFAULT 'internal',
      usage_mode TEXT DEFAULT 'production', status TEXT DEFAULT 'active', is_default INTEGER DEFAULT 0, trial_expires_at TEXT,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_tenants (user_id INTEGER REFERENCES users(id), tenant_id INTEGER REFERENCES tenants(id), role TEXT DEFAULT 'viewer',
      is_owner INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE team_members (team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      is_leader INTEGER DEFAULT 0, added_by INTEGER, added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(team_id,user_id));
  `);
  db.prepare('INSERT INTO users (id,username,email,password_hash,role) VALUES (1,?,?,?,?)').run('admin', 'admin@example.com', 'x', 'admin');
  db.prepare('INSERT INTO users (id,username,email,password_hash,role) VALUES (2,?,?,?,?)').run('requester', 'user@example.com', 'x', 'viewer');
  db.prepare('INSERT INTO users (id,username,email,password_hash,role) VALUES (3,?,?,?,?)').run('approver', 'approver@example.com', 'x', 'operator');
  db.prepare("INSERT INTO tenants (id,slug,name,usage_mode) VALUES (1,'platform','Platform','production')").run();
  migration124.up(db);
  migration125.up(db);
  return db;
}

const users = {
  admin: { id: 1, username: 'admin', role: 'admin' },
  requester: { id: 2, username: 'requester', role: 'viewer' },
  approver: { id: 3, username: 'approver', role: 'operator' },
};

describe('v8.50 identity and policy governance', () => {
  let db;
  let approvals;
  let identity;
  let capacity;
  let scim;

  beforeEach(() => {
    db = database();
    approvals = new GovernanceApprovalsService(() => db);
    identity = new IdentityGovernanceService(() => db);
    capacity = new GovernanceCapacityService(() => db, approvals, { can: () => true });
    scim = new ScimService(() => db);
  });
  afterEach(() => db.close());

  test('migration adds the complete metric and permission catalogs', () => {
    expect(db.prepare('SELECT COUNT(*) c FROM governance_project_extended_quotas').get().c).toBe(0);
    expect(migration125._EXTENDED_METRICS).toEqual(expect.arrayContaining([
      'nic_count', 'public_ip_count', 'snapshot_count', 'backup_bytes', 'gpu_count', 'accelerator_seconds',
    ]));
    const permissions = db.prepare('SELECT permission_key FROM governance_permissions').all().map(row => row.permission_key);
    expect(permissions).toEqual(expect.arrayContaining(['quota.request', 'identity.manage', 'blackout.manage']));
  });

  test('two-person approvals bind canonical payload and are single-use', () => {
    approvals.savePolicy(null, { name: 'Production deploy', actionPattern: 'POST /api/deploy', environment: 'production',
      minimumRisk: 2, approvalsRequired: 2 }, users.admin);
    const request = approvals.createRequest({ actionKey: 'POST /api/deploy', environment: 'production', risk: 3,
      payload: { z: 1, a: 2 }, reason: 'release' }, users.requester);
    expect(request.payload_hash).toBe(payloadHash('POST /api/deploy', { a: 2, z: 1 }));
    expect(() => approvals.decide(request.id, 'approve', '', users.requester)).toThrow(ApprovalError);
    approvals.decide(request.id, 'approve', 'reviewed', users.admin);
    expect(approvals.getRequest(request.id).state).toBe('pending');
    approvals.decide(request.id, 'approve', 'reviewed twice', users.approver);
    const http = { method: 'POST', originalUrl: '/api/deploy', body: { a: 2, z: 1 }, query: {},
      headers: { 'x-dd-risk': '3', 'x-dd-approval-request': String(request.id) }, user: users.admin };
    expect(approvals.authorizeHttp(http)).toBe(request.id);
    approvals.finishHttpClaim(request.id, 500);
    expect(approvals.authorizeHttp(http)).toBe(request.id);
    approvals.finishHttpClaim(request.id, 201);
    expect(approvals.getRequest(request.id).state).toBe('consumed');
    expect(() => approvals.authorizeHttp(http)).toThrow(ApprovalError);
  });

  test('organization approval policies inherit into project-scoped mutations', () => {
    const projectScope = db.prepare("SELECT id FROM governance_scopes WHERE tenant_id=1 AND scope_type='project'").get().id;
    const policy = approvals.savePolicy(null, { name: 'Organization capacity', scopeId: 1,
      actionPattern: 'PUT /api/governance/controls/projects/*/capacity/quotas', environment: 'production',
      minimumRisk: 2, approvalsRequired: 1 }, users.admin);
    const request = approvals.createRequest({ actionKey: 'PUT /api/governance/controls/projects/1/capacity/quotas',
      environment: 'production', risk: 2, scopeId: projectScope, payload: { quotas: {} }, reason: 'capacity policy' }, users.requester);
    expect(request.policy_id).toBe(policy.id);
  });

  test('blackout denies mutations and records admin emergency exceptions', () => {
    approvals.saveBlackout(null, { name: 'Freeze', actionPattern: 'DELETE /api/*', environment: 'any',
      startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(),
      reason: 'quarter close', allowEmergencyOverride: true }, users.admin);
    const request = { method: 'DELETE', originalUrl: '/api/stacks/1', body: {}, query: {}, headers: {}, user: users.admin };
    expect(() => approvals.authorizeHttp(request)).toThrow(expect.objectContaining({ code: 'CHANGE_BLACKOUT', status: 423 }));
    request.headers = { 'x-dd-emergency-override': 'restore production', 'x-dd-emergency-ticket': 'INC-42' };
    expect(approvals.authorizeHttp(request)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM governance_blackout_exceptions').get().c).toBe(1);
  });

  test('network, backup and accelerator quotas enforce hard limits', () => {
    capacity.setQuotas(1, { public_ip_count: { softLimit: 1, hardLimit: 2 }, backup_bytes: { hardLimit: 1000 },
      gpu_count: { hardLimit: 1 } }, users.admin);
    capacity.assign(1, { metric: 'public_ip_count', amount: 2, resourceType: 'vm', resourceKey: 'web-1' }, users.admin);
    capacity.assign(1, { metric: 'backup_bytes', amount: 900, resourceType: 'backup', resourceKey: 'daily' }, users.admin);
    capacity.assign(1, { metric: 'gpu_count', amount: 1, resourceType: 'vm', resourceKey: 'ml-1', profile: 'A10' }, users.admin);
    expect(capacity.projectCapacity(1, users.admin).metrics.public_ip_count.usage).toBe(2);
    expect(() => capacity.assign(1, { metric: 'gpu_count', amount: 1, resourceType: 'vm', resourceKey: 'ml-2' }, users.admin))
      .toThrow(expect.objectContaining({ code: 'HARD_QUOTA_EXCEEDED' }));
  });

  test('quota requests become time-bound grants after distinct approvals', () => {
    const quota = capacity.requestQuota(1, { limits: { gpu_count: { softLimit: 2, hardLimit: 4 } },
      durationSeconds: 3600, reason: 'model training' }, users.requester);
    expect(quota.approval_state).toBe('pending');
    expect(() => approvals.decide(quota.approval_request_id, 'approve', '', users.requester)).toThrow(ApprovalError);
    approvals.decide(quota.approval_request_id, 'approve', '', users.admin);
    approvals.decide(quota.approval_request_id, 'approve', '', users.approver);
    const active = capacity.syncQuotaRequest(quota.approval_request_id);
    expect(active.state).toBe('active');
    expect(capacity.projectCapacity(1, users.admin).metrics.gpu_count).toMatchObject({ hardLimit: 4 });
  });

  test('domain routing, short-lived token rotation and revocation work', () => {
    identity.saveRealm(null, { slug: 'corp-oidc', name: 'Corporate', protocol: 'oidc', domains: ['Example.COM'],
      loginUrl: '/api/auth/oidc/login', issuerUrl: 'https://id.example.com/' }, users.admin);
    expect(identity.resolveRealm('person@example.com')).toMatchObject({ slug: 'corp-oidc', protocol: 'oidc' });
    const issued = identity.issueToken({ name: 'SCIM', principal: 'idp:scim', scopes: ['scim.read', 'scim.write'], ttlSeconds: 600 }, users.admin);
    expect(issued.token).toMatch(/^ddst_/);
    expect(identity.validateToken(issued.token)).toMatchObject({ serviceToken: true, scopes: ['scim.read', 'scim.write'] });
    const rotated = identity.rotateToken(issued.id, { ttlSeconds: 600 }, users.admin);
    expect(identity.validateToken(issued.token)).toBeNull();
    identity.revokeToken(rotated.id, users.admin);
    expect(identity.validateToken(rotated.token)).toBeNull();
  });

  test('signed workload assertions exchange once and reject replay', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'key-1'; jwk.use = 'sig';
    identity.saveTrust(null, { name: 'CI', issuer: 'https://ci.example.com', audience: 'docker-dash',
      subjectPattern: 'repo:org/*', identityKind: 'oidc', jwks: { keys: [jwk] }, scopes: ['api.read'], tokenTtlSeconds: 300 }, users.admin);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: 'https://ci.example.com', aud: 'docker-dash', sub: 'repo:org/app', iat: now, exp: now + 300, jti: 'run-1' })).toString('base64url');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
    const assertion = `${header}.${claims}.${signature}`;
    expect(identity.exchange(assertion)).toMatchObject({ tokenType: 'Bearer', scopes: ['api.read'] });
    expect(() => identity.exchange(assertion)).toThrow(expect.objectContaining({ code: 'ASSERTION_REPLAY' }));
  });

  test.each([
    ['ES256', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }), (data, key) => crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })],
    ['EdDSA', () => crypto.generateKeyPairSync('ed25519'), (data, key) => crypto.sign(null, data, key)],
  ])('workload exchange verifies %s public JWK signatures', (algorithm, keyFactory, signer) => {
    const { publicKey, privateKey } = keyFactory();
    const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = algorithm; jwk.use = 'sig';
    identity.saveTrust(null, { name: algorithm, issuer: `https://${algorithm.toLowerCase()}.example.com`, audience: 'docker-dash',
      subjectPattern: 'spiffe://cluster/*', identityKind: 'spiffe', jwks: { keys: [jwk] }, scopes: ['api.read'] }, users.admin);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: algorithm })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: `https://${algorithm.toLowerCase()}.example.com`, aud: 'docker-dash',
      sub: 'spiffe://cluster/worker', iat: now, exp: now + 300 })).toString('base64url');
    const signature = signer(Buffer.from(`${header}.${claims}`), privateKey).toString('base64url');
    expect(identity.exchange(`${header}.${claims}.${signature}`).accessToken).toMatch(/^ddst_/);
  });

  test('SCIM provisions users and groups and deactivation invalidates sessions', () => {
    const user = scim.createUser({ userName: 'scim.user', displayName: 'SCIM User', externalId: 'ext-user-1',
      active: true, emails: [{ value: 'scim@example.com', primary: true }] });
    const group = scim.createGroup({ displayName: 'SCIM Operators', externalId: 'ext-group-1', members: [{ value: user.id }] });
    expect(group.members).toEqual([expect.objectContaining({ value: user.id })]);
    db.prepare('INSERT INTO sessions (id,token_hash,user_id,is_valid) VALUES (1,?,?,1)').run('hash', Number(user.id));
    expect(scim.patchUser(user.id, { Operations: [{ op: 'replace', path: 'active', value: false }] }).active).toBe(false);
    expect(db.prepare('SELECT is_valid FROM sessions WHERE id=1').get().is_valid).toBe(0);
    expect(scim.listUsers({ filter: 'externalId eq "ext-user-1"' }).totalResults).toBe(1);
    expect(scim.deleteGroup(group.id)).toEqual({ deleted: true });
  });
});
