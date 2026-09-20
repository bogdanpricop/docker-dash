'use strict';

const {
  ProviderResilienceManager,
} = require('../services/provider-conformance/resilience');

describe('Provider endpoint resilience budget', () => {
  it('opens the circuit after bounded transient failures and recovers half-open', async () => {
    const manager = new ProviderResilienceManager({
      concurrency: 1, maxQueue: 1, timeoutMs: 20, failureThreshold: 2, cooldownMs: 30,
    });
    await expect(manager.run(7, () => Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' })))).rejects.toMatchObject({ code: 'ECONNRESET' });
    await expect(manager.run(7, () => new Promise(() => {}))).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT', status: 504 });
    await expect(manager.run(7, async () => 'blocked')).rejects.toMatchObject({ code: 'PROVIDER_CIRCUIT_OPEN', status: 503 });
    manager.endpoints.get('7').openedAt = Date.now() - 100;
    await expect(manager.run(7, async () => 'recovered')).resolves.toBe('recovered');
    expect(manager.status(7).circuit).toBe('closed');
  });

  it('bounds endpoint concurrency and rejects queue overflow', async () => {
    const manager = new ProviderResilienceManager({ concurrency: 1, maxQueue: 1, timeoutMs: 1000 });
    let release;
    const first = manager.run('host-a', () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    const second = manager.run('host-a', async () => 'second');
    await expect(manager.run('host-a', async () => 'overflow')).rejects.toMatchObject({
      code: 'PROVIDER_BUDGET_EXHAUSTED', status: 429,
    });
    release('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(manager.status('host-a')).toEqual(expect.objectContaining({ active: 0, queued: 0 }));
  });

  it('reduces concurrency after a provider rate limit', async () => {
    const manager = new ProviderResilienceManager({ concurrency: 4, maxQueue: 4, failureThreshold: 5 });
    await expect(manager.run(9, () => Promise.reject(Object.assign(new Error('limited'), { code: 'RATE_LIMITED', status: 429 })))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(manager.status(9).concurrency).toBe(2);
  });
});
