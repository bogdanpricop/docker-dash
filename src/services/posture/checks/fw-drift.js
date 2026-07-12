'use strict';

// v8.9.37-alpha.1 — firewall drift: app-managed rules missing on the host. Only
// probes hosts that actually have app-managed rules (keeps the scan cheap).

module.exports = {
  id: 'fw-drift',
  category: 'firewall',
  async run(ctx) {
    const out = [];
    let hostIds;
    try {
      hostIds = ctx.db.prepare('SELECT DISTINCT host_id FROM firewall_rules WHERE is_active = 1').all().map(r => r.host_id);
    } catch { return out; }
    if (!hostIds.length) return out;
    const fw = require('../../firewall');
    for (const hostId of hostIds) {
      const h = ctx.hosts.find(x => x.id === hostId);
      if (!h) continue;
      try {
        const info = await fw.listRules(hostId);
        if (info && info.drift && info.drift.length) {
          out.push({
            checkId: 'fw.drift', severity: 'medium', hostId, subject: `host:${hostId}`,
            title: `${info.drift.length} firewall rule(s) drifted on ${h.name}`,
            detail: 'App-managed firewall rules are missing on the host — removed manually or lost on a daemon/container restart.',
            evidence: `drift=${info.drift.length}`,
            // Safe one-click: re-applies rules the admin already defined (no
            // lockout risk — no new exposure is created).
            remediation: { type: 'action', label: 'Re-apply drifted rules', link: '#/firewall', action: { type: 'fw-reconcile', hostId } },
          });
        }
      } catch { /* unreachable → coverage gap, not a false pass */ }
    }
    return out;
  },
};
