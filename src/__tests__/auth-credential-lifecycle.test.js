'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'credential-lifecycle-fixture', ENCRYPTION_KEY: 'credential-lifecycle-fixture-key', BCRYPT_ROUNDS: '4', LOCKOUT_ATTEMPTS: '3' });
const bcrypt = require('bcrypt');
const { getDb } = require('../db');
const auth = require('../services/auth');
const reset = require('../services/password-reset');
const totp = require('../utils/totp');
const { sha256, encrypt } = require('../utils/crypto');
const crypto = require('crypto');
const config = require('../config');
let db, id, username, secret, passwordHash;
beforeAll(() => { db = getDb(); passwordHash = bcrypt.hashSync('FixtureSecret123!', 4); });
beforeEach(() => {
  db.exec('DELETE FROM login_attempts; DELETE FROM sessions; DELETE FROM mfa_tokens; DELETE FROM password_reset_tokens');
  db.prepare("UPDATE users SET email=NULL WHERE email='fixture@example.test'").run();
  username = 'lifecycle-' + crypto.randomBytes(5).toString('hex'); secret = totp.generateSecret();
  id = Number(db.prepare("INSERT INTO users(username,email,password_hash,role,is_active,must_change_password,totp_enabled,totp_secret,recovery_codes) VALUES (?, 'fixture@example.test', ?, 'viewer',1,0,1,?,?)")
    .run(username, passwordHash, encrypt(secret), encrypt(JSON.stringify(['fixture-recovery']))).lastInsertRowid);
});
afterEach(() => jest.restoreAllMocks());
function challenge() {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+5 minutes'))").run(sha256(token), id);
  return token;
}
function state() { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
function counts() { return { sessions: db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND is_valid=1').get(id).n, challenges: db.prepare('SELECT COUNT(*) n FROM mfa_tokens WHERE user_id=?').get(id).n }; }
function holdCompare() { let resolve; const promise = new Promise(r => { resolve = r; }); jest.spyOn(bcrypt, 'compare').mockReturnValue(promise); return resolve; }

test.each(['admin-reset', 'self-change', 'email-reset', 'disable-reactivate', 'delete-reactivate', 'source', 'factor-disable', 'factor-secret'])('%s invalidates an earlier password proof held in an MFA challenge', async action => {
  const token = challenge();
  if (action === 'admin-reset') await auth.resetPassword(id, 'ReplacementSecret123!');
  if (action === 'self-change') await auth.changePassword(id, 'FixtureSecret123!', 'ReplacementSecret123!');
  if (action === 'email-reset') {
    const issued = reset.issue(db, id, 'reset', 900000, 'fixture@example.test');
    reset.consume(db, new URL(issued.url).searchParams.get('token'), 'new-fixture-hash', () => {});
  }
  if (action === 'disable-reactivate') { auth.updateUser(id, { isActive: false }); auth.updateUser(id, { isActive: true }); }
  if (action === 'delete-reactivate') { auth.deleteUser(id); auth.updateUser(id, { isActive: true }); }
  if (action === 'source') db.prepare("UPDATE users SET auth_source='ldap' WHERE id=?").run(id);
  if (action === 'factor-disable') await auth.mfaDisable(id, 'FixtureSecret123!');
  if (action === 'factor-secret') db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(encrypt(totp.generateSecret()), id);
  expect(auth.verifyMfaRecovery(token, 'fixture-recovery', '192.0.2.1', 'fixture').token).toBeUndefined();
  expect(auth.verifyMfa(token, totp.generateTOTP(secret), '192.0.2.1', 'fixture').token).toBeUndefined();
  expect(counts()).toEqual({ sessions: 0, challenges: 0 });
});
test.each(['reset', 'disable-reactivate', 'factor-enable', 'source'])('login completing after %s cannot issue a stale session or challenge', async action => {
  db.prepare('UPDATE users SET totp_enabled=0 WHERE id=?').run(id);
  const resume = holdCompare();
  const pending = auth.login(username, 'FixtureSecret123!', '192.0.2.1', 'fixture');
  if (action === 'reset') await auth.resetPassword(id, 'ReplacementSecret123!');
  if (action === 'disable-reactivate') { auth.updateUser(id, { isActive: false }); auth.updateUser(id, { isActive: true }); }
  if (action === 'factor-enable') auth.mfaEnable(id, totp.generateTOTP(secret));
  if (action === 'source') db.prepare("UPDATE users SET auth_source='ldap' WHERE id=?").run(id);
  resume(true);
  const result = await pending;
  expect(result.error).toBeTruthy(); expect(result.token).toBeUndefined(); expect(result.mfaToken).toBeUndefined();
  expect(counts()).toEqual({ sessions: 0, challenges: 0 });
});
test('LDAP verification cannot revive an account disabled and reactivated while directory I/O was pending', async () => {
  db.prepare("UPDATE users SET auth_source='ldap' WHERE id=?").run(id);
  let resume; jest.spyOn(auth, '_tryLdapLogin').mockReturnValue(new Promise(r => { resume = r; }));
  const pending = auth.login(username, 'DirectorySecret123!', '192.0.2.1', 'fixture');
  auth.updateUser(id, { isActive: false }); auth.updateUser(id, { isActive: true });
  resume({ username }); expect((await pending).error).toBeTruthy(); expect(counts().challenges).toBe(0);
});
test('parallel incorrect passwords count every committed failure toward lockout', async () => {
  const resume = holdCompare();
  const attempts = Array.from({ length: 3 }, (_, n) => auth.login(username, 'wrong', '192.0.2.' + n, 'fixture'));
  resume(false); await Promise.all(attempts);
  expect(state()).toMatchObject({ failed_attempts: 3, is_locked: 1 }); expect(counts().sessions).toBe(0);
});
test('a concurrent account lock blocks a previously verified correct password', async () => {
  const resume = holdCompare(); const pending = auth.login(username, 'FixtureSecret123!', '192.0.2.1', 'fixture');
  db.prepare("UPDATE users SET is_locked=1,locked_until=?,failed_attempts=3 WHERE id=?").run(new Date(Date.now()+60000).toISOString(), id);
  resume(true); expect((await pending).error).toMatch(/locked/); expect(state().failed_attempts).toBe(3);
});
test('current role is used when a password check completes', async () => {
  db.prepare('UPDATE users SET totp_enabled=0 WHERE id=?').run(id);
  const resume = holdCompare(); const pending = auth.login(username, 'FixtureSecret123!', '192.0.2.1', 'fixture');
  db.prepare("UPDATE users SET role='operator' WHERE id=?").run(id);
  resume(true); expect((await pending).user.role).toBe('operator');
});
test.each(['disable', 'change'])('%s refuses a password check from before deactivation/reactivation', async action => {
  const resume = holdCompare();
  const pending = action === 'disable' ? auth.mfaDisable(id, 'FixtureSecret123!') : auth.changePassword(id, 'FixtureSecret123!', 'ReplacementSecret123!');
  auth.updateUser(id, { isActive: false }); auth.updateUser(id, { isActive: true });
  resume(true); expect((await pending).error).toMatch(/Account changed/);
  expect(state()).toMatchObject({ totp_enabled: 1, password_hash: passwordHash });
});
test('existing enrollment cannot be overwritten or recovery codes regenerated through setup/enable', () => {
  const before = state();
  expect(auth.mfaSetup(id).error).toBeTruthy(); expect(auth.mfaEnable(id, totp.generateTOTP(secret)).error).toBeTruthy();
  expect(state()).toMatchObject({ totp_secret: before.totp_secret, recovery_codes: before.recovery_codes, auth_version: before.auth_version });
});
test('reactivation cannot resurrect an existing session or password reset link', () => {
  const session = auth._createSession(state(), '192.0.2.1', 'fixture');
  const issued = reset.issue(db, id, 'reset', 900000, 'fixture@example.test');
  auth.updateUser(id, { isActive: false }); auth.updateUser(id, { isActive: true });
  expect(auth.validateSession(session.token)).toBeNull(); expect(reset.find(db, new URL(issued.url).searchParams.get('token'))).toBeNull();
});
test('trigger revocation rolls back together with a failed credential transaction', () => {
  const token = challenge(), version = state().auth_version;
  const session = auth._createSession(state(), '192.0.2.1', 'fixture');
  expect(() => db.transaction(() => {
    db.prepare("UPDATE users SET password_hash='changed' WHERE id=?").run(id);
    throw Error('rollback fixture');
  }).immediate()).toThrow('rollback fixture');
  expect(state().auth_version).toBe(version); expect(counts().challenges).toBe(1);
  expect(auth.validateSession(session.token)).toBeTruthy();
  expect(auth.verifyMfaRecovery(token, 'fixture-recovery', '192.0.2.1', 'fixture').token).toBeTruthy();
});
test('recovery verification refuses a disabled factor even if a challenge is injected afterward', () => {
  db.prepare('UPDATE users SET totp_enabled=0 WHERE id=?').run(id);
  expect(auth.verifyMfaRecovery(challenge(), 'fixture-recovery', '192.0.2.1', 'fixture').token).toBeUndefined();
});
test('IP lock established during password verification is rechecked', async () => {
  const resume = holdCompare(); const pending = auth.login(username, 'FixtureSecret123!', '192.0.2.1', 'fixture');
  for (let n=0;n<config.rateLimit.loginMaxAttempts;n++) auth.logAttempt('192.0.2.1', username, id, false, 'fixture');
  resume(true); expect((await pending).locked).toBe(true); expect(counts().challenges).toBe(0);
});
test.each(['setup', 'enable', 'disable', 'admin-disable'])('MFA %s respects the HTTP read-only gate', async action => {
  const request = require('supertest'), express = require('express');
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(id);
  const session = auth._createSession(state(), '192.0.2.1', 'fixture');
  const app = express(); app.use(express.json()); app.use('/api/auth', require('../routes/auth'));
  const readOnly = config.features.readOnly, before = state(); config.features.readOnly = true;
  try {
    const req = action === 'admin-disable' ? request(app).delete(`/api/auth/users/${id}/mfa`) : request(app).post('/api/auth/mfa/' + action);
    const response = await req.set('Authorization', 'Bearer ' + session.token).send({ code: totp.generateTOTP(secret), password: 'FixtureSecret123!' });
    expect(response.status).toBe(403); expect(response.body.error).toMatch(/read-only/);
    expect(state()).toMatchObject({ totp_secret: before.totp_secret, recovery_codes: before.recovery_codes, auth_version: before.auth_version });
  } finally { config.features.readOnly = readOnly; }
});
test('migration revokes pre-upgrade MFA challenges while preserving established sessions', () => {
  const Database = require('better-sqlite3'), migration = require('../db/migrations/179_auth_credential_version');
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,password_hash TEXT,auth_source TEXT,is_active INTEGER,totp_secret TEXT,totp_enabled INTEGER);
      CREATE TABLE sessions(user_id INTEGER,is_valid INTEGER);
      CREATE TABLE mfa_tokens(user_id INTEGER);
      CREATE TABLE password_reset_tokens(user_id INTEGER,used_at TEXT);
      INSERT INTO users VALUES(1,'hash','local',1,'secret',1);
      INSERT INTO sessions VALUES(1,1);
      INSERT INTO mfa_tokens VALUES(1);
      INSERT INTO password_reset_tokens VALUES(1,NULL);`);
    legacy.transaction(() => migration.up(legacy))();
    expect(legacy.prepare('SELECT COUNT(*) n FROM mfa_tokens').get().n).toBe(0);
    expect(legacy.prepare('SELECT is_valid FROM sessions').get().is_valid).toBe(1);
    expect(legacy.prepare('SELECT used_at FROM password_reset_tokens').get().used_at).toBeNull();
    legacy.exec("INSERT INTO mfa_tokens VALUES(1); UPDATE users SET password_hash='new' WHERE id=1");
    expect(legacy.prepare('SELECT auth_version FROM users').get().auth_version).toBe(1);
    expect(legacy.prepare('SELECT COUNT(*) n FROM mfa_tokens').get().n).toBe(0);
    expect(legacy.prepare('SELECT is_valid FROM sessions').get().is_valid).toBe(0);
    expect(legacy.prepare('SELECT used_at FROM password_reset_tokens').get().used_at).not.toBeNull();
    legacy.transaction(() => migration.down(legacy))();
    expect(legacy.prepare('PRAGMA table_info(users)').all().map(row => row.name)).not.toContain('auth_version');
  } finally { legacy.close(); }
});
