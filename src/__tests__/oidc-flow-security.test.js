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
  Object.assign(config.oidc, { enabled: true, issuerUrl: issuer, clientId, clientSecret: 'fixture-secret', redirectUri: 'http://localhost/api/auth/oidc/callback', defaultRole: 'viewer', adminGroups: [], operatorGroups: [], viewerGroups: [] });
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
test('secure deployments use a Host-prefixed cookie without trusting arbitrary forwarded headers', async () => {
  config.session.secureCookie = true;
  expect((await start()).response.headers['set-cookie'][0]).toMatch(/^__Host-dd_oidc_flow=.*; Path=\/; .*HttpOnly; Secure; SameSite=Lax$/);
  config.session.secureCookie = false;
  const result = await request(app).get('/api/auth/oidc/login').set('X-Forwarded-Proto','https');
  expect(result.headers['set-cookie'][0]).toMatch(/^dd_oidc_flow=/); expect(result.headers['set-cookie'][0]).not.toMatch(/; Secure/);
});
