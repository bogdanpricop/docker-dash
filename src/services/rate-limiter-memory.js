'use strict';

// Rate limiter — in-memory sliding window. v6.17.0.
//
// Extracted from src/middleware/rateLimit.js so src/services/cluster.js
// can delegate to it in standalone mode while the HA path uses Redis.
//
// Sliding-window semantics: every key keeps a list of recent request
// timestamps. Requests older than `now - windowMs` are trimmed on each
// tick. Stricter than the HA Redis fixed-window (which allows a 2× burst
// at bucket boundaries). Acceptable trade-off — see deep-spec §4.3.

const _windows = new Map();

/** Returns { allowed, remaining, retryAfterSec }. */
function tick(key, maxRequests, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let entry = _windows.get(key);
  if (!entry) { entry = { times: [], windowMs }; _windows.set(key, entry); }
  // A scope has one configured window. Never silently reset a live budget
  // when callers accidentally reuse its key with a different duration.
  if (entry.windowMs !== windowMs) throw new Error('Conflicting rate-limit window for scope');
  const times = entry.times;
  // In-place filter (avoids allocating a new array on the hot path).
  let w = 0;
  for (let r = 0; r < times.length; r++) {
    if (times[r] > cutoff) times[w++] = times[r];
  }
  times.length = w;

  if (times.length >= maxRequests) {
    const retryAfterSec = Math.ceil((times[0] + windowMs - now) / 1000);
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, retryAfterSec) };
  }
  times.push(now);
  return { allowed: true, remaining: maxRequests - times.length, retryAfterSec: null };
}

/** Drop keys whose windows are fully expired. Called periodically. */
function _cleanup(nowOverride) {
  const now = nowOverride ?? Date.now();
  for (const [k, entry] of _windows) {
    entry.times = entry.times.filter(t => t > now - entry.windowMs);
    if (entry.times.length === 0) _windows.delete(k);
  }
}

// Auto-cleanup every 5 min. `.unref()` so it doesn't block process exit.
const _interval = setInterval(_cleanup, 300000);
if (typeof _interval.unref === 'function') _interval.unref();

module.exports = {
  tick,
  // test-only
  _reset: () => _windows.clear(),
  _windows,
  _cleanup,
};
