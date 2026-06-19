'use strict';

// v8.7.10 — Per-operation timeouts for simple-git. Without these, a slow
// or hung git remote stalled the leader's gitPolling cron indefinitely
// (the `_checking` Set guard kept the stack stuck "in flight" until process
// restart, silently) and tied up an express worker per affected interactive
// request. This test pins the timeout contract — if any future contributor
// drops the option from a simpleGit call site, the regression is caught here.

process.env.APP_SECRET = 'test-git-timeouts';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const path = require('path');
const fs = require('fs');
const { _gitTimeouts } = require('../services/git');

describe('git service — per-operation timeouts (v8.7.10)', () => {
  it('exports the three documented timeout constants as positive integers', () => {
    expect(Number.isInteger(_gitTimeouts.fetch)).toBe(true);
    expect(Number.isInteger(_gitTimeouts.clone)).toBe(true);
    expect(Number.isInteger(_gitTimeouts.remoteProbe)).toBe(true);
    expect(_gitTimeouts.fetch).toBeGreaterThan(0);
    expect(_gitTimeouts.clone).toBeGreaterThan(0);
    expect(_gitTimeouts.remoteProbe).toBeGreaterThan(0);
  });

  it('timeouts are in a sane order: remoteProbe < fetch < clone', () => {
    // Probe is a single lightweight ls-remote against the URL — short
    // budget. Fetch covers pull/log/fetch on already-cloned repos.
    // Clone is initial deep clone of potentially-large repos — longest.
    expect(_gitTimeouts.remoteProbe).toBeLessThan(_gitTimeouts.fetch);
    expect(_gitTimeouts.fetch).toBeLessThan(_gitTimeouts.clone);
  });

  it('all timeouts are within sensible bounds (1s..1h)', () => {
    for (const t of [_gitTimeouts.remoteProbe, _gitTimeouts.fetch, _gitTimeouts.clone]) {
      expect(t).toBeGreaterThanOrEqual(1_000);
      expect(t).toBeLessThanOrEqual(60 * 60 * 1000);
    }
  });

  it('build() helper produces the exact shape simple-git expects', () => {
    const opts = _gitTimeouts.build(5000);
    expect(opts).toEqual({ timeout: { block: 5000 } });
  });

  it('build() defaults to the fetch timeout when called with no args', () => {
    const opts = _gitTimeouts.build();
    expect(opts).toEqual({ timeout: { block: _gitTimeouts.fetch } });
  });

  it('every simpleGit() call site in src/services/git.js passes _gitOpts', () => {
    // Source-level guard: if a future edit adds a new simpleGit(...) without
    // a timeout, this test fails fast. We rely on the canonical pattern
    // simpleGit(<dirOrUndefined>, _gitOpts(...)).
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'git.js'), 'utf8');
    // Strip the helper definition line so we don't false-positive on it
    const body = src.replace(/const\s+_gitOpts\s*=.*$/m, '');
    const calls = body.match(/simpleGit\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/_gitOpts\(/);
    }
  });
});
