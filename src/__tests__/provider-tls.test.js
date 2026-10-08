'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'provider-tls-test', ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
const fs = require('node:fs'), path = require('node:path'), https = require('node:https');
const { tlsOptions, secureEndpoint } = require('../utils/provider-tls');
const { IncusClient } = require('../services/incus');
const { ProxmoxClient } = require('../services/proxmox');
const { VSphereClient } = require('../services/vsphere');
const { KubernetesClient, buildKubeconfig, encryptDaemonConfig } = require('../services/kubernetes');
const { NomadClient } = require('../services/nomad');
const { XenOrchestraClient, XapiClient } = require('../services/xen');
const fixture = file => fs.readFileSync(path.join(__dirname, 'fixtures/provider-tls', file), 'utf8');
const ca = fixture('ca.pem'), key = fixture('server.key');
const providers = ['incus', 'lxd', 'proxmox', 'vsphere', 'kubernetes', 'nomad', 'xo', 'xapi'];
function clientFor(provider, endpoint, extra = {}) {
  const config = { endpoint, ...extra };
  if (provider === 'incus' || provider === 'lxd') return new IncusClient({ transport: 'https', daemonType: provider, cert: fixture('client.pem'), key: fixture('client.key'), ...config });
  if (provider === 'proxmox') return new ProxmoxClient({ tokenId: 'fixture@pam!dd', tokenSecret: 'fixture-secret', ...config });
  if (provider === 'vsphere') return new VSphereClient({ username: 'fixture', password: 'fixture-secret', ...config });
  if (provider === 'kubernetes') return new KubernetesClient({ token: 'fixture-secret', ...config });
  if (provider === 'nomad') return new NomadClient({ token: 'fixture-secret', ...config });
  if (provider === 'xo') return new XenOrchestraClient({ token: 'fixture-secret', ...config });
  return new XapiClient({ username: 'fixture', password: 'fixture-secret', ...config });
}
function request(client, provider) {
  if (provider === 'vsphere') return client._soapPost('<Login>fixture-secret</Login>');
  if (provider === 'xapi') return client._rpcJson('session.login_with_password', ['fixture', 'fixture-secret']);
  return client._request('GET', '/fixture');
}
function closeClient(client) { client._agent?.destroy(); client._config?._agent?.destroy(); }

test.each(providers)('%s refuses plaintext and explicit TLS bypass before connecting', provider => {
  expect(() => clientFor(provider, 'http://127.0.0.1:12345')).toThrow(/HTTPS/);
  expect(() => clientFor(provider, 'https://127.0.0.1:12345', { skipTlsVerify: true })).toThrow(/TLS verification is required/);
});
test.each(['bad PEM', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', 'x'.repeat(131073), 123, {}])('rejects malformed CA %j', caCert => {
  expect(() => tlsOptions({ caCert })).toThrow(/CA/);
});
test('validates every PEM and refuses private keys and extra content', () => {
  expect(tlsOptions({ caCert: ca }).rejectUnauthorized).toBe(true);
  expect(() => tlsOptions({ caCert: ca + key })).toThrow(/only PEM certificates/);
  expect(() => tlsOptions({ caCert: ca + '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' })).toThrow(/Invalid/);
  expect(() => tlsOptions({ skipTlsVerify: 'false' })).toThrow();
  expect(secureEndpoint('private.example:8443')).toBe('https://private.example:8443');
  for (const endpoint of ['https://user:password@host', 'https://host/#fragment', 'https://host/\nunsafe']) expect(() => secureEndpoint(endpoint)).toThrow();
});

describe('real TLS connections', () => {
  let servers, requests;
  beforeAll(async () => {
    servers = {}; requests = [];
    for (const name of ['server', 'wrong-name', 'expired', 'mtls']) {
      const server = https.createServer({ key, cert: fixture((name === 'mtls' ? 'server' : name) + '.pem'),
        ...(name === 'mtls' ? { ca, requestCert: true, rejectUnauthorized: true } : {}) }, (req, res) => {
        requests.push({ server: name, headers: req.headers, authorized: req.socket.authorized });
        req.resume(); res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: 'fixture-session', data: { ok: true }, metadata: { ok: true }, status_code: 200 }));
      });
      server.on('tlsClientError', () => {});
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      servers[name] = server;
    }
  });
  beforeEach(() => { requests = []; });
  afterAll(async () => { for (const server of Object.values(servers)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const endpoint = server => `https://127.0.0.1:${servers[server].address().port}`;

  test.each(providers)('%s verifies a private CA before sending API credentials', async provider => {
    const client = clientFor(provider, endpoint('server'), { caCert: ca });
    try { await request(client, provider); expect(requests).toHaveLength(1); }
    finally { closeClient(client); }
  });
  test.each(providers.flatMap(provider => ['untrusted', 'wrong-ca', 'wrong-name', 'expired'].map(failure => [provider, failure])))('%s rejects %s without sending any HTTP request', async (provider, failure) => {
    const target = ['wrong-name', 'expired'].includes(failure) ? failure : 'server';
    const client = clientFor(provider, endpoint(target), failure === 'untrusted' ? {} : { caCert: failure === 'wrong-ca' ? fixture('wrong-ca.pem') : ca });
    try { await expect(request(client, provider)).rejects.toThrow(/certificate|hostname|expired|altname/i); expect(requests).toEqual([]); }
    finally { closeClient(client); }
  });
  test.each(['incus', 'lxd'])('%s still presents its client identity to a verified mTLS server', async provider => {
    const client = clientFor(provider, endpoint('mtls'), { caCert: ca });
    try { await request(client, provider); expect(requests).toHaveLength(1); expect(requests[0].authorized).toBe(true); }
    finally { closeClient(client); }
  });
});

test('kubeconfig keeps default CA verification and serializes hostile token text as data', () => {
  const token = 'fixture\n    exec:\n      command: hostile-command';
  const output = buildKubeconfig({ name: '123', daemon_type: 'kubernetes', daemon_config: encryptDaemonConfig({ endpoint: 'kube.example:6443', token }) });
  const parsed = require('yaml').parse(output);
  expect(parsed.clusters[0].cluster).toEqual({ server: 'https://kube.example:6443' });
  expect(parsed.clusters[0].name).toBe('123'); expect(parsed.users[0].user).toEqual({ token });
  expect(() => buildKubeconfig({ name: 'x', daemon_type: 'kubernetes', daemon_config: encryptDaemonConfig({ endpoint: 'https://kube.example', token: 'fixture', skipTlsVerify: true }) })).toThrow(/TLS verification/);
});

test('Xen console descriptor retains strict server verification and configured CA', () => {
  const client = clientFor('xo', 'https://xo.example', { caCert: ca });
  const descriptor = client.vmConsoleProxy('vm-123');
  expect(descriptor.url).toMatch(/^wss:/); expect(descriptor.rejectUnauthorized).toBe(true); expect(descriptor.ca).toBe(ca);
});

test('Xen request paths cannot downgrade TLS or send credentials to another origin', async () => {
  const client = clientFor('xo', 'https://xo.example', { caCert: ca });
  await expect(client._request('GET', 'http://xo.example/path')).rejects.toThrow(/HTTPS/);
  await expect(client._request('GET', 'https://other.example/path')).rejects.toThrow(/Cross-origin/);
});
