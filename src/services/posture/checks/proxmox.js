'use strict';

// v8.9.45-alpha.1 — read-only posture coverage for Proxmox VE hosts. Uses ONLY
// the connection config already stored in daemon_config (decrypt, no live API
// calls — same trust boundary as insecure-docker.js / secrets.js). Findings are
// advisory: hypervisor connections are never auto-remediated from here.
//
// Floor of coverage (mirrors vsphere.js's role as the hypervisor-type check,
// scoped to what's observable without a network round-trip):
//   - TLS verification disabled (skipTlsVerify) — self-signed certs accepted
//     blind, so the API token can be MITM'd.
//   - daemon_config stored without the "enc:" envelope — a legacy/manual row
//     that bypassed the normal encrypt-on-save path (src/services/proxmox.js
//     encryptDaemonConfig / decryptDaemonConfig).

module.exports = {
  id: 'proxmox',
  category: 'exposure',
  async run(ctx) {
    const out = [];
    const hosts = ctx.hosts.filter(h => h.daemon_type === 'proxmox');
    if (!hosts.length) return out;
    const { decryptDaemonConfig } = require('../../proxmox');

    for (const h of hosts) {
      if (!h.daemon_config) continue;

      if (!String(h.daemon_config).startsWith('enc:')) {
        out.push({
          checkId: 'proxmox.credential-unencrypted', severity: 'medium', hostId: h.id, subject: `host:${h.id}`,
          category: 'credentials',
          title: `Proxmox API token stored without encryption — ${h.name}`,
          detail: 'This host\'s daemon_config is stored in plaintext (no "enc:" envelope), so the Proxmox API token is readable in the clear by anyone with DB/file access instead of being protected by ENCRYPTION_KEY (AES-256-GCM).',
          evidence: `daemon_config missing "enc:" prefix on host ${h.id}`,
          remediation: { type: 'guide', label: 'Re-save the host', link: '#/hosts', steps: 'Open this host\'s connection settings and save again — docker-dash encrypts daemon_config automatically when it goes through the normal edit path.' },
        });
      }

      let cfg;
      try { cfg = decryptDaemonConfig(h.daemon_config); }
      catch { continue; } // can't decrypt (ENCRYPTION_KEY changed?) — not this check's job to flag

      if (cfg.skipTlsVerify) {
        out.push({
          checkId: 'proxmox.tls-verify-disabled', severity: 'high', hostId: h.id, subject: `host:${h.id}`,
          title: `TLS certificate verification disabled — ${h.name}`,
          detail: 'This Proxmox host is configured with skipTlsVerify, so the API connection accepts ANY certificate, including a spoofed one. Anyone positioned on the network path between docker-dash and this cluster can intercept the API token.',
          evidence: `daemon_config.skipTlsVerify = true on host ${h.id}`,
          remediation: { type: 'guide', label: 'Trust the real certificate', link: '#/hosts', steps: 'Edit this host once the cluster serves a certificate your system trusts (its own CA or a public one), then turn skipTlsVerify off — don\'t leave verification permanently skipped.' },
        });
      }
    }
    return out;
  },
};
