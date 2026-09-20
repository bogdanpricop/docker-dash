'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'oidc-flow-fixture', ENCRYPTION_KEY: 'oidc-flow-encryption-fixture-32ch' });
const crypto = require('crypto'), express = require('express'), request = require('supertest');
const config = require('../config'), { getDb, closeDb } = require('../db');
const router = require('../routes/auth'), internals = router._oidcCacheInternals;
const app = express(); app.use(require('cookie-parser')()); app.use('/api/auth', router);
const issuer = 'https://identity.example.test', clientId = 'fixture-client';
const discovery = { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', userinfo_endpoint: issuer + '/userinfo' };
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256' };
let db, fetcher, claims, tokenBody, userInfo, exchangeBody;
const originalOidc = { ...config.oidc }, originalSecurity = config.security.isStrict, originalCookie = config.session.secureCookie;
function sign(payload) {
  const message = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  return message + '.' + crypto.sign('SHA256', Buffer.from(message), keys.privateKey).toString('base64url');
}
beforeAll(() => { db = getDb(); db.exec("CREATE TABLE IF NOT EXISTS oidc_states(state TEXT PRIMARY KEY,created_at TEXT DEFAULT (datetime('now')),expires_at TEXT NOT NULL)"); });
beforeEach(() => {
  Object.assign(config.oidc, { enabled: true, issuerUrl: issuer, clientId, clientSecret: 'fixture-secret', redirectUri: 'http://localhost/api/auth/oidc/callback', defaultRole: 'viewer', groupClaim:'groups', adminGroups: [], operatorGroups: [], viewerGroups: [] });
  config.security.isStrict = false; config.session.secureCookie = false;
  db.exec("DELETE FROM sessions; DELETE FROM oidc_states; UPDATE users SET role='viewer' WHERE username='oidc-flow-fixture'");
  claims = {}; tokenBody = null; exchangeBody = null; userInfo = { sub: 'fixture-subject', email: 'fixture@example.test' };
  internals.clear();
  fetcher = jest.fn(async (url, opts) => {
    if (url.endsWith('/.well-known/openid-configuration')) return { status: 200, body: discovery };
    if (url === discovery.jwks_uri) return { status: 200, body: { keys: [jwk] } };
    if (url === discovery.token_endpoint) { exchangeBody = new URLSearchParams(opts.body); return { status: 200, body: tokenBody || { access_token: 'fixture-access', id_token: sign(claims) } }; }
    if (url === discovery.userinfo_endpoint) return { status: 200, body: userInfo };
    throw new Error('Unexpected fixture request');
  });
  internals.setFetcher(fetcher);
});
afterAll(() => { Object.assign(config.oidc, originalOidc); config.security.isStrict = originalSecurity; config.session.secureCookie = originalCookie; internals.clear(); internals.resetFetcher(); closeDb(); });
async function start() {
  const response = await request(app).get('/api/auth/oidc/login'); expect(response.status).toBe(200);
  const params = new URL(response.body.url).searchParams;
  claims = { iss: issuer, aud: clientId, sub: 'fixture-subject', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, nonce: params.get('nonce'), email: 'fixture@example.test', preferred_username: 'oidc-flow-fixture' };
  return { params, cookie: response.headers['set-cookie']?.[0]?.split(';')[0], response };
}
function callback(flow, cookie = flow.cookie, extra = {}) {
  const req = request(app).get('/api/auth/oidc/callback').query({ state: flow.params.get('state'), code: 'fixture-code', ...extra });
  return cookie ? req.set('Cookie', cookie) : req;
}
function noSession() { expect(db.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(0); }
test('foreign browser cannot consume a valid state or contact the provider', async () => {
  const flow = await start(); fetcher.mockClear();
  expect((await callback(flow, null)).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) n FROM oidc_states').get().n).toBe(1); noSession();
});
test('another login cookie cannot redeem the first browser state', async () => {
  const first = await start(), second = await start(); fetcher.mockClear();
  expect((await callback(first, second.cookie)).status).toBe(400); expect(fetcher).not.toHaveBeenCalled(); noSession();
});
test('login uses a private short-lived cookie, S256 PKCE and a unique nonce', async () => {
  const first = await start(), second = await start();
  const header = first.response.headers['set-cookie'][0];
  expect(header).toMatch(/HttpOnly/); expect(header).toMatch(/SameSite=Lax/); expect(header).toMatch(/Max-Age=300/); expect(header).not.toMatch(/Domain=/);
  expect(first.params.get('code_challenge_method')).toBe('S256');
  expect(first.params.get('nonce')).toMatch(/^[a-f0-9]{64}$/); expect(first.params.get('nonce')).not.toBe(second.params.get('nonce'));
  expect(first.response.headers['cache-control']).toBe('no-store');
});
test('matching browser completes login once and sends the correct PKCE verifier', async () => {
  const flow = await start(), result = await callback(flow);
  expect(result.status).toBe(302); expect(result.headers.location).toBe('/');
  expect(crypto.createHash('sha256').update(exchangeBody.get('code_verifier')).digest('base64url')).toBe(flow.params.get('code_challenge'));
  expect(db.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(1);
  expect(result.headers['set-cookie'].some(c => c.startsWith('dd_oidc_flow=;'))).toBe(true);
  fetcher.mockClear(); expect((await callback(flow)).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
});
test.each(['missing', 'wrong'])('a %s nonce cannot fall back to userinfo', async kind => {
  const flow = await start(); if (kind === 'missing') delete claims.nonce; else claims.nonce = 'wrong';
  expect((await callback(flow)).status).toBe(401);
  expect(fetcher.mock.calls.some(([url]) => url === discovery.userinfo_endpoint)).toBe(false); noSession();
});
test.each(['missing', 'malformed', 'signature'])('a %s ID token cannot fall back to userinfo', async kind => {
  const flow = await start(); tokenBody = { access_token: 'fixture-access' };
  if (kind === 'malformed') tokenBody.id_token = 'bad';
  if (kind === 'signature') tokenBody.id_token = sign(claims).replace(/.$/, 'x').split('.').slice(0,2).join('.') + '.AAAA';
  expect((await callback(flow)).status).toBe(401); noSession();
  expect(fetcher.mock.calls.some(([url]) => url === discovery.userinfo_endpoint)).toBe(false);
});
test.each([{ exp: 'tomorrow' }, { exp: null }, { nbf: 'yesterday' }, { iat: null }, { sub: '' }, { aud: [clientId,'other'] }, { azp: 'other' }])('rejects invalid signed claims %j', async invalid => {
  const flow = await start(); Object.assign(claims, invalid);
  expect((await callback(flow)).status).toBe(401); noSession();
});
test('userinfo for another subject is rejected', async () => {
  const flow = await start(); delete claims.email; userInfo.sub = 'other-subject';
  expect((await callback(flow)).status).toBe(401); noSession();
});
test('matching userinfo cannot override verified role claims', async () => {
  config.oidc.adminGroups = ['admins']; const flow = await start(); delete claims.email; claims.groups = [];
  userInfo.groups = ['admins']; userInfo.preferred_username = 'oidc-flow-fixture';
  expect((await callback(flow)).status).toBe(302);
  expect(db.prepare("SELECT role FROM users WHERE username='oidc-flow-fixture'").get().role).toBe('viewer');
});
test('provider error consumes bound state and returns only fixed text', async () => {
  const flow = await start(); fetcher.mockClear();
  const result = await callback(flow, flow.cookie, { error: '<script>fixture</script>' });
  expect(result.status).toBe(400); expect(result.text).toBe('OIDC authorization failed');
  expect(db.prepare('SELECT COUNT(*) n FROM oidc_states').get().n).toBe(0); expect(fetcher).not.toHaveBeenCalled();
});
test.each(['expired', 'malformed'])('a bound browser cannot redeem %s state', async kind => {
  const flow = await start(); db.prepare('UPDATE oidc_states SET expires_at=?').run(kind === 'expired' ? new Date(Date.now()-1000).toISOString() : 'invalid');
  fetcher.mockClear(); expect((await callback(flow)).status).toBe(400); expect(fetcher).not.toHaveBeenCalled(); noSession();
});
test('a state is consumed before provider failure and errors do not disclose details', async () => {
  const flow = await start(); fetcher.mockImplementation(async () => { throw new Error('fixture-private-token'); });
  const result = await callback(flow); expect(result.status).toBe(500); expect(result.text).toBe('OIDC callback failed');
  expect((await callback(flow)).status).toBe(400); expect(fetcher).toHaveBeenCalledTimes(2); noSession();
});
test('a callback cannot redeem state after provider configuration changes', async () => {
  const flow = await start(); config.oidc.clientId = 'other-client'; fetcher.mockClear();
  expect((await callback(flow)).status).toBe(400); expect(fetcher).not.toHaveBeenCalled(); noSession();
});
test('concurrent matching callbacks create only one session', async () => {
  const flow = await start(); const results = await Promise.all([callback(flow), callback(flow)]);
  expect(results.map(r => r.status).sort()).toEqual([302,400]);
  expect(db.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(1);
  expect(fetcher.mock.calls.filter(([url]) => url === discovery.token_endpoint)).toHaveLength(1);
});
test('OIDC profile collision cannot authenticate the existing local administrator', async () => {
  const id=Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES ('oidc-local-owner','fixture-hash','admin')").run().lastInsertRowid);
  const flow=await start(); claims.sub='local-collision-subject'; claims.preferred_username='oidc-local-owner';
  expect((await callback(flow)).status).toBe(302);
  const session=db.prepare('SELECT user_id FROM sessions').get(); expect(session.user_id).not.toBe(id);
  expect(db.prepare('SELECT role FROM users WHERE id=?').get(session.user_id).role).toBe('viewer');
});
test('failed login audit leaves neither a session nor a newly provisioned identity', async () => {
  const flow=await start(); claims.sub='failed-audit-subject'; claims.preferred_username='oidc-audit-rollback';
  db.exec("CREATE TEMP TRIGGER fail_oidc_audit BEFORE INSERT ON audit_log WHEN NEW.action='oidc_login' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  try {
    expect((await callback(flow)).status).toBe(500); noSession();
    expect(db.prepare("SELECT id FROM users WHERE external_subject='failed-audit-subject'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM audit_log WHERE username='oidc-audit-rollback'").get()).toBeUndefined();
  } finally { db.exec('DROP TRIGGER fail_oidc_audit'); }
});
async function loginMappedAdmin() {
  config.oidc.adminGroups=['admins'];
  const flow=await start(); claims.groups=['admins'];
  expect((await callback(flow)).status).toBe(302);
  const auth=require('../services/auth'), {apiKeys}=require('../services/misc');
  const user=db.prepare("SELECT id,username,role FROM users WHERE external_source='oidc' AND external_subject='fixture-subject'").get();
  const session=auth._createSession(user,'127.0.0.1','fixture');
  const key=apiKeys.create(user.id,{name:'oidc-policy-fixture',permissions:['read','write']}).key;
  return {auth,apiKeys,user,session,key};
}
test('empty group list demotes an existing administrator and revokes old credentials', async () => {
  const prior=await loginMappedAdmin(), flow=await start(); claims.groups=[];
  expect((await callback(flow)).status).toBe(302);
  expect(db.prepare('SELECT role FROM users WHERE id=?').get(prior.user.id).role).toBe('viewer');
  expect(prior.auth.validateSession(prior.session.token)).toBeNull(); expect(prior.apiKeys.validate(prior.key)).toBeNull();
  expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE is_valid=1').get().n).toBe(1);
});
test('authorization checks the current role after acquiring its write transaction', async () => {
  const prior=await loginMappedAdmin(), flow=await start(); claims.groups=[];
  db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(prior.user.id);
  const transaction=db.transaction.bind(db); let interleaved=false;
  const hook=jest.spyOn(db,'transaction').mockImplementation(fn=>{
    const tx=transaction(fn);
    return Object.assign((...args)=>tx(...args),{immediate:(...args)=>{
      if(!interleaved) {
        expect(db.inTransaction).toBe(false); interleaved=true;
        // Model another connection committing immediately before BEGIN IMMEDIATE.
        db.prepare("UPDATE users SET role='admin' WHERE id=?").run(prior.user.id);
      }
      return tx.immediate(...args);
    },deferred:tx.deferred,exclusive:tx.exclusive});
  });
  try {
    expect((await callback(flow)).status).toBe(302); expect(interleaved).toBe(true);
    expect(db.prepare('SELECT role FROM users WHERE id=?').get(prior.user.id).role).toBe('viewer');
    expect(prior.auth.validateSession(prior.session.token)).toBeNull(); expect(prior.apiKeys.validate(prior.key)).toBeNull();
  } finally {hook.mockRestore();}
});
test.each(['missing','null','mixed','object','overage','hasgroups'])('unusable groups (%s) deny login and revoke the bound user credentials', async kind => {
  const prior=await loginMappedAdmin(), flow=await start();
  if(kind==='null') claims.groups=null;
  if(kind==='mixed') claims.groups=['admins',42];
  if(kind==='object') claims.groups={admin:true};
  if(kind==='overage') {claims.groups=['admins'];claims._claim_names={groups:'src1'};}
  if(kind==='hasgroups') claims.hasgroups=true;
  expect((await callback(flow)).status).toBe(403);
  expect(prior.auth.validateSession(prior.session.token)).toBeNull(); expect(prior.apiKeys.validate(prior.key)).toBeNull();
  expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE is_valid=1').get().n).toBe(0);
  const recovered=await start(); claims.groups=['admins'];
  expect((await callback(recovered)).status).toBe(302);
  expect(prior.apiKeys.validate(prior.key)).toBeNull(); expect(prior.auth.validateSession(prior.session.token)).toBeNull();
});
test('missing mapped groups never auto-provision a user', async () => {
  config.oidc.adminGroups=['admins']; const flow=await start(); claims.sub='missing-groups-new-user'; claims.preferred_username='missing-groups-new-user';
  expect((await callback(flow)).status).toBe(403);
  expect(db.prepare("SELECT id FROM users WHERE external_subject='missing-groups-new-user'").get()).toBeUndefined();
});
test('mapping disabled preserves an explicitly assigned role without requiring groups', async () => {
  const prior=await loginMappedAdmin(); config.oidc.adminGroups=[];
  const flow=await start(); expect((await callback(flow)).status).toBe(302);
  expect(db.prepare('SELECT role FROM users WHERE id=?').get(prior.user.id).role).toBe('admin');
});
test.each(['denial','demotion','revocation-audit','login-audit'])('audit failure during %s cannot restore previously revoked credentials', async kind => {
  const prior=await loginMappedAdmin(), flow=await start(); if(kind!=='denial') claims.groups=[];
  const action=({denial:'oidc_authorization_denied',demotion:'sso_role_updated','revocation-audit':'oidc_authorization_changed','login-audit':'oidc_login'})[kind];
  db.exec(`CREATE TEMP TRIGGER fail_authorization_audit BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END`);
  try {
    expect((await callback(flow)).status).toBe(500);
    expect(prior.auth.validateSession(prior.session.token)).toBeNull(); expect(prior.apiKeys.validate(prior.key)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE is_valid=1').get().n).toBe(0);
  } finally {db.exec('DROP TRIGGER fail_authorization_audit');}
});
test('secure deployments use a Host-prefixed cookie without trusting arbitrary forwarded headers', async () => {
  config.session.secureCookie = true;
  expect((await start()).response.headers['set-cookie'][0]).toMatch(/^__Host-dd_oidc_flow=.*; Path=\/; .*HttpOnly; Secure; SameSite=Lax$/);
  config.session.secureCookie = false;
  const result = await request(app).get('/api/auth/oidc/login').set('X-Forwarded-Proto','https');
  expect(result.headers['set-cookie'][0]).toMatch(/^dd_oidc_flow=/); expect(result.headers['set-cookie'][0]).not.toMatch(/; Secure/);
});
