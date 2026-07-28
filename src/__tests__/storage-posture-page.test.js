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
});
