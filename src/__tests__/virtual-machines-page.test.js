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
});
