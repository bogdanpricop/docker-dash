'use strict';

jest.mock('../services/cluster', () => ({ rateLimitTick: jest.fn() }));
jest.mock('../utils/logger', () => () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const express = require('express');
const request = require('supertest');
const { getClientIp } = require('../utils/helpers');
const proxyTrust = require('../utils/proxy-trust');
const cluster = require('../services/cluster');
const { rateLimit } = require('../middleware/rateLimit');
const memory = require('../services/rate-limiter-memory');

beforeEach(() => { cluster.rateLimitTick.mockReset(); memory._reset(); });
afterEach(() => jest.useRealTimers());

function appWithTrust(trust) {
  const app = express(); app.set('trust proxy', proxyTrust(trust));
  app.get('/ip', (req, res) => res.json({ ip: getClientIp(req) }));
  return app;
}

test('untrusted forwarding and real-IP headers cannot replace the socket address', async () => {
  const app = appWithTrust('false');
  const plain = await request(app).get('/ip');
  const spoof = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.77').set('X-Real-IP', '198.51.100.99');
  expect(spoof.body.ip).toBe(plain.body.ip);
});
test('trusted proxy chain stops at the closest untrusted hop', async () => {
  const res = await request(appWithTrust('loopback')).get('/ip')
    .set('X-Forwarded-For', '198.51.100.42, 203.0.113.8');
  expect(res.body.ip).toBe('203.0.113.8');
});
test('a proxy outside the configured subnet cannot assert client identity', async () => {
  const res = await request(appWithTrust('192.0.2.0/24')).get('/ip').set('X-Forwarded-For', '203.0.113.8');
  expect(res.body.ip).not.toBe('203.0.113.8');
});
test('raw Node requests ignore forwarding headers too', () => {
  expect(getClientIp({ headers: { 'x-forwarded-for': 'evil' }, socket: { remoteAddress: '192.0.2.7' } })).toBe('192.0.2.7');
  expect(getClientIp({ headers: { 'x-real-ip': 'evil' } })).toBe('unknown');
});
test.each(['true', '1', '2', '99'])('blanket or hop-count proxy trust %s is refused', value => {
  expect(() => proxyTrust(value)).toThrow('explicit proxy IPs/CIDRs');
});
test('default proxy policy is independent of application environment', () => {
  expect(proxyTrust(undefined)).toBe('loopback'); expect(proxyTrust(' ')).toBe('loopback');
  expect(proxyTrust('0')).toBe(false); expect(proxyTrust('false')).toBe(false);
});

test('changing URL, case, query or forged IP cannot multiply a configured quota', async () => {
  cluster.rateLimitTick.mockImplementation((...args) => memory.tick(...args));
  const app = express(); app.set('trust proxy', false);
  app.use('/api/items', rateLimit(2, 60000, 'api'));
  app.use('/api/items', (_req, res) => res.json({ ok: true }));
  expect((await request(app).get('/api/items/1')).status).toBe(200);
  expect((await request(app).get('/API/items/2?new=1').set('X-Forwarded-For', '192.0.2.2')).status).toBe(200);
  const blocked = await request(app).get('/api/items/999').set('X-Forwarded-For', '192.0.2.3');
  expect(blocked.status).toBe(429); expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  expect(new Set(cluster.rateLimitTick.mock.calls.map(c => c[0])).size).toBe(1);
});

test('independent scopes do not consume one another and trusted clients remain distinct', async () => {
  cluster.rateLimitTick.mockImplementation((...args) => memory.tick(...args));
  const app = express(); app.set('trust proxy', 'loopback');
  app.get('/login', rateLimit(1, 60000, 'login'), (_q, s) => s.sendStatus(200));
  app.get('/mfa', rateLimit(1, 60000, 'mfa'), (_q, s) => s.sendStatus(200));
  for (const [url, ip] of [['/login', '192.0.2.1'], ['/mfa', '192.0.2.1'], ['/login', '192.0.2.2']]) {
    expect((await request(app).get(url).set('X-Forwarded-For', ip)).status).toBe(200);
  }
});

test('a shared API limiter charges once when an Express router falls through to another mount', async () => {
  cluster.rateLimitTick.mockImplementation((...args) => memory.tick(...args));
  const app = express(), limiter = rateLimit(2, 60000, 'api'), first = express.Router();
  first.get('/other', (_req, res) => res.sendStatus(200));
  app.use('/api/volumes', limiter, first);
  app.use('/api/volumes', limiter, (_req, res) => res.sendStatus(200));
  for (let n = 0; n < 2; n++) {
    const response = await request(app).get('/api/volumes/browser');
    expect(response.status).toBe(200);
    expect(response.headers['x-ratelimit-remaining']).toBe(String(1 - n));
  }
  expect((await request(app).get('/api/volumes/browser')).status).toBe(429);
  expect(cluster.rateLimitTick).toHaveBeenCalledTimes(3);
});

test('an API allowance cannot skip a different route-specific limiter on the same request', async () => {
  cluster.rateLimitTick.mockImplementation((...args) => memory.tick(...args));
  const app = express(), shared = rateLimit(10, 60000, 'api');
  app.use('/api', shared);
  app.post('/api/run', shared, rateLimit(1, 60000, 'procedure-run'), (_req, res) => res.sendStatus(200));
  expect((await request(app).post('/api/run')).status).toBe(200);
  expect((await request(app).post('/api/run')).status).toBe(429);
  expect(cluster.rateLimitTick.mock.calls.map(c => JSON.parse(c[0])[0])).toEqual(['api', 'procedure-run', 'api', 'procedure-run']);
});

test.each([new Error('Redis unavailable'), null, {}, { allowed: true, remaining: NaN },
  { allowed: false, remaining: 0, retryAfterSec: 0 }])('unavailable/invalid quota never reaches the handler: %p', async value => {
  if (value instanceof Error) cluster.rateLimitTick.mockRejectedValue(value);
  else cluster.rateLimitTick.mockResolvedValue(value);
  const handler = jest.fn((_req, res) => res.sendStatus(200)), app = express();
  app.post('/login', rateLimit(5, 60000, 'login'), handler);
  const res = await request(app).post('/login');
  expect(res.status).toBe(503); expect(res.headers['retry-after']).toBe('3');
  expect(handler).not.toHaveBeenCalled(); expect(res.body.error).not.toContain('Redis');
});

test('a hung backend is bounded and late success cannot run the handler', async () => {
  jest.useFakeTimers(); let finish;
  cluster.rateLimitTick.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const next = jest.fn(), res = { set: jest.fn(), status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const pending = rateLimit(5, 60000, 'login')({ ip: '192.0.2.1' }, res, next);
  await jest.advanceTimersByTimeAsync(3000); await pending;
  expect(res.status).toHaveBeenCalledWith(503); expect(next).not.toHaveBeenCalled();
  finish({ allowed: true, remaining: 4 }); await Promise.resolve();
  expect(next).not.toHaveBeenCalled(); expect(res.json).toHaveBeenCalledTimes(1);
});

test('an abandoned response never proceeds to protected work', async () => {
  cluster.rateLimitTick.mockResolvedValue({ allowed: true, remaining: 4 });
  const next = jest.fn(); await rateLimit(5, 60000)({ ip: '192.0.2.1' }, { destroyed: true }, next);
  expect(next).not.toHaveBeenCalled();
});

test.each([[0, 100], [5, 0], [NaN, 100], [5, Infinity], [1.1, 100]])('rejects invalid quota %p / %p', (max, window) => {
  expect(() => rateLimit(max, window)).toThrow('positive integers');
});
