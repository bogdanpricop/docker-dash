'use strict';

// Tests for src/services/cluster.js (v6.17.0)
//
// Two describe blocks — standalone and HA. The HA block uses `ioredis-mock`
// via jest.mock('ioredis') so we don't need a real Redis running.

describe('cluster — standalone (DD_MODE unset)', () => {
  let cluster;

  beforeAll(() => {
    delete process.env.DD_MODE;
    delete process.env.REDIS_URL;
    jest.resetModules();
    cluster = require('../services/cluster');
  });

  it('isHa() returns false', () => {
    expect(cluster.isHa()).toBe(false);
  });

  it('nodeId() returns "standalone"', () => {
    expect(cluster.nodeId()).toBe('standalone');
  });

  it('redis() returns null', async () => {
    expect(await cluster.redis()).toBeNull();
  });

  it('isLeader() returns true (standalone is its own cluster-of-1)', async () => {
    expect(await cluster.isLeader()).toBe(true);
  });

  it('publish/subscribe are no-ops in standalone mode', async () => {
    let received = null;
    await cluster.publish('test-channel', { hello: 'world' });
    cluster.subscribe('test-channel', (payload) => { received = payload; });
    await cluster.publish('test-channel', { hello: 'world' });
    expect(received).toBeNull();
  });

  it('rateLimitTick delegates to memory limiter', async () => {
    const mem = require('../services/rate-limiter-memory');
    mem._reset();
    const r1 = await cluster.rateLimitTick('sync-key-1', 3, 60000);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
  });

  it('rateLimitTick rejects when over quota (standalone path)', async () => {
    const mem = require('../services/rate-limiter-memory');
    mem._reset();
    await cluster.rateLimitTick('sync-key-2', 2, 60000);
    await cluster.rateLimitTick('sync-key-2', 2, 60000);
    const r = await cluster.rateLimitTick('sync-key-2', 2, 60000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it('onBecomeLeader / onBecomeReader are no-ops', () => {
    expect(() => cluster.onBecomeLeader(() => {})).not.toThrow();
    expect(() => cluster.onBecomeReader(() => {})).not.toThrow();
  });

  it('shutdown is safe to call in standalone', async () => {
    await expect(cluster.shutdown()).resolves.not.toThrow();
  });
});

describe('cluster — HA mode (DD_MODE=ha, ioredis-mock)', () => {
  let cluster;

  beforeAll(() => {
    // Map ioredis → ioredis-mock so no real Redis needed.
    jest.doMock('ioredis', () => require('ioredis-mock'));
    process.env.DD_MODE = 'ha';
    process.env.REDIS_URL = 'redis://localhost:6379';
    jest.resetModules();
    cluster = require('../services/cluster');
  });

  afterAll(async () => {
    await cluster.shutdown();
    delete process.env.DD_MODE;
    delete process.env.REDIS_URL;
    jest.resetModules();
    jest.dontMock('ioredis');
  });

  it('isHa() returns true', () => {
    expect(cluster.isHa()).toBe(true);
  });

  it('nodeId() returns a UUID', () => {
    const id = cluster.nodeId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('redis() returns an ioredis-mock client (not null)', async () => {
    const r = await cluster.redis();
    expect(r).not.toBeNull();
    expect(typeof r.incr).toBe('function');
  });

  it('rateLimitTick uses Redis INCR and blocks over quota', async () => {
    const r1 = await cluster.rateLimitTick('ha-key-1', 3, 60000);
    const r2 = await cluster.rateLimitTick('ha-key-1', 3, 60000);
    const r3 = await cluster.rateLimitTick('ha-key-1', 3, 60000);
    const r4 = await cluster.rateLimitTick('ha-key-1', 3, 60000);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterSec).toBeGreaterThan(0);
  });

  it('rateLimitTick keys different users independently', async () => {
    await cluster.rateLimitTick('user-x', 2, 60000);
    await cluster.rateLimitTick('user-x', 2, 60000);
    const blockedX = await cluster.rateLimitTick('user-x', 2, 60000);
    const allowedY = await cluster.rateLimitTick('user-y', 2, 60000);
    expect(blockedX.allowed).toBe(false);
    expect(allowedY.allowed).toBe(true);
  });

  it('isLeader() elects a single node against the Redis mock', async () => {
    expect(await cluster.isLeader()).toBe(true);
  });

  // ─── Phase 3: pub/sub (v6.17.1) ─────────────────────────────────

  it('publish sends an envelope with nodeId to the Redis pub/sub channel', async () => {
    const r = await cluster.redis();
    const publishSpy = jest.spyOn(r, 'publish');
    await cluster.publish('ws:broadcast', { kind: 'all', type: 'test', data: 42 });
    expect(publishSpy).toHaveBeenCalled();
    const call = publishSpy.mock.calls[publishSpy.mock.calls.length - 1];
    expect(call[0]).toBe('ddash:pubsub');
    const envelope = JSON.parse(call[1]);
    expect(envelope.nodeId).toBe(cluster.nodeId());
    expect(envelope.appChannel).toBe('ws:broadcast');
    expect(envelope.payload).toEqual({ kind: 'all', type: 'test', data: 42 });
    publishSpy.mockRestore();
  });

  it('subscribe filters out self-published messages', async () => {
    let received = null;
    cluster.subscribe('self-loop-test', (p) => { received = p; });
    // Wait for subscriber connection to settle (ioredis-mock is synchronous
    // but the subscribe()+publish() cycle still needs a microtask tick)
    await new Promise(r => setTimeout(r, 50));
    await cluster.publish('self-loop-test', { test: 'self' });
    await new Promise(r => setTimeout(r, 100));
    expect(received).toBeNull();
  });

  it('subscribe receives messages from OTHER node IDs', async () => {
    let received = null;
    cluster.subscribe('foreign-test', (p) => { received = p; });
    await new Promise(r => setTimeout(r, 50));
    // Simulate a foreign-node publish by constructing the envelope directly
    // with a different nodeId and publishing via our own Redis client.
    const r = await cluster.redis();
    const foreignEnvelope = JSON.stringify({
      nodeId: 'foreign-node-deadbeef',
      appChannel: 'foreign-test',
      payload: { test: 'foreign' },
    });
    await r.publish('ddash:pubsub', foreignEnvelope);
    await new Promise(r => setTimeout(r, 100));
    expect(received).toEqual({ test: 'foreign' });
  });

  it('subscribe routes to the correct app channel (ignores others)', async () => {
    let chanA = null;
    let chanB = null;
    cluster.subscribe('chan-a', (p) => { chanA = p; });
    cluster.subscribe('chan-b', (p) => { chanB = p; });
    await new Promise(r => setTimeout(r, 50));
    const r = await cluster.redis();
    await r.publish('ddash:pubsub', JSON.stringify({
      nodeId: 'other', appChannel: 'chan-a', payload: { msg: 'A' },
    }));
    await r.publish('ddash:pubsub', JSON.stringify({
      nodeId: 'other', appChannel: 'chan-b', payload: { msg: 'B' },
    }));
    await new Promise(r => setTimeout(r, 100));
    expect(chanA).toEqual({ msg: 'A' });
    expect(chanB).toEqual({ msg: 'B' });
  });

  it('multiple handlers on the same channel all fire', async () => {
    const calls = [];
    cluster.subscribe('multi-handler-test', (p) => calls.push(['h1', p]));
    cluster.subscribe('multi-handler-test', (p) => calls.push(['h2', p]));
    await new Promise(r => setTimeout(r, 50));
    const r = await cluster.redis();
    await r.publish('ddash:pubsub', JSON.stringify({
      nodeId: 'other', appChannel: 'multi-handler-test', payload: { n: 1 },
    }));
    await new Promise(r => setTimeout(r, 100));
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c[0])).toEqual(expect.arrayContaining(['h1', 'h2']));
  });

  it('malformed envelope JSON is silently dropped (no throw)', async () => {
    let received = null;
    cluster.subscribe('bad-json-test', (p) => { received = p; });
    await new Promise(r => setTimeout(r, 50));
    const r = await cluster.redis();
    // Direct publish of garbage — must not crash the subscriber
    await r.publish('ddash:pubsub', 'this is not json');
    await new Promise(r => setTimeout(r, 50));
    expect(received).toBeNull();
  });

  // ─── Phase 4: Leader election (v6.17.2) ──────────────────────────

  it('isLeader() acquires the lock on first call (single-node cluster → becomes leader)', async () => {
    cluster._reset();
    const first = await cluster.isLeader();
    expect(first).toBe(true);  // we grabbed it
  });

  it('a second "replica" cannot acquire the lock while held', async () => {
    cluster._reset();
    // We hold it (first call)
    await cluster.isLeader();
    // Simulate a second replica trying to acquire by manipulating the SET NX path
    // directly through the same Redis client (ioredis-mock uses a shared state).
    const r = await cluster.redis();
    const attempt = await r.set('leader', 'other-node-id', 'NX', 'PX', 30000);
    expect(attempt).toBeNull();  // NX fails because key exists
  });

  it('onBecomeLeader fires callbacks on role transition', async () => {
    cluster._reset();
    const calls = [];
    cluster.onBecomeLeader(() => calls.push('leader'));
    cluster.onBecomeReader(() => calls.push('reader'));
    await cluster.isLeader();  // triggers _electOnce → transitions unknown → leader
    expect(calls).toContain('leader');
    expect(calls).not.toContain('reader');
  });

  it('_forceRole transitions call reader callbacks', () => {
    cluster._reset();
    const calls = [];
    cluster.onBecomeReader(() => calls.push('reader'));
    cluster.onBecomeLeader(() => calls.push('leader'));
    cluster._forceRole('leader');
    cluster._forceRole('reader');
    cluster._forceRole('leader');  // back to leader again
    expect(calls).toEqual(['leader', 'reader', 'leader']);
  });

  it('callbacks do not fire twice on the same role (idempotent transition)', () => {
    cluster._reset();
    const calls = [];
    cluster.onBecomeLeader(() => calls.push('leader'));
    cluster._forceRole('leader');
    cluster._forceRole('leader');  // same role — no-op
    cluster._forceRole('leader');
    expect(calls).toEqual(['leader']);
  });

  it('a throwing callback does not prevent other callbacks from firing', () => {
    cluster._reset();
    const fired = [];
    cluster.onBecomeLeader(() => { throw new Error('boom'); });
    cluster.onBecomeLeader(() => { fired.push('second'); });
    cluster._forceRole('leader');
    expect(fired).toEqual(['second']);
  });
});

// ─── Standalone onBecomeLeader fires synchronously ─────────────────

describe('cluster — standalone leader callbacks', () => {
  beforeAll(() => {
    delete process.env.DD_MODE;
    jest.resetModules();
    jest.dontMock('ioredis');
  });

  it('onBecomeLeader fires immediately in standalone mode', () => {
    const cluster = require('../services/cluster');
    cluster._reset();
    let fired = false;
    cluster.onBecomeLeader(() => { fired = true; });
    expect(fired).toBe(true);
  });

  it('onBecomeReader does NOT fire in standalone mode', () => {
    const cluster = require('../services/cluster');
    cluster._reset();
    let fired = false;
    cluster.onBecomeReader(() => { fired = true; });
    expect(fired).toBe(false);
  });
});
