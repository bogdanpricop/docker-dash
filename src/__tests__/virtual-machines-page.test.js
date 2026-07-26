'use strict';

const page = require('../../public/js/pages/virtual-machines');

describe('common virtual machines page routing', () => {
  it('parses only canonical host-scoped VM deep links', () => {
    const id = `ddr_vm_${'a'.repeat(26)}`;
    expect(page._parseRoute(`7/${id}/hardware`)).toEqual({ hostId: 7, resourceId: id, tab: 'hardware' });
    expect(page._parseRoute(`7/${id}`)).toEqual({ hostId: 7, resourceId: id, tab: null });
    expect(page._parseRoute('7/OpaqueRef:secret')).toBeNull();
    expect(page._parseRoute(`0/${id}`)).toBeNull();
  });

  it('turns action blockers into an explanatory disabled-action tooltip', () => {
    expect(page._blockerSummary({ blockers: [
      { type: 'POLICY_BLOCKED', reason: 'Change freeze' },
      { type: 'ACTION_NOT_ENABLED', reason: 'Read-only in V1.1' },
    ] })).toBe('Change freeze · Read-only in V1.1');
  });

  it('renders snapshot preflight guardrails without trusting provider text', () => {
    global.Utils = { escapeHtml: value => String(value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') };
    const html = page._snapshotPlanHtml({
      vm: { displayName: '<img src=x>' }, action: 'create', name: 'safe-snapshot',
      consistency: 'crash', protection: { warning: '<script>alert(1)</script>' },
      blockers: [{ reason: '<b>blocked</b>' }], warnings: [{ type: 'NOT_A_BACKUP', reason: 'guardrail' }],
    });
    expect(html).toContain('Snapshot is not backup');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<script>');
    delete global.Utils;
  });
});
