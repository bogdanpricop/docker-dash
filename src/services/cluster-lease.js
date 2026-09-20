'use strict';

const { performance } = require('node:perf_hooks');

// One Redis transaction checks ownership and renews, or acquires an empty key.
// In particular, XX alone is NOT an ownership check.
const HEARTBEAT = `
  local owner = redis.call('GET', KEYS[1])
  if owner == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  if not owner and ARGV[3] == '1' then
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
    return 1
  end
  return 0
`;
const RELEASE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

function bounded(work, ms) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis lease deadline exceeded')), ms);
  })]).finally(() => clearTimeout(timer));
}

class ClusterLease {
  constructor({ client, token, onRole, onPoll = () => {}, now = () => performance.now(),
    ttl = 30000, interval = 10000, timeout = 3000, margin = 1000 }) {
    this.client = client; this.token = token; this.onRole = onRole; this.onPoll = onPoll;
    this.now = now; this.ttl = ttl; this.interval = interval; this.timeout = timeout; this.margin = margin;
    this.role = 'unknown'; this.deadline = 0; this.generation = 0;
    this.timer = null; this.expiry = null; this.pending = null; this.closed = false;
  }

  _role(role) {
    if (this.role === role) return;
    this.role = role; this.onRole(role);
  }

  invalidate() {
    this.generation++;
    this.deadline = 0;
    clearTimeout(this.expiry); this.expiry = null;
    this._role('reader');
  }

  isLeader() {
    if (this.role === 'leader' && this.now() >= this.deadline) this.invalidate();
    return !this.closed && this.role === 'leader';
  }

  async start() {
    if (this.closed) return false;
    // Install once BEFORE awaiting I/O: concurrent callers cannot spawn loops.
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, this.interval);
      this.timer.unref?.();
      await this.tick();
    } else if (this.pending) await this.pending;
    return this.isLeader();
  }

  tick() {
    if (this.closed) return Promise.resolve(false);
    if (this.pending) return this.pending;
    const renewOnly = this.isLeader(), generation = this.generation, started = this.now();
    const work = (async () => {
      try {
        const result = await bounded((async () => {
          const r = await this.client();
          // Shutdown/disconnection may happen while initial connect is pending.
          if (this.closed || generation !== this.generation) throw new Error('Lease operation cancelled');
          return r.eval(HEARTBEAT, 1, 'leader', this.token, this.ttl, renewOnly ? '0' : '1');
        })(), this.timeout);
        if (this.closed || generation !== this.generation) return false;
        this.onPoll();
        // Start the local lease BEFORE the Redis request, subtracting a margin.
        // A delayed response never grants a fresh full TTL to stale ownership.
        const deadline = started + this.ttl - this.margin;
        if (result !== 1 || this.now() >= deadline) { this.invalidate(); return false; }
        this.deadline = deadline;
        clearTimeout(this.expiry);
        const expire = () => {
          if (!this.isLeader()) return;
          this.expiry = setTimeout(expire, Math.max(1, this.deadline - this.now()));
          this.expiry.unref?.();
        };
        this.expiry = setTimeout(expire, Math.max(1, deadline - this.now()));
        this.expiry.unref?.();
        this._role('leader');
        return true;
      } catch {
        if (!this.closed && generation === this.generation) this.invalidate();
        return false;
      }
    })();
    const pending = work.finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer); this.timer = null;
    this.invalidate();
  }

  async release(client) {
    this.stop();
    // Safe even after uncertainty: compare+delete never releases another owner.
    if (client) {
      try { await bounded(client.eval(RELEASE, 1, 'leader', this.token), this.timeout); }
      catch { /* expiry is the fallback; never report leadership after shutdown */ }
    }
  }
}

module.exports = ClusterLease;
