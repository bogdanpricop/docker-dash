'use strict';

// Tests for src/services/rate-limiter-memory.js (v6.17.0)

const rlm = require('../services/rate-limiter-memory');

beforeEach(() => rlm._reset());
afterEach(() => jest.useRealTimers());

describe('tick — sliding window behavior', () => {
  it('refuses conflicting durations without resetting an existing scope budget', () => {
    rlm.tick('same-scope', 1, 7200000);
    expect(() => rlm.tick('same-scope', 1, 60000)).toThrow('Conflicting rate-limit window');
    expect(rlm.tick('same-scope', 1, 7200000).allowed).toBe(false);
  });
  it('allows up to maxRequests in a fresh window', () => {
    expect(rlm.tick('k', 3, 60000)).toMatchObject({ allowed: true, remaining: 2 });
    expect(rlm.tick('k', 3, 60000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(rlm.tick('k', 3, 60000)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('rejects when the window is full', () => {
    rlm.tick('k', 2, 60000);
    rlm.tick('k', 2, 60000);
    const r = rlm.tick('k', 2, 60000);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect(r.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('keys different users independently', () => {
    rlm.tick('user:a', 1, 60000);
    const blockedA = rlm.tick('user:a', 1, 60000);
    const allowedB = rlm.tick('user:b', 1, 60000);
    expect(blockedA.allowed).toBe(false);
    expect(allowedB.allowed).toBe(true);
  });

  it('retryAfterSec is at least 1', () => {
    rlm.tick('k', 1, 500);
    const r = rlm.tick('k', 1, 500);
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('expires timestamps older than windowMs (sliding)', async () => {
    const origNow = Date.now;
    let t = 1000000;
    Date.now = () => t;
    try {
      rlm.tick('k', 2, 1000);
      rlm.tick('k', 2, 1000);
      // 1.1s later — both prior timestamps expire
      t += 1100;
      const r = rlm.tick('k', 2, 1000);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(1);
    } finally {
      Date.now = origNow;
    }
  });
});

describe('_cleanup', () => {
  it('preserves a two-hour quota beyond the former one-hour cleanup horizon', () => {
    jest.useFakeTimers().setSystemTime(0);
    rlm.tick('long-login-window', 1, 7200000);
    jest.setSystemTime(3900000);
    rlm._cleanup();
    expect(rlm.tick('long-login-window', 1, 7200000)).toEqual({
      allowed: false, remaining: 0, retryAfterSec: 3300,
    });
    jest.setSystemTime(7200000);
    rlm._cleanup();
    expect(rlm.tick('long-login-window', 1, 7200000).allowed).toBe(true);
  });

  it('removes short windows promptly without discarding still-live long windows', () => {
    jest.useFakeTimers().setSystemTime(0);
    rlm.tick('short', 1, 1000); rlm.tick('long', 2, 7200000);
    jest.setSystemTime(1000); rlm._cleanup();
    expect(rlm._windows.has('short')).toBe(false);
    expect(rlm._windows.has('long')).toBe(true);
  });

  it('expires individual timestamps, preserving the rest of a sliding budget', () => {
    jest.useFakeTimers().setSystemTime(0); rlm.tick('staggered', 2, 7200000);
    jest.setSystemTime(1800000); rlm.tick('staggered', 2, 7200000);
    jest.setSystemTime(7200000); rlm._cleanup();
    expect(rlm.tick('staggered', 2, 7200000)).toEqual({ allowed: true, remaining: 0, retryAfterSec: null });
    expect(rlm.tick('staggered', 2, 7200000)).toEqual({ allowed: false, remaining: 0, retryAfterSec: 1800 });
  });

  it('drops keys whose windows have all expired', () => {
    rlm.tick('k1', 5, 1000);
    rlm.tick('k2', 5, 1000);
    expect(rlm._windows.size).toBe(2);
    // Simulate 2h in the future
    rlm._cleanup(Date.now() + 2 * 3600 * 1000);
    expect(rlm._windows.size).toBe(0);
  });

  it('keeps keys with fresh timestamps', () => {
    rlm.tick('k', 5, 1000);
    rlm._cleanup();  // nowOverride undefined → now
    expect(rlm._windows.has('k')).toBe(true);
  });
});
