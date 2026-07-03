'use strict';

// v8.9.4-alpha.1 — Sprint 5 (Kubernetes) tests.
// Covers: constructor validation, daemon_config encryption round-trip,
// fromHostRow behavior, and response-envelope unwrapping (list responses
// have a { items: [...] } shape — every list method returns items).
//
// The transport layer (https.request) is mocked — no live cluster.

process.env.APP_SECRET = 'test-kubernetes';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// Mock https so _request can run without a real cluster.
const mockHttps = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error('mockHttps: no queued handler; call _mockNext first');
    const req = {
      _writtenBody: null,
      _opts: opts,
      _cb: cb,
      write(buf) { this._writtenBody = buf; },
      end() { setImmediate(() => handler(opts, cb, this)); },
      on(_e, _fn) { /* mock: never errors */ },
      destroy() { /* no-op */ },
    };
    return req;
  },
};
jest.mock('https', () => mockHttps);

const {
  KubernetesClient, fromHostRow, encryptDaemonConfig, decryptDaemonConfig,
} = require('../services/kubernetes');

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

describe('KubernetesClient (v8.9.4-alpha.1)', () => {
  beforeEach(() => { mockHttps._handlers.length = 0; });

  describe('constructor', () => {
    it('rejects missing config', () => {
      expect(() => new KubernetesClient(null)).toThrow(/config object required/);
    });

    it('rejects config without endpoint', () => {
      expect(() => new KubernetesClient({ token: 'x' })).toThrow(/endpoint required/);
    });

    it('rejects config without token', () => {
      expect(() => new KubernetesClient({ endpoint: 'https://k.example.com:6443' }))
        .toThrow(/token required/);
    });

    it('accepts a fully-formed config', () => {
      expect(() => new KubernetesClient({
        endpoint: 'https://k.example.com:6443', token: 'x', caCert: 'PEM',
      })).not.toThrow();
    });

    it('exposes daemonType via getter', () => {
      const c = new KubernetesClient({ endpoint: 'https://x:6443', token: 'y' });
      expect(c.daemonType).toBe('kubernetes');
    });
  });

  describe('daemon_config encryption', () => {
    it('round-trips through encrypt/decrypt', () => {
      const cfg = {
        endpoint: 'https://k.example.com:6443',
        token: 'eyJhbG.SECRET.TOKEN',
        caCert: '-----BEGIN CERT-----',
        skipTlsVerify: false,
      };
      const enc = encryptDaemonConfig(cfg);
      expect(enc).toMatch(/^enc:/);
      expect(enc).not.toContain('SECRET.TOKEN');    // ciphertext must not contain the token
      expect(enc).not.toContain('k.example.com');
      const back = decryptDaemonConfig(enc);
      expect(back).toEqual(cfg);
    });

    it('decryptDaemonConfig passes through plain JSON for backward compat', () => {
      const cfg = { endpoint: 'https://x:6443', token: 'y' };
      expect(decryptDaemonConfig(JSON.stringify(cfg))).toEqual(cfg);
    });
  });

  describe('fromHostRow', () => {
    it('rejects a non-kubernetes row', () => {
      expect(() => fromHostRow({ daemon_type: 'docker' }))
        .toThrow(/not a Kubernetes host/);
    });

    it('rejects invalid JSON in daemon_config', () => {
      expect(() => fromHostRow({ daemon_type: 'kubernetes', daemon_config: 'not-json' }))
        .toThrow(/invalid daemon_config/);
    });

    it('accepts an encrypted daemon_config', () => {
      const enc = encryptDaemonConfig({
        endpoint: 'https://k.local:6443', token: 'xyz',
      });
      const client = fromHostRow({ daemon_type: 'kubernetes', daemon_config: enc });
      expect(client).toBeInstanceOf(KubernetesClient);
      expect(client._config.endpoint).toBe('https://k.local:6443');
      expect(client._config.token).toBe('xyz');
    });
  });

  describe('response envelope unwrapping', () => {
    // k8s List responses shape: { kind: 'PodList', items: [...] }.
    // Every list method should return items directly.

    it('listNamespaces returns items array', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 200,
          body: { kind: 'NamespaceList', items: [
            { metadata: { name: 'default' } },
            { metadata: { name: 'kube-system' } },
          ] },
        });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      const rows = await c.listNamespaces();
      expect(rows).toHaveLength(2);
      expect(rows[0].metadata.name).toBe('default');
    });

    it('listPods scoped to namespace hits the right path', async () => {
      let seenPath = null;
      mockHttps._mockNext((opts, cb, _req) => {
        seenPath = opts.path;
        const res = fakeResponse({ status: 200, body: { items: [] } });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await c.listPods('production');
      expect(seenPath).toBe('/api/v1/namespaces/production/pods');
    });

    it('listPods unscoped hits the cluster-wide path', async () => {
      let seenPath = null;
      mockHttps._mockNext((opts, cb, _req) => {
        seenPath = opts.path;
        const res = fakeResponse({ status: 200, body: { items: [] } });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await c.listPods();
      expect(seenPath).toBe('/api/v1/pods');
    });

    it('listDeployments uses apps/v1 group', async () => {
      let seenPath = null;
      mockHttps._mockNext((opts, cb, _req) => {
        seenPath = opts.path;
        const res = fakeResponse({ status: 200, body: { items: [] } });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await c.listDeployments('default');
      expect(seenPath).toBe('/apis/apps/v1/namespaces/default/deployments');
    });

    it('listNodes returns items array', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 200,
          body: { kind: 'NodeList', items: [{ metadata: { name: 'k3s-node-1' } }] },
        });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      const rows = await c.listNodes();
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata.name).toBe('k3s-node-1');
    });

    it('bearer token is set on the Authorization header', async () => {
      let seenAuth = null;
      mockHttps._mockNext((opts, cb, _req) => {
        seenAuth = opts.headers.Authorization;
        const res = fakeResponse({ status: 200, body: { gitVersion: 'v1.29.0' } });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 'secret-jwt' });
      await c.version();
      expect(seenAuth).toBe('Bearer secret-jwt');
    });

    it('surfaces 4xx as an error with status + parsed body', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 403,
          body: { message: 'forbidden', reason: 'Forbidden' },
        });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await expect(c.listPods()).rejects.toMatchObject({
        message: /forbidden/i,
        status: 403,
      });
    });
  });
});
