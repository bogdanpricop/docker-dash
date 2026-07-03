'use strict';

// v8.9.5-alpha.1 — Sprint 10 (Nomad) client tests.

process.env.APP_SECRET = 'test-nomad';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const mockHttp = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error('mockHttp: no queued handler');
    const req = {
      _opts: opts,
      write() { /* mock */ },
      end() { setImmediate(() => handler(opts, cb, this)); },
      on() { /* mock */ },
      destroy() { /* mock */ },
    };
    return req;
  },
};
const mockHttps = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error('mockHttps: no queued handler');
    const req = {
      _opts: opts,
      write() { /* mock */ },
      end() { setImmediate(() => handler(opts, cb, this)); },
      on() { /* mock */ },
      destroy() { /* mock */ },
    };
    return req;
  },
};
jest.mock('http', () => mockHttp);
jest.mock('https', () => mockHttps);

const {
  NomadClient, fromHostRow, encryptDaemonConfig, decryptDaemonConfig,
} = require('../services/nomad');

function fakeResponse({ status = 200, body = null, raw }) {
  const bufChunks = [];
  if (body !== null) bufChunks.push(Buffer.from(JSON.stringify(body)));
  else if (raw !== undefined) bufChunks.push(Buffer.from(raw));
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

describe('NomadClient (v8.9.5-alpha.1)', () => {
  beforeEach(() => { mockHttp._handlers.length = 0; mockHttps._handlers.length = 0; });

  describe('constructor', () => {
    it('rejects missing config', () => {
      expect(() => new NomadClient(null)).toThrow(/config object required/);
    });

    it('rejects config without endpoint', () => {
      expect(() => new NomadClient({})).toThrow(/endpoint required/);
    });

    it('accepts a valid http endpoint (no token required)', () => {
      expect(() => new NomadClient({ endpoint: 'http://nomad.local:4646' })).not.toThrow();
    });

    it('accepts a valid https endpoint', () => {
      expect(() => new NomadClient({
        endpoint: 'https://nomad.example.com:4646', token: 't',
      })).not.toThrow();
    });

    it('exposes daemonType via getter', () => {
      const c = new NomadClient({ endpoint: 'http://n:4646' });
      expect(c.daemonType).toBe('nomad');
    });
  });

  describe('daemon_config encryption', () => {
    it('round-trips', () => {
      const cfg = {
        endpoint: 'https://nomad.example.com:4646',
        token: 'SECRET-ACL-TOKEN-UUID',
        region: 'eu-west-1',
      };
      const enc = encryptDaemonConfig(cfg);
      expect(enc).toMatch(/^enc:/);
      expect(enc).not.toContain('SECRET-ACL-TOKEN');
      expect(decryptDaemonConfig(enc)).toEqual(cfg);
    });
  });

  describe('fromHostRow', () => {
    it('rejects a non-nomad row', () => {
      expect(() => fromHostRow({ daemon_type: 'docker' }))
        .toThrow(/not a Nomad host/);
    });

    it('accepts a nomad row with encrypted config', () => {
      const enc = encryptDaemonConfig({ endpoint: 'http://n:4646' });
      const client = fromHostRow({ daemon_type: 'nomad', daemon_config: enc });
      expect(client).toBeInstanceOf(NomadClient);
    });
  });

  describe('request handling', () => {
    it('sets X-Nomad-Token when token configured', async () => {
      let seenHeaders = null;
      mockHttp._mockNext((opts, cb, _req) => {
        seenHeaders = opts.headers;
        const res = fakeResponse({ status: 200, body: [] });
        cb(res); res._fire();
      });
      const c = new NomadClient({ endpoint: 'http://n:4646', token: 'test-token' });
      await c.listJobs();
      expect(seenHeaders['X-Nomad-Token']).toBe('test-token');
    });

    it('omits X-Nomad-Token when no token configured (ACL disabled)', async () => {
      let seenHeaders = null;
      mockHttp._mockNext((opts, cb, _req) => {
        seenHeaders = opts.headers;
        const res = fakeResponse({ status: 200, body: [] });
        cb(res); res._fire();
      });
      const c = new NomadClient({ endpoint: 'http://n:4646' });
      await c.listJobs();
      expect(seenHeaders['X-Nomad-Token']).toBeUndefined();
    });

    it('list endpoints hit /v1/jobs, /v1/allocations, /v1/nodes', async () => {
      const paths = [];
      mockHttp._mockNext((opts, cb, _req) => {
        paths.push(opts.path);
        const res = fakeResponse({ status: 200, body: [] });
        cb(res); res._fire();
      });
      mockHttp._mockNext((opts, cb, _req) => {
        paths.push(opts.path);
        const res = fakeResponse({ status: 200, body: [] });
        cb(res); res._fire();
      });
      mockHttp._mockNext((opts, cb, _req) => {
        paths.push(opts.path);
        const res = fakeResponse({ status: 200, body: [] });
        cb(res); res._fire();
      });
      const c = new NomadClient({ endpoint: 'http://n:4646' });
      await c.listJobs();
      await c.listAllocations();
      await c.listNodes();
      expect(paths).toEqual(['/v1/jobs', '/v1/allocations', '/v1/nodes']);
    });

    it('namespace scoping is applied to jobs list', async () => {
      let seenPath = null;
      mockHttp._mockNext((opts, cb, _req) => {
        seenPath = opts.path;
        const res = fakeResponse({ status: 200, body: [] });
        cb(res); res._fire();
      });
      const c = new NomadClient({ endpoint: 'http://n:4646' });
      await c.listJobs('production');
      expect(seenPath).toBe('/v1/jobs?namespace=production');
    });

    it('listNamespaces gracefully handles 501 (OSS) as empty list', async () => {
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({ status: 501, body: { error: 'not implemented' } });
        cb(res); res._fire();
      });
      const c = new NomadClient({ endpoint: 'http://n:4646' });
      const nss = await c.listNamespaces();
      expect(nss).toEqual([]);
    });

    it('surfaces 4xx with status and message', async () => {
      mockHttp._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({ status: 403, body: { error: 'ACL forbidden' } });
        cb(res); res._fire();
      });
      const c = new NomadClient({ endpoint: 'http://n:4646', token: 't' });
      await expect(c.listJobs()).rejects.toMatchObject({
        message: /ACL forbidden/,
        status: 403,
      });
    });
  });
});
