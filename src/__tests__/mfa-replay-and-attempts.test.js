'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'mfa-replay-fixture', ENCRYPTION_KEY: 'mfa-replay-fixture-key', BCRYPT_ROUNDS: '4', LOCKOUT_ATTEMPTS: '10' });
const crypto = require('crypto'), bcrypt = require('bcrypt');
const { getDb } = require('../db'), auth = require('../services/auth');
const { sha256, encrypt } = require('../utils/crypto'), totp = require('../utils/totp');
const config = require('../config');
let db, id, secret, code, instant, username;
beforeAll(() => { db = getDb(); });
beforeEach(() => {
  instant = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(instant);
  secret = totp.generateSecret(); code = totp.generateTOTP(secret);
  username = 'mfa-' + crypto.randomBytes(6).toString('hex');
  id = Number(db.prepare("INSERT INTO users(username,password_hash,role,is_active,must_change_password,totp_enabled,totp_secret,recovery_codes) VALUES (?,?,'viewer',1,0,1,?,?)")
    .run(username, bcrypt.hashSync('FixtureSecret123!', 4), encrypt(secret), encrypt(JSON.stringify(['fixture-recovery']))).lastInsertRowid);
});
afterEach(() => jest.restoreAllMocks());
function challenge() {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(sha256(token), id);
  return token;
}
function verify(token, value = code) { return auth.verifyMfa(token, value, '192.0.2.1', 'fixture'); }
function recover(token, value = 'fixture-recovery') { return auth.verifyMfaRecovery(token, value, '192.0.2.1', 'fixture'); }
function state() { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
function claim(token) { return db.prepare('SELECT * FROM mfa_tokens WHERE token_hash=?').get(sha256(token)); }

test('a TOTP can create only one session across distinct login challenges', () => {
  expect(verify(challenge()).token).toBeTruthy();
  expect(verify(challenge()).error).toMatch(/already used/);
  expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(id).n).toBe(1);
});
test.each(['login-first', 'step-up-first'])('login and privileged step-up share the replay boundary (%s)', order => {
  const token = challenge();
  if (order === 'login-first') {
    expect(verify(token).token).toBeTruthy(); expect(auth.verifyStepUpMfa(id, code).error).toBeTruthy();
  } else {
    expect(auth.verifyStepUpMfa(id, code).success).toBe(true); expect(verify(token).error).toBeTruthy();
  }
});
test('enrollment consumes its proof before subsequent login or step-up', () => {
  db.prepare('UPDATE users SET totp_enabled=0 WHERE id=?').run(id);
  expect(auth.mfaEnable(id, code).success).toBe(true);
  expect(verify(challenge()).error).toBeTruthy(); expect(auth.verifyStepUpMfa(id, code).error).toBeTruthy();
});
test('the next unused counter succeeds but an older accepted-window counter does not', () => {
  expect(verify(challenge()).token).toBeTruthy();
  Date.now.mockReturnValue(instant + 30000);
  expect(verify(challenge(), totp.generateTOTP(secret)).token).toBeTruthy();
  expect(verify(challenge(), code).error).toBeTruthy();
});
test.each(['totp', 'recovery', 'mixed'])('five guesses exhaust one challenge across %s requests', mode => {
  const token = challenge();
  for (let n=0;n<5;n++) {
    const result = mode === 'recovery' || (mode === 'mixed' && n%2) ? recover(token, 'wrong') : verify(token, 'invalid');
    expect(result.error).toBeTruthy();
  }
  expect(verify(token).token).toBeUndefined(); expect(recover(token).token).toBeUndefined();
  expect(claim(token)).toMatchObject({ attempts: 5, used: 1 });
});
test('a correct fifth attempt succeeds and clears the account failure count', () => {
  const token = challenge(); for(let n=0;n<4;n++) verify(token, 'invalid');
  expect(verify(token).token).toBeTruthy(); expect(claim(token)).toMatchObject({ attempts: 5, used: 1 });
  expect(state().mfa_failed_attempts).toBe(0);
});
test('new challenge tokens and factor endpoints do not bypass the shared account lock', async () => {
  for (let n=0;n<config.security.lockoutAttempts;n++) {
    if(n%2) recover(challenge(), 'wrong'); else verify(challenge(), 'invalid');
  }
  const fresh = await auth.login(username, 'FixtureSecret123!', '192.0.2.2', 'fixture');
  expect(fresh.mfaToken).toBeTruthy();
  expect(verify(fresh.mfaToken).error).toMatch(/Too many/);
  expect(recover(challenge()).error).toMatch(/Too many/);
  expect(auth.verifyStepUpMfa(id, code).error).toMatch(/Too many/);
  expect(state().mfa_locked_until).toBeTruthy();
});
test('MFA cooldown expiry permits a valid factor without reusing an exhausted challenge', () => {
  db.prepare("UPDATE users SET mfa_failed_attempts=10,mfa_locked_until=datetime('now','-1 second') WHERE id=?").run(id);
  expect(verify(challenge()).token).toBeTruthy(); expect(state()).toMatchObject({ mfa_failed_attempts: 0, mfa_locked_until: null });
});
test('a malformed stored cooldown denies factor verification', () => {
  db.prepare("UPDATE users SET mfa_locked_until='not-a-time' WHERE id=?").run(id);
  expect(verify(challenge()).error).toMatch(/Too many/); expect(state().totp_last_counter).toBeNull();
});
test('failed session storage rolls back counter consumption and the challenge attempt', () => {
  const token = challenge(); const create = jest.spyOn(auth, '_createSession').mockImplementation(() => { throw Error('fixture outage'); });
  expect(() => verify(token)).toThrow('fixture outage');
  expect(state().totp_last_counter).toBeNull(); expect(claim(token)).toMatchObject({ attempts: 0, used: 0 });
  create.mockRestore(); expect(verify(token).token).toBeTruthy();
});
test('a new authenticator clears the previous counter and factor cooldown', () => {
  expect(verify(challenge()).token).toBeTruthy();
  db.prepare("UPDATE users SET mfa_locked_until='not-a-time',totp_secret=? WHERE id=?").run(encrypt(totp.generateSecret()), id);
  expect(state()).toMatchObject({ totp_last_counter: null, mfa_failed_attempts: 0, mfa_locked_until: null });
});
test.each([{}, null, 123456, 'x'.repeat(129)])('malformed recovery input consumes a bounded attempt (%p)', value => {
  const token = challenge(); expect(recover(token, value).error).toBe('Invalid recovery code');
  expect(claim(token).attempts).toBe(1);
});
test('utility returns the matching counter and rejects non-string codes', () => {
  expect(totp.matchTOTPCounter(secret, code)).toBe(Math.floor(instant/30000));
  expect(totp.matchTOTPCounter(secret, Number(code))).toBeNull();
  expect(totp.matchTOTPCounter(secret, code, 1000)).toBeNull();
});
test('upgrade excludes unrecorded historical TOTP windows and reenrollment clears that boundary', () => {
  const Database = require('better-sqlite3'), migration = require('../db/migrations/180_mfa_replay_and_attempts');
  const legacy = new Database(':memory:');
  try {
    legacy.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,totp_enabled INTEGER,totp_secret TEXT); CREATE TABLE mfa_tokens(id INTEGER); INSERT INTO users VALUES(1,1,'secret'),(2,0,NULL)");
    legacy.transaction(() => migration.up(legacy))();
    const counter = legacy.prepare('SELECT totp_last_counter FROM users WHERE id=1').get().totp_last_counter;
    expect(counter).toBeGreaterThanOrEqual(Math.floor(instant/30000)+1);
    expect(counter).toBeLessThanOrEqual(Math.floor(instant/30000)+2);
    expect(legacy.prepare('SELECT totp_last_counter FROM users WHERE id=2').get().totp_last_counter).toBeNull();
    legacy.exec("UPDATE users SET totp_secret='replacement',mfa_failed_attempts=5,mfa_locked_until='future' WHERE id=1");
    expect(legacy.prepare('SELECT totp_last_counter,mfa_failed_attempts,mfa_locked_until FROM users WHERE id=1').get())
      .toEqual({ totp_last_counter: null, mfa_failed_attempts: 0, mfa_locked_until: null });
    legacy.transaction(() => migration.down(legacy))();
    expect(legacy.prepare('PRAGMA table_info(users)').all().map(row => row.name)).toEqual(['id','totp_enabled','totp_secret']);
  } finally { legacy.close(); }
});
