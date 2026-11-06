'use strict';

Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'ssh-config-tests',
  ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'admin', role: 'admin' }; next(); },
  requireRole: () => (_req, _res, next) => next(), writeable: (_req, _res, next) => next(),
}));
jest.mock('../middleware/hostAccess', () => ({ requireHostAccess: () => (_req, _res, next) => next() }));
jest.mock('../services/docker', () => ({
  getHostStatus: () => ({ healthy: true }), _getHostConfig: jest.fn(() => ({})), dropConnection: jest.fn(),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/ssh-tunnel', () => ({ createTunnel: jest.fn(), closeTunnel: jest.fn(), testConnection: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/connection-health', () => ({ resume: jest.fn() }));
const express = require('express');
const request = require('supertest');
const { getDb } = require('../db');
const { decryptSshConfig } = require('../services/host-config-crypto');
const tunnel = require('../services/ssh-tunnel');
const app = express(); app.use(express.json()); app.use('/hosts', require('../routes/hosts'));
app.use('/keys', require('../routes/ssh-keys'));
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
const pin = 'ab'.repeat(32), replacementPin = 'cd'.repeat(32);
const ssh = { name: 'fixture', connectionType: 'ssh', sshHost: 'example.invalid', sshUsername: 'fixture',
  sshPrivateKey: 'private-fixture', sshPassphrase: 'phrase-fixture', sshHostKeySha256: pin };
const row = id => getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(id);

beforeEach(() => { jest.clearAllMocks(); });

test.each([undefined, '', 'invalid'])('new SSH host rejects missing or invalid identity %j before persistence', async invalid => {
  const before = getDb().prepare('SELECT COUNT(*) AS total FROM docker_hosts').get().total;
  const response = await request(app).post('/hosts').send({ ...ssh, sshHostKeySha256: invalid });
  expect(response.status).toBe(400);
  expect(getDb().prepare('SELECT COUNT(*) AS total FROM docker_hosts').get().total).toBe(before);
  expect(tunnel.createTunnel).not.toHaveBeenCalled();
});

test('editing a Docker fingerprint retains encrypted credentials and exposes only the nonsecret pin', async () => {
  const created = await request(app).post('/hosts').send(ssh);
  expect(created.status).toBe(201);
  const id = created.body.id;
  const updated = await request(app).put(`/hosts/${id}`).send({ ...ssh, sshHostKeySha256: replacementPin,
    sshPrivateKey: '', sshPassword: '', sshPassphrase: '' });
  expect(updated.status).toBe(200);
  expect(decryptSshConfig(row(id).ssh_config)).toMatchObject({ hostKeySha256: replacementPin,
    privateKey: 'private-fixture', passphrase: 'phrase-fixture' });
  expect(row(id).ssh_config).not.toContain('private-fixture');
  const response = await request(app).get(`/hosts/${id}`);
  expect(response.body.sshHostKeySha256).toBe(replacementPin);
  expect(JSON.stringify(response.body)).not.toContain('private-fixture');
  expect(JSON.stringify(response.body)).not.toContain('phrase-fixture');
  const test = await request(app).post('/hosts/test').send({ ...ssh, hostId: id,
    sshHostKeySha256: replacementPin, sshPrivateKey: '', sshPassphrase: '' });
  expect(test.status).toBe(200);
  expect(tunnel.testConnection).toHaveBeenCalledWith(expect.objectContaining({
    hostKeySha256: replacementPin, privateKey: 'private-fixture', passphrase: 'phrase-fixture',
  }));
});

test('explicit password replaces stored private-key authentication', async () => {
  const created = await request(app).post('/hosts').send(ssh);
  const id = created.body.id;
  const updated = await request(app).put(`/hosts/${id}`).send({ ...ssh, sshPrivateKey: '', sshPassword: 'new-password' });
  expect(updated.status).toBe(200);
  const config = decryptSshConfig(row(id).ssh_config);
  expect(config.password).toBe('new-password'); expect(config.privateKey).toBeUndefined();
});

test.each(['vsphere', 'proxmox'])('%s pin-only update preserves nested SSH secrets', async daemonType => {
  const provider = require(`../services/${daemonType}`);
  const created = await request(app).post('/hosts').send({ name: daemonType, daemonType, daemonConfig: {
    endpoint: 'https://example.invalid', username: 'fixture', password: 'api-secret',
    sshConfig: { host: 'example.invalid', user: 'fixture', privateKey: 'nested-private', hostKeySha256: pin },
  } });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const updated = await request(app).put(`/hosts/${id}`).send({ daemonConfig: {
    sshConfig: { hostKeySha256: replacementPin, privateKey: '', password: '' },
  } });
  expect(updated.status).toBe(200);
  expect(provider.decryptDaemonConfig(row(id).daemon_config).sshConfig).toMatchObject({
    hostKeySha256: replacementPin, privateKey: 'nested-private', host: 'example.invalid', user: 'fixture',
  });
  const response = await request(app).get(`/hosts/${id}`);
  expect(response.body.daemonConfig.sshHostKeySha256).toBe(replacementPin);
  expect(response.body.daemonConfig.sshKeyPresent).toBe(true);
  expect(JSON.stringify(response.body)).not.toContain('nested-private');
  const passwordUpdate = await request(app).put(`/hosts/${id}`).send({ daemonConfig: {
    sshConfig: { password: 'replacement-password', privateKey: '' },
  } });
  expect(passwordUpdate.status).toBe(200);
  const replacement = provider.decryptDaemonConfig(row(id).daemon_config).sshConfig;
  expect(replacement.password).toBe('replacement-password');
  expect(replacement.privateKey).toBeUndefined();
  expect(replacement.hostKeySha256).toBe(replacementPin);
});

test('attaching a vSphere key also requires and preserves the server fingerprint', async () => {
  const created = await request(app).post('/hosts').send({ name: 'vsphere', daemonType: 'vsphere', daemonConfig: { endpoint: 'https://example.invalid' } });
  const hostId = created.body.id;
  const config = { host: 'example.invalid', user: 'fixture', privateKey: 'new-private' };
  const invalid = await request(app).post('/keys/attach-vsphere').send({ hostId, sshConfig: config });
  expect(invalid.status).toBe(400);
  const response = await request(app).post('/keys/attach-vsphere').send({ hostId, sshConfig: { ...config, hostKeySha256: pin } });
  expect(response.status).toBe(200);
  const saved = require('../services/vsphere').decryptDaemonConfig(row(hostId).daemon_config);
  expect(saved.sshConfig).toMatchObject({ ...config, hostKeySha256: pin });
});

test.each(['incus', 'lxd', 'proxmox', 'kubernetes', 'nomad', 'vsphere'])('%s validates CA updates and preserves encrypted credentials', async daemonType => {
  const ca = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/provider-tls/ca.pem'), 'utf8');
  const config = { transport: 'https', endpoint: 'https://provider.example', caCert: ca,
    token: 'provider-token', tokenSecret: 'provider-token-secret', password: 'provider-password', cert: 'client-cert', key: 'client-key' };
  const created = await request(app).post('/hosts').send({ name: daemonType + '-tls', daemonType, daemonConfig: config });
  expect(created.status).toBe(201); const id = created.body.id;
  const original = row(id).daemon_config;
  const invalid = await request(app).put(`/hosts/${id}`).send({ daemonConfig: { caCert: 'malformed' } });
  expect(invalid.status).toBe(400); expect(row(id).daemon_config).toBe(original);
  const insecure = await request(app).put(`/hosts/${id}`).send({ daemonConfig: { skipTlsVerify: true } });
  expect(insecure.status).toBe(400); expect(row(id).daemon_config).toBe(original);
  const plain = await request(app).put(`/hosts/${id}`).send({ daemonConfig: { endpoint: 'http://provider.example' } });
  expect(plain.status).toBe(400); expect(row(id).daemon_config).toBe(original);
  const edit = await request(app).put(`/hosts/${id}`).send({ daemonConfig: { password: '', token: '', caCert: '', skipTlsVerify: false } });
  expect(edit.status).toBe(200);
  const provider = require('../services/' + (daemonType === 'lxd' ? 'incus' : daemonType));
  expect(provider.decryptDaemonConfig(row(id).daemon_config)).toMatchObject(config);
  const publicConfig = (await request(app).get(`/hosts/${id}`)).body.daemonConfig;
  expect(publicConfig.caCertPresent).toBe(true); expect(JSON.stringify(publicConfig)).not.toContain('provider-password');
  const clear = await request(app).put(`/hosts/${id}`).send({ daemonConfig: { caCert: null } });
  expect(clear.status).toBe(200); expect(provider.decryptDaemonConfig(row(id).daemon_config).caCert).toBeNull();
  getDb().prepare('UPDATE docker_hosts SET daemon_config = ? WHERE id = ?').run('enc:invalid-ciphertext', id);
  const broken = await request(app).put(`/hosts/${id}`).send({ daemonConfig: { caCert: ca } });
  expect(broken.status).toBe(409); expect(row(id).daemon_config).toBe('enc:invalid-ciphertext');
});
