'use strict';

jest.mock('../services/auth', () => ({ validateSession: jest.fn(), findOrCreateSsoUser: jest.fn() }));
jest.mock('../services/misc', () => ({ apiKeys: { validate: jest.fn() } }));
jest.mock('../config', () => ({ features: { ssoHeaders: true }, session: { cookieName: 'session' } }));
jest.mock('../utils/logger', () => () => ({ warn: jest.fn() }));
const express = require('express');
const request = require('supertest');

function app(trusted) {
  process.env.SSO_TRUSTED_PROXY_IPS = trusted;
  jest.resetModules();
  const auth = require('../services/auth');
  auth.findOrCreateSsoUser.mockReturnValue({ id: 1, username: 'sso', role: 'admin' });
  const { requireAuth } = require('../middleware/auth');
  const server = express(); server.set('trust proxy', 'loopback');
  server.get('/', requireAuth, (q, s) => s.json({ username: q.user.username }));
  return { server, auth };
}
const original = process.env.SSO_TRUSTED_PROXY_IPS;
afterAll(() => { if (original === undefined) delete process.env.SSO_TRUSTED_PROXY_IPS; else process.env.SSO_TRUSTED_PROXY_IPS = original; });

test('resolved client IP matching the proxy allow-list cannot authenticate an untrusted peer', async () => {
  const { server, auth } = app('203.0.113.50');
  const res = await request(server).get('/').set('X-Forwarded-For', '203.0.113.50')
    .set('X-Forwarded-User', 'admin').set('X-Forwarded-Groups', 'admin');
  expect(res.status).toBe(401); expect(auth.findOrCreateSsoUser).not.toHaveBeenCalled();
});
test('an allow-listed socket proxy can forward an external client without granting that client proxy trust', async () => {
  const { server, auth } = app('127.0.0.1,::1');
  const res = await request(server).get('/').set('X-Forwarded-For', '203.0.113.50').set('X-Forwarded-User', 'alice');
  expect(res.status).toBe(200); expect(auth.findOrCreateSsoUser).toHaveBeenCalledWith('alice', 'viewer', '');
});
test('missing SSO proxy configuration refuses asserted identity', async () => {
  const { server, auth } = app('');
  const res = await request(server).get('/').set('Remote-User', 'admin');
  expect(res.status).toBe(401); expect(auth.findOrCreateSsoUser).not.toHaveBeenCalled();
});
