'use strict';

// Posture coverage for Proxmox + Kubernetes hosts (v8.9.45). Mirrors the
// insecure-docker check test style: feed a synthetic ctx = { hosts }, no DB
// needed since these checks only read daemon_config already on the host row.

process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';

const proxmoxCheck = require('../services/posture/checks/proxmox');
const k8sCheck = require('../services/posture/checks/k8s');
const { encryptDaemonConfig: encryptProxmoxConfig } = require('../services/proxmox');
const { encryptDaemonConfig: encryptK8sConfig } = require('../services/kubernetes');

const ctx = (hosts) => ({ hosts });

describe('proxmox posture check', () => {
  test('flags TLS verification disabled + unencrypted credential storage', async () => {
    const insecureHost = {
      id: 10, name: 'homelab-pve', daemon_type: 'proxmox',
      daemon_config: JSON.stringify({ endpoint: 'https://pve.local:8006', tokenId: 'root@pam!dd', tokenSecret: 'secret-uuid', skipTlsVerify: true }),
    };
    const out = await proxmoxCheck.run(ctx([insecureHost]));
    expect(out).toHaveLength(2);
    expect(out).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'proxmox.tls-verify-disabled', severity: 'high', hostId: 10 }),
      expect.objectContaining({ checkId: 'proxmox.credential-unencrypted', severity: 'medium', hostId: 10 }),
    ]));
  });

  test('a properly secured + encrypted host produces no findings', async () => {
    const secureHost = {
      id: 11, name: 'prod-pve', daemon_type: 'proxmox',
      daemon_config: encryptProxmoxConfig({ endpoint: 'https://pve.example.com:8006', tokenId: 'root@pam!dd', tokenSecret: 'secret-uuid', skipTlsVerify: false }),
    };
    const out = await proxmoxCheck.run(ctx([secureHost]));
    expect(out).toHaveLength(0);
  });

  test('ignores non-proxmox hosts and hosts with no daemon_config', async () => {
    const out = await proxmoxCheck.run(ctx([
      { id: 1, name: 'docker-host', daemon_type: 'docker', daemon_config: null },
      { id: 12, name: 'blank-proxmox', daemon_type: 'proxmox', daemon_config: null },
    ]));
    expect(out).toHaveLength(0);
  });

  test('does not throw on an undecryptable daemon_config (still flags the unencrypted-storage case if applicable)', async () => {
    const garbled = { id: 30, name: 'broken', daemon_type: 'proxmox', daemon_config: 'enc:not-a-valid-cipher-blob' };
    const out = await proxmoxCheck.run(ctx([garbled]));
    // Already carries "enc:" so no credential-hygiene finding; decrypt fails so
    // the TLS check is skipped too — the important part is that it doesn't throw.
    expect(out).toHaveLength(0);
  });
});

describe('k8s posture check', () => {
  test('flags TLS verification disabled + unencrypted credential storage', async () => {
    const insecureHost = {
      id: 20, name: 'homelab-k3s', daemon_type: 'kubernetes',
      daemon_config: JSON.stringify({ endpoint: 'https://k3s.local:6443', token: 'eyJhbGciOiJSUzI1NiJ9', skipTlsVerify: true }),
    };
    const out = await k8sCheck.run(ctx([insecureHost]));
    expect(out).toHaveLength(2);
    expect(out).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'k8s.tls-verify-disabled', severity: 'high', hostId: 20 }),
      expect.objectContaining({ checkId: 'k8s.credential-unencrypted', severity: 'medium', hostId: 20 }),
    ]));
  });

  test('a properly secured + encrypted host produces no findings', async () => {
    const secureHost = {
      id: 21, name: 'prod-k8s', daemon_type: 'kubernetes',
      daemon_config: encryptK8sConfig({ endpoint: 'https://k8s.example.com:6443', token: 'eyJhbGciOiJSUzI1NiJ9', caCert: '-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----', skipTlsVerify: false }),
    };
    const out = await k8sCheck.run(ctx([secureHost]));
    expect(out).toHaveLength(0);
  });

  test('accepts the "k8s" alias daemon_type defensively', async () => {
    const host = {
      id: 22, name: 'aliased', daemon_type: 'k8s',
      daemon_config: JSON.stringify({ endpoint: 'https://k3s.local:6443', token: 'x', skipTlsVerify: true }),
    };
    const out = await k8sCheck.run(ctx([host]));
    expect(out.some(f => f.checkId === 'k8s.tls-verify-disabled')).toBe(true);
  });

  test('ignores non-kubernetes hosts and hosts with no daemon_config', async () => {
    const out = await k8sCheck.run(ctx([
      { id: 2, name: 'docker-host', daemon_type: 'docker', daemon_config: null },
      { id: 23, name: 'blank-k8s', daemon_type: 'kubernetes', daemon_config: null },
    ]));
    expect(out).toHaveLength(0);
  });
});

describe('proxmox + k8s checks are registered', () => {
  test('appear in the posture check registry', () => {
    const { ALL } = require('../services/posture/checks');
    expect(ALL.some(c => c.id === 'proxmox')).toBe(true);
    expect(ALL.some(c => c.id === 'k8s')).toBe(true);
  });
});
