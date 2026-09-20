'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'reset-test-secret', ENCRYPTION_KEY: 'reset-test-encryption-key-32chars' });
jest.mock('../services/email', () => ({ sendPasswordReset: jest.fn(), sendInvitation: jest.fn() }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/cluster', () => ({ rateLimitTick: jest.fn(async () => ({ allowed: true, remaining: 4 })) }));
jest.mock('../utils/logger', () => { const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }; return () => logger; });
jest.mock('../middleware/auth', () => ({ requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'operator', role: 'admin' }; next(); },
  requireRole: () => (_req, _res, next) => next(), writeable: (_req, _res, next) => next() }));
const request = require('supertest'), express = require('express'), bcrypt = require('bcrypt');
const config = require('../config'), { getDb } = require('../db'), { sha256 } = require('../utils/crypto');
const email = require('../services/email'), audit = require('../services/audit'), log = require('../utils/logger')();
const delivery = require('../services/password-reset-delivery');
const app = express(); app.use(express.json()); app.use('/api/auth', require('../routes/auth'));
let db, userId;
beforeAll(() => {
  db = getDb(); userId = Number(db.prepare("INSERT INTO users(username,email,password_hash,role,is_active) VALUES ('reset-fixture','fixture@example.test','old-hash','admin',1)").run().lastInsertRowid);
});
beforeEach(() => {
  jest.clearAllMocks(); email.sendPasswordReset.mockResolvedValue({ ok: true }); email.sendInvitation.mockResolvedValue({ ok: true });
  audit.log.mockImplementation(() => {});
  config.app.publicUrl = 'https://dashboard.example.test/panel'; config.smtp.host = 'smtp.example.test';
  db.exec('DELETE FROM password_reset_tokens');
  db.prepare("UPDATE users SET password_hash='old-hash',email='fixture@example.test',is_active=1,must_change_password=1 WHERE id=?").run(userId);
});
afterEach(async () => { await delivery.whenIdle(); jest.restoreAllMocks(); });
function token(expiry = new Date(Date.now() + 3600000).toISOString()) {
  const value = require('crypto').randomBytes(32).toString('hex');
  db.prepare('INSERT INTO password_reset_tokens(user_id,token_hash,type,expires_at) VALUES (?,?,?,?)').run(userId, sha256(value), 'reset', expiry);
  return value;
}
function reset(value, password = 'DifferentStrongPass123!') { return request(app).post('/api/auth/reset-password-token').send({ token: value, newPassword: password }); }

test.each(['public', 'admin-reset', 'admin-invite'])('%s link ignores body origin, Host and forwarding headers', async kind => {
  const route = kind === 'public' ? '/request-password-reset' : '/users/' + userId + (kind === 'admin-reset' ? '/send-reset' : '/send-invite');
  expect((await request(app).post('/api/auth' + route).set('Host', 'evil.example').set('X-Forwarded-Host', 'evil.example')
    .send({ email: 'fixture@example.test', origin: 'https://evil.example/steal' })).status).toBe(200);
  await delivery.whenIdle();
  const args = (kind === 'admin-invite' ? email.sendInvitation : email.sendPasswordReset).mock.calls[0][0];
  const link = new URL(args.resetUrl || args.inviteUrl);
  expect(link.origin).toBe('https://dashboard.example.test'); expect(link.pathname).toBe('/panel/reset-password.html');
  const raw = link.searchParams.get('token'); expect(raw).toMatch(/^[a-f0-9]{64}$/);
  expect(db.prepare('SELECT token_hash FROM password_reset_tokens WHERE user_id=?').get(userId).token_hash).toBe(sha256(raw));
});

test('expired ISO timestamps from earlier today cannot validate or reset', async () => {
  const raw = token(new Date(Date.now() - 1000).toISOString());
  expect((await request(app).post('/api/auth/validate-reset-token').send({ token: raw })).status).toBe(400);
  expect((await reset(raw)).status).toBe(400);
  expect(db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId).password_hash).toBe('old-hash');
});

test('disabled accounts cannot redeem a previously issued link', async () => {
  const raw = token(); db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
  expect((await reset(raw)).status).toBe(400);
});

test('SMTP failure never logs the URL/token and revokes the failed delivery', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); let raw;
  email.sendPasswordReset.mockImplementation(async args => { raw = new URL(args.resetUrl).searchParams.get('token'); throw Error('SMTP failed: ' + args.resetUrl); });
  expect((await request(app).post('/api/auth/request-password-reset').send({ email: 'fixture@example.test' })).status).toBe(200);
  await delivery.whenIdle();
  expect(JSON.stringify([warn.mock.calls, log.error.mock.calls, log.warn.mock.calls])).not.toContain(raw);
  expect(db.prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash=?').get(sha256(raw)).used_at).not.toBeNull();
});

test('missing SMTP does not mint tokens or invalidate an existing reset link', async () => {
  const raw = token(); config.smtp.host = '';
  expect((await request(app).post('/api/auth/request-password-reset').send({ email: 'fixture@example.test' })).status).toBe(200);
  await delivery.whenIdle();
  expect(email.sendPasswordReset).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').get().n).toBe(1);
  expect(db.prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash=?').get(sha256(raw)).used_at).toBeNull();
});

test('two concurrent requests can redeem a token only once', async () => {
  const raw = token(), waiting = []; let both;
  const ready = new Promise(resolve => { both = resolve; });
  jest.spyOn(bcrypt, 'hash').mockImplementation(password => new Promise(resolve => { waiting.push(() => resolve('hash:' + password)); if (waiting.length === 2) both(); }));
  const a = reset(raw, 'FirstStrongPass123!').then(r => r), b = reset(raw, 'SecondStrongPass123!').then(r => r);
  await ready; waiting.forEach(fn => fn());
  expect((await Promise.all([a, b])).map(r => r.status).sort()).toEqual([200, 400]);
  expect(audit.log).toHaveBeenCalledTimes(1);
});

test('expiry is rechecked after password hashing and audit failure rolls back the change', async () => {
  const raw = token();
  jest.spyOn(bcrypt, 'hash').mockImplementation(async () => {
    db.prepare("UPDATE password_reset_tokens SET expires_at=datetime('now','-1 day')").run(); return 'new-hash';
  });
  expect((await reset(raw)).status).toBe(400);
  expect(db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId).password_hash).toBe('old-hash');
  db.prepare("UPDATE password_reset_tokens SET expires_at=datetime('now','+1 day')").run();
  bcrypt.hash.mockResolvedValue('new-hash'); audit.log.mockImplementation(() => { throw Error('audit unavailable'); });
  expect((await reset(raw)).status).toBe(500);
  expect(db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId).password_hash).toBe('old-hash');
  expect(db.prepare('SELECT used_at FROM password_reset_tokens').get().used_at).toBeNull();
});

test.each(['javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test/?redirect=evil', 'https://example.test/#fragment'])('invalid configured URL refuses token issuance: %s', async url => {
  config.app.publicUrl = url;
  expect((await request(app).post('/api/auth/request-password-reset').send({ email: 'fixture@example.test' })).status).toBe(200);
  await delivery.whenIdle();
  expect(db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').get().n).toBe(0);
  expect(email.sendPasswordReset).not.toHaveBeenCalled();
});

test.each(['token', 'authenticated', 'admin'])('%s password change invalidates sessions and outstanding links', async kind => {
  const raw = token(), sibling = token();
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(sha256(raw), userId);
  jest.spyOn(bcrypt, 'hash').mockResolvedValue('new-hash');
  jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
  const auth = require('../services/auth');
  if (kind === 'token') expect((await reset(raw)).status).toBe(200);
  else if (kind === 'authenticated') expect(await auth.changePassword(userId, 'old', 'new')).toEqual({ success: true });
  else expect(await auth.resetPassword(userId, 'new')).toEqual({ success: true });
  expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND is_valid=1').get(userId).n).toBe(0);
  expect((await request(app).post('/api/auth/validate-reset-token').send({ token: sibling })).status).toBe(400);
  expect(db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId).password_hash).toBe('new-hash');
  if (kind !== 'admin') expect(db.prepare('SELECT must_change_password FROM users WHERE id=?').get(userId).must_change_password).toBe(0);
});

test.each(['password', 'deactivation'])('authenticated change refuses stale authorization after concurrent %s change', async kind => {
  const raw = token();
  jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
  jest.spyOn(bcrypt, 'hash').mockImplementation(async () => {
    if (kind === 'password') db.prepare("UPDATE users SET password_hash='other-reset' WHERE id=?").run(userId);
    else db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
    return 'stale-change';
  });
  expect((await require('../services/auth').changePassword(userId, 'old', 'new')).error).toBeDefined();
  expect(db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId).password_hash).not.toBe('stale-change');
  expect(db.prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash=?').get(sha256(raw)).used_at).toBeNull();
});

test('failed session invalidation rolls back password change and link consumption', async () => {
  const raw = token();
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(sha256(raw), userId);
  db.exec("CREATE TEMP TRIGGER fail_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  jest.spyOn(bcrypt, 'hash').mockResolvedValue('new-hash');
  try {
    expect((await reset(raw)).status).toBe(500);
    expect(db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId).password_hash).toBe('old-hash');
    expect(db.prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash=?').get(sha256(raw)).used_at).toBeNull();
  } finally { db.exec('DROP TRIGGER fail_session_update'); }
});

test.each(['email', 'disable', 'disable-zero', 'delete'])('%s update permanently revokes outstanding account links', async kind => {
  const raw = token(), auth = require('../services/auth');
  if (kind === 'email') auth.updateUser(userId, { email: 'new@example.test' });
  else if (kind === 'disable') auth.updateUser(userId, { isActive: false });
  else if (kind === 'disable-zero') auth.updateUser(userId, { isActive: 0 });
  else auth.deleteUser(userId);
  auth.updateUser(userId, { isActive: true });
  expect((await request(app).post('/api/auth/validate-reset-token').send({ token: raw })).status).toBe(400);
});

test.each(['email', 'disabled'])('issuance refuses a stale recipient snapshot after %s changes', kind => {
  const raw = token();
  if (kind === 'email') db.prepare("UPDATE users SET email='new@example.test' WHERE id=?").run(userId);
  else db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
  expect(() => require('../services/password-reset').issue(db, userId, 'reset', 900000, 'fixture@example.test'))
    .toThrow('Account changed before reset issuance');
  expect(db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').get().n).toBe(1);
  expect(db.prepare('SELECT used_at FROM password_reset_tokens WHERE token_hash=?').get(sha256(raw)).used_at).toBeNull();
});
