'use strict';

// v8.9.1-alpha.1 — tests for the Proxmox VE client scaffold.
// Mocked https module, no real Proxmox cluster in CI.

process.env.APP_SECRET = 'test-proxmox';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const mockHttps = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error('mockHttps: no queued handler; call _mockNext first');
    const req = {
      _writtenBody: null, _opts: opts, _cb: cb,
      write(buf) { this._writtenBody = buf; },
      end() { setImmediate(() => handler(opts, cb, this)); },
      on(_e, _fn) { /* mock: never fires 'error' */ },
      destroy() { /* mock: no-op */ },
    };
    return req;
  },
};
jest.mock('https', () => mockHttps);

const { ProxmoxClient, fromHostRow, encryptDaemonConfig, decryptDaemonConfig } = require('../services/proxmox');

function fakeResponse({ status = 200, body = null }) {
  const bufChunks = [];
  if (body !== null) bufChunks.push(Buffer.from(JSON.stringify(body)));
  const listeners = {};
  return {
    statusCode: status,
    on(event, fn) { listeners[event] = fn; },
    _fire() {
      if (bufChunks.length && listeners.data) listeners.data(bufChunks[0]);
      if (listeners.end) listeners.end();
    },
  };
}

describe('ProxmoxClient (v8.9.1-alpha.1)', () => {
  beforeEach(() => { mockHttps._handlers.length = 0; });

  describe('constructor', () => {
    it('rejects missing endpoint', () => {
      expect(() => new ProxmoxClient({ tokenId: 'a@b!c', tokenSecret: 'x' }))
        .toThrow(/endpoint required/);
    });

    it('rejects missing token', () => {
      expect(() => new ProxmoxClient({ endpoint: 'https://pve:8006' }))
        .toThrow(/tokenId.*tokenSecret required/);
    });

    it('rejects malformed tokenId', () => {
      expect(() => new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'not-formatted', tokenSecret: 'x',
      })).toThrow(/USER@REALM!TOKENID/);
    });

    it('accepts a well-formed config', () => {
      expect(() => new ProxmoxClient({
        endpoint: 'https://pve.example.com:8006',
        tokenId: 'root@pam!docker-dash', tokenSecret: 'uuid-here',
      })).not.toThrow();
    });
  });

  describe('auth header + response envelope', () => {
    it('sends the PVEAPIToken Authorization header', async () => {
      let receivedAuth;
      mockHttps._mockNext((opts, cb, _req) => {
        receivedAuth = opts.headers.Authorization;
        const res = fakeResponse({
          status: 200,
          body: { data: { version: '8.1.4', release: '8.1', repoid: 'abc123' } },
        });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve.example.com:8006',
        tokenId: 'root@pam!docker-dash',
        tokenSecret: 'my-uuid',
      });
      const info = await client.version();
      expect(receivedAuth).toBe('PVEAPIToken=root@pam!docker-dash=my-uuid');
      // Data envelope unwrapped.
      expect(info.version).toBe('8.1.4');
    });

    it('surfaces Proxmox errors with structured message', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 401,
          body: { data: null, errors: { 'PVEAPIToken': 'invalid token' } },
        });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x',
      });
      await expect(client.version()).rejects.toMatchObject({
        status: 401,
        message: expect.stringMatching(/PVEAPIToken.*invalid token/),
      });
    });

    it('listVMs returns [] when data missing', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({ status: 200, body: { data: null } });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x',
      });
      expect(await client.listVMs()).toEqual([]);
    });

    it('listLXC filters cluster/resources by type=lxc', async () => {
      let receivedPath;
      mockHttps._mockNext((opts, cb, _req) => {
        receivedPath = opts.path;
        const res = fakeResponse({
          status: 200,
          body: { data: [
            { type: 'qemu', vmid: 100, name: 'web-vm' },
            { type: 'lxc',  vmid: 101, name: 'db-lxc' },
            { type: 'storage', storage: 'local' },
          ] },
        });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x',
      });
      const lxc = await client.listLXC();
      expect(receivedPath).toBe('/api2/json/cluster/resources');
      expect(lxc).toHaveLength(1);
      expect(lxc[0]).toMatchObject({ type: 'lxc', vmid: 101, name: 'db-lxc' });
    });
  });

  describe('daemon_config encryption', () => {
    it('round-trips encryptDaemonConfig / decryptDaemonConfig', () => {
      const cfg = {
        endpoint: 'https://pve:8006',
        tokenId: 'root@pam!docker-dash',
        tokenSecret: 'a-very-secret-uuid',
        skipTlsVerify: true,
      };
      const enc = encryptDaemonConfig(cfg);
      expect(enc).toMatch(/^enc:/);
      expect(enc).not.toContain('a-very-secret-uuid');
      expect(decryptDaemonConfig(enc)).toEqual(cfg);
    });

    it('accepts plaintext JSON for backward-compat', () => {
      const cfg = { endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' };
      expect(decryptDaemonConfig(JSON.stringify(cfg))).toEqual(cfg);
    });

    it('fromHostRow works with encrypted daemon_config', () => {
      const cfg = {
        endpoint: 'https://pve.example.com:8006',
        tokenId: 'root@pam!docker-dash',
        tokenSecret: 'uuid',
      };
      const enc = encryptDaemonConfig(cfg);
      const client = fromHostRow({ daemon_type: 'proxmox', daemon_config: enc });
      expect(client._config.endpoint).toBe('https://pve.example.com:8006');
    });

    it('fromHostRow rejects non-Proxmox rows', () => {
      expect(() => fromHostRow({ daemon_type: 'docker' })).toThrow(/not a Proxmox host/);
    });
  });
});
