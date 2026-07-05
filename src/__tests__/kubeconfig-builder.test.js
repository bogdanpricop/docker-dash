'use strict';

// v8.9.7-alpha.1 — Portainer G08 closure tests.

process.env.APP_SECRET = 'test-kubeconfig';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const mockHttps = {
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request: function () { throw new Error('mockHttps: request not implemented in this test'); },
};
jest.mock('https', () => mockHttps);

const { buildKubeconfig, encryptDaemonConfig } = require('../services/kubernetes');

describe('buildKubeconfig (v8.9.7-alpha.1)', () => {
  it('rejects non-kubernetes row', () => {
    expect(() => buildKubeconfig({ daemon_type: 'docker' })).toThrow(/not a Kubernetes/);
  });

  it('emits valid kubeconfig with CA', () => {
    const enc = encryptDaemonConfig({
      endpoint: 'https://k3s.example.com:6443',
      token: 'eyJhbG.SECRET',
      caCert: '-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----',
    });
    const yaml = buildKubeconfig({ id: 5, name: 'homelab-k3s', daemon_type: 'kubernetes', daemon_config: enc });
    expect(yaml).toContain('apiVersion: v1');
    expect(yaml).toContain('kind: Config');
    expect(yaml).toContain('server: https://k3s.example.com:6443');
    expect(yaml).toContain('token: eyJhbG.SECRET');
    expect(yaml).toContain('certificate-authority-data:');
    expect(yaml).toContain('name: homelab-k3s');
  });

  it('falls back to insecure-skip-tls-verify when no CA', () => {
    const enc = encryptDaemonConfig({
      endpoint: 'https://k3s.local:6443',
      token: 'xxx',
      skipTlsVerify: true,
    });
    const yaml = buildKubeconfig({ id: 6, name: 'lab', daemon_type: 'kubernetes', daemon_config: enc });
    expect(yaml).toContain('insecure-skip-tls-verify: true');
    expect(yaml).not.toContain('certificate-authority-data');
  });

  it('sanitizes cluster name from row.name', () => {
    const enc = encryptDaemonConfig({ endpoint: 'https://x:6443', token: 't' });
    const yaml = buildKubeconfig({ id: 7, name: 'my cluster/with#chars', daemon_type: 'kubernetes', daemon_config: enc });
    expect(yaml).toContain('my_cluster_with_chars');
  });
});
