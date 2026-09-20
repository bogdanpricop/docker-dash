'use strict';

// Phase 3 (deep-spec-standardized-detail-views.md) — the DetailShell's
// DOM-independent decision core. The project's Jest runs without jsdom, so the
// shell factors its logic into DetailShell._pure (initial-tab resolution, hash
// building, keyboard index math, lazy/live render decision). The DOM wiring
// that consumes these is covered by per-page Puppeteer regression in 3.1+.
//
// The frontend file isn't a CommonJS module by default (it's a browser global),
// but it has a `module.exports = DetailShell` tail guard, so require() works.

const path = require('path');
const DetailShell = require(path.join(__dirname, '../../public/js/components/detail-shell.js'));
const P = DetailShell._pure;

const KEYS = ['summary', 'monitor', 'configure', 'events', 'inspect'];

describe('DetailShell._pure.initialTab', () => {
  it('falls back to the first tab when nothing else applies', () => {
    expect(P.initialTab({ tabKeys: KEYS })).toBe('summary');
  });

  it('honours an explicit defaultTab', () => {
    expect(P.initialTab({ tabKeys: KEYS, defaultTab: 'events' })).toBe('events');
  });

  it('ignores a defaultTab that is not a real tab', () => {
    expect(P.initialTab({ tabKeys: KEYS, defaultTab: 'nope' })).toBe('summary');
  });

  it('deep-links to the trailing hash segment when hashRouting is on', () => {
    expect(P.initialTab({
      hash: '#/containers/abc123/monitor', tabKeys: KEYS, hashRouting: true, id: 'abc123',
    })).toBe('monitor');
  });

  it('does not treat the id itself as a tab', () => {
    expect(P.initialTab({
      hash: '#/containers/monitor', tabKeys: KEYS, hashRouting: true, id: 'monitor',
    })).toBe('summary'); // last segment === id, not a tab selection
  });

  it('ignores hash routing when disabled', () => {
    expect(P.initialTab({
      hash: '#/containers/abc/events', tabKeys: KEYS, hashRouting: false, id: 'abc', defaultTab: 'inspect',
    })).toBe('inspect');
  });

  it('returns null when there are no tabs', () => {
    expect(P.initialTab({ tabKeys: [] })).toBeNull();
  });
});

describe('DetailShell._pure.buildHash', () => {
  it('builds a resource/id/tab hash', () => {
    expect(P.buildHash('containers', 'abc123', 'monitor')).toBe('#/containers/abc123/monitor');
  });
  it('returns null when resourceKey or id is missing', () => {
    expect(P.buildHash(null, 'abc', 'monitor')).toBeNull();
    expect(P.buildHash('containers', null, 'monitor')).toBeNull();
  });
});

describe('DetailShell._pure.nextIndex', () => {
  it('wraps forward past the end', () => {
    expect(P.nextIndex(4, 1, 5)).toBe(0);
  });
  it('wraps backward past the start', () => {
    expect(P.nextIndex(0, -1, 5)).toBe(4);
  });
  it('moves normally in the middle', () => {
    expect(P.nextIndex(2, 1, 5)).toBe(3);
  });
});

describe('DetailShell._pure.shouldRender', () => {
  it('renders an unrendered tab', () => {
    expect(P.shouldRender(false, false)).toBe(true);
  });
  it('does not re-render a rendered static tab', () => {
    expect(P.shouldRender(true, false)).toBe(false);
  });
  it('always re-renders a live (streaming) tab', () => {
    expect(P.shouldRender(true, true)).toBe(true);
  });
});

describe('B353 standardized resource detail contract', () => {
  it('orders the shared operational tabs first and preserves resource-specific tabs', () => {
    const tabs = P.standardizeTabs([
      { key: 'overview' }, { key: 'hardware' }, { key: 'events' }, { key: 'tasks' },
    ]);
    expect(tabs.map(tab => tab.key)).toEqual([
      'overview', 'actions', 'tasks', 'events', 'audit', 'hardware',
    ]);
    expect(tabs.find(tab => tab.key === 'actions').unavailable).toBe(true);
  });

  it('deduplicates action blocker explanations', () => {
    expect(P.actionExplanation({ available: false, blockers: [
      { message: 'Read-only policy' }, { message: 'Read-only policy' }, { reason: 'VM is stopped' },
    ] })).toBe('Read-only policy · VM is stopped');
  });
});
