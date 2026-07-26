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

  it('escapes all provider evidence and renders no native references or mutation controls', () => {
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
    expect(`${repositories}${points}`).not.toMatch(/restore|delete|run backup/i);
  });

  it('wires only the read-only recovery-point API', () => {
    const source = page._load.toString();
    expect(source).toContain('getProviderRecoveryPoints');
    expect(source).not.toContain('post(');
    expect(source).not.toContain('delete(');
  });
});
