'use strict';

// v8.9.38-alpha.1 — outbound network posture per Docker/Podman host, reusing the
// existing egress-audit analyzer. Emits per-host summaries (not one finding per
// container) so it never floods the score. Best-effort: unreachable hosts skip.

module.exports = {
  id: 'egress',
  category: 'network',
  async run(ctx) {
    const out = [];
    const egressAudit = require('../../egress-audit');
    const dockerService = require('../../docker');
    for (const h of ctx.hosts) {
      const dt = h.daemon_type || 'docker';
      if (dt !== 'docker' && dt !== 'podman') continue;
      try {
        const docker = dockerService.getDocker(h.id);
        const containers = await docker.listContainers({ all: false }); // running only
        if (!containers.length) continue;

        const networksByName = new Map();
        try {
          const nets = await docker.listNetworks();
          await Promise.all(nets.map(async (n) => {
            try { const full = await docker.getNetwork(n.Id).inspect(); networksByName.set(full.Name, full); } catch { /* ignore */ }
          }));
        } catch { /* ignore */ }

        let imds = 0, critical = 0;
        for (const c of containers) {
          try {
            const inspect = await docker.getContainer(c.Id).inspect();
            const a = egressAudit.analyzeContainer(inspect, networksByName);
            if (a.canReachIMDS) imds++;
            if ((a.findings || []).some((f) => f.severity === 'critical')) critical++;
          } catch { /* skip container */ }
        }

        if (imds > 0) {
          out.push({
            checkId: 'egress.imds', severity: 'high', hostId: h.id, subject: `host:${h.id}:imds`,
            title: `${imds} container(s) can reach cloud metadata (IMDS) on ${h.name}`,
            detail: 'Containers that can reach 169.254.169.254 can have cloud credentials stolen via SSRF if compromised.',
            evidence: `imds-reachable=${imds}`,
            remediation: { type: 'guide', label: 'Egress posture', link: '#/system', steps: 'Apply an egress policy (System → Egress) that blocks IMDS, or move these containers to an internal network.' },
          });
        }
        if (critical > 0) {
          out.push({
            checkId: 'egress.internet', severity: 'medium', hostId: h.id, subject: `host:${h.id}:egress`,
            title: `${critical} container(s) with critical egress exposure on ${h.name}`,
            detail: 'Containers with unrestricted outbound internet access and a sensitive network posture.',
            evidence: `critical-egress=${critical}`,
            remediation: { type: 'guide', label: 'Egress posture', link: '#/system', steps: 'Review and apply egress policies for these containers (System → Egress).' },
          });
        }
      } catch { /* host unreachable → coverage gap, not a false pass */ }
    }
    return out;
  },
};
