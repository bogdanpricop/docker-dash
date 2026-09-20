'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'delivery-fixture-secret', ENCRYPTION_KEY: 'delivery-fixture-key-32characters' });
jest.mock('../services/email', () => ({ sendPasswordReset: jest.fn(), sendInvitation: jest.fn() }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/cluster', () => ({ rateLimitTick: jest.fn(async () => ({ allowed: true, remaining: 2 })) }));
jest.mock('../utils/logger', () => { const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }; return () => logger; });
const request = require('supertest'), express = require('express');
const config = require('../config'), { getDb } = require('../db');
const email = require('../services/email'), cluster = require('../services/cluster');
const audit = require('../services/audit'), tokens = require('../services/password-reset');
const delivery = require('../services/password-reset-delivery'), { ResetDelivery } = delivery;
const app = express(); app.use(express.json()); app.use('/api/auth', require('../routes/auth'));
let db, userId, queues;
beforeAll(() => {
  db = getDb(); userId = Number(db.prepare("INSERT INTO users(username,email,password_hash,role,is_active) VALUES ('delivery-fixture','fixture@example.test','old-hash','viewer',1)").run().lastInsertRowid);
});
beforeEach(() => {
  jest.clearAllMocks(); queues = [];
  email.sendPasswordReset.mockResolvedValue({ ok: true });
  cluster.rateLimitTick.mockResolvedValue({ allowed: true, remaining: 2 });
  audit.log.mockImplementation(() => {});
  config.app.publicUrl = 'https://dashboard.example.test'; config.smtp.host = 'smtp.example.test';
  db.exec('DELETE FROM password_reset_tokens');
  db.prepare("UPDATE users SET email='fixture@example.test',is_active=1 WHERE id=?").run(userId);
});
afterEach(async () => { for (const q of queues) q.stop(); await delivery.whenIdle(); jest.restoreAllMocks(); });
function queue() { const q = new ResetDelivery(); queues.push(q); return q; }
const job = { email: 'fixture@example.test', lang: 'en', ip: '127.0.0.1' };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function post(address) { return request(app).post('/api/auth/request-password-reset').send({ email: address }).timeout(1000); }

test('HTTP responses finish identically even while known-account SMTP is unresolved', async () => {
  const held = deferred(); email.sendPasswordReset.mockReturnValue(held.promise);
  try {
    const known = await post(job.email), absent = await post('absent@example.test');
    expect(known.status).toBe(200); expect(absent.status).toBe(200);
    expect(known.body).toEqual(absent.body);
    expect(known.headers['content-length']).toBe(absent.headers['content-length']);
  } finally { held.resolve({ ok: true }); await delivery.whenIdle(); }
});

test('account lookup and enqueue are deferred until after the HTTP response finishes', () => {
  const layer = require('../routes/auth').stack.find(entry => entry.route?.path === '/request-password-reset');
  const handler = layer.route.stack.at(-1).handle;
  const enqueue = jest.spyOn(delivery, 'enqueue').mockReturnValue(true);
  let finished;
  const res = { once: jest.fn((_event, callback) => { finished = callback; }), json: jest.fn() };
  handler({ body: { email: job.email }, socket: { remoteAddress: '127.0.0.1' } }, res);
  expect(res.json).toHaveBeenCalledTimes(1); expect(enqueue).not.toHaveBeenCalled();
  finished(); expect(enqueue).toHaveBeenCalledWith({ email: job.email, lang: undefined, ip: '127.0.0.1' });
});

test('queue holds at most 32 jobs and two SMTP operations; errors release capacity', async () => {
  const q = queue(), held = deferred(); email.sendPasswordReset.mockReturnValue(held.promise);
  for (let n = 0; n < 32; n++) expect(q.enqueue(job)).toBe(true);
  expect(q.enqueue(job)).toBe(false);
  await new Promise(setImmediate); await new Promise(setImmediate);
  expect(email.sendPasswordReset).toHaveBeenCalledTimes(2);
  expect(q.running).toBe(2); expect(q.pending).toHaveLength(30);
  email.sendPasswordReset.mockRejectedValue(new Error('simulated failure'));
  held.resolve({ ok: true }); await q.whenIdle();
  expect(q.running).toBe(0); expect(q.pending).toHaveLength(0);
  expect(q.enqueue(job)).toBe(true); await q.whenIdle();
});

test('a single account quota covers case variants and different source IPs without leaking email in its key', async () => {
  const q = queue(), memory = require('../services/rate-limiter-memory'); memory._reset();
  cluster.rateLimitTick.mockImplementation(async (...args) => memory.tick(...args));
  for (let n = 0; n < 6; n++) q.enqueue({ ...job, email: n % 2 ? ' FIXTURE@EXAMPLE.TEST ' : job.email, ip: '192.0.2.' + n });
  await q.whenIdle();
  expect(email.sendPasswordReset).toHaveBeenCalledTimes(3);
  expect(new Set(cluster.rateLimitTick.mock.calls.map(args => args[0])).size).toBe(1);
  expect(cluster.rateLimitTick).toHaveBeenCalledWith(JSON.stringify(['auth-reset-account', userId]), 3, 3600000);
  expect(JSON.stringify(cluster.rateLimitTick.mock.calls)).not.toContain('fixture@example.test');
  memory._reset();
});

test.each([null, { allowed: 'yes', remaining: 1 }, { allowed: true, remaining: -1 }, { allowed: false, remaining: 0 }])
('denied or invalid quota %j never issues a token or sends mail', async decision => {
  const q = queue(); cluster.rateLimitTick.mockResolvedValue(decision);
  q.enqueue(job); await q.whenIdle();
  expect(db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').get().n).toBe(0);
  expect(email.sendPasswordReset).not.toHaveBeenCalled();
});

test('quota failure and a late decision after the deadline cannot issue a link', async () => {
  const q = queue(); cluster.rateLimitTick.mockRejectedValueOnce(new Error('Redis unavailable'));
  q.enqueue(job); await q.whenIdle();
  const held = deferred(); cluster.rateLimitTick.mockReturnValue(held.promise);
  jest.useFakeTimers();
  try {
    q.enqueue(job); await jest.advanceTimersByTimeAsync(3001); await q.whenIdle();
    held.resolve({ allowed: true, remaining: 2 }); await Promise.resolve();
    expect(email.sendPasswordReset).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').get().n).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('shutdown discards pending jobs, revokes in-flight links and ignores late mail completion', async () => {
  const q = queue(), held = deferred(); let raw;
  email.sendPasswordReset.mockImplementation(args => { raw = new URL(args.resetUrl).searchParams.get('token'); return held.promise; });
  q.enqueue(job); await new Promise(setImmediate); await new Promise(setImmediate);
  expect(tokens.find(db, raw)).not.toBeNull();
  q.enqueue({ ...job, email: 'absent@example.test' });
  q.stop(); expect(tokens.find(db, raw)).toBeNull(); expect(q.enqueue(job)).toBe(false);
  held.resolve({ ok: true }); await q.whenIdle();
  expect(audit.log).toHaveBeenCalledTimes(1);
  expect(audit.log.mock.calls[0][0].details).toEqual({ delivery: 'pending' });
});

test('audit intent failure rolls back issuance and never calls SMTP', async () => {
  const q = queue(); audit.log.mockImplementation(() => { throw new Error('audit unavailable'); });
  q.enqueue(job); await q.whenIdle();
  expect(email.sendPasswordReset).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').get().n).toBe(0);
});

test.each(['stop', 'email', 'disable'])('%s while the quota is pending prevents token issuance', async kind => {
  const q = queue(), held = deferred(); cluster.rateLimitTick.mockReturnValue(held.promise);
  q.enqueue(job); await new Promise(setImmediate);
  if (kind === 'stop') q.stop();
  else if (kind === 'email') db.prepare("UPDATE users SET email='new@example.test' WHERE id=?").run(userId);
  else db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
  held.resolve({ allowed: true, remaining: 2 }); await q.whenIdle();
  expect(email.sendPasswordReset).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) n FROM password_reset_tokens').get().n).toBe(0);
});
