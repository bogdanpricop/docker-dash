'use strict';

const page = require('../../public/js/pages/backup-policies');

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

describe('backup policies page', () => {
  beforeEach(() => {
    global.Utils = { escapeHtml, timeAgo: value => String(value) };
    global.App = { user: { role: 'admin' } };
  });
  afterEach(() => { delete global.Utils; delete global.App; });

  it('escapes policy and preflight evidence and labels execution as plan-only', () => {
    const html = page._policyHtml({ id: `pbp_${'a'.repeat(26)}`, name: '<policy>', description: '<script>x</script>',
      enabled: true, schedule: { frequency: 'daily', timezone: '<zone>' },
      scope: { includeAll: true }, retention: {}, lastPlanStatus: 'planned' });
    const preflight = page._preflightHtml({ allowed: false, planHash: '<hash>', summary: {}, findings: [{
      severity: 'blocker', code: '<code>', message: '<message>',
    }] });
    expect(html).toContain('&lt;policy&gt;'); expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>'); expect(html).toContain('plan only');
    expect(preflight).toContain('&lt;code&gt;'); expect(preflight).toContain('&lt;message&gt;');
  });

  it('uses only backup-policy planning APIs and never exposes an execution control', () => {
    const source = `${page._load} ${page._preflight} ${page._save} ${page._plan}`;
    expect(source).toContain('getProviderBackupPolicies');
    expect(source).toContain('preflightProviderBackupPolicy');
    expect(source).toContain('planProviderBackupPolicy');
    expect(source).not.toMatch(/executeProviderBackup|runProviderBackup|restoreProvider/);
  });
});
