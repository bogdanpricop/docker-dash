'use strict';

const page = require('../../public/js/pages/virtualization-catalog');

describe('Virtualization catalog presentation helpers', () => {
  it('maps portable artifact kinds to operator labels', () => {
    expect(page._kindLabel('vmTemplate')).toBe('VM template');
    expect(page._kindLabel('iso')).toBe('ISO image');
    expect(page._kindLabel('futureKind')).toBe('futureKind');
  });

  it('builds searchable text only from public catalog fields', () => {
    expect(page._searchText({
      displayName: 'Debian Gold', description: 'Hardened', spec: { osType: 'Linux' }, labels: { team: 'Platform' },
    })).toContain('debian gold hardened linux platform');
  });
});
