'use strict';

const page = require('../../public/js/pages/high-availability');

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

describe('high availability page', () => {
  beforeEach(() => {
    global.Utils = { escapeHtml, timeAgo: value => String(value) };
    global.App = { user: { role: 'admin' } };
  });
  afterEach(() => { delete global.Utils; delete global.App; });

  it('escapes provider evidence, validates DOM IDs and never renders native references', () => {
    const html = page._domainHtml({
      id: '"><script>bad()</script>', displayName: '<cluster>', state: 'degraded', score: 40,
      onlineHostCount: 1, hostCount: 2, protectedVmCount: 0, poweredOnVmCount: 1,
      protectionCoveragePercent: 0, observedFailureTolerance: null,
      signals: [{ key: '<signal>', state: 'warning', reason: '<reason>', source: '<source>', confidence: 'high' }],
      scenarios: [{ failures: 1, state: 'fail', source: 'estimated', reason: '<unsafe>' }],
      recoveryGroups: [{ priority: 'disabled', items: [{ displayName: '<vm>', poweredOn: true, protected: false }] }],
      warnings: ['<warning>'], nativeRef: 'OpaqueRef:secret',
    });
    expect(html).toContain('id="ha-domain-ddr_cluster_unknown"');
    expect(html).toContain('&lt;cluster&gt;');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('OpaqueRef:secret');
  });

  it('sanitizes malformed history scalars and wires read, refresh and history APIs', () => {
    const html = page._historyHtml({ items: [{
      observedAt: '<time>', state: null, score: '<img>', domainCount: -1, snapshotHash: '<hash>',
    }] });
    expect(html).toContain('&lt;time&gt;');
    expect(html).toContain('unknown');
    expect(html).not.toContain('<img>');
    const source = page._load.toString();
    expect(source).toContain('getProviderHaReadiness');
    expect(source).toContain('refreshProviderHaReadiness');
    expect(source).toContain('getProviderHaReadinessHistory');
    expect(source).not.toContain('nativeRef');
  });
});
