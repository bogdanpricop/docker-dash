'use strict';

process.env.APP_SECRET = 'csrf-regression-test-secret';
process.env.ENCRYPTION_KEY = 'csrf-regression-encryption-key';
delete process.env.CSRF_DISABLED;
const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const config = require('../config');
const { encrypt, decrypt } = require('../utils/crypto');
const app = express();
app.use(cookieParser());
app.use(require('../middleware/csrf'));
app.use((_req, res) => res.json({ ok: true }));

test.each(['/api/status-page/config', '/api/status-page/items', '/api/auth/login-extra'])('%s cannot bypass CSRF', async path => {
  await request(app).post(path).expect(403);
});
test('real login and signed webhook routes remain exempt', async () => {
  await request(app).post('/api/auth/login').expect(200);
  await request(app).post('/api/git/webhook/example-token').expect(200);
  await request(app).post('/api/automation/webhooks/example').expect(200);
});
test('adding a fake Bearer header cannot bypass cookie-based CSRF', async () => {
  await request(app).post('/api/auth/ldap')
    .set('Cookie', `${config.session.cookieName}=session`)
    .set('Authorization', 'Bearer fake').expect(403);
});
test('SSO authentication cannot bypass CSRF using a fake Bearer header', async () => {
  await request(app).post('/api/auth/ldap')
    .set('X-Forwarded-User', 'admin').set('Authorization', 'Bearer fake').expect(403);
});
test.each(['Bearer token', 'ApiKey token'])('explicit %s clients do not need cookie CSRF tokens', async header => {
  await request(app).post('/api/containers').set('Authorization', header).expect(200);
});
test('matching double-submit tokens permit cookie-authenticated writes', async () => {
  await request(app).post('/api/status-page/config')
    .set('Cookie', `${config.session.cookieName}=session; XSRF-TOKEN=token`)
    .set('X-XSRF-TOKEN', 'token').expect(200);
});
test('encrypted credentials require the full 128-bit authentication tag', () => {
  const value = encrypt('secret');
  const [iv, tag, data] = value.split(':');
  expect(decrypt(value)).toBe('secret');
  expect(() => decrypt(`${iv}:${tag.slice(0, 8)}:${data}`)).toThrow();
  expect(() => decrypt(`${iv}:${tag}:${data}zz`)).toThrow();
});
