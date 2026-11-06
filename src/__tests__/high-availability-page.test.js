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
      recoveryPlan: { state: 'advisory', mode: 'explicit_dependencies', confidence: 'high',
        estimatedCompletionSeconds: 90, blockers: ['<timing limit>'], edges: [{ from: 'a', to: 'b' }],
        nodes: [{ id: 'a', displayName: '<database>', priority: 'highest', estimatedReadySeconds: 60, dependencyIds: [] },
          { id: 'b', displayName: '<application>', priority: 'medium', estimatedReadySeconds: 30, dependencyIds: ['a'] }],
        waves: [{ index: 1, startOffsetSeconds: 0, estimatedReadyAtSeconds: 60, items: ['a'], dependsOnWaveIds: [] },
          { index: 2, startOffsetSeconds: 60, estimatedReadyAtSeconds: 90, items: ['b'], dependsOnWaveIds: ['wave-1'] }] },
      recoveryGroups: [{ priority: 'disabled', items: [{ displayName: '<vm>', poweredOn: true, protected: false }] }],
      warnings: ['<warning>'], nativeRef: 'OpaqueRef:secret',
    });
    expect(html).toContain('id="ha-domain-ddr_cluster_unknown"');
    expect(html).toContain('&lt;cluster&gt;');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).toContain('Recovery dependency DAG');
    expect(html).toContain('&lt;database&gt;');
    expect(html).toContain('&lt;timing limit&gt;');
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
