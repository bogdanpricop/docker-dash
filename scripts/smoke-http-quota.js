'use strict';

// Runs solely in this invocation's disposable Redis namespace and controller.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Docker = require('dockerode');
const tar = require('tar-stream');
const { Readable } = require('node:stream');
const yaml = require('yaml');
const { readOutput } = require('../src/services/egress-runner')._internals;
const { hashArchive } = require('./verify-scanner-artifacts');
const verifyBundled = process.env.DD_SMOKE_VERIFY_BUNDLED === '1';
const image = process.env.DD_SMOKE_APP_IMAGE;
assert.match(image || '', /^sha256:[a-f0-9]{64}$/);
const redisImage = 'redis@sha256:bd999b5cfee25fb24b8320a31fddbd69f462df44c8138c66e369582937beebc0';
const url = new URL(process.env.DD_SMOKE_DOCKER_URL);
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
const docker = new Docker({ host: url.hostname, port: Number(url.port), timeout: 30000 });
const marker = 'dd-http-quota-' + crypto.randomBytes(6).toString('hex'), owned = [];
const password = crypto.randomBytes(32).toString('hex');
const labels = { 'com.docker-dash.smoke': marker };
const redisCommand = yaml.parse(fs.readFileSync('docker-compose.yml', 'utf8')).services.redis.command;
assert.match(redisCommand, /--maxmemory-policy noeviction(?:\s|$)/, 'Coordination profile must not evict leases');
const sources = ['src/services/cluster.js', 'src/services/cluster-lease.js',
  'src/middleware/rateLimit.js', 'src/utils/helpers.js', 'src/utils/proxy-trust.js', 'scripts/fixtures/http-quota-checks.js'];

(async () => {
  try {
    const backend = await docker.createContainer({ name: marker + '-redis', Image: redisImage, User: '999:999',
      Entrypoint: ['redis-server'], Cmd: ['--bind', '127.0.0.1', '--save', '', '--appendonly', 'no',
        '--maxmemory-policy', 'noeviction', '--requirepass', password],
      Labels: labels, WorkingDir: '/tmp', HostConfig: { NetworkMode: 'bridge', CapDrop: ['ALL'], ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' }, Memory: 128 * 1024 ** 2, NanoCpus: 500000000,
        PidsLimit: 32, SecurityOpt: ['no-new-privileges'] } });
    owned.push(backend); await backend.start();
    const controller = await docker.createContainer({ name: marker + '-check', Image: image,
      Entrypoint: ['node'], Cmd: ['scripts/fixtures/http-quota-checks.js'], Labels: labels, WorkingDir: '/app',
      Env: ['APP_ENV=test', 'DD_MODE=ha', 'ENV_FILE=/tmp/no-env-file', 'LOG_LEVEL=error', 'REDIS_URL=redis://:' + password + '@127.0.0.1:6379'],
      HostConfig: { NetworkMode: 'container:' + backend.id, CapDrop: ['ALL'], Memory: 256 * 1024 ** 2,
        NanoCpus: 1000000000, PidsLimit: 96, SecurityOpt: ['no-new-privileges'] } });
    owned.push(controller);
    const pack = tar.pack(), sourceSha256 = {};
    for (const name of sources) {
      const body = fs.readFileSync(name); sourceSha256[name] = crypto.createHash('sha256').update(body).digest('hex');
      if (verifyBundled && name.startsWith('src/')) {
        const actual = await hashArchive(await controller.getArchive({ path: '/app/' + name }), name.split('/').pop());
        assert.equal(actual.sha256, sourceSha256[name], 'Bundled source mismatch: ' + name);
        continue;
      }
      pack.entry({ name, mode: 0o644 }, body);
    }
    pack.finalize(); await controller.putArchive(pack, { path: '/app' });
    await controller.start();
    const until = Date.now() + 120000;
    let info;
    do { info = await controller.inspect(); if (!info.State.Running) break; await new Promise(r => setTimeout(r, 1000)); } while (Date.now() < until);
    const logs = await controller.logs({ stdout: true, stderr: true, follow: false });
    const output = await readOutput(Buffer.isBuffer(logs) ? Readable.from([logs]) : logs);
    process.stdout.write(output);
    assert.equal(info.State.Running, false, 'HTTP quota controller timeout'); assert.equal(info.State.OOMKilled, false);
    assert.equal(info.State.ExitCode, 0, 'HTTP quota canary failed');
    const match = /^DD_HA_REPORT (.+)$/m.exec(output); assert.ok(match, 'Missing HTTP quota proof');
    console.log(JSON.stringify({ ...JSON.parse(match[1]), marker, appImage: image, redisImage,
      redisImageId: (await backend.inspect()).Image, sourceSha256, bundledSourceVerified: verifyBundled, publishedPorts: false }));
  } finally {
    for (const c of owned.reverse()) {
      const info = await c.inspect(); assert.equal(info.Config.Labels['com.docker-dash.smoke'], marker);
      await c.remove({ force: true, v: true });
    }
    console.log('Removed own HTTP quota canary containers and ephemeral Redis data');
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
