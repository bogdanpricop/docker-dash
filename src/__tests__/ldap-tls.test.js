'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'ldap-tls-test', ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
const ldap = require('../services/ldap');
const { createLdapServer, fixture } = require('./helpers/ldap-server');
const cfg = (server, tls, extra = {}) => ({ host: '127.0.0.1', port: server.port, tls,
  bindDn: 'cn=service,dc=fixture', bindPassword: 'service-password', baseDn: 'dc=fixture', enabled: true, caCert: fixture('ca.pem'), ...extra });

async function run(operation, config) {
  if (operation === 'authenticate') { ldap.saveConfig(config); return ldap.authenticate('alice', 'user-password'); }
  if (operation === 'preview') return ldap.listUsers(config);
  return ldap.testConnection(config);
}

test.each([false, true].flatMap(tls => ['probe', 'preview', 'authenticate'].map(operation => [tls, operation])))('TLS=%s %s sends bind credentials only over verified encryption', async (ldaps, operation) => {
  const server = await createLdapServer({ ldaps });
  try {
    const result = await run(operation, cfg(server, ldaps));
    expect(result).toBeTruthy(); expect(server.binds.length).toBe(operation === 'authenticate' ? 2 : 1);
    expect(server.binds.every(bind => bind.encrypted)).toBe(true);
    if (!ldaps) expect(server.operations.filter(op => !op.encrypted).every(op => op.tag === 0x77)).toBe(true);
    if (operation === 'authenticate') expect(result.username).toBe('alice');
  } finally { await server.close(); }
});

test.each([false, true].flatMap(tls => ['missing-ca', 'wrong-ca', 'wrong-name', 'expired'].map(failure => [tls, failure])))('TLS=%s rejects %s without sending any bind password', async (ldaps, failure) => {
  const server = await createLdapServer({ ldaps, certificate: ['wrong-name', 'expired'].includes(failure) ? failure + '.pem' : 'server.pem' });
  try {
    const caCert = failure === 'missing-ca' ? null : fixture(failure === 'wrong-ca' ? 'wrong-ca.pem' : 'ca.pem');
    await expect(ldap.testConnection(cfg(server, ldaps, { caCert }))).rejects.toThrow(/certificate|hostname|altname|expired/i);
    expect(server.binds).toEqual([]);
  } finally { await server.close(); }
});

test('StartTLS refusal never falls back to plaintext bind', async () => {
  const server = await createLdapServer({ rejectStartTls: true });
  try {
    await expect(ldap.testConnection(cfg(server, false))).rejects.toThrow();
    expect(server.binds).toEqual([]); expect(server.operations[0].tag).toBe(0x77);
  } finally { await server.close(); }
});

test.each([true, 'trickle'])('a stalled StartTLS handshake (%s) has an absolute deadline and never sends a bind', async stallHandshake => {
  const server = await createLdapServer({ stallHandshake }); const started = Date.now();
  try {
    await expect(ldap.testConnection(cfg(server, false))).rejects.toThrow(/timed out|timeout/i);
    expect(Date.now() - started).toBeLessThan(12000); expect(server.binds).toEqual([]);
  } finally { await server.close(); }
}, 15000);

test.each([{ host: 'user:pass@host' }, { host: 'ldap://host' }, { host: 'host/path' }, { port: '389suffix' }, { port: 65536 }, { tlsSkipVerify: true }, { tls: 'false' }])('invalid transport settings are rejected before any connection %j', async bad => {
  const server = await createLdapServer();
  try { await expect(ldap.testConnection(cfg(server, false, bad))).rejects.toThrow(); expect(server.connections).toBe(0); }
  finally { await server.close(); }
});

test('an upgraded connection cannot be reopened for a plaintext bind', async () => {
  const { Client } = require('ldapts');
  const original = Client.prototype.startTLS;
  const server = await createLdapServer();
  const upgrade = jest.spyOn(Client.prototype, 'startTLS').mockImplementation(async function (options) {
    await original.call(this, options);
    // Closing the upgraded session exercises ldapts' transparent reconnect
    // path before the service performs its first bind.
    await this.unbind();
  });
  try {
    await expect(ldap.testConnection(cfg(server, false))).rejects.toThrow(/unencrypted reconnect refused/);
    expect(server.connections).toBe(1); expect(server.binds).toEqual([]);
  } finally { upgrade.mockRestore(); await server.close(); }
});
