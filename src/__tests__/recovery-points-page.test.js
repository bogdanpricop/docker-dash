'use strict';

const page = require('../../public/js/pages/recovery-points');

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

describe('recovery points page', () => {
  beforeEach(() => {
    global.Utils = { escapeHtml, timeAgo: value => String(value), formatBytes: value => `${value} B` };
  });
  afterEach(() => { delete global.Utils; });

  it('escapes all provider evidence and never renders native references', () => {
    const repositories = page._repositoriesHtml([{
      id: `ddr_repo_${'a'.repeat(26)}`, displayName: '<repo>', repositoryType: 'xen-orchestra-remote',
      status: { accessible: true }, capabilities: { verification: true }, nativeRef: 'secret-remote',
    }]);
    const points = page._pointsHtml([{
      id: `ddr_rp_${'b'.repeat(26)}`, displayName: '<point>', createdAt: '<time>',
      repository: { displayName: '<repository>' }, workload: { displayName: '<script>bad()</script>', missingFromInventory: true },
      backup: { mode: '<delta>', format: '<format>', sizeBytes: 10 }, verification: { state: 'unknown' },
      nativeRef: 'OpaqueRef:secret',
    }]);
    expect(repositories).toContain('&lt;repo&gt;');
    expect(points).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(points).not.toContain('<script>');
    expect(`${repositories}${points}`).not.toContain('secret-remote');
    expect(`${repositories}${points}`).not.toContain('OpaqueRef');
    expect(`${repositories}${points}`).not.toMatch(/delete|run backup/i);
    expect(points).toContain('release disabled');
  });

  it('wires guarded restore through preflight before submit', () => {
    const source = page._load.toString();
    expect(source).toContain('getProviderRecoveryPoints');
    expect(source).not.toContain('post(');
    expect(source).not.toContain('delete(');
    const restore = page._restore.toString();
    expect(restore).toContain('preflightProviderRecoveryRestore');
    expect(restore).toContain('submitProviderRecoveryRestore');
    expect(restore.indexOf('preflightProviderRecoveryRestore')).toBeLessThan(restore.indexOf('submitProviderRecoveryRestore'));
  });

  it('wires isolated drills through preflight and two confirmations before submit', () => {
    const drill = page._drill.toString();
    expect(drill).toContain('preflightProviderRestoreDrill');
    expect(drill).toContain('submitProviderRestoreDrill');
    expect(drill.indexOf('preflightProviderRestoreDrill')).toBeLessThan(
      drill.indexOf('submitProviderRestoreDrill'));
    expect(drill).toContain('cleanupConfirmText');
    expect(drill).toContain("guestAgent: guestType === 'lxc'");
  });
});
