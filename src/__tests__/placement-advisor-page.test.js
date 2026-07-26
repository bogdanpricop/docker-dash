'use strict';

const page = require('../../public/js/pages/placement-advisor');

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

describe('placement advisor page', () => {
  beforeEach(() => {
    global.Utils = { escapeHtml, timeAgo: value => String(value) };
    global.App = { user: { role: 'admin' } };
  });
  afterEach(() => { delete global.Utils; delete global.App; });

  it('escapes rule/recommendation evidence and never renders native references', () => {
    const policy = page._affinityHtml({
      observedAt: '<time>', provider: { type: '<xen>' }, capability: { state: 'conditional' }, freshness: { state: 'fresh' },
      limitations: ['<limit>'], rules: [{ name: '<rule>', kind: 'vm_host_affinity', mandatory: true,
        compliance: { state: 'violated', reason: '<reason>' }, virtualMachineIds: ['safe'], hostIds: [], nativeRef: 'OpaqueRef:secret' }],
    });
    expect(policy).toContain('&lt;rule&gt;');
    expect(policy).toContain('&lt;reason&gt;');
    expect(policy).not.toContain('<rule>');
    expect(policy).not.toContain('OpaqueRef:secret');

    const recommendation = page._recommendationHtml({ vm: { displayName: '<vm>' }, planHash: 'a'.repeat(64), candidates: [{
      target: { id: 'safe', displayName: '<host>' }, score: 80, evidenceCoveragePercent: 75, confidence: 'medium',
      readyModes: ['live'], eligible: false, blockers: [{ reason: '<blocked>' }],
    }] });
    expect(recommendation).toContain('&lt;blocked&gt;');
    expect(recommendation).not.toContain('<blocked>');
  });

  it('wires all three placement APIs and labels rebalance as a dry-run', () => {
    expect(page._load.toString()).toContain('getProviderAffinity');
    expect(page._recommend.toString()).toContain('getProviderPlacementRecommendations');
    expect(page._plan.toString()).toContain('planProviderRebalance');
    expect(page._planHtml({ moves: [], skipped: [], planHash: 'a'.repeat(64), expiresAt: 'later' })).toContain('Dry-run only');
    expect(page._plan.toString()).not.toMatch(/migrate|execute|apply/i);
  });
});
