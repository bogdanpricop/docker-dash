'use strict';

// v8.9.37-alpha.1 — least-privilege / access-control checks (DB-only).

module.exports = {
  id: 'rbac',
  category: 'access-control',
  async run(ctx) {
    const out = [];
    const legacy = ctx.db.prepare("SELECT value FROM settings WHERE key = 'legacy_host_access_default'").get();
    if (legacy && legacy.value === 'true') {
      out.push({
        checkId: 'rbac.legacy-default', severity: 'medium', subject: 'rbac',
        title: 'Legacy host-access default is ON',
        detail: 'Non-admin users with no explicit grants can operate every host (backward-compat default). Configure per-host permissions, then turn this off.',
        evidence: 'settings.legacy_host_access_default = true',
        remediation: { type: 'link', label: 'Configure host permissions', link: '#/hosts' },
      });
    }
    return out;
  },
};
