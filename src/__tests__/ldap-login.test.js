'use strict';

process.env.APP_SECRET = 'ldap-login-regression-test-secret';
process.env.ENCRYPTION_KEY = 'ldap-login-regression-encryption-key';
process.env.DB_PATH = ':memory:';
process.env.BCRYPT_ROUNDS = '4';

const { getDb, closeDb } = require('../db');
const db = getDb();
const ldap = require('../services/ldap');
const auth = require('../services/auth');
const bcrypt = require('bcrypt');
const migration = require('../db/migrations/174_encrypt_ldap_password');
const profile = { username: 'directory-user', displayName: 'Directory User', email: 'user@example.test' };

beforeEach(() => {
  db.prepare('DELETE FROM login_attempts').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM mfa_tokens').run();
  db.prepare('DELETE FROM users').run();
  ldap.saveConfig({ enabled: true, bindPassword: 'service-password', defaultRole: 'viewer' });
  jest.spyOn(ldap, 'authenticate').mockResolvedValue(profile);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => closeDb());

test('first and subsequent LDAP logins use directory authentication', async () => {
  const first = await auth.login(profile.username, 'directory-password', '127.0.0.1', 'test');
  expect(first.token).toBeTruthy();
  expect(first.user.role).toBe('viewer');
  const second = await auth.login(profile.username, 'directory-password', '127.0.0.1', 'test');
  expect(second.token).toBeTruthy();
  expect(ldap.authenticate).toHaveBeenCalledTimes(2);
});

test('directory rejection never falls back to a local hash', async () => {
  await auth.login(profile.username, 'directory-password', '127.0.0.1', 'test');
  db.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync('old-local-password', 4));
  ldap.authenticate.mockResolvedValue(null);
  const result = await auth.login(profile.username, 'old-local-password', '127.0.0.1', 'test');
  expect(result.error).toBe('Invalid credentials');
  expect(result.token).toBeUndefined();
});

test('disabled LDAP accounts are rejected before contacting the directory', async () => {
  await auth.login(profile.username, 'password', '127.0.0.1', 'test');
  ldap.authenticate.mockClear();
  db.prepare('UPDATE users SET is_active = 0').run();
  expect((await auth.login(profile.username, 'password', '127.0.0.1', 'test')).error).toMatch(/disabled/);
  expect(ldap.authenticate).not.toHaveBeenCalled();
});

test('LDAP users still have to complete MFA', async () => {
  await auth.login(profile.username, 'password', '127.0.0.1', 'test');
  db.prepare('UPDATE users SET totp_enabled = 1').run();
  const result = await auth.login(profile.username, 'password', '127.0.0.1', 'test');
  expect(result.mfaRequired).toBe(true);
  expect(result.token).toBeUndefined();
});

test('a local account cannot be taken over by LDAP provisioning', () => {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(profile.username, bcrypt.hashSync('local-password', 4), 'admin');
  expect(() => auth._provisionLdapUser(db, profile)).toThrow(/local account/);
  expect(db.prepare('SELECT auth_source FROM users').get().auth_source).toBe('local');
});

test('migration encrypts legacy credentials, is idempotent, and preserves authentication config', () => {
  const cfg = { enabled: true, host: 'ldap.example.test', bindPassword: 'legacy-secret' };
  db.prepare("UPDATE settings SET value = ? WHERE key = 'ldap_config'").run(JSON.stringify(cfg));
  migration.up(db);
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'ldap_config'").get().value;
  expect(stored).not.toContain('legacy-secret');
  expect(ldap.getConfig()).toEqual(cfg);
  migration.up(db);
  expect(db.prepare("SELECT value FROM settings WHERE key = 'ldap_config'").get().value).toBe(stored);
});

test('corrupted encrypted credentials fail closed', () => {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'ldap_config'")
    .run(JSON.stringify({ enabled: true, bindPasswordEncrypted: 'corrupted' }));
  expect(() => ldap.getConfig()).toThrow();
});
