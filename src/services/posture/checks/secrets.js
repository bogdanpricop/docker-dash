'use strict';

// v8.9.37-alpha.1 — credential/setup hygiene checks (DB-only, always reliable).

module.exports = {
  id: 'secrets',
  category: 'credentials',
  async run(ctx) {
    const out = [];
    const admin = ctx.db.prepare("SELECT must_change_password FROM users WHERE username = 'admin'").get();
    if (admin && admin.must_change_password) {
      out.push({
        checkId: 'secrets.default-admin', severity: 'critical', subject: 'admin',
        title: 'Default admin password not changed',
        detail: 'The built-in admin account still has must-change-password set — it is almost certainly still using the default credential (admin/admin).',
        evidence: 'users.must_change_password = 1 for admin',
        remediation: { type: 'link', label: 'Change the admin password', link: '#/profile' },
      });
    }
    const setup = ctx.db.prepare("SELECT value FROM settings WHERE key = 'setup_completed'").get();
    if (!setup || setup.value !== 'true') {
      out.push({
        checkId: 'secrets.setup', severity: 'medium', subject: 'setup',
        title: 'Initial security setup not completed',
        detail: 'The initial security setup has not been completed — run it to lock down defaults.',
        evidence: 'settings.setup_completed != true',
        remediation: { type: 'link', label: 'Open System', link: '#/system' },
      });
    }
    return out;
  },
};
