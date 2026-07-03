'use strict';

// v8.9.3-alpha.1 — Sprint 8: LXD reuses the Incus client. Tests verify
// that the client + fromHostRow are honest about daemonType, that the
// snap-socket default is chosen for LXD rows, and that the encryption
// round-trip still works when the row's daemon_type is 'lxd'.
//
// NOTE: no additional HTTP mocking — the request layer is exercised in
// incus-client.test.js. LXD's REST API is byte-identical for every
// endpoint we call.

process.env.APP_SECRET = 'test-lxd';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// Mock the http module minimally — same shape the incus tests use so
// the module doesn't blow up at require-time when constructing http.Agent.
const mockHttp = {
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request: function () { throw new Error('mockHttp: request not implemented in LXD tests'); },
};
jest.mock('http', () => mockHttp);

const { IncusClient, fromHostRow, encryptDaemonConfig } = require('../services/incus');

describe('LXD client (Sprint 8, v8.9.3-alpha.1)', () => {
  describe('IncusClient with daemonType=lxd', () => {
    it('exposes daemonType via getter', () => {
      const client = new IncusClient({
        transport: 'unix',
        socket: '/var/snap/lxd/common/lxd/unix.socket',
        daemonType: 'lxd',
      });
      expect(client.daemonType).toBe('lxd');
    });

    it('defaults daemonType to incus for backward compatibility', () => {
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      expect(client.daemonType).toBe('incus');
    });
  });

  describe('fromHostRow with lxd rows', () => {
    it('accepts a row with daemon_type=lxd', () => {
      const client = fromHostRow({ daemon_type: 'lxd', daemon_config: null });
      expect(client).toBeInstanceOf(IncusClient);
      expect(client.daemonType).toBe('lxd');
    });

    it('defaults LXD unix socket to /var/snap/lxd/common/lxd/unix.socket', () => {
      const client = fromHostRow({ daemon_type: 'lxd', daemon_config: null });
      expect(client._config.transport).toBe('unix');
      expect(client._config.socket).toBe('/var/snap/lxd/common/lxd/unix.socket');
    });

    it('lets daemon_config override the LXD socket path (legacy /var/lib/lxd)', () => {
      const client = fromHostRow({
        daemon_type: 'lxd',
        daemon_config: JSON.stringify({ transport: 'unix', socket: '/var/lib/lxd/unix.socket' }),
      });
      expect(client._config.socket).toBe('/var/lib/lxd/unix.socket');
    });

    it('reads an encrypted LXD daemon_config transparently', () => {
      const cfg = {
        transport: 'https',
        endpoint: 'https://lxd.example.com:8443',
        cert: '-----BEGIN CERT-----',
        key: '-----BEGIN KEY-----',
      };
      const enc = encryptDaemonConfig(cfg);
      const client = fromHostRow({ daemon_type: 'lxd', daemon_config: enc });
      expect(client.daemonType).toBe('lxd');
      expect(client._config.endpoint).toBe('https://lxd.example.com:8443');
      expect(client._config.cert).toBe('-----BEGIN CERT-----');
    });

    it('Incus rows still use the Incus default socket (regression guard)', () => {
      const client = fromHostRow({ daemon_type: 'incus', daemon_config: null });
      expect(client.daemonType).toBe('incus');
      expect(client._config.socket).toBe('/var/lib/incus/unix.socket');
    });

    it('still rejects a non-Incus/non-LXD daemon_type', () => {
      expect(() => fromHostRow({ daemon_type: 'docker' })).toThrow(/Incus\/LXD host/);
      expect(() => fromHostRow({ daemon_type: 'proxmox' })).toThrow(/Incus\/LXD host/);
    });
  });
});
