'use strict';

// Every destructive API call requires this invocation's positive label filter.
// The guard name/list are namespaced by an adapter; no production prune is run.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs');
const Docker = require('dockerode'), tar = require('tar-stream');
const guard = require('../src/services/docker-prune-guard');
const { hashArchive } = require('./verify-scanner-artifacts');
const verifyBundled = process.env.DD_SMOKE_VERIFY_BUNDLED === '1';
let connection;
if (process.env.DD_SMOKE_DOCKER_SOCKET) {
  assert.equal(process.env.DD_SMOKE_DOCKER_SOCKET, '/var/run/docker.sock');
  assert.equal(process.env.DD_SMOKE_DOCKER_URL, undefined);
  connection = { socketPath: process.env.DD_SMOKE_DOCKER_SOCKET };
} else {
  const url = new URL(process.env.DD_SMOKE_DOCKER_URL);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
  connection = { host: url.hostname, port: Number(url.port) };
}
const docker = new Docker({ ...connection, timeout: 60000 });
const marker = 'dd-prune-smoke-' + crypto.randomBytes(6).toString('hex'), label = 'com.docker-dash.prune-smoke';
const owned = [], checks = [], oldImage = process.env.DD_EGRESS_HELPER_IMAGE;
const filters = { label: [label + '=' + marker] };
const reservedName = marker + '-reservation';
let image;
const bundledSources = {};
const adapter = {
  getImage: id => docker.getImage(id), listImages: () => docker.listImages({ filters: JSON.stringify(filters) }),
  getContainer: name => docker.getContainer(name === guard.NAME ? reservedName : name),
  listContainers: () => docker.listContainers({ all: true, filters: JSON.stringify(filters) }),
  createContainer: async options => {
    const c = await docker.createContainer({ ...options, name: reservedName,
      Labels: { ...options.Labels, [label]: marker } }); owned.push(c); return c;
  },
};
async function fixture(name, labels = {}) {
  const c = await docker.createContainer({ name, Image: image, Entrypoint: ['/bin/false'], Cmd: [],
    Labels: { [label]: marker, ...labels }, HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'] } });
  owned.push(c); return c;
}
(async () => {
  try {
    assert.match(oldImage || '', /^sha256:[a-f0-9]{64}$/);
    if (verifyBundled) {
      assert.match(process.env.DD_SMOKE_APP_IMAGE || '', /^sha256:[a-f0-9]{64}$/);
      const sourceContainer = await docker.createContainer({ Image: process.env.DD_SMOKE_APP_IMAGE,
        Entrypoint: ['/bin/false'], Cmd: [], Labels: { [label]: marker },
        HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'] } });
      owned.push(sourceContainer);
      for (const file of ['src/services/docker-prune-guard.js', 'src/services/docker.js',
        'src/services/container-replacement.js', 'src/services/egress-runner.js', 'src/services/disk-pressure.js']) {
        const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        const actual = await hashArchive(await sourceContainer.getArchive({ path: '/app/' + file }), file.split('/').pop());
        assert.equal(actual.sha256, expected, 'Bundled source mismatch: ' + file);
        bundledSources[file] = expected;
      }
      await sourceContainer.remove({ v: true });
    }
    const pack = tar.pack();
    pack.entry({ name: 'Dockerfile' }, `FROM ${oldImage}\nLABEL ${label}=${marker}\n`); pack.finalize();
    const stream = await docker.buildImage(pack, { t: marker + ':test', memory: 128 * 1024 ** 2 });
    await new Promise((resolve, reject) => docker.modem.followProgress(stream, (e, events) => {
      const failure = events?.find(item => item.error); e || failure ? reject(e || Error(failure.error)) : resolve();
    }));
    image = (await docker.getImage(marker + ':test').inspect()).Id;
    process.env.DD_EGRESS_HELPER_IMAGE = image;
    await guard.withPrune(adapter, async () => {
      await assert.rejects(guard.assertNoPrune(adapter), { status: 409 });
      await assert.rejects(guard.withPrune(adapter, async () => assert.fail('competing prune ran')), { status: 409 });
      checks.push('daemon-name-reservation-blocks-operations-and-competing-prune');
      const victim = await fixture(marker + '-victim');
      const lateLock = await fixture(marker + '-late-lock', { 'com.docker-dash.replacement.role': 'lock', [guard.PROTECT_LABEL]: 'true' });
      const lateEgress = await fixture(marker + '-late-egress', { 'com.docker-dash.egress-operation': marker, [guard.PROTECT_LABEL]: 'true' });
      const lateDesktop = await fixture(marker + '-late-desktop', { 'com.desktop-streamer.release-operation': marker, [guard.PROTECT_LABEL]: 'true' });
      const result = await docker.pruneContainers({ filters: JSON.stringify({ ...filters, ...guard.CONTAINER_FILTERS }) });
      assert.deepEqual(result.ContainersDeleted, [victim.id]);
      await lateLock.inspect(); await lateEgress.inspect(); await lateDesktop.inspect(); await adapter.getContainer(guard.NAME).inspect();
      checks.push('real-container-prune-keeps-guard-and-late-operation-reservations');
      await lateLock.remove({ v: true }); await lateEgress.remove({ v: true }); await lateDesktop.remove({ v: true });
      await docker.pruneImages({ filters: JSON.stringify({ ...filters, dangling: ['false'] }) });
      await docker.getImage(image).inspect();
      checks.push('real-image-prune-preserves-helper-referenced-only-by-guard');
      return result;
    });
    await guard.assertNoPrune(adapter);
    const recovery = await fixture('dd-recovery-' + marker);
    await assert.rejects(guard.withPrune(adapter, async () => assert.fail('pruned recovery')), { status: 409 });
    await recovery.inspect(); await recovery.remove({ v: true });
    checks.push('retained-original-blocks-prune-before-deletion');
    for (const role of ['release-operation', 'release-reservation', 'cutover-owner']) {
      const evidence = await fixture(marker + '-desktop-' + role, { ['com.desktop-streamer.' + role]: marker });
      await assert.rejects(guard.withPrune(adapter, async () => assert.fail('pruned Desktop Streamer evidence')), { status: 409 });
      await evidence.inspect(); await evidence.remove({ v: true });
      checks.push('desktop-' + role + '-blocks-prune-before-deletion');
    }
    await assert.rejects(guard.withPrune(adapter, async () => { throw Error('simulated lost response, no prune dispatched'); }),
      { recoveryRequired: true, recoveryContainer: guard.NAME });
    await assert.rejects(guard.assertNoPrune(adapter), { status: 409 });
    checks.push('uncertain-outcome-retains-barrier');
    console.log(JSON.stringify({ at: new Date().toISOString(), marker, checks, fixtureImage: image,
      appImage: process.env.DD_SMOKE_APP_IMAGE, bundledSourceVerified: verifyBundled, bundledSources,
      sourceSha256: crypto.createHash('sha256').update(fs.readFileSync('src/services/docker-prune-guard.js')).digest('hex'),
      onlyLabeledTestResources: true, productionPruneCalled: false }));
  } finally {
    process.env.DD_EGRESS_HELPER_IMAGE = oldImage;
    for (const c of owned.reverse()) {
      try { const info = await c.inspect(); assert.equal(info.Config.Labels[label], marker); await c.remove({ force: true, v: true }); }
      catch (error) { if (error.statusCode !== 404) throw error; }
    }
    if (image) { const info = await docker.getImage(image).inspect(); assert.equal(info.Config.Labels[label], marker); await docker.getImage(image).remove({ noprune: true }); }
    await docker.getImage(oldImage).inspect();
    console.log('Removed all owned prune canary resources');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
