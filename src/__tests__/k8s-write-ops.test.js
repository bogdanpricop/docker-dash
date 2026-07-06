'use strict';

// v8.9.8-alpha.1 — Portainer G04 closure tests: k8s write ops.

process.env.APP_SECRET = 'test-k8s-write';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const mockHttps = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error('mockHttps: no queued handler');
    const req = {
      _opts: opts,
      _writtenBody: null,
      write(buf) { this._writtenBody = buf; },
      end() { setImmediate(() => handler(opts, cb, this)); },
      on() { /* mock */ },
      destroy() { /* mock */ },
    };
    return req;
  },
};
jest.mock('https', () => mockHttps);

const { KubernetesClient } = require('../services/kubernetes');

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

describe('KubernetesClient write ops (v8.9.8-alpha.1)', () => {
  beforeEach(() => { mockHttps._handlers.length = 0; });

  describe('scaleDeployment', () => {
    it('rejects negative replicas', async () => {
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await expect(c.scaleDeployment('default', 'x', -1)).rejects.toThrow(/non-negative/);
    });

    it('rejects non-integer replicas', async () => {
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await expect(c.scaleDeployment('default', 'x', 'many')).rejects.toThrow();
    });

    it('sends PATCH with strategic-merge content type', async () => {
      let seenMethod = null, seenPath = null, seenCT = null, seenBody = null;
      mockHttps._mockNext((opts, cb, req) => {
        seenMethod = opts.method;
        seenPath = opts.path;
        seenCT = opts.headers['Content-Type'];
        seenBody = req._writtenBody;
        const res = fakeResponse({ status: 200, body: { spec: { replicas: 3 } } });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await c.scaleDeployment('default', 'nginx', 3);
      expect(seenMethod).toBe('PATCH');
      expect(seenPath).toBe('/apis/apps/v1/namespaces/default/deployments/nginx/scale');
      expect(seenCT).toBe('application/strategic-merge-patch+json');
      expect(JSON.parse(seenBody.toString())).toEqual({ spec: { replicas: 3 } });
    });
  });

  describe('restartDeployment', () => {
    it('patches restartedAt annotation with an ISO timestamp', async () => {
      let seenBody = null;
      mockHttps._mockNext((_opts, cb, req) => {
        seenBody = req._writtenBody;
        const res = fakeResponse({ status: 200, body: {} });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await c.restartDeployment('default', 'nginx');
      const patch = JSON.parse(seenBody.toString());
      const stamp = patch.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'];
      expect(typeof stamp).toBe('string');
      expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('deletePod', () => {
    it('sends DELETE to the correct URL', async () => {
      let seenMethod = null, seenPath = null;
      mockHttps._mockNext((opts, cb, _req) => {
        seenMethod = opts.method;
        seenPath = opts.path;
        const res = fakeResponse({ status: 200, body: {} });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await c.deletePod('production', 'my-pod-xyz');
      expect(seenMethod).toBe('DELETE');
      expect(seenPath).toBe('/api/v1/namespaces/production/pods/my-pod-xyz');
    });
  });

  describe('cordonNode', () => {
    it('patches unschedulable=true by default', async () => {
      let seenBody = null;
      mockHttps._mockNext((_opts, cb, req) => {
        seenBody = req._writtenBody;
        const res = fakeResponse({ status: 200, body: {} });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await c.cordonNode('worker-1');
      expect(JSON.parse(seenBody.toString())).toEqual({ spec: { unschedulable: true } });
    });

    it('supports uncordon (unschedulable=false)', async () => {
      let seenBody = null;
      mockHttps._mockNext((_opts, cb, req) => {
        seenBody = req._writtenBody;
        const res = fakeResponse({ status: 200, body: {} });
        cb(res); res._fire();
      });
      const c = new KubernetesClient({ endpoint: 'https://k:6443', token: 't' });
      await c.cordonNode('worker-1', false);
      expect(JSON.parse(seenBody.toString())).toEqual({ spec: { unschedulable: false } });
    });
  });
});
