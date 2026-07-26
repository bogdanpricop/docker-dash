'use strict';

global.Utils = { formatDuration: seconds => `${seconds}s` };

const page = require('../../public/js/pages/activity-center');

describe('Provider operation Activity Center presentation helpers', () => {
  it('renders explicit user and system ownership', () => {
    expect(page._ownerLabel({ owner: { type: 'user', id: 7, username: 'operator-a' } })).toBe('operator-a');
    expect(page._ownerLabel({ owner: { type: 'user', id: 7, username: null } })).toBe('User #7');
    expect(page._ownerLabel({ owner: { type: 'system', id: null, username: null } })).toBe('System');
  });

  it('derives bounded operation duration from public timestamps', () => {
    expect(page._duration({ startedAt: null })).toBe('—');
    expect(page._duration({
      startedAt: '2026-07-26T12:00:00.000Z', completedAt: '2026-07-26T12:01:05.000Z',
    })).toBe('65s');
    expect(page._duration({ startedAt: 'invalid', completedAt: 'invalid' })).toBe('—');
  });
});
