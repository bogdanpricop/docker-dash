'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const Redis = require('ioredis');
const { rateLimit } = require('../../src/middleware/rateLimit');
const { getClientIp } = require('../../src/utils/helpers');
const proxyTrust = require('../../src/utils/proxy-trust');
const cluster = require('../../src/services/cluster');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const r = new Redis(process.env.REDIS_URL, { protocol: 2, commandTimeout: 3000 });
r.on('error', () => {});
const app = express(), checks = []; let mutations = 0, server;
app.set('trust proxy', proxyTrust('false'));
app.get('/identity', (req, res) => res.json({ ip: getClientIp(req) }));
app.use('/items', rateLimit(2, 86400000, 'canary-api'));
app.use('/items', (_q, s) => s.json({ ok: true }));
app.post('/mutation', rateLimit(20, 86400000, 'canary-mutation'), (_q, s) => { mutations++; s.json({ ok: true }); });

(async () => {
  try {
    await r.ping(); const info = await r.info('server');
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const call = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(7000) });
    const plain = await (await call('/identity')).json();
    assert.deepEqual(await (await call('/identity', { headers: { 'X-Forwarded-For': '203.0.113.8', 'X-Real-IP': '198.51.100.9' } })).json(), plain);
    checks.push('direct-client-cannot-forge-forwarding-identity');
    assert.equal((await call('/items/1')).status, 200);
    assert.equal((await call('/ITEMS/2?q=other', { headers: { 'X-Forwarded-For': '203.0.113.99' } })).status, 200);
    assert.equal((await call('/items/3', { headers: { 'X-Real-IP': '203.0.113.22' } })).status, 429);
    checks.push('real-redis-quota-survives-url-case-and-header-rotation');
    app.set('trust proxy', proxyTrust('loopback'));
    const chain = await (await call('/identity', { headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' } })).json();
    assert.equal(chain.ip, '203.0.113.9');
    checks.push('trusted-proxy-stops-at-closest-untrusted-hop');
    app.set('trust proxy', false);

    await r.client('PAUSE', 5000, 'ALL');
    const start = Date.now(), blocked = await call('/mutation', { method: 'POST' });
    assert.equal(blocked.status, 503); assert.equal(blocked.headers.get('retry-after'), '3');
    assert.ok(Date.now() - start < 4500); assert.equal(mutations, 0);
    checks.push('stalled-redis-returns-bounded-503-before-mutation');
    await sleep(2500); await r.ping(); assert.equal(mutations, 0);
    checks.push('late-quota-success-does-not-run-abandoned-mutation');
    assert.equal((await call('/mutation', { method: 'POST' })).status, 200); assert.equal(mutations, 1);
    checks.push('quota-service-recovers-without-bypass');
    const used = Number(/^used_memory:(\d+)$/m.exec(await r.info('memory'))[1]);
    await r.config('SET', 'maxmemory', used - 1);
    const full = await call('/mutation', { method: 'POST' });
    assert.equal(full.status, 503); assert.equal(mutations, 1);
    checks.push('redis-noeviction-oom-blocks-protected-handler');
    await r.config('SET', 'maxmemory', 0);
    assert.equal((await call('/mutation', { method: 'POST' })).status, 200); assert.equal(mutations, 2);
    checks.push('clearing-memory-pressure-restores-verified-requests');
    console.log('DD_HA_REPORT ' + JSON.stringify({ at: new Date().toISOString(),
      redisVersion: /^redis_version:(.+)$/m.exec(info)[1].trim(), ioredisVersion: require('ioredis/package.json').version,
      checks, productionDatabaseUsed: false, onlyDisposableMutationHandler: true }));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await cluster.shutdown(); r.disconnect();
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
