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
});
