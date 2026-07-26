'use strict';

const config = require('../../config');

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH',
  'AUTH_EXPIRED', 'PROVIDER_BUSY', 'RATE_LIMITED', 'TOO_MANY_REQUESTS',
  'PROVIDER_REQUEST_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_CIRCUIT_OPEN',
]);
const RATE_CODES = new Set(['RATE_LIMITED', 'TOO_MANY_REQUESTS']);

class ProviderResilienceError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ProviderResilienceError';
    this.code = code;
    this.status = status;
  }
}

function _boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

class ProviderResilienceManager {
  constructor(options = {}) {
    this.maxConcurrency = _boundedInteger(options.concurrency, 2, 1, 32);
    this.maxQueue = _boundedInteger(options.maxQueue, 64, 0, 10000);
    this.timeoutMs = _boundedInteger(options.timeoutMs, 30000, 10, 300000);
    this.failureThreshold = _boundedInteger(options.failureThreshold, 3, 1, 20);
    this.cooldownMs = _boundedInteger(options.cooldownMs, 30000, 10, 3600000);
    this.endpoints = new Map();
  }

  _endpoint(key) {
    const safeKey = String(key);
    if (!this.endpoints.has(safeKey)) {
      this.endpoints.set(safeKey, {
        active: 0, limit: this.maxConcurrency, queue: [], failures: 0,
        successes: 0, circuit: 'closed', openedAt: 0, halfOpenActive: false,
      });
    }
    return this.endpoints.get(safeKey);
  }

  _admitCircuit(endpoint) {
    if (endpoint.circuit === 'open') {
      if (Date.now() - endpoint.openedAt < this.cooldownMs) {
        throw new ProviderResilienceError('Provider circuit is open', 'PROVIDER_CIRCUIT_OPEN', 503);
      }
      endpoint.circuit = 'half_open';
    }
    if (endpoint.circuit === 'half_open') {
      if (endpoint.halfOpenActive) throw new ProviderResilienceError('Provider circuit is testing recovery', 'PROVIDER_CIRCUIT_OPEN', 503);
      endpoint.halfOpenActive = true;
    }
  }

  _isTransient(err) {
    const code = String(err?.code || '').toUpperCase();
    return TRANSIENT_CODES.has(code) || Number(err?.status) === 429 || Number(err?.status) >= 500;
  }

  _success(endpoint) {
    endpoint.failures = 0;
    endpoint.successes += 1;
    if (endpoint.circuit === 'half_open') endpoint.circuit = 'closed';
    endpoint.halfOpenActive = false;
    if (endpoint.successes >= 5 && endpoint.limit < this.maxConcurrency) {
      endpoint.limit += 1;
      endpoint.successes = 0;
    }
  }

  _failure(endpoint, err) {
    endpoint.successes = 0;
    endpoint.halfOpenActive = false;
    if (!this._isTransient(err)) return;
    endpoint.failures += 1;
    const code = String(err?.code || '').toUpperCase();
    if (RATE_CODES.has(code) || Number(err?.status) === 429) endpoint.limit = Math.max(1, Math.floor(endpoint.limit / 2));
    if (endpoint.circuit === 'half_open' || endpoint.failures >= this.failureThreshold) {
      endpoint.circuit = 'open';
      endpoint.openedAt = Date.now();
    }
  }

  _withTimeout(task, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProviderResilienceError(
        'Provider request timed out', 'PROVIDER_REQUEST_TIMEOUT', 504
      )), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([Promise.resolve().then(task), timeout]).finally(() => clearTimeout(timer));
  }

  _drain(endpoint) {
    while (endpoint.queue.length && endpoint.active < endpoint.limit) {
      const waiter = endpoint.queue.shift();
      try {
        this._admitCircuit(endpoint);
        endpoint.active += 1;
        waiter.resolve();
      } catch (err) { waiter.reject(err); }
    }
  }

  async run(key, task, options = {}) {
    if (typeof task !== 'function') throw new TypeError('Provider resilience task must be a function');
    const endpoint = this._endpoint(key);
    if (endpoint.active >= endpoint.limit) {
      if (endpoint.circuit === 'open' && Date.now() - endpoint.openedAt < this.cooldownMs) {
        throw new ProviderResilienceError('Provider circuit is open', 'PROVIDER_CIRCUIT_OPEN', 503);
      }
      if (endpoint.queue.length >= this.maxQueue) {
        throw new ProviderResilienceError('Provider request budget is exhausted', 'PROVIDER_BUDGET_EXHAUSTED', 429);
      }
      await new Promise((resolve, reject) => endpoint.queue.push({ resolve, reject }));
    } else {
      this._admitCircuit(endpoint);
      endpoint.active += 1;
    }
    try {
      const result = await this._withTimeout(task,
        _boundedInteger(options.timeoutMs, this.timeoutMs, 10, 300000));
      this._success(endpoint);
      return result;
    } catch (err) {
      this._failure(endpoint, err);
      throw err;
    } finally {
      endpoint.active = Math.max(0, endpoint.active - 1);
      this._drain(endpoint);
    }
  }

  status(key) {
    const endpoint = this._endpoint(key);
    return {
      active: endpoint.active, queued: endpoint.queue.length, concurrency: endpoint.limit,
      circuit: endpoint.circuit, failures: endpoint.failures,
      retryAfterMs: endpoint.circuit === 'open' ? Math.max(0, this.cooldownMs - (Date.now() - endpoint.openedAt)) : 0,
    };
  }

  clear() { this.endpoints.clear(); }
}

const manager = new ProviderResilienceManager(config.providerResilience || {});

module.exports = manager;
module.exports.ProviderResilienceManager = ProviderResilienceManager;
module.exports.ProviderResilienceError = ProviderResilienceError;
module.exports._internals = { TRANSIENT_CODES, RATE_CODES };
