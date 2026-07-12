'use strict';

// v8.9.39-alpha.1 — sensitive ports open to the world. Parses the live firewall
// ruleset (shared per-scan via ctx.firewall.info) with HIGH precision — it only
// flags a sensitive port that is ALLOWed from ANY source (no CIDR/IP restriction),
// so a port restricted to a subnet is not a false positive. Guided remediation
// only (closing a port could self-lock; the Firewall page's lockout guard helps).

const SENSITIVE = {
  2375: { sev: 'critical', name: 'Docker API (plaintext)' },
  2376: { sev: 'high', name: 'Docker API (TLS)' },
  3389: { sev: 'high', name: 'RDP' },
  5432: { sev: 'high', name: 'PostgreSQL' },
  3306: { sev: 'high', name: 'MySQL/MariaDB' },
  6379: { sev: 'high', name: 'Redis' },
  27017: { sev: 'high', name: 'MongoDB' },
  9200: { sev: 'medium', name: 'Elasticsearch' },
  5900: { sev: 'medium', name: 'VNC' },
  22: { sev: 'medium', name: 'SSH' },
  8101: { sev: 'medium', name: 'docker-dash' },
};

// Return the set of ports that ACCEPT from anywhere, given a backend + raw dump.
function _worldOpenPorts(backend, raw) {
  const open = new Set();
  if (!raw) return open;
  for (const line of String(raw).split('\n')) {
    if (backend === 'ufw') {
      // "2375/tcp on ens192   ALLOW IN   Anywhere"  → world-open
      // "...                   ALLOW IN   192.168.0.0/20" → restricted (skip)
      const m = line.match(/^\s*(\d{1,5})(?:\/(?:tcp|udp))?\b.*\bALLOW\s+IN\b\s+Anywhere(?:\s+\(v6\))?\s*(?:#.*)?$/i);
      if (m) open.add(parseInt(m[1], 10));
    } else if (backend === 'iptables') {
      // "-A INPUT -p tcp --dport 2375 -j ACCEPT" with no "-s <src>"
      if (!/-j ACCEPT\b/.test(line)) continue;
      if (/\s-s\s/.test(line)) continue;
      const m = line.match(/--dport\s+(\d{1,5})\b/);
      if (m) open.add(parseInt(m[1], 10));
    } else if (backend === 'nftables') {
      // "... tcp dport 2375 accept" with no "saddr"
      if (!/\baccept\b/.test(line)) continue;
      if (/\bsaddr\b/.test(line)) continue;
      const m = line.match(/dport\s+(\d{1,5})\b/);
      if (m) open.add(parseInt(m[1], 10));
    }
  }
  return open;
}

module.exports = {
  id: 'exposed-port',
  category: 'exposure',
  _internals: { _worldOpenPorts, SENSITIVE },
  async run(ctx) {
    const out = [];
    for (const h of ctx.hosts) {
      const dt = h.daemon_type || 'docker';
      if (['vsphere', 'proxmox', 'incus', 'lxd'].includes(dt)) continue; // platform firewalls are read-only + parsed elsewhere
      let info;
      try { info = await ctx.firewall.info(h.id); } catch { continue; }
      if (!info || !info.available || !info.backend || !info.raw) continue;
      const openPorts = _worldOpenPorts(info.backend, info.raw);
      for (const port of openPorts) {
        const s = SENSITIVE[port];
        if (!s) continue;
        out.push({
          checkId: 'fw.exposed-port', severity: s.sev, hostId: h.id, subject: `host:${h.id}:port:${port}`,
          title: `${s.name} (port ${port}) is open to the world on ${h.name}`,
          detail: `Port ${port} accepts connections from any source. Restrict it to trusted IPs — an exposed ${s.name} is a direct attack surface.`,
          evidence: `${info.backend}: ${port} ALLOW from anywhere`,
          remediation: { type: 'guide', label: 'Restrict in Firewall', link: '#/firewall', steps: `On the Firewall page, add a rule allowing ${port}/tcp only from your admin range, then block ${port} for everyone else. The lockout guard protects your SSH/management port from being cut off.` },
        });
      }
    }
    return out;
  },
};
