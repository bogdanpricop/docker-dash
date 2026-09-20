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

  it('escapes policy and preflight evidence and labels execution independently', () => {
    const html = page._policyHtml({ id: `pbp_${'a'.repeat(26)}`, name: '<policy>', description: '<script>x</script>',
      enabled: true, schedule: { frequency: 'daily', timezone: '<zone>' },
      scope: { includeAll: true }, retention: {}, lastPlanStatus: 'planned' });
    const preflight = page._preflightHtml({ allowed: false, planHash: '<hash>', summary: {}, findings: [{
      severity: 'blocker', code: '<code>', message: '<message>',
    }] });
    expect(html).toContain('&lt;policy&gt;'); expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>'); expect(html).toContain('execution disabled');
    expect(preflight).toContain('&lt;code&gt;'); expect(preflight).toContain('&lt;message&gt;');
  });

  it('keeps planning separate while exposing gated authorization and execution controls', () => {
    const source = `${page._load} ${page._preflight} ${page._save} ${page._plan} ${page._authorize} ${page._execute}`;
    expect(source).toContain('getProviderBackupPolicies');
    expect(source).toContain('preflightProviderBackupPolicy');
    expect(source).toContain('planProviderBackupPolicy');
    expect(source).toContain('authorizeProviderBackupExecution');
    expect(source).toContain('executeProviderBackupPolicy');
    expect(page._executionsHtml()).toContain('disabled by the release gate');
    const editor = page._editorHtml();
    expect(editor).toContain('bp-backup-mode');
    expect(editor).toContain('bp-limit-repository');
    expect(editor).toContain('bp-integrity-methods');
    expect(page._payload.toString()).toContain('bandwidthWindows');
    expect(page._payload.toString()).toContain('pathSelectors');
  });

  it('keeps restore-drill authorization separate and links it only to opted-in backup policies', () => {
    const source = `${page._load} ${page._configureDrill} ${page._deleteDrill}`;
    expect(source).toContain('getProviderRestoreDrillPolicies');
    expect(source).toContain('saveProviderRestoreDrillPolicy');
    expect(source).toContain('deleteProviderRestoreDrillPolicy');
    expect(source).toContain('AUTHORIZE DRILL');
    expect(source).toContain('ALLOW AUTOMATIC CLEANUP');
    expect(page._payload.toString()).toContain('bp-restore-drill');
  });
});
