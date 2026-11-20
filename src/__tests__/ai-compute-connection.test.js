'use strict';

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';
jest.mock('../services/host-config-crypto', () => ({ decryptSshConfig: jest.fn() }));
const { getDb, closeDb } = require('../db');
const { decryptSshConfig } = require('../services/host-config-crypto');
const service = require('../services/ai-compute-connection');
let db, host, ssh;
const observation = { title: 'Private tunnel', route: ['DGX initiates outbound SSH to VPS'], protections: ['Dedicated key-only account'], operations: ['Keepalives enabled'], privateKey: 'DO NOT STORE' };
beforeAll(() => {
  db = getDb();
  host = db.prepare("INSERT INTO docker_hosts(name,connection_type,ssh_config) VALUES ('Spark','ssh','encrypted')").run().lastInsertRowid;
});
afterAll(() => closeDb());
beforeEach(() => {
  db.prepare('DELETE FROM ai_compute_hosts WHERE host_id=?').run(host);
  db.prepare("UPDATE docker_hosts SET connection_type='ssh',is_active=1 WHERE id=?").run(host);
  ssh = { host: '172.23.0.1', port: 12223, username: 'admin', dockerSocket: '/var/run/docker.sock', hostKeySha256: 'ab'.repeat(32),
    password: 'secret-password', privateKey: 'secret-private-key', passphrase: 'secret-passphrase', nested: { token: 'secret-token' } };
  decryptSshConfig.mockReset().mockImplementation(() => ssh);
});
test('offline metadata returns only public fields and the normalized server fingerprint', () => {
  const result = service.get(host);
  expect(result).toMatchObject({ endpoint: '172.23.0.1', port: 12223, authentication: 'SSH key', recordStatus: 'unrecorded', deployment: null });
  expect(result.fingerprint).toBe('SHA256:' + Buffer.from('ab'.repeat(32), 'hex').toString('base64').replace(/=+$/, ''));
  expect(JSON.stringify(result)).not.toMatch(/secret-|password|privateKey|passphrase|nested/);
});
test('inspection is dated, excludes unknown fields and preserves monitoring', () => {
  db.prepare('INSERT INTO ai_compute_hosts(host_id,monitoring,updated_at) VALUES (?,1,?)').run(host, new Date().toISOString());
  const result = service.recordDeploymentInfo(host, observation);
  expect(result.recordStatus).toBe('recorded');
  expect(result.deployment.title).toBe('Private tunnel');
  expect(Number.isFinite(Date.parse(result.deployment.verifiedAt))).toBe(true);
  expect(db.prepare('SELECT monitoring FROM ai_compute_hosts WHERE host_id=?').get(host).monitoring).toBe(1);
  expect(db.prepare('SELECT connection_info_json FROM ai_compute_hosts WHERE host_id=?').get(host).connection_info_json).not.toMatch(/DO NOT STORE|secret-/);
});
test.each(['host','port','username','dockerSocket','hostKeySha256'])('changing %s hides previous deployment assertions', field => {
  service.recordDeploymentInfo(host, observation);
  ssh[field] = field === 'port' ? 22 : field === 'hostKeySha256' ? 'cd'.repeat(32) : 'changed';
  expect(service.get(host)).toMatchObject({ recordStatus: 'stale', deployment: null });
});
test('secret rotation keeps an unchanged public identity and never stores a secret-derived hash', () => {
  service.recordDeploymentInfo(host, observation);
  ssh.privateKey = 'rotated-private-key'; ssh.password = 'rotated-password'; ssh.passphrase = 'rotated-passphrase';
  expect(service.get(host).recordStatus).toBe('recorded');
  delete ssh.privateKey;
  expect(service.get(host)).toMatchObject({ authentication: 'Password over SSH', recordStatus: 'stale', deployment: null });
});
test('malformed/missing pins are explicit and cannot be recorded as inspected', () => {
  ssh.hostKeySha256 = 'invalid';
  expect(service.get(host).fingerprint).toBe(null);
  expect(() => service.recordDeploymentInfo(host, observation)).toThrow(/valid server fingerprint/);
});
test('unavailable credentials and corrupt snapshots do not expose decryption internals', () => {
  service.recordDeploymentInfo(host, observation);
  decryptSshConfig.mockImplementation(() => { throw new Error('secret-private-key'); });
  expect(service.get(host)).toMatchObject({ configurationAvailable: false, recordStatus: 'stale', deployment: null });
  expect(JSON.stringify(service.get(host))).not.toContain('secret-');
  db.prepare("UPDATE ai_compute_hosts SET connection_info_json='invalid' WHERE host_id=?").run(host);
  expect(service.get(host).recordStatus).toBe('unrecorded');
});
test('inactive/missing hosts are rejected and socket hosts never decrypt credentials', () => {
  db.prepare("UPDATE docker_hosts SET connection_type='socket' WHERE id=?").run(host);
  expect(service.get(host).connectionType).toBe('socket');
  expect(decryptSshConfig).not.toHaveBeenCalled();
  db.prepare('UPDATE docker_hosts SET is_active=0 WHERE id=?').run(host);
  expect(() => service.get(host)).toThrow(/Host not found/);
  expect(() => service.get(999999)).toThrow(/Host not found/);
});
