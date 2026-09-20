'use strict';

Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'ssh-identity-tests',
  ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
const { createHash } = require('node:crypto');
const { Client, Server, utils } = require('ssh2');
const { normalizeFingerprint, hostKeyOptions } = require('../utils/ssh-host-key');
const { generateKeyPair } = require('../services/ssh-keygen');
const tunnel = require('../services/ssh-tunnel');
const deploy = require('../services/ssh-deploy');
const vsphere = require('../services/vsphere-ssh');
const { XenRawClient } = require('../services/xen');

test.each(['', null, {}, 'SHA256:bad', 'zz'.repeat(32), 'ab'.repeat(31),
  'SHA256:' + 'A'.repeat(42) + 'B', 'SHA256:' + 'A'.repeat(43) + '==',
  'SHA256:' + 'A'.repeat(42) + '-', 'SHA256:' + 'A'.repeat(43) + '\nignored'])('rejects malformed or absent pin %j', value => {
  expect(() => normalizeFingerprint(value)).toThrow(/hostKeySha256/);
});

test('normalizes exact hexadecimal and OpenSSH encodings and compares all digest bytes', () => {
  const expected = Buffer.alloc(32, 0xab);
  const openSsh = 'SHA256:' + expected.toString('base64').replace(/=+$/, '');
  expect(normalizeFingerprint(openSsh)).toBe(expected.toString('hex'));
  expect(normalizeFingerprint(openSsh + '=')).toBe(expected.toString('hex'));
  expect(normalizeFingerprint(expected.toString('hex').toUpperCase())).toBe(expected.toString('hex'));
  const options = hostKeyOptions({ hostKeySha256: openSsh });
  expect(options.hostHash).toBe('sha256');
  expect(options.hostVerifier(expected.toString('hex'))).toBe(true);
  for (const invalid of [null, '', Buffer.alloc(32), expected.toString('hex').slice(2), 'ac' + expected.toString('hex').slice(2)]) {
    expect(options.hostVerifier(invalid)).toBe(false);
  }
});

describe('real SSH handshake refuses a different host key before authentication', () => {
  let server, port, fingerprint, authentication, connections, clients;
  beforeAll(async () => {
    const key = generateKeyPair({ type: 'ed25519', comment: 'ephemeral-test-server' });
    fingerprint = createHash('sha256').update(utils.parseKey(key.privateKey).getPublicSSH()).digest('hex');
    clients = new Set();
    server = new Server({ hostKeys: [key.privateKey] }, client => {
      connections++; clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('error', () => {});
      client.on('authentication', context => {
        authentication.push(context.method);
        if (context.method === 'password' && context.password === 'fixture-password') context.accept();
        else context.reject(['password']);
      });
      client.on('ready', () => client.on('session', accept => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const channel = acceptExec();
          const output = info.command.startsWith('esxcli') ? '[{"Product":"fixture","Version":"test"}]\n'
            : info.command.includes('socket=') ? 'socket=ok\nsocat=ok\ndocker=fixture\n' : 'fixture-user\n';
          channel.write(output); channel.exit(0); channel.end();
        });
      }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  beforeEach(() => { authentication = []; connections = 0; });
  afterAll(async () => {
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
  });

  async function connect(engine, hostKeySha256) {
    const config = { host: '127.0.0.1', port, user: 'fixture', username: 'fixture',
      password: 'fixture-password', hostKeySha256 };
    if (engine === 'docker') return tunnel.testConnection(config);
    if (engine === 'deployer') return deploy.testConnection({ targetType: 'linux', connection: config });
    if (engine === 'vsphere') return vsphere.testSsh(config);
    if (engine === 'xen') {
      const xen = new XenRawClient({ sshHost: config.host, sshPort: port, sshUsername: config.user,
        sshPassword: config.password, hostKeySha256 });
      const client = await xen._connect(); client.end(); return { ok: true };
    }
    const identity = hostKeyOptions(config);
    return new Promise((resolve, reject) => {
      const client = new Client();
      client.on('error', reject);
      client.on('ready', () => { client.end(); resolve({ ok: true }); });
      client.connect({ ...config, ...identity, readyTimeout: 3000 });
    });
  }

  test.each(['client', 'docker', 'deployer', 'vsphere', 'xen'])('%s authenticates only with the expected host key', async engine => {
    expect(await connect(engine, fingerprint)).toMatchObject({ ok: true });
    expect(authentication).toContain('password');
  });

  test.each(['client', 'docker', 'deployer', 'vsphere', 'xen'])('%s rejects an impostor before sending authentication', async engine => {
    await expect(connect(engine, '00'.repeat(32))).rejects.toThrow(/host|handshake|verification/i);
    expect(authentication).toEqual([]);
    expect(connections).toBe(1);
  });

  test.each(['client', 'docker', 'deployer', 'vsphere', 'xen'])('%s refuses missing trust before connecting', async engine => {
    await expect(connect(engine, undefined)).rejects.toThrow(/hostKeySha256 is required/);
    expect(authentication).toEqual([]); expect(connections).toBe(0);
  });
});
