'use strict';

const { EventEmitter } = require('node:events');

// Minimal Redis double for the HA tests. Keep the supported surface explicit:
// adding a production Redis command requires adding its test semantics here.
const values = new Map();
const subscribers = new Set();
const defer = (callback) => Promise.resolve().then(callback);

function current(key) {
  const item = values.get(key);
  if (!item) return null;
  if (item.expiresAt !== null && item.expiresAt <= Date.now()) {
    values.delete(key);
    return null;
  }
  return item;
}

function put(key, value, ttlMs = null) {
  values.set(key, {
    value: String(value),
    expiresAt: ttlMs === null ? null : Date.now() + Number(ttlMs),
  });
}

class RedisMock extends EventEmitter {
  constructor() {
    super();
    this.status = 'ready';
    this.channels = new Set();
    defer(() => {
      if (this.status === 'ready') this.emit('connect');
    });
  }

  async connect() {
    this.status = 'ready';
  }

  async flushall() {
    values.clear();
    return 'OK';
  }

  async get(key) {
    return current(key)?.value ?? null;
  }

  async set(key, value, ...options) {
    let nx = false;
    let ttlMs = null;
    for (let i = 0; i < options.length; i++) {
      const option = String(options[i]).toUpperCase();
      if (option === 'NX') nx = true;
      if (option === 'PX') ttlMs = Number(options[++i]);
    }
    if (nx && current(key)) return null;
    put(key, value, ttlMs);
    return 'OK';
  }

  async del(key) {
    current(key);
    return values.delete(key) ? 1 : 0;
  }

  async incr(key) {
    const next = Number(current(key)?.value ?? 0) + 1;
    const expiresAt = current(key)?.expiresAt ?? null;
    values.set(key, { value: String(next), expiresAt });
    return next;
  }

  async pexpire(key, ttlMs) {
    const item = current(key);
    if (!item) return 0;
    item.expiresAt = Date.now() + Number(ttlMs);
    return 1;
  }

  async pttl(key) {
    const item = current(key);
    if (!item) return -2;
    if (item.expiresAt === null) return -1;
    return Math.max(0, item.expiresAt - Date.now());
  }

  async eval(script, _numberOfKeys, key, ...args) {
    if (script.includes("redis.call('INCR'")) {
      const count = await this.incr(key);
      if (count === 1) await this.pexpire(key, args[0]);
      return count;
    }

    if (script.includes("ARGV[3] == '1'")) {
      const [token, ttlMs, allowAcquire] = args;
      // Keep the whole branch synchronous to model Redis' atomic Lua execution.
      const owner = current(key)?.value ?? null;
      if (owner === String(token)) {
        current(key).expiresAt = Date.now() + Number(ttlMs);
        return 1;
      }
      if (owner === null && String(allowAcquire) === '1') {
        put(key, token, ttlMs);
        return 1;
      }
      return 0;
    }

    if (script.includes("redis.call('DEL'")) {
      if ((current(key)?.value ?? null) !== String(args[0])) return 0;
      return values.delete(key) ? 1 : 0;
    }

    throw new Error('RedisMock received an unsupported Lua script');
  }

  async subscribe(channel) {
    this.channels.add(channel);
    subscribers.add(this);
    return this.channels.size;
  }

  async publish(channel, message) {
    let receivers = 0;
    for (const client of subscribers) {
      if (client.status === 'ready' && client.channels.has(channel)) {
        receivers++;
        defer(() => client.emit('message', channel, message));
      }
    }
    return receivers;
  }

  disconnect() {
    this.status = 'end';
    subscribers.delete(this);
    this.channels.clear();
    this.emit('close');
  }

  async quit() {
    this.disconnect();
    return 'OK';
  }
}

module.exports = RedisMock;
