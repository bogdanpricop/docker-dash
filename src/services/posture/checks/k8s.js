'use strict';

// v8.9.45-alpha.1 — read-only posture coverage for Kubernetes hosts. Mirrors
// proxmox.js: connection config only, decrypted from daemon_config, no live API
// calls. 'kubernetes' is the DB CHECK-constraint value (migration 069); 'k8s' is
// accepted defensively in case a row is ever seeded with the short alias.
//
// Floor of coverage:
//   - TLS verification disabled (skipTlsVerify) — the API server's certificate
//     is accepted blind, so the ServiceAccount bearer token can be MITM'd.
//   - daemon_config stored without the "enc:" envelope — bypassed the normal
//     encrypt-on-save path (src/services/kubernetes.js encryptDaemonConfig).

const KUBE_TYPES = new Set(['kubernetes', 'k8s']);

module.exports = {
  id: 'k8s',
  category: 'exposure',
  async run(ctx) {
    const out = [];
    const hosts = ctx.hosts.filter(h => KUBE_TYPES.has(h.daemon_type));
    if (!hosts.length) return out;
    const { decryptDaemonConfig } = require('../../kubernetes');

    for (const h of hosts) {
      if (!h.daemon_config) continue;

      if (!String(h.daemon_config).startsWith('enc:')) {
        out.push({
          checkId: 'k8s.credential-unencrypted', severity: 'medium', hostId: h.id, subject: `host:${h.id}`,
          category: 'credentials',
          title: `Kubernetes bearer token stored without encryption — ${h.name}`,
          detail: 'This host\'s daemon_config is stored in plaintext (no "enc:" envelope), so the ServiceAccount bearer token is readable in the clear by anyone with DB/file access instead of being protected by ENCRYPTION_KEY (AES-256-GCM).',
          evidence: `daemon_config missing "enc:" prefix on host ${h.id}`,
          remediation: { type: 'guide', label: 'Re-save the host', link: '#/hosts', steps: 'Open this host\'s connection settings and save again — docker-dash encrypts daemon_config automatically when it goes through the normal edit path.' },
        });
      }

      let cfg;
      try { cfg = decryptDaemonConfig(h.daemon_config); }
      catch { continue; } // can't decrypt (ENCRYPTION_KEY changed?) — not this check's job to flag

      if (cfg.skipTlsVerify) {
        out.push({
          checkId: 'k8s.tls-verify-disabled', severity: 'high', hostId: h.id, subject: `host:${h.id}`,
          title: `TLS certificate verification disabled — ${h.name}`,
          detail: 'This Kubernetes host is configured with skipTlsVerify, so the API server connection accepts ANY certificate, including a spoofed one. Anyone positioned on the network path can intercept the ServiceAccount bearer token.',
          evidence: `daemon_config.skipTlsVerify = true on host ${h.id}`,
          remediation: { type: 'guide', label: 'Trust the cluster CA', link: '#/hosts', steps: 'Edit this host and supply the cluster\'s CA certificate (caCert) instead of skipping verification, then turn skipTlsVerify off — don\'t leave verification permanently skipped.' },
        });
      }
    }
    return out;
  },
};
