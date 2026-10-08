'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'expiry-fixture-secret', ENCRYPTION_KEY: 'expiry-fixture-encryption-key-32c' });
jest.mock('../services/cluster', () => ({ rateLimitTick: jest.fn(async () => ({ allowed: true, remaining: 4 })) }));
const { getDb, closeDb } = require('../db'), auth = require('../services/auth');
const { sha256, encrypt, decrypt } = require('../utils/crypto'), totp = require('../utils/totp');
const config = require('../config'), express = require('express'), request = require('supertest');
const originalIssuer=config.oidc.issuerUrl;
const router = require('../routes/auth'), app = express(); app.use(express.json()); app.use(require('cookie-parser')()); app.use('/api/auth', router);
let db, userId;
const secret = 'JBSWY3DPEHPK3PXP', recovery = 'fixture-recovery';
const expired = () => new Date(Date.now() - 1000).toISOString();
const future = () => new Date(Date.now() + 60000).toISOString();
beforeAll(() => {
  db = getDb(); userId = Number(db.prepare("INSERT INTO users(username,password_hash,role,is_active,totp_enabled,totp_secret,recovery_codes) VALUES ('expiry-fixture','fixture-hash','viewer',1,1,?,?)")
    .run(encrypt(secret), encrypt(JSON.stringify([recovery]))).lastInsertRowid);
  db.exec('CREATE TABLE IF NOT EXISTS oidc_states(state TEXT PRIMARY KEY,expires_at TEXT NOT NULL)');
});
beforeEach(() => {
  config.oidc.issuerUrl='https://identity.example.test';
  db.exec('DELETE FROM sessions; DELETE FROM mfa_tokens; DELETE FROM login_attempts; DELETE FROM oidc_states');
  db.prepare('UPDATE users SET recovery_codes=?,totp_last_counter=NULL,mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=?').run(encrypt(JSON.stringify([recovery])),userId);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => { config.oidc.issuerUrl=originalIssuer;closeDb(); });
function session(expiry) { const value = require('crypto').randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha256(value),userId,expiry); return value; }
function mfa(expiry) { const value = require('crypto').randomBytes(32).toString('hex'); db.prepare('INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha256(value),userId,expiry); return value; }
async function oidcFlow() {
  router._oidcCacheInternals.clear();
  const issuer=config.oidc.issuerUrl.replace(/\/$/,'');
  router._oidcCacheInternals.setFetcher(async () => ({ status: 200, body: { issuer, authorization_endpoint: issuer+'/authorize', token_endpoint: issuer+'/token', jwks_uri: issuer+'/keys' } }));
  const response = await request(app).get('/api/auth/oidc/login'); expect(response.status).toBe(200);
  router._oidcCacheInternals.clear();
  return { state: new URL(response.body.url).searchParams.get('state'), cookie: response.headers['set-cookie'][0].split(';')[0] };
}

test('a session expired earlier today is rejected by service and real HTTP authentication', async () => {
  const raw = session(expired());
  expect(auth.validateSession(raw)).toBeNull();
  expect((await request(app).get('/api/auth/me').set('Authorization', 'Bearer ' + raw)).status).toBe(401);
});

test.each(['not-a-date', '9999-invalid'])('malformed session expiry is rejected (%s)', expiry => {
  expect(auth.validateSession(session(expiry))).toBeNull();
});

test.each(['totp', 'recovery'])('expired MFA challenge cannot issue a session with a valid %s factor', kind => {
  const raw = mfa(expired());
  const result = kind === 'totp' ? auth.verifyMfa(raw,totp.generateTOTP(secret),'192.0.2.1','fixture') : auth.verifyMfaRecovery(raw,recovery,'192.0.2.1','fixture');
  expect(result.error).toBe('Invalid or expired MFA token');
  expect(db.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(0);
});

test('login lockout counts production logAttempt timestamps', () => {
  for (let n=0;n<config.rateLimit.loginMaxAttempts;n++) auth.logAttempt('192.0.2.2','fixture',userId,false,'fixture');
  expect(auth.isIpLocked('192.0.2.2')).toBe(true);
  db.prepare("UPDATE login_attempts SET attempted_at=datetime('now','-1 day')").run();
  expect(auth.isIpLocked('192.0.2.2')).toBe(false);
});

test('cleanup removes expired and malformed sessions/MFA while retaining future timestamps in both formats', () => {
  for (const create of [session,mfa]) {
    create(expired()); create('invalid'); create(future());
    create(db.prepare("SELECT datetime('now','+1 minute') value").get().value);
  }
  auth.cleanSessions(); auth.cleanMfaTokens();
  expect(db.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(2);
  expect(db.prepare('SELECT COUNT(*) n FROM mfa_tokens').get().n).toBe(2);
});

test('expired OIDC state is rejected before discovering provider endpoints', async () => {
  const prior = config.oidc.enabled; config.oidc.enabled = true;
  const flow = await oidcFlow();
  const fetcher = jest.fn(async () => { throw new Error('Provider request should not happen'); });
  router._oidcCacheInternals.setFetcher(fetcher);
  db.prepare('UPDATE oidc_states SET expires_at=? WHERE state=?').run(expired(),flow.state);
  try {
    const response = await request(app).get('/api/auth/oidc/callback').query({ state: flow.state, code: 'fixture' }).set('Cookie',flow.cookie);
    expect(response.status).toBe(400); expect(response.text).toBe('Invalid or expired state parameter');
    expect(fetcher).not.toHaveBeenCalled();
  } finally { config.oidc.enabled = prior; router._oidcCacheInternals.resetFetcher(); }
});

test.each(['totp', 'recovery'])('%s challenge and recovery state roll back when session insertion fails', kind => {
  const raw = mfa(future());
  db.exec("CREATE TEMP TRIGGER fail_session_insert BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  try {
    expect(() => kind === 'totp' ? auth.verifyMfa(raw,totp.generateTOTP(secret),'192.0.2.1','fixture') : auth.verifyMfaRecovery(raw,recovery,'192.0.2.1','fixture'))
      .toThrow('fixture storage failure');
    expect(db.prepare('SELECT used FROM mfa_tokens').get().used).toBe(0);
    expect(JSON.parse(decrypt(db.prepare('SELECT recovery_codes FROM users WHERE id=?').get(userId).recovery_codes))).toEqual([recovery]);
  } finally { db.exec('DROP TRIGGER fail_session_insert'); }
});

test.each(['totp', 'recovery'])('a current %s challenge creates one session and refuses reuse', kind => {
  const raw = mfa(future());
  const redeem = () => kind === 'totp' ? auth.verifyMfa(raw,totp.generateTOTP(secret),'192.0.2.1','fixture') : auth.verifyMfaRecovery(raw,recovery,'192.0.2.1','fixture');
  expect(redeem().token).toBeDefined(); expect(redeem().error).toBe('Invalid or expired MFA token');
  expect(db.prepare('SELECT COUNT(*) n FROM sessions').get().n).toBe(1);
});

test.each(['iso', 'sqlite'])('future %s session timestamps remain accepted', format => {
  const expiry = format === 'iso' ? future() : db.prepare("SELECT datetime('now','+1 minute') value").get().value;
  expect(auth.validateSession(session(expiry)).id).toBe(userId);
});

test('windowed security alerts count actual production login timestamps and mixed audit formats', () => {
  const alerts = require('../services/securityAlerts'); alerts._cooldowns.clear();
  const notify = jest.spyOn(alerts,'_recordAndNotify').mockImplementation(() => {});
  auth.logAttempt('192.0.2.8','fixture',userId,false,'fixture');
  auth.logAttempt('192.0.2.8','fixture',userId,false,'fixture');
  alerts._evaluateFailedLogins({ id: 9001, threshold: 2, window_seconds: 60 });
  expect(notify).toHaveBeenCalledTimes(1);
  db.prepare("INSERT INTO audit_log(action,created_at) VALUES ('expiry-fixture-action',datetime('now'))").run();
  db.prepare("INSERT INTO audit_log(action,created_at) VALUES ('expiry-fixture-action',?)").run(new Date().toISOString());
  alerts._evaluateThresholdRule({ id: 9002, threshold: 2, window_seconds: 60 }, { action: 'expiry-fixture-action' });
  expect(notify).toHaveBeenCalledTimes(2);
  alerts._cooldowns.clear();
});

test('OIDC state is consumed once before an asynchronous provider failure', async () => {
  const prior = config.oidc.enabled; config.oidc.enabled = true;
  const flow = await oidcFlow();
  const fetcher = jest.fn(async () => { throw new Error('fixture provider failure'); });
  router._oidcCacheInternals.clear(); router._oidcCacheInternals.setFetcher(fetcher);
  try {
    expect((await request(app).get('/api/auth/oidc/callback').query({ state: flow.state, code: 'fixture' }).set('Cookie',flow.cookie)).status).toBe(500);
    expect((await request(app).get('/api/auth/oidc/callback').query({ state: flow.state, code: 'fixture' }).set('Cookie',flow.cookie)).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { config.oidc.enabled = prior; router._oidcCacheInternals.resetFetcher(); router._oidcCacheInternals.clear(); }
});

test('lockout and alert windows use numeric timestamp range indexes', () => {
  const cutoff = new Date(Date.now()-60000).toISOString();
  const plans = [
    db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM login_attempts WHERE ip=? AND success=0 AND julianday(attempted_at)>julianday(?)').all('192.0.2.1',cutoff),
    db.prepare('EXPLAIN QUERY PLAN SELECT ip,COUNT(*) FROM login_attempts INDEXED BY idx_login_failed_instant WHERE success=0 AND julianday(attempted_at)>julianday(?) GROUP BY ip').all(cutoff),
    db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM audit_log WHERE action=? AND julianday(created_at)>julianday(?)').all('fixture',cutoff),
  ];
  for (const plan of plans) expect(plan.map(row=>row.detail).join(' ')).toMatch(/SEARCH .* USING .*INDEX .*instant.*<expr>>/);
});
