'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const Redis = require('ioredis');
const children = [], checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const r = new Redis(process.env.REDIS_URL, { protocol: 2, maxRetriesPerRequest: 0, commandTimeout: 3000 });
r.on('error', () => {});
function node() {
  const child = fork(path.join(__dirname, 'ha-lease-node.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  children.push(child);
  let sequence = 0; const pending = new Map();
  child.on('message', m => {
    const p = pending.get(m.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  child.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Canary child exited')); } pending.clear(); });
  return { child, call(command, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Canary child deadline: ' + command)); }, 8000);
      pending.set(id, { resolve, reject, timer }); child.send({ id, command, args });
    });
  } };
}
async function until(fn, limit = 13000) {
  const end = Date.now() + limit;
  do { if (await fn()) return; await sleep(100); } while (Date.now() < end);
  throw new Error('Canary condition deadline exceeded');
}
function passed(name) { checks.push(name); console.log('PASS ' + name); }

(async () => {
  try {
    await r.ping(); const info = await r.info('server');
    const a = node(), b = node();
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).call('leader')));
    const states = await Promise.all([a.call('status'), b.call('status')]);
    assert.equal(states.filter(s => s.role === 'leader').length, 1);
    const leaderIndex = states.findIndex(s => s.role === 'leader');
    const old = [a, b][leaderIndex], next = [a, b][1 - leaderIndex];
    assert.equal(await r.get('leader'), states[leaderIndex].nodeId);
    passed('concurrent-processes-elect-one-leader');

    const key = 'canary-' + Date.now(), window = 86400000, bucket = Math.floor(Date.now() / window);
    const quota = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).call('quota', key, 7, window)));
    assert.equal(Math.floor(Date.now() / window), bucket, 'Test crossed rate-limit bucket boundary');
    assert.equal(quota.filter(x => x.allowed).length, 7);
    assert.ok(await r.pttl('rl:' + key + ':' + bucket) > 0);
    passed('ioredis6-shared-lua-rate-limit-and-expiry');

    await Promise.all([a.call('subscribe'), b.call('subscribe')]);
    await until(async () => Number((await r.pubsub('NUMSUB', 'ddash:pubsub'))[1]) === 2);
    await a.call('publish', { from: 'a', sequence: 1 });
    await until(async () => (await b.call('messages')).length === 1);
    assert.deepEqual(await a.call('messages'), []);
    assert.deepEqual(await b.call('messages'), [{ from: 'a', sequence: 1 }]);
    passed('cross-process-pubsub-without-self-echo');

    const nextId = (await next.call('status')).nodeId;
    // Controlled ownership turnover, only in this disposable Redis instance.
    await r.set('leader', nextId, 'PX', 30000);
    await until(async () => (await old.call('status')).role === 'reader' && (await next.call('status')).role === 'leader');
    assert.equal(await r.get('leader'), nextId);
    passed('stale-leader-heartbeat-cannot-overwrite-successor');
    await old.call('shutdown'); assert.equal(await r.get('leader'), nextId);
    assert.equal(await old.call('leader'), false);
    passed('old-owner-shutdown-preserves-successor-and-stays-closed');

    await r.client('KILL', 'TYPE', 'normal', 'SKIPME', 'yes');
    await until(async () => (await next.call('status')).role === 'reader', 2000);
    passed('connection-loss-demotes-leader');
    await until(async () => await next.call('leader'));
    passed('reconnection-can-confirm-owned-lease');

    // SIGSTOP creates a real event-loop/process suspension past the Redis TTL.
    next.child.kill('SIGSTOP');
    const successor = node(); await successor.call('leader');
    await until(async () => await successor.call('leader'), 43000);
    const successorId = (await successor.call('status')).nodeId;
    assert.equal(await r.get('leader'), successorId);
    next.child.kill('SIGCONT');
    assert.equal(await next.call('leader'), false);
    assert.equal((await next.call('status')).role, 'reader');
    assert.equal(await r.get('leader'), successorId);
    passed('expired-process-resumes-as-reader-after-real-ttl-takeover');
    await next.call('shutdown'); assert.equal(await r.get('leader'), successorId);
    await successor.call('shutdown'); assert.equal(await r.get('leader'), null);
    const fresh = node(); assert.equal(await fresh.call('leader'), true); await fresh.call('shutdown');
    passed('graceful-release-allows-immediate-new-process-election');
    await r.set('leader', 'memory-pressure-owner', 'PX', 30000);
    const used = Number(/^used_memory:(\d+)$/m.exec(await r.info('memory'))[1]);
    await r.config('SET', 'maxmemory', used + 131072);
    await assert.rejects(r.set('memory-pressure', Buffer.alloc(512 * 1024)), /OOM/);
    assert.equal(await r.get('leader'), 'memory-pressure-owner');
    assert.ok(await r.pttl('leader') > 0);
    passed('memory-pressure-rejects-writes-without-evicting-lease');
    console.log('DD_HA_REPORT ' + JSON.stringify({ at: new Date().toISOString(),
      redisVersion: /^redis_version:(.+)$/m.exec(info)[1].trim(), ioredisVersion: require('ioredis/package.json').version,
      checks, independentNodeProcesses: true, productionDatabaseUsed: false }));
  } finally {
    for (const c of children) { c.kill('SIGCONT'); c.kill('SIGTERM'); }
    await Promise.all(children.map(c => new Promise(resolve => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve();
      const timer = setTimeout(() => { c.kill('SIGKILL'); resolve(); }, 2000);
      c.once('exit', () => { clearTimeout(timer); resolve(); });
    })));
    r.disconnect();
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
