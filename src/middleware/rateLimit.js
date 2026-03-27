'use strict';

const { getClientIp } = require('../utils/helpers');

class RateLimiter {
  constructor() {
    this.windows = new Map();
    // Clean up every 5 minutes
    setInterval(() => this._cleanup(), 300000);
  }

  middleware(maxRequests, windowMs) {
    return (req, res, next) => {
      const key = getClientIp(req);
      const windowKey = `${req.route?.path || req.path}:${key}`;
      const now = Date.now();

      if (!this.windows.has(windowKey)) {
        this.windows.set(windowKey, []);
      }

      const requests = this.windows.get(windowKey).filter(t => t > now - windowMs);
      this.windows.set(windowKey, requests);

      if (requests.length >= maxRequests) {
        const retryAfter = Math.ceil((requests[0] + windowMs - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter,
        });
      }

      requests.push(now);
      next();
    };
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, times] of this.windows) {
      const filtered = times.filter(t => t > now - 3600000); // Keep max 1h
      if (filtered.length === 0) this.windows.delete(key);
      else this.windows.set(key, filtered);
    }
  }
}

const limiter = new RateLimiter();

module.exports = {
  rateLimiter: limiter,
  rateLimit: (max, windowMs) => limiter.middleware(max, windowMs),
};
