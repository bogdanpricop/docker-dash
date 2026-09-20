'use strict';

Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'ssh-entrypoints',
  ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
const mockConnect = jest.fn(), mockSftp = jest.fn(), mockExec = jest.fn(), mockEnd = jest.fn();
jest.mock('ssh2', () => {
  const { EventEmitter } = require('node:events');
  return { Client: class extends EventEmitter {
    connect(options) { mockConnect(options, this); }
    sftp(callback) { mockSftp(callback); }
    exec(command, options, callback) { mockExec(command, typeof options === 'function' ? options : callback); }
    end() { mockEnd(); }
    shell(_options, callback) { mockExec('shell', callback); }
  } };
});
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 1, username: 'admin', role: 'admin' }; next(); },
  requireRole: () => (_req, _res, next) => next(),
  writeable: (req, res, next) => req.get('x-read-only') ? res.status(403).json({ error: 'Read only' }) : next(),
  requireFeature: () => (_req, _res, next) => next(),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/proxmox', () => ({ fromHostRow: () => ({ version: async () => ({}) }), decryptDaemonConfig: JSON.parse }));
const express = require('express'), request = require('supertest'), { EventEmitter } = require('node:events');
const { getDb } = require('../db');
const { encryptSshConfig } = require('../services/host-config-crypto');
const audit = require('../services/audit');
const migration = require('../services/migration-vm');
const ws = require('../ws');
const app = express(); app.use(express.json()); app.use('/system', require('../routes/system'));
const pin = 'ab'.repeat(32);

function insertHost(type, hostKeySha256 = pin) {
  const sshConfig = { host: 'example.invalid', username: 'fixture', user: 'fixture', password: 'fixture-password', hostKeySha256 };
  return getDb().prepare(`INSERT INTO docker_hosts (name, connection_type, daemon_type, ssh_config, daemon_config)
    VALUES ('fixture', 'ssh', ?, ?, ?)`).run(type, encryptSshConfig(sshConfig), JSON.stringify({ sshConfig })).lastInsertRowid;
}

function verify(options) {
  expect(options.hostHash).toBe('sha256');
  expect(options.hostVerifier(pin)).toBe(true);
  expect(options.hostVerifier('cd'.repeat(32))).toBe(false);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockImplementation((options, client) => {
    verify(options);
    setImmediate(() => client.emit('error', new Error('Host denied (fixture)')));
  });
});

test('Proxmox migration applies the verifier before running any remote command', async () => {
  const hostId = insertHost('proxmox');
  const id = getDb().prepare(`INSERT INTO migration_jobs
    (source_type, source_url, source_format, destination_host_id, destination_node, destination_storage,
     destination_vmid, destination_vm_name, status, progress)
    VALUES ('url', 'https://example.invalid/source.qcow2', 'qcow2', ?, 'fixture', 'local', 901, 'fixture', 'pending', 0)`)
    .run(hostId).lastInsertRowid;
  await migration.runJob(id);
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockExec).not.toHaveBeenCalled();
  expect(migration.getJob(id).status).toBe('failed');
});

test('ESXi terminal applies the verifier and never opens a shell on rejection', async () => {
  const hostId = insertHost('vsphere');
  const socket = { send: jest.fn(), readyState: 1 };
  ws.clients.set(socket, { user: { id: 1, username: 'admin', role: 'admin' } });
  try {
    await ws.startVsphereSsh(socket, hostId);
    await new Promise(resolve => setImmediate(resolve));
    expect(mockConnect).toHaveBeenCalledTimes(1); expect(mockExec).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('Host denied'));
  } finally { ws.clients.delete(socket); }
});

test('remote secrets deploy decrypts SSH config and refuses a rejected server before upload', async () => {
  const response = await request(app).post('/system/secrets-wizard/deploy-remote').send({ hostId: insertHost('docker'), script: 'true' });
  expect(response.status).toBe(500);
  expect(mockConnect).toHaveBeenCalledTimes(1); expect(mockSftp).not.toHaveBeenCalled();
  expect(mockConnect.mock.calls[0][0].password).toBe('fixture-password');
});

test('remote secrets deploy requires trust and respects read-only mode', async () => {
  const hostId = insertHost('docker', '');
  const missing = await request(app).post('/system/secrets-wizard/deploy-remote').send({ hostId, script: 'true' });
  expect(missing.status).toBe(400); expect(missing.body.error).toContain('hostKeySha256');
  const readonly = await request(app).post('/system/secrets-wizard/deploy-remote').set('x-read-only', 'true').send({ hostId, script: 'true' });
  expect(readonly.status).toBe(403); expect(mockConnect).not.toHaveBeenCalled();
});

test('remote secret script uses stdin without SFTP and audit contains only its hash', async () => {
  mockConnect.mockImplementation((options, client) => { verify(options); setImmediate(() => client.emit('ready')); });
  const script = 'TOKEN=never-record-this-secret\ntrue';
  mockExec.mockImplementation((command, callback) => {
    expect(command).not.toContain('never-record-this-secret');
    const marker = command.match(/DD_SCRIPT_VERIFIED_[a-f0-9]{32}/)[0];
    const channel = new EventEmitter(); channel.stderr = new EventEmitter();
    channel.end = data => {
      expect(data.toString()).toBe(script);
      setImmediate(() => { channel.emit('data', Buffer.from(marker + '\n')); channel.emit('close', 0); });
    };
    callback(null, channel);
  });
  const response = await request(app).post('/system/secrets-wizard/deploy-remote').send({ hostId: insertHost('docker'), script });
  expect(response.status).toBe(200); expect(response.body.ok).toBe(true);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(mockSftp).not.toHaveBeenCalled();
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'secrets_deploy_remote',
    details: expect.objectContaining({ scriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }));
  expect(JSON.stringify(audit.log.mock.calls)).not.toContain('never-record-this-secret');
  expect(JSON.stringify(audit.log.mock.calls)).not.toContain('scriptPreview');
});

test('remote secrets deploy bounds stdout and stderr together and terminates excessive output', async () => {
  mockConnect.mockImplementation((options, client) => { verify(options); setImmediate(() => client.emit('ready')); });
  mockSftp.mockImplementation(callback => callback(null, { createWriteStream() {
    const stream = new EventEmitter(); stream.end = () => setImmediate(() => stream.emit('close')); return stream;
  } }));
  mockExec.mockImplementation((_command, callback) => {
    const channel = new EventEmitter(); channel.stderr = new EventEmitter(); channel.end = () => {}; callback(null, channel);
    setImmediate(() => {
      channel.emit('data', Buffer.alloc(600000)); channel.stderr.emit('data', Buffer.alloc(600000));
    });
  });
  const response = await request(app).post('/system/secrets-wizard/deploy-remote').send({ hostId: insertHost('docker'), script: 'true' });
  expect(response.status).toBe(500); expect(mockEnd).toHaveBeenCalled();
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'secrets_deploy_remote_failed' }));
  expect(response.body.output).toBeUndefined();
});


test.each([{ useSudo: 'false' }, { script: 'contains\0NUL' }])('remote secret execution rejects invalid input before SSH: %j', async fields => {
  const response = await request(app).post('/system/secrets-wizard/deploy-remote').send({ hostId: insertHost('docker'), script: 'true', ...fields });
  expect(response.status).toBe(400); expect(mockConnect).not.toHaveBeenCalled();
});

test('remote secret execution does not start when intent audit cannot be saved', async () => {
  audit.log.mockImplementationOnce(() => { throw new Error('storage unavailable'); });
  const response = await request(app).post('/system/secrets-wizard/deploy-remote').send({ hostId: insertHost('docker'), script: 'true' });
  expect(response.status).toBe(500); expect(mockConnect).not.toHaveBeenCalled();
});


test.each(['1garbage', '1.5', '0', '-1', '9007199254740992'])('remote deploy refuses ambiguous host ID %s', async hostId => {
  const response = await request(app).post('/system/secrets-wizard/deploy-remote').send({ hostId, script: 'true' });
  expect(response.status).toBe(400); expect(mockConnect).not.toHaveBeenCalled();
});

test('an interrupted execution is reported as uncertain and audited without output', async () => {
  mockConnect.mockImplementation((options, client) => { verify(options); setImmediate(() => client.emit('ready')); });
  mockExec.mockImplementation((_command, callback) => {
    const channel = new EventEmitter(); channel.stderr = new EventEmitter();
    channel.end = () => setImmediate(() => channel.emit('error', new Error('secret-should-not-be-logged')));
    callback(null, channel);
  });
  const response = await request(app).post('/system/secrets-wizard/deploy-remote').send({ hostId: insertHost('docker'), script: 'true' });
  expect(response.status).toBe(500); expect(response.body.outcomeUnknown).toBe(true);
  expect(response.body.error).toContain('check the host before retrying');
  expect(response.body.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(audit.log.mock.calls)).not.toContain('secret-should-not-be-logged');
});
