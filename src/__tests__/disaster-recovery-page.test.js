'use strict';

const page = require('../../public/js/pages/disaster-recovery');

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

describe('disaster recovery page', () => {
  beforeEach(() => {
    global.Utils = { escapeHtml, timeAgo: value => String(value) };
    global.App = { user: { role: 'admin' } };
  });
  afterEach(() => { delete global.Utils; delete global.App; });

  it('escapes protection posture and exposes only canonical, measured evidence', () => {
    page._groups = [{ id: `pdrg_${'a'.repeat(26)}`, name: '<group>', members: [] }];
    page._overview = { count: 1, counts: { failed: 1 }, replication: {
      count: 0, capability: { state: 'unsupported', reason: '<provider reason>' },
    }, items: [{ group: { id: `pdrg_${'a'.repeat(26)}`, name: '<script>bad()</script>',
      strategy: 'backup_restore', revision: 1, enabled: true, members: [],
      rpoTargetSeconds: 300, rtoTargetSeconds: 120 }, compliance: 'failed', blockerCount: 1,
      warningCount: 0, rpoMaxSeconds: 400, rtoMaxSeconds: 121, lastRun: null }] };
    const html = `${page._summaryHtml()}${page._groupsHtml()}`;
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('&lt;provider reason&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Review real plan');
    expect(html).toContain('Record rehearsal');
  });

  it('keeps provider mutations unavailable while wiring evidence, plan and rehearsal APIs', () => {
    const load = page._load.toString(); const plan = page._plan.toString();
    const rehearse = page._rehearse.toString(); const save = page._save.toString();
    expect(load).toContain('getProviderDrOverview');
    expect(load).toContain('getProviderDrReplications');
    expect(load).toContain('getProviderDrRuns');
    expect(plan).toContain('preflightProviderDrRunbook');
    expect(rehearse).toContain('rehearseProviderDrRunbook');
    expect(rehearse).toContain('REHEARSE');
    expect(save).toContain('saveProviderDrProtectionGroup');
    expect(`${plan}${rehearse}${save}`).not.toContain('failoverProvider');
  });

  it('renders opaque evidence hashes without unsafe provider-native references', () => {
    page._groups = [];
    page._runs = [{ groupId: `pdrg_${'b'.repeat(26)}`, mode: 'test', state: 'succeeded',
      compliance: 'met', completedAt: '<time>', evidenceHash: '<hash>', rpoMaxSeconds: 60,
      rtoMaxSeconds: 120, nativeRef: 'OpaqueRef:secret' }];
    const html = page._runsHtml();
    expect(html).toContain('&lt;hash&gt;'); expect(html).toContain('&lt;time&gt;');
    expect(html).not.toContain('OpaqueRef:secret');
  });
});
