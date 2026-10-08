'use strict';

// Static credential/transport checks for every Xen management plane. No live
// hypervisor calls are made during a posture scan.

module.exports = {
  id: 'xen',
  category: 'exposure',
  async run(ctx) {
    const findings = [];
    const hosts = ctx.hosts.filter(host => host.daemon_type === 'xen');
    const { decryptDaemonConfig } = require('../../xen');
    for (const host of hosts) {
      if (!host.daemon_config) continue;
      if (!String(host.daemon_config).startsWith('enc:')) {
        findings.push({
          checkId: 'xen.credential-unencrypted', severity: 'high', hostId: host.id, subject: `host:${host.id}`,
          category: 'credentials', title: `Xen credentials stored without encryption — ${host.name}`,
          detail: 'The Xen daemon_config has no encrypted envelope, so its token, password, or SSH key may be readable directly from the database.',
          evidence: `daemon_config missing "enc:" prefix on host ${host.id}`,
          remediation: { type: 'guide', label: 'Re-save the host', link: '#/hosts', steps: 'Edit and save this Xen host through Docker Dash to encrypt daemon_config with ENCRYPTION_KEY.' },
        });
      }
      let config;
      try { config = decryptDaemonConfig(host.daemon_config); }
      catch { continue; }
      const provider = String(config.provider || 'xo').toLowerCase();
      if ((provider === 'xo' || provider === 'xapi') && config.skipTlsVerify) {
        findings.push({
          checkId: 'xen.tls-verify-disabled', severity: 'high', hostId: host.id, subject: `host:${host.id}`,
          title: `Xen TLS certificate verification disabled — ${host.name}`,
          detail: 'The management connection accepts any server certificate, allowing a network attacker to intercept the Xen token or password.',
          evidence: `provider=${provider}, skipTlsVerify=true`,
          remediation: { type: 'guide', label: 'Trust the management CA', link: '#/hosts', steps: 'Supply the Xen Orchestra/XAPI CA certificate and disable skipTlsVerify.' },
        });
      }
      if (provider === 'raw' && !config.hostKeySha256) {
        findings.push({
          checkId: 'xen.ssh-host-key-unpinned', severity: 'high', hostId: host.id, subject: `host:${host.id}`,
          title: `Raw Xen SSH host key is not pinned — ${host.name}`,
          detail: 'SSH authentication is not bound to an expected server fingerprint, so a spoofed dom0 could capture credentials and receive privileged xl/xm commands.',
          evidence: 'daemon_config.hostKeySha256 is empty',
          remediation: { type: 'guide', label: 'Pin SSH fingerprint', link: '#/hosts', steps: 'Record the dom0 SHA-256 host-key digest, edit this Xen host, and set Host key SHA-256 fingerprint.' },
        });
      }
      if (provider === 'raw' && config.sshPassword && !config.sshPrivateKey) {
        findings.push({
          checkId: 'xen.ssh-password-auth', severity: 'medium', hostId: host.id, subject: `host:${host.id}`,
          category: 'credentials', title: `Raw Xen uses SSH password authentication — ${host.name}`,
          detail: 'A dedicated key with a restricted sudo policy is safer and easier to rotate than an interactive dom0 password.',
          evidence: 'sshPassword is configured and sshPrivateKey is absent',
          remediation: { type: 'guide', label: 'Use a restricted SSH key', link: '#/howto/xen-integration', steps: 'Install a dedicated key, restrict its account/sudo policy to the Xen commands, then remove the stored password.' },
        });
      }
    }
    return findings;
  },
};
