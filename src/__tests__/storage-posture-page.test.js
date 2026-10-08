'use strict';

const page = require('../../public/js/pages/storage-posture');

describe('Storage posture presentation helpers', () => {
  it('uses a failing badge only for a failing provider signal', () => {
    expect(page._badge('fail')).toBe('badge-danger');
    expect(page._badge('unknown')).toBe('badge-secondary');
  });

  it('renders unsupported coverage as unknown rather than healthy', () => {
    global.Utils = { escapeHtml: value => String(value), formatBytes: value => `${value} B` };
    const html = page._capabilityHtml({ qos: { state: 'unsupported' }, health: { state: 'conditional' } });
    expect(html).toContain('qos: unsupported');
    expect(html).toContain('badge-secondary');
  });

  it('labels a topology with unread VM evidence as partial', () => {
    global.Utils = { escapeHtml: value => String(value), formatBytes: value => `${value} B` };
    const html = page._topologyHtml({ summary: { confirmedCount: 0, reviewCount: 1 },
      coverage: { complete: false, truncated: false, hardwareUnavailable: 1 }, sharedBackings: [] });
    expect(html).toContain('partial evidence');
    expect(html).toContain('Unreadable VM inventories');
  });

  it('calls placement results advisory-only rather than a reservation', () => {
    global.Utils = { escapeHtml: value => String(value), formatBytes: value => `${value} B` };
    const html = page._placementHtml({ requested: { bytes: 10, requiredBytes: 11, headroomPercent: 10 },
      summary: { candidateCount: 1, blockedCount: 0, unknownCount: 0 }, storages: [] });
    expect(html).toContain('does not reserve capacity');
    expect(html).toContain('Candidates');
  });

  it('renders policy noncompliance separately from missing evidence', () => {
    global.Utils = { escapeHtml: value => String(value), formatBytes: value => `${value} B` };
    const html = page._policyHtml({ policy: { minFreeBytes: 10, requireShared: true },
      summary: { compliantCount: 1, noncompliantCount: 1, unknownCount: 1 }, storages: [] });
    expect(html).toContain('Noncompliant');
    expect(html).toContain('not persisted');
  });

  it('renders snapshot risk as monitor-only and never as inferred byte coverage', () => {
    global.App = { user: { role: 'viewer' } };
    global.Utils = { escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), formatBytes: value => value === null ? '—' : `${value} B`, timeAgo: value => value };
    page._hostId = 7;
    const html = page._snapshotRiskHtml({
      summary: { state: 'warning', snapshotCount: 2, states: { critical: 0, warning: 1 }, oldestAgeDays: 10, maxChainDepth: 2, estimatedBytesKnownCount: 0 },
      coverage: { evidenceFreshness: 'fresh', lastCaptureAt: '2026-07-30T00:00:00Z' },
      policy: { warningAgeDays: 7, criticalAgeDays: 30, warningChainDepth: 3, criticalChainDepth: 8, warningGrowthPercent: 20, criticalGrowthPercent: 50 },
      items: [{ snapshotId: `dds_snap_${'a'.repeat(26)}`, vm: { id: `ddr_vm_${'b'.repeat(26)}`, displayName: '<vm>' }, name: '<snap>', state: 'warning', ageDays: 10, chainDepth: 2, estimatedBytes: null, growthPercent: null, reasons: [{ code: 'AGE_WARNING' }] }],
      history: [],
    });
    expect(html).toContain('Monitor only');
    expect(html).toContain('0/2');
    expect(html).toContain('&lt;vm&gt;');
    expect(html).not.toContain('<vm>');
    delete global.App;
  });

  it('keeps network-only repository evidence unknown and escapes endpoint content', () => {
    global.App = { user: { role: 'viewer' } };
    global.Utils = { escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), formatBytes: value => `${value} B` };
    const html = page._repositoryHealthHtml({
      summary: { total: 1, states: { healthy: 0, unknown: 1, degraded: 0, unavailable: 0, critical: 0 } },
      coverage: { dataPlaneAdapterAvailable: false },
      limitations: ['Auth and list require an adapter.'],
      repositories: [{ id: 1, name: '<NAS>', protocol: 'smb', hostname: '<host>', port: 445,
        repositoryPath: 'backups', credentialConfigured: true, freshness: 'fresh', latest: {
          observedAt: '2026-07-30T10:00:00Z', state: 'unknown', latencyMs: 10,
          stages: { dns: { state: 'pass' }, tcp: { state: 'pass' }, auth: { state: 'unknown' }, list: { state: 'unknown' } },
        }, history: [] }],
    });
    expect(html).toContain('An open port alone is never reported as healthy');
    expect(html).toContain('&lt;NAS&gt;');
    expect(html).not.toContain('<NAS>');
    expect(html).toContain('auth: unknown');
    delete global.App;
  });
});
