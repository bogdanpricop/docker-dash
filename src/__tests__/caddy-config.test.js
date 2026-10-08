'use strict';

// Tests for src/services/caddy-config.js (v6.5 LE Wizard)
//
// We don't talk to a real Caddy here — the orchestration logic is what we
// validate. Real Caddy admin API behavior was already validated in preflight A1.

process.env.APP_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-jest-32chars';
// Include "404" in the missing socket path to prove transport errors are not
// mistaken for an HTTP 404 response based on unstructured message text.
process.env.CADDY_ADMIN_SOCKET = '/tmp/no-such-caddy-admin-404.sock-' + process.pid;

const caddyConfig = require('../services/caddy-config');

describe('caddy-config — module shape', () => {
  it('exports the expected functions', () => {
    expect(typeof caddyConfig.caddyApi).toBe('function');
    expect(typeof caddyConfig.fetchConfig).toBe('function');
    expect(typeof caddyConfig.configPathExists).toBe('function');
    expect(typeof caddyConfig.addAcmePolicy).toBe('function');
    expect(typeof caddyConfig.findAcmePolicyIndex).toBe('function');
    expect(typeof caddyConfig.removeAcmePolicyBySubjects).toBe('function');
    expect(typeof caddyConfig.removeAcmePolicyByIndex).toBe('function');
    expect(typeof caddyConfig.isHealthy).toBe('function');
  });
});

describe('caddy-config — error handling when Caddy is unreachable', () => {
  it('caddyApi rejects with a clear ENOENT message when socket is missing', async () => {
    await expect(caddyConfig.caddyApi('GET', '/config/'))
      .rejects.toThrow(/Caddy admin socket not found/);
  });

  it('isHealthy() returns false when Caddy is unreachable (does NOT throw)', async () => {
    const ok = await caddyConfig.isHealthy();
    expect(ok).toBe(false);
  });

  it('configPathExists() rethrows non-404 errors', async () => {
    await expect(caddyConfig.configPathExists('/apps/tls'))
      .rejects.toThrow(/socket not found|admin socket/);
  });
});

describe('caddy-config — addAcmePolicy validation', () => {
  it('rejects empty subjects array', async () => {
    await expect(caddyConfig.addAcmePolicy({
      subjects: [], email: 'a@b.com', challengeType: 'http-01',
    })).rejects.toThrow(/subjects/);
  });

  it('rejects missing email', async () => {
    await expect(caddyConfig.addAcmePolicy({
      subjects: ['x.example.com'], email: '', challengeType: 'http-01',
    })).rejects.toThrow(/email/);
  });

  it('rejects unknown challenge type', async () => {
    await expect(caddyConfig.addAcmePolicy({
      subjects: ['x.example.com'], email: 'a@b.com', challengeType: 'tls-alpn-01',
    })).rejects.toThrow(/challengeType/);
  });

  it('requires providerConfig for dns-01', async () => {
    await expect(caddyConfig.addAcmePolicy({
      subjects: ['x.example.com'], email: 'a@b.com', challengeType: 'dns-01',
    })).rejects.toThrow(/providerConfig/);
  });
});
