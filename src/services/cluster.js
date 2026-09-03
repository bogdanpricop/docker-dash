'use strict';

// cluster — v6.17.0 (HA foundation)
//
// Central abstraction for HA-aware state. Every HA-eligible subsystem
// (rate limiter now; WS pub/sub + cron leader election in v7.0.0)
// imports this module.
//
// Standalone default (DD_MODE unset):
//   - Every method is a cheap no-op or falls through to in-process state.
//   - Zero runtime overhead. ioredis is never require()d.
//
// HA mode (DD_MODE=ha):
//   - Lazy-connects to Redis (REDIS_URL, default redis://localhost:6379)
//   - rateLimitTick → Redis INCR + PEXPIRE
//   - publish/subscribe / isLeader remain stubs in v6.17.0 (see deep-spec §8);
//     wired in v7.0.0-alpha.1 and v7.0.0-rc.1 respectively.
//
// See plans/deep-spec-ha-mode.md for architecture + rollout plan.

const log = require('../utils/logger')('cluster');
const crypto = require('crypto');

const MODE = process.env.DD_MODE || 'standalone';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const NODE_ID = MODE === 'ha' ? crypto.randomUUID() : 'standalone';

let _redis = null;
let _redisPromise = null;

function isHa() { return MODE === 'ha'; }
function nodeId() { return NODE_ID; }

/** Return the ioredis client in HA mode, or null in standalone.
 *  Lazy-connects on first call. Caches the connection for the process lifetime. */
async function redis() {
  if (!isHa()) return null;
  if (_redis) return _redis;
  if (_redisPromise) return _redisPromise;
  _redisPromise = (async () => {
    let Redis;
    try {
      Redis = require('ioredis');
    } catch {
      const msg = 'DD_MODE=ha but ioredis is not installed. Run `npm install ioredis` or unset DD_MODE.';
      log.error(msg);
      throw new Error(msg);
    }
    const client = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    _redis = client;

    // v8.95.1 — the handlers check they are still the current client before
    // logging. `connect` fires on a later tick, so it can land after the client
    // has been discarded by shutdown() or _reset(): in production that is noise
    // about a connection nobody is using, and under Jest it lands after the suite
    // has torn down, where Jest attributes the stray write to whichever test
    // happens to be running and fails it. That was the source of an intermittent
    // 2-4 test failures across the whole suite, unrelated to the tests it hit.
    client.on('connect', () => {
      if (_redis !== client) return;
      log.info('Redis connected', {
        // Redact credentials in the URL before logging
        url: REDIS_URL.replace(/:\/\/[^@]*@/, '://***@'),
        nodeId: NODE_ID,
      });
    });
    client.on('error', (e) => {
      if (_redis !== client) return;
      log.error('Redis error', { message: e.message });
    });
    return client;
  })();
  return _redisPromise;
}

/** Rate-limit decision for a given key + bucket.
 *  Returns { allowed, remaining, retryAfterSec }.
 *  Standalone: falls through to src/services/rate-limiter-memory.js (sliding window).
 *  HA: Redis INCR + PEXPIRE (fixed window — 2× looser at bucket boundary; documented trade-off).
 *
 *  v8.7.29 — two bugs fixed here:
 *  1. retryAfterSec used to return Math.ceil(windowMs / 1000) — the FULL
 *     window length. The correct value is time-until-bucket-rolls-over,
 *     which can be a fraction of a second if the client hit the limit at
 *     the end of a bucket. Clients were waiting up to N times longer than
 *     necessary (where N = windowMs / actual-remaining-time).
 *  2. INCR + PEXPIRE was two separate round-trips. If the connection
 *     dropped between INCR and PEXPIRE (a few ms is enough on a busy
 *     Redis), the bucket key would exist with no TTL → grew forever →
 *     that key was permanently blocked at maxRequests. Fixed via Lua
 *     script that does both atomically in one round-trip. */
const RATE_LIMIT_LUA = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return c
`;

async function rateLimitTick(key, maxRequests, windowMs) {
  if (!isHa()) {
    const mem = require('./rate-limiter-memory');
    return mem.tick(key, maxRequests, windowMs);
  }
  const r = await redis();
  const now = Date.now();
  const bucketIdx = Math.floor(now / windowMs);
  const bucket = `rl:${key}:${bucketIdx}`;
  const count = Number(await r.eval(RATE_LIMIT_LUA, 1, bucket, windowMs + 1000));
  // Time until this bucket rolls over to the next (capped at 1s minimum so
  // clients don't hammer the limiter with sub-second retries).
  const retryAfterSec = Math.max(1, Math.ceil(((bucketIdx + 1) * windowMs - now) / 1000));
  if (count > maxRequests) {
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  return { allowed: true, remaining: maxRequests - count, retryAfterSec: null };
}

// ─── Phase 3 — Redis pub/sub (v6.17.1) ────────────────────────────
//
// Single Redis channel `ddash:pubsub` carries all application-level pub/sub
// traffic. App-level channel routing happens in the subscriber callback.
// Envelope includes `nodeId` so publishers ignore their own echoes (avoids
// deliver-twice-locally loop).
//
// Why single Redis channel: app-level channels (ws:broadcast, etc.) are ~3-5
// total. Sub-channels would reduce filtering cost slightly but multiply
// connection state. For the volume Docker Dash handles (~10s msg/sec) a
// single subscribed channel + in-process dispatch is simpler and plenty fast.

const REDIS_PUBSUB_CHANNEL = 'ddash:pubsub';
let _subClient = null;
let _subClientPromise = null;
const _subscribers = new Map(); // appChannel → Set<handler>

async function _ensureSubscriber() {
  if (_subClient) return _subClient;
  if (_subClientPromise) return _subClientPromise;
  _subClientPromise = (async () => {
    let Redis;
    try { Redis = require('ioredis'); }
    catch { throw new Error('ioredis missing — install it or unset DD_MODE'); }
    const c = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
    c.on('error', (e) => log.error('Redis subscriber error', { message: e.message }));
    c.on('message', (_chan, raw) => {
      let env;
      try { env = JSON.parse(raw); } catch { return; }
      if (!env || env.nodeId === NODE_ID) return; // skip self-echo
      const handlers = _subscribers.get(env.appChannel);
      if (!handlers) return;
      for (const h of handlers) {
        try { h(env.payload); }
        catch (e) { log.warn('subscriber handler threw', { message: e.message }); }
      }
    });
    await c.subscribe(REDIS_PUBSUB_CHANNEL);
    _subClient = c;
    log.info('Redis subscriber connected', { channel: REDIS_PUBSUB_CHANNEL, nodeId: NODE_ID });
    return c;
  })();
  return _subClientPromise;
}

/** Publish to cross-replica. Best-effort (errors logged + swallowed —
 *  pub/sub is eventually-consistent, local delivery must not fail). */
async function publish(appChannel, payload) {
  if (!isHa()) return;
  try {
    const r = await redis();
    const envelope = JSON.stringify({ nodeId: NODE_ID, appChannel, payload });
    await r.publish(REDIS_PUBSUB_CHANNEL, envelope);
  } catch (err) {
    log.warn('publish failed (local delivery unaffected)', { appChannel, message: err.message });
  }
}

/** Subscribe to a cross-replica channel. Handler receives the `payload`
 *  object, already filtered to exclude messages from this node. */
function subscribe(appChannel, handler) {
  if (!isHa()) return;
  let set = _subscribers.get(appChannel);
  if (!set) { set = new Set(); _subscribers.set(appChannel, set); }
  set.add(handler);
  // Fire-and-forget — the subscriber client connects async; messages published
  // before it's ready are lost (acceptable for our use case: WS broadcasts
  // and cache invalidations are eventually consistent).
  _ensureSubscriber().catch((e) => log.error('subscriber connect failed', { message: e.message }));
}

// ─── Phase 4 — Leader election (v6.17.2) ─────────────────────────
//
// Redis SET NX PX pattern:
//   - Key: `leader` (namespace prefix omitted — Redis instance is
//     ours, no need for app prefix on the hot path)
//   - Value: NODE_ID (UUID)
//   - TTL: LEADER_TTL_MS (30s — tolerates a stalled heartbeat round)
//   - Heartbeat: every LEADER_HEARTBEAT_MS (10s) the leader extends
//     the TTL with SET XX PX (only if still owned)
//   - Reader poll: every LEADER_HEARTBEAT_MS readers try to acquire
//     (in case leader died)
//
// Role transitions fire `onBecomeLeader` / `onBecomeReader` callbacks
// registered before loop start. Used by jobs/index.js to start/stop
// cron, ws/index.js to start/stop the Docker event stream, and
// gitPolling.js to start/stop per-stack polling.

const LEADER_KEY = 'leader';
const LEADER_TTL_MS = 30000;
const LEADER_HEARTBEAT_MS = 10000;

let _leaderState = 'unknown';       // 'leader' | 'reader' | 'unknown'
let _leaderTimer = null;
let _leaderSince = null;             // ms timestamp since last transition TO leader
let _lastHeartbeatAt = null;         // ms timestamp of last successful heartbeat / election
const _onLeaderCbs = [];
const _onReaderCbs = [];

/** Return cached role. In standalone mode, always leader. */
async function isLeader() {
  if (!isHa()) return true;  // standalone IS its own cluster-of-1 leader
  // Start the election loop lazily on first `isLeader()` call so we don't
  // incur Redis traffic if the app isn't in HA mode yet.
  if (!_leaderTimer && _leaderState === 'unknown') {
    await _electOnce();
    _leaderTimer = setInterval(() => _electOnce().catch(() => {}), LEADER_HEARTBEAT_MS);
    if (typeof _leaderTimer.unref === 'function') _leaderTimer.unref();
  }
  return _leaderState === 'leader';
}

async function _electOnce() {
  if (!isHa()) return;
  let r;
  try { r = await redis(); }
  catch { _transitionTo('reader'); return; }

  const wasLeader = (_leaderState === 'leader');

  if (wasLeader) {
    // Extend our existing lock (XX = only if key exists; silently fails if
    // the lock has expired and was grabbed by someone else).
    const ok = await r.set(LEADER_KEY, NODE_ID, 'XX', 'PX', LEADER_TTL_MS).catch(() => null);
    if (ok === 'OK') { _lastHeartbeatAt = Date.now(); return; }  // still leader
    // Lock lost — check who has it
    const holder = await r.get(LEADER_KEY).catch(() => null);
    if (holder === NODE_ID) { _lastHeartbeatAt = Date.now(); return; }  // race: still ours
    _transitionTo('reader');
    return;
  }

  // Reader path — try to acquire
  const ok = await r.set(LEADER_KEY, NODE_ID, 'NX', 'PX', LEADER_TTL_MS).catch(() => null);
  if (ok === 'OK') {
    _lastHeartbeatAt = Date.now();
    _transitionTo('leader');
    return;
  }
  // NX failed — check whether we already hold it (e.g. after an internal
  // state reset in tests, or a brief event-loop hiccup across heartbeats).
  // If the holder is our NODE_ID, re-claim the role without SET and refresh
  // the TTL to our intended value.
  const holder = await r.get(LEADER_KEY).catch(() => null);
  if (holder === NODE_ID) {
    await r.pexpire(LEADER_KEY, LEADER_TTL_MS).catch(() => null);
    _lastHeartbeatAt = Date.now();
    _transitionTo('leader');
  } else {
    _lastHeartbeatAt = Date.now();
    _transitionTo('reader');
  }
}

function _transitionTo(role) {
  if (_leaderState === role) return;
  const prev = _leaderState;
  _leaderState = role;
  if (role === 'leader') _leaderSince = Date.now();
  else _leaderSince = null;
  log.info('Cluster role changed', { from: prev, to: role, nodeId: NODE_ID });
  const cbs = role === 'leader' ? _onLeaderCbs : _onReaderCbs;
  for (const cb of cbs) {
    try { cb(); }
    catch (e) { log.warn('role-transition callback threw', { message: e.message, role }); }
  }
}

/** Return a plain-object snapshot of cluster state for /api/cluster/status
 *  and /api/metrics. Safe to call from any thread; no I/O. */
function getStatus() {
  const now = Date.now();
  return {
    mode: isHa() ? 'ha' : 'standalone',
    nodeId: NODE_ID,
    role: isHa() ? _leaderState : 'standalone',
    // ms since this node became leader (null if not leader)
    leaderSinceMs: _leaderSince ? (now - _leaderSince) : null,
    // ms since last successful heartbeat / election poll (HA only)
    heartbeatAgeMs: isHa() && _lastHeartbeatAt ? (now - _lastHeartbeatAt) : null,
    // ms TTL of the leader lock (static config, exposed for observability)
    leaderLockTtlMs: isHa() ? LEADER_TTL_MS : null,
    heartbeatIntervalMs: isHa() ? LEADER_HEARTBEAT_MS : null,
    // Redis connection health (true/false/null for standalone)
    redisConnected: !isHa() ? null : !!(_redis && _redis.status === 'ready'),
  };
}

/** Register a callback to run when this node becomes leader.
 *  In standalone mode: fires immediately (we're always leader). */
function onBecomeLeader(fn) {
  _onLeaderCbs.push(fn);
  if (!isHa()) {
    // Fire synchronously in standalone so callers don't need to await.
    try { fn(); }
    catch (e) { log.warn('standalone leader callback threw', { message: e.message }); }
  }
}

/** Register a callback for when this node becomes a reader. */
function onBecomeReader(fn) {
  _onReaderCbs.push(fn);
  // No standalone fire — standalone never becomes reader.
}

async function shutdown() {
  if (_leaderTimer) { clearInterval(_leaderTimer); _leaderTimer = null; }
  // Release the leader lock proactively on graceful shutdown so another
  // replica can pick it up within milliseconds instead of waiting for TTL.
  if (_leaderState === 'leader' && _redis) {
    try {
      // Delete only if we still own it (Lua to avoid clobbering a new leader
      // that acquired right before our DEL lands).
      const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
      await _redis.eval(script, 1, LEADER_KEY, NODE_ID);
    } catch { /* ignore */ }
  }
  if (_subClient) {
    try { await _subClient.quit(); } catch { /* ignore */ }
    _subClient = null;
    _subClientPromise = null;
  }
  if (_redis) {
    try { await _redis.quit(); } catch { /* ignore */ }
    _redis = null;
    _redisPromise = null;
  }
  _subscribers.clear();
}

module.exports = {
  isHa, nodeId, redis,
  rateLimitTick,
  publish, subscribe,
  isLeader, onBecomeLeader, onBecomeReader,
  getStatus,
  shutdown,
  // test-only: reset internal state
  _reset() {
    if (_leaderTimer) { clearInterval(_leaderTimer); _leaderTimer = null; }
    // Detach before dropping the reference: an orphaned client keeps its
    // listeners, and a mock that emits `connect` on a later tick would otherwise
    // still reach the logger long after the test that created it finished.
    for (const c of [_redis, _subClient]) {
      if (c && typeof c.removeAllListeners === 'function') {
        try { c.removeAllListeners(); } catch { /* best effort */ }
      }
    }
    _redis = null;
    _redisPromise = null;
    _subClient = null;
    _subClientPromise = null;
    _leaderState = 'unknown';
    _subscribers.clear();
    _onLeaderCbs.length = 0;
    _onReaderCbs.length = 0;
  },
  // test-only: force a role transition (for unit tests of gating logic)
  _forceRole(role) {
    _transitionTo(role);
  },
};
