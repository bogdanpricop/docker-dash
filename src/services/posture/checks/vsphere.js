'use strict';

// v8.9.37-alpha.1 — ESXi lifecycle posture: End-of-Life versions and known
// critical CVEs, from the built-in esxi-version-db. Best-effort live SOAP call.

module.exports = {
  id: 'vsphere',
  category: 'lifecycle',
  async run(ctx) {
    const out = [];
    const vsphereHosts = ctx.hosts.filter(h => h.daemon_type === 'vsphere');
    if (!vsphereHosts.length) return out;
    const vsphere = require('../../vsphere');
    const { checkVersion } = require('../../esxi-version-db');
    for (const h of vsphereHosts) {
      let client;
      try {
        client = vsphere.fromHostRow(h);
        await client.login();
        const esxiHosts = await client.listHosts();
        for (const eh of (esxiHosts || [])) {
          if (!eh.productVersion || !eh.build) continue;
          const c = checkVersion(eh.productVersion, eh.build);
          if (c.isEndOfLife) {
            out.push({
              checkId: 'vsphere.eol', severity: 'high', hostId: h.id, subject: `esxi:${eh.name}`,
              title: `ESXi ${eh.productVersion} is End of Life — ${eh.name}`,
              detail: 'This ESXi version no longer receives security updates. Plan an upgrade or migrate its VMs to a supported platform.',
              evidence: `version=${eh.productVersion} build=${eh.build}`,
              remediation: { type: 'guide', label: 'Upgrade / migrate', link: '#/vsphere-resources', steps: 'Upgrade ESXi to a supported release, or use the VM migration tooling to move its VMs to Proxmox/Incus.' },
            });
          }
          if ((c.criticalCVECount || 0) > 0) {
            out.push({
              checkId: 'vsphere.cve', severity: 'critical', hostId: h.id, subject: `esxi:${eh.name}`,
              title: `${c.criticalCVECount} critical CVE(s) affect ESXi ${eh.productVersion} — ${eh.name}`,
              detail: 'Known critical vulnerabilities affect this ESXi version. Patch to the latest build or apply mitigations.',
              evidence: `criticalCVECount=${c.criticalCVECount}, build=${eh.build}`,
              remediation: { type: 'link', label: 'Version & security', link: '#/vsphere-resources' },
            });
          }
        }
      } catch { /* unreachable/auth → coverage gap */ }
      finally { if (client) { try { await client.logout(); } catch { /* ignore */ } } }
    }
    return out;
  },
};
