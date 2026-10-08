'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'ldap-api-tls', ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
jest.mock('../middleware/auth', () => ({ requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'fixture', role: 'admin' }; next(); }, requireRole: () => (_req, _res, next) => next(), writeable: (_req, _res, next) => next() }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
const express = require('express'), request = require('supertest');
const ldap = require('../services/ldap');
const { getDb } = require('../db');
const { fixture } = require('./helpers/ldap-server');
const app = express(); app.use(express.json()); app.use('/auth', require('../routes/auth'));
const config = { host: 'ldap.example.invalid', tls: false, port: 389, bindDn: 'cn=service,dc=fixture',
  bindPassword: 'service-password', baseDn: 'dc=fixture', caCert: fixture('ca.pem') };
const stored = () => getDb().prepare("SELECT value FROM settings WHERE key='ldap_config'").get()?.value;
beforeEach(() => ldap.deleteConfig()); afterEach(() => jest.restoreAllMocks());

test('save/test preserve encrypted password and CA; explicit clear uses system CA trust', async () => {
  expect((await request(app).put('/auth/ldap').send(config)).status).toBe(200);
  expect(stored()).not.toContain('service-password');
  const publicConfig = (await request(app).get('/auth/ldap')).body;
  expect(publicConfig.caCertPresent).toBe(true); expect(publicConfig.caCert).toBeUndefined();
  expect(publicConfig.bindPassword).not.toBe(config.bindPassword);
  const update = { ...config, bindPassword: '', caCert: '', tls: true, port: 636 };
  expect((await request(app).put('/auth/ldap').send(update)).status).toBe(200);
  expect(ldap.getConfig()).toMatchObject({ bindPassword: config.bindPassword, caCert: config.caCert, tls: true });
  const probe = jest.spyOn(ldap, 'testConnection').mockResolvedValue({ ok: true, usersFound: 1 });
  expect((await request(app).post('/auth/ldap/test').send(update)).status).toBe(200);
  expect(probe).toHaveBeenCalledWith(expect.objectContaining({ bindPassword: config.bindPassword, caCert: config.caCert }));
  expect((await request(app).put('/auth/ldap').send({ ...update, caCert: null })).status).toBe(200);
  expect(ldap.getConfig().caCert).toBeNull(); expect(ldap.getConfig().bindPassword).toBe(config.bindPassword);
});

test.each([{ tlsSkipVerify: true }, { caCert: 'invalid' }, { host: 'user@ldap.example' }, { port: '389junk' }, { port: -1 }, { tls: 'false' }])('invalid configuration is refused without modifying storage: %j', async invalid => {
  expect((await request(app).put('/auth/ldap').send(config)).status).toBe(200);
  const before = stored();
  const response = await request(app).put('/auth/ldap').send({ ...config, ...invalid });
  expect(response.status).toBe(400); expect(stored()).toBe(before);
});

test('new configuration requires a service password and corrupt encrypted settings are not overwritten', async () => {
  expect((await request(app).put('/auth/ldap').send({ ...config, bindPassword: '' })).status).toBe(400);
  expect(stored()).toBeUndefined();
  expect((await request(app).put('/auth/ldap').send(config)).status).toBe(200);
  const damaged = JSON.parse(stored()); damaged.bindPasswordEncrypted = 'invalid';
  getDb().prepare("UPDATE settings SET value=? WHERE key='ldap_config'").run(JSON.stringify(damaged));
  const before = stored();
  expect((await request(app).put('/auth/ldap').send(config)).status).toBe(500);
  expect(stored()).toBe(before);
});
