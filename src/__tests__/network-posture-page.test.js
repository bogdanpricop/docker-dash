'use strict';

const page = require('../../public/js/pages/network-posture');

describe('Network posture presentation helpers', () => {
  it('keeps missing posture evidence secondary', () => {
    expect(page._badge('unknown')).toBe('badge-secondary');
  });

  it('renders route and isolation as assessment limits rather than guarantees', () => {
    global.Utils = { escapeHtml: value => String(value) };
    const html = page._resultHtml({ provider: { type: 'vsphere' }, summary: { state: 'unknown', networkCount: 0, states: {} }, networks: [], limitations: ['Routing is not tested'] });
    expect(html).toContain('Assessment limits');
    expect(html).toContain('Routing is not tested');
  });
});
