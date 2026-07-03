'use strict';

// v8.9.0-alpha — tests for the Incus client scaffold.
// The client wraps HTTP or HTTPS + JSON — we don't spin up a real Incus
// instance in CI. Tests cover: construction validation, config parsing
// from a docker_hosts row, and the response envelope contract (Incus
// wraps every payload in { metadata, status_code, ... }).

process.env.APP_SECRET = 'test-incus';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// Mock the http module so _request can be exercised without a real socket.
const mockHttp = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  // Minimal Agent stub — real Agent options aren't exercised in tests.
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error('mockHttp: no queued handler; call _mockNext first');
    const req = {
      _writtenBody: null,
      _opts: opts,
      _cb: cb,
      write(buf) { this._writtenBody = buf; },
      end() {
        // Fire the handler on next tick to mimic real async behavior.
        setImmediate(() => handler(opts, cb, this));
      },
      on(_e, _fn) { /* mock: never fires 'error' */ },
      destroy() { /* mock: no-op */ },
    };
    return req;
  },
};
jest.mock('http', () => mockHttp);

const { IncusClient, fromHostRow } = require('../services/incus');

// Helper: fabricate a fake IncomingMessage that Incus would send.
function fakeResponse({ status = 200, body = null }) {
  const bufChunks = [];
  if (body !== null) bufChunks.push(Buffer.from(JSON.stringify(body)));
  const listeners = {};
  return {
    statusCode: status,
    on(event, fn) { listeners[event] = fn; },
    // Manually driven so the test can control timing if needed.
    _fire() {
      if (bufChunks.length && listeners.data) listeners.data(bufChunks[0]);
      if (listeners.end) listeners.end();
    },
  };
}

describe('IncusClient (v8.9.0-alpha)', () => {
  beforeEach(() => { mockHttp._handlers.length = 0; });

  describe('constructor', () => {
    it('rejects config without transport field', () => {
      expect(() => new IncusClient({})).toThrow(/transport/);
    });

    it('rejects unix transport without socket', () => {
      expect(() => new IncusClient({ transport: 'unix' })).toThrow(/socket required/);
    });

    it('rejects https transport without endpoint', () => {
      expect(() => new IncusClient({ transport: 'https' })).toThrow(/endpoint required/);
    });

    it('accepts a valid unix config', () => {
      expect(() => new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' }))
        .not.toThrow();
    });
  });

  describe('fromHostRow', () => {
    it('rejects a non-Incus row', () => {
      expect(() => fromHostRow({ daemon_type: 'docker' })).toThrow(/not an Incus host/);
    });

    it('rejects invalid JSON in daemon_config', () => {
      expect(() => fromHostRow({ daemon_type: 'incus', daemon_config: 'not-json' }))
        .toThrow(/invalid daemon_config JSON/);
    });

    it('defaults to unix transport at /var/lib/incus/unix.socket when config empty', () => {
      const client = fromHostRow({ daemon_type: 'incus', daemon_config: null });
      expect(client).toBeInstanceOf(IncusClient);
      expect(client._config.transport).toBe('unix');
      expect(client._config.socket).toBe('/var/lib/incus/unix.socket');
    });

    it('reads a JSON config verbatim', () => {
      const client = fromHostRow({
        daemon_type: 'incus',
        daemon_config: JSON.stringify({
          transport: 'https', endpoint: 'https://incus.example.com:8443',
          skipTlsVerify: true,
        }),
      });
      expect(client._config.transport).toBe('https');
      expect(client._config.endpoint).toBe('https://incus.example.com:8443');
    });
  });

  describe('response envelope unwrapping', () => {
    // Incus wraps every list response in { metadata: [...] }. Client
    // methods unwrap; verify a few of them do so consistently.

    it('listInstances returns metadata array', async () => {
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 200,
          body: {
            type: 'sync',
            status: 'Success',
            status_code: 200,
            metadata: [
              { name: 'web', status: 'Running', type: 'container' },
              { name: 'db',  status: 'Stopped', type: 'container' },
            ],
          },
        });
        cb(res);
        res._fire();
      });
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      const list = await client.listInstances();
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe('web');
    });

    it('listInstances returns [] when metadata missing', async () => {
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({ status: 200, body: { type: 'sync', status: 'Success' } });
        cb(res);
        res._fire();
      });
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      const list = await client.listInstances();
      expect(list).toEqual([]);
    });

    it('surfaces Incus API errors with status + body', async () => {
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 404,
          body: { error: 'Instance not found', error_code: 404 },
        });
        cb(res);
        res._fire();
      });
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      await expect(client.getInstance('doesnotexist')).rejects.toMatchObject({
        status: 404,
        message: expect.stringMatching(/Instance not found/),
      });
    });

    it('passes ?project= query when a project is supplied', async () => {
      let receivedPath;
      mockHttp._mockNext((opts, cb, _req) => {
        receivedPath = opts.path;
        const res = fakeResponse({
          status: 200, body: { type: 'sync', metadata: [] },
        });
        cb(res);
        res._fire();
      });
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      await client.listInstances('production');
      expect(receivedPath).toMatch(/\?project=production&recursion=1$/);
    });
  });
});
