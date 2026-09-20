'use strict';

jest.mock('../services/cluster', () => ({ rateLimitTick: jest.fn().mockRejectedValue(new Error('Redis unavailable')) }));
jest.mock('../services/auth', () => ({ login: jest.fn(), verifyMfa: jest.fn(), verifyMfaRecovery: jest.fn() }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/email', () => ({}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('Protected handler reached database'); }) }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (_q, s) => s.sendStatus(401), requireRole: () => (_q, s) => s.sendStatus(403),
  writeable: (_q, _s, next) => next(),
}));
const request = require('supertest');
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/auth', require('../routes/auth'));

test.each(['/login', '/mfa/verify', '/mfa/recovery', '/request-password-reset', '/validate-reset-token', '/reset-password-token'])
('real auth route %s blocks before authentication or database work when quota is unavailable', async route => {
  const res = await request(app).post('/api/auth' + route).send({ username: 'admin', password: 'example', token: 'example' });
  expect(res.status).toBe(503); expect(res.headers['set-cookie']).toBeUndefined();
  expect(require('../db').getDb).not.toHaveBeenCalled();
  for (const fn of Object.values(require('../services/auth'))) expect(fn).not.toHaveBeenCalled();
});
