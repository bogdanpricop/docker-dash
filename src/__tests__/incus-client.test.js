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

  describe('daemon_config encryption (v8.9.0-alpha.3)', () => {
    const { encryptDaemonConfig, decryptDaemonConfig, fromHostRow: _ } = require('../services/incus');

    it('round-trips a plain config through encryptDaemonConfig / decryptDaemonConfig', () => {
      const cfg = {
        transport: 'https',
        endpoint: 'https://incus.example.com:8443',
        cert: '-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----',
        key:  '-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----',
      };
      const enc = encryptDaemonConfig(cfg);
      expect(enc).toMatch(/^enc:/);
      expect(enc).not.toContain('BEGIN CERTIFICATE');   // ciphertext must not contain the secret
      expect(enc).not.toContain('incus.example.com');
      const back = decryptDaemonConfig(enc);
      expect(back).toEqual(cfg);
    });

    it('decryptDaemonConfig passes through plain JSON (backward compat with alpha.1/2)', () => {
      const cfg = { transport: 'unix', socket: '/var/lib/incus/unix.socket' };
      const plain = JSON.stringify(cfg);
      expect(decryptDaemonConfig(plain)).toEqual(cfg);
    });

    it('fromHostRow accepts encrypted daemon_config', () => {
      const cfg = { transport: 'unix', socket: '/tmp/incus.sock' };
      const enc = encryptDaemonConfig(cfg);
      const { fromHostRow } = require('../services/incus');
      const client = fromHostRow({ daemon_type: 'incus', daemon_config: enc });
      expect(client._config.socket).toBe('/tmp/incus.sock');
    });

    it('surfaces a clear error when ENCRYPTION_KEY has rotated (decrypt fails)', () => {
      const { fromHostRow } = require('../services/incus');
      // Manually craft a bogus enc: blob that decrypt() won't recognize.
      // Format: enc:<iv-hex>:<tag-hex>:<ciphertext-hex>
      const badEnc = 'enc:00000000000000000000000000000000:00000000000000000000000000000000:deadbeef';
      expect(() => fromHostRow({ daemon_type: 'incus', daemon_config: badEnc }))
        .toThrow(/decrypt failed|invalid daemon_config/);
    });
  });

  describe('fromHostRow', () => {
    it('rejects a non-Incus row', () => {
      // v8.9.3-alpha.1 — fromHostRow now accepts both 'incus' and 'lxd'
      // so the error message widened accordingly.
      expect(() => fromHostRow({ daemon_type: 'docker' })).toThrow(/Incus\/LXD host/);
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

  // v8.9.0-alpha.2 — write methods (state changes + snapshots).
  describe('state-changing operations', () => {
    // Helper: mocks the two-step async operation (PUT/POST returns operation
    // path; the client then polls /wait). Response bodies use the Incus
    // envelope shape.
    const _queueAsyncOperation = (opPath = '/1.0/operations/test-op') => {
      // Step 1: the state change request → returns async operation ref.
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 202,
          body: { type: 'async', status_code: 100, operation: opPath, metadata: { id: 'test-op' } },
        });
        cb(res);
        res._fire();
      });
      // Step 2: the /wait poll → returns success.
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 200,
          body: { type: 'sync', status_code: 200,
            metadata: { status: 'Success', status_code: 200, id: 'test-op' } },
        });
        cb(res);
        res._fire();
      });
    };

    it('startInstance PUTs the correct path + body and waits for the operation', async () => {
      let stateReq;
      // Custom first handler to capture body.
      mockHttp._mockNext((opts, cb, req) => {
        stateReq = { opts, body: req._writtenBody };
        const res = fakeResponse({
          status: 202,
          body: { type: 'async', operation: '/1.0/operations/abc' },
        });
        cb(res);
        res._fire();
      });
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 200,
          body: { type: 'sync', metadata: { status: 'Success', status_code: 200 } },
        });
        cb(res);
        res._fire();
      });
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      const result = await client.startInstance('web');
      expect(stateReq.opts.method).toBe('PUT');
      expect(stateReq.opts.path).toBe('/1.0/instances/web/state');
      // The client sends action + timeout + force + stateful.
      const bodyStr = stateReq.body.toString('utf8');
      expect(JSON.parse(bodyStr)).toMatchObject({ action: 'start', force: false });
      // Wait step succeeded → result is the Success metadata.
      expect(result.status).toBe('Success');
    });

    it('stopInstance and restartInstance use the right action name', async () => {
      const capturedActions = [];
      for (let i = 0; i < 2; i++) {
        mockHttp._mockNext((_opts, cb, req) => {
          capturedActions.push(JSON.parse(req._writtenBody.toString()).action);
          const res = fakeResponse({
            status: 202, body: { type: 'async', operation: '/1.0/operations/x' },
          });
          cb(res); res._fire();
        });
        mockHttp._mockNext((_opts, cb, _req) => {
          const res = fakeResponse({
            status: 200, body: { type: 'sync', metadata: { status: 'Success', status_code: 200 } },
          });
          cb(res); res._fire();
        });
      }
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      await client.stopInstance('web', { force: true });
      await client.restartInstance('web');
      expect(capturedActions).toEqual(['stop', 'restart']);
    });

    it('surfaces failed operations as a rejected promise with metadata attached', async () => {
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 202, body: { type: 'async', operation: '/1.0/operations/x' },
        });
        cb(res); res._fire();
      });
      mockHttp._mockNext((_opts, cb, _req) => {
        // Operation failed.
        const res = fakeResponse({
          status: 200,
          body: {
            type: 'sync', metadata: { status: 'Failure', status_code: 400, err: 'container is not stopped' },
          },
        });
        cb(res); res._fire();
      });
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      let caught;
      try { await client.deleteInstance('web'); } catch (e) { caught = e; }
      expect(caught).toBeDefined();
      expect(caught.message).toMatch(/container is not stopped/);
      expect(caught.incusOperation.status).toBe('Failure');
    });

    it('createSnapshot validates the snapshot name and body', async () => {
      let stateReq;
      _queueAsyncOperation();
      mockHttp._handlers[0] = ((original) => (opts, cb, req) => {
        stateReq = { opts, body: req._writtenBody };
        original(opts, cb, req);
      })(mockHttp._handlers[0]);
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      await client.createSnapshot('web', 'pre-upgrade-2026-07', { stateful: false });
      expect(stateReq.opts.method).toBe('POST');
      expect(stateReq.opts.path).toBe('/1.0/instances/web/snapshots');
      expect(JSON.parse(stateReq.body.toString())).toEqual({
        name: 'pre-upgrade-2026-07', stateful: false,
      });
    });

    it('restoreSnapshot uses PUT on the instance with {restore}', async () => {
      let stateReq;
      _queueAsyncOperation();
      mockHttp._handlers[0] = ((original) => (opts, cb, req) => {
        stateReq = { opts, body: req._writtenBody };
        original(opts, cb, req);
      })(mockHttp._handlers[0]);
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      await client.restoreSnapshot('web', 'pre-upgrade-2026-07');
      expect(stateReq.opts.method).toBe('PUT');
      expect(stateReq.opts.path).toBe('/1.0/instances/web');
      expect(JSON.parse(stateReq.body.toString())).toEqual({ restore: 'pre-upgrade-2026-07' });
    });

    it('deleteInstance sends DELETE on the instance path', async () => {
      let stateReq;
      _queueAsyncOperation();
      mockHttp._handlers[0] = ((original) => (opts, cb, req) => {
        stateReq = { opts };
        original(opts, cb, req);
      })(mockHttp._handlers[0]);
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      await client.deleteInstance('web');
      expect(stateReq.opts.method).toBe('DELETE');
      expect(stateReq.opts.path).toBe('/1.0/instances/web');
    });

    it('rejects invalid action names in _changeInstanceState', async () => {
      const client = new IncusClient({ transport: 'unix', socket: '/tmp/incus.sock' });
      await expect(client._changeInstanceState('web', 'invalid-action')).rejects.toThrow(/invalid state action/);
    });
  });
});
