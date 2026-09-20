'use strict';

const Redis = require('ioredis-mock');
const ClusterLease = require('../services/cluster-lease');

describe('HA lease ownership and local validity', () => {
  let r, leases;
  beforeEach(async () => {
    jest.useFakeTimers(); leases = [];
    r = new Redis(); await r.flushall();
  });
  afterEach(() => { for (const l of leases) l.stop(); r.disconnect(); jest.useRealTimers(); });
  function lease(token = 'node-a', overrides = {}) {
    const l = new ClusterLease({ client: async () => r, token, onRole: jest.fn(),
      now: () => Date.now(), ...overrides });
    leases.push(l); return l;
  }

  test('one owner wins concurrent acquisition and another cannot change its TTL', async () => {
    const a = lease(), b = lease('node-b');
    expect((await Promise.all([a.start(), b.start()])).filter(Boolean)).toHaveLength(1);
    expect(await r.get('leader')).toBe('node-a');
    const ttl = await r.pttl('leader');
    expect(await b.tick()).toBe(false);
    expect(await r.pttl('leader')).toBe(ttl);
  });

  test('a stale leader cannot overwrite or extend the successor lease', async () => {
    const a = lease(); expect(await a.start()).toBe(true);
    await r.set('leader', 'successor', 'PX', 5000);
    expect(await a.tick()).toBe(false);
    expect(await r.get('leader')).toBe('successor');
    expect(await r.pttl('leader')).toBe(5000);
    expect(a.onRole.mock.calls.map(c => c[0])).toEqual(['leader', 'reader']);
  });

  test('renewal does not recreate an absent key under the old leader role', async () => {
    const a = lease(); await a.start(); await r.del('leader');
    expect(await a.tick()).toBe(false); expect(await r.get('leader')).toBeNull();
    expect(await a.tick()).toBe(true); // a fresh reader election may acquire
  });

  test('one atomic renewal extends only the current owner', async () => {
    const a = lease(); await a.start();
    await r.pexpire('leader', 4000);
    expect(await a.tick()).toBe(true); expect(await r.pttl('leader')).toBe(30000);
  });

  test('concurrent initial callers create one request and one heartbeat loop', async () => {
    const a = lease(), evalSpy = jest.spyOn(r, 'eval');
    expect(await Promise.all(Array.from({ length: 20 }, () => a.start()))).toEqual(Array(20).fill(true));
    expect(evalSpy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10000);
    expect(evalSpy).toHaveBeenCalledTimes(2);
  });

  test('event-loop pause expires the local role before the next gate returns', async () => {
    let clock = 0; const a = lease('node-a', { now: () => clock });
    await a.start(); clock = 29000; // move monotonic clock without running timers
    expect(a.isLeader()).toBe(false);
    expect(a.onRole).toHaveBeenLastCalledWith('reader');
  });

  test('watchdog demotes even when no caller checks isLeader', async () => {
    const a = lease('node-a', { interval: 60000 }); await a.start();
    await jest.advanceTimersByTimeAsync(29000);
    expect(a.role).toBe('reader');
  });

  test('a delayed successful reply does not grant a new full lease lifetime', async () => {
    let resolve, clock = 0;
    const a = lease('node-a', { now: () => clock, client: async () => ({ eval: () => new Promise(r => { resolve = r; }) }) });
    const starting = a.start(); await Promise.resolve();
    clock = 29000; resolve(1);
    expect(await starting).toBe(false); expect(a.isLeader()).toBe(false);
  });

  test('timeout demotes and a late successful reply cannot resurrect leadership', async () => {
    const a = lease(); await a.start();
    let resolve; a.client = async () => ({ eval: () => new Promise(r => { resolve = r; }) });
    const tick = a.tick(); await jest.advanceTimersByTimeAsync(3000);
    expect(await tick).toBe(false); expect(a.isLeader()).toBe(false);
    resolve(1); await Promise.resolve(); expect(a.isLeader()).toBe(false);
  });

  test('failure never falls back to GET evidence of old ownership', async () => {
    const a = lease(); await a.start();
    const get = jest.spyOn(r, 'get');
    a.client = async () => ({ eval: async () => { throw new Error('disconnected'); } });
    expect(await a.tick()).toBe(false); expect(get).not.toHaveBeenCalled();
  });

  test('disconnect invalidates an in-flight successful renewal', async () => {
    const a = lease(); await a.start();
    let resolve; a.client = async () => ({ eval: () => new Promise(r => { resolve = r; }) });
    const tick = a.tick(); await Promise.resolve(); a.invalidate(); resolve(1);
    expect(await tick).toBe(false); expect(a.isLeader()).toBe(false);
  });

  test('shutdown cannot delete another owner or restart the coordinator', async () => {
    const a = lease(); await a.start(); await r.set('leader', 'successor', 'PX', 5000);
    await a.release(r); expect(await r.get('leader')).toBe('successor');
    expect(await a.start()).toBe(false); expect(await a.tick()).toBe(false);
  });

  test('graceful shutdown releases the owned key for immediate takeover', async () => {
    const a = lease(), b = lease('node-b'); await a.start();
    await a.release(r); expect(await b.start()).toBe(true);
  });

  test('shutdown during initial connection prevents sending an acquisition later', async () => {
    let resolve; const evalFn = jest.fn();
    const a = lease('node-a', { client: () => new Promise(r => { resolve = r; }) });
    const start = a.start(); a.stop(); resolve({ eval: evalFn });
    expect(await start).toBe(false); expect(evalFn).not.toHaveBeenCalled();
  });
});
