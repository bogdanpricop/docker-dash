'use strict';

// v8.9.37-alpha.1 — Docker daemon exposed over plain TCP without TLS. Whoever can
// reach that port has root-equivalent control of the host (CIS Docker Benchmark).

module.exports = {
  id: 'insecure-docker',
  category: 'exposure',
  async run(ctx) {
    const out = [];
    for (const h of ctx.hosts) {
      if (h.connection_type !== 'tcp') continue;
      if ((h.daemon_type || 'docker') !== 'docker' && (h.daemon_type || 'docker') !== 'podman') continue;
      let tls = null;
      try { tls = h.tls_config ? JSON.parse(h.tls_config) : null; } catch { /* treat as none */ }
      const hasTls = tls && (tls.ca || tls.cert || tls.key);
      if (!hasTls) {
        out.push({
          checkId: 'fw.insecure-docker', severity: 'critical', hostId: h.id, subject: `host:${h.id}`,
          title: `Docker daemon over plain TCP without TLS — ${h.name}`,
          detail: 'This host is reached over unencrypted TCP (typically :2375) with no TLS. Anyone who can reach that port controls the Docker daemon, i.e. root on the host.',
          evidence: `connection_type=tcp, no tls_config on host ${h.id}`,
          remediation: { type: 'guide', label: 'Secure the daemon', link: '#/firewall', steps: 'Switch this host to TLS (2376) or SSH transport, AND restrict the port to trusted IPs with a firewall rule (Firewall page → block 2375 for everyone / allow only your admin range).' },
        });
      }
    }
    return out;
  },
};
