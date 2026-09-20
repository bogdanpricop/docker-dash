'use strict';

// Rate-limit middleware — delegates to src/services/cluster.js which routes
// to src/services/rate-limiter-memory.js (standalone) or Redis INCR (HA mode,
// v6.17.0+). See plans/deep-spec-ha-mode.md §4 for the split rationale.
//
// A missing, invalid or late quota decision must not bypass login/MFA or
// mutation limits. Return 503 on uncertainty; reserve 429 for confirmed quota.

const { getClientIp } = require('../utils/helpers');
const cluster = require('../services/cluster');
const log = require('../utils/logger')('ratelimit');

function middleware(maxRequests, windowMs, scope = `quota:${maxRequests}:${windowMs}`) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error('Rate-limit count and window must be positive integers');
  }
  if (typeof scope !== 'string' || !scope || scope.length > 128) throw new Error('Invalid rate-limit scope');
  return async (req, res, next) => {
    const ip = getClientIp(req);
    // Scope belongs to the configured limiter, never a caller-controlled URL,
    // parameter, capitalization, forwarding header or query string.
    const key = JSON.stringify([scope, ip]);
    let result, timer;
    try {
      result = await Promise.race([cluster.rateLimitTick(key, maxRequests, windowMs), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Rate-limit deadline exceeded')), 3000);
      })]);
      if (!result || typeof result.allowed !== 'boolean' || !Number.isSafeInteger(result.remaining) || result.remaining < 0
        || (!result.allowed && (!Number.isSafeInteger(result.retryAfterSec) || result.retryAfterSec < 1))) {
        throw new Error('Invalid rate-limit decision');
      }
    } catch {
      log.warn('Rate limiter unavailable; request blocked', { scope });
      if (res.destroyed || res.writableEnded) return;
      res.set('Retry-After', '3');
      return res.status(503).json({ error: 'Rate limit verification temporarily unavailable', retryAfter: 3 });
    } finally { clearTimeout(timer); }
    if (res.destroyed || res.writableEnded) return;
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSec));
      res.set('X-RateLimit-Remaining', '0');
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: result.retryAfterSec,
      });
    }
    res.set('X-RateLimit-Remaining', String(result.remaining));
    next();
  };
}

// Back-compat export — keep the old `rateLimiter.middleware(…)` + `rateLimit(…)` API
// callers use. Passing `rateLimiter` itself as the object that exposes `middleware`.
const rateLimiter = { middleware };

module.exports = {
  rateLimiter,
  rateLimit: middleware,
  middleware,
};
