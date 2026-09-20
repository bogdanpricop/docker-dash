'use strict';

// Build fixtures/egress-packet-probe.go with GOOS=linux GOARCH=amd64 CGO_ENABLED=0.
// Only our labeled containers and their namespaces are changed. One raw frame
// goes to our own receiver using the sender's real interface identity.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tar = require('tar-stream');
const Docker = require('dockerode');
const url = new URL(process.env.DD_SMOKE_DOCKER_URL || 'http://127.0.0.1:2375');
const docker = new Docker({ host: url.hostname, port: Number(url.port || 2375), timeout: 30000 });
const image = process.env.DD_EGRESS_HELPER_IMAGE;
assert.match(image || '', /^sha256:[a-f0-9]{64}$/);
const binary = fs.readFileSync(process.env.DD_PACKET_PROBE_BINARY);
assert.ok(binary.length < 10 * 1024 ** 2);
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.DD_EGRESS_SIDECAR_ENDPOINT = '192.0.2.10:29193';
require('../src/services/docker').getDocker = () => docker;
const runner = require('../src/services/egress-runner');
const filter = require('../src/services/egress-filter');
const { resolveSource } = require('../src/services/egress-authorization');
const marker = 'dd-egress-raw-' + crypto.randomBytes(6).toString('hex');
const owned = [];

async function create(suffix, hostConfig, listen = false) {
  const c = await docker.createContainer({ name: marker + '-' + suffix, Image: image,
    Entrypoint: listen ? ['/probe'] : ['sleep'], Cmd: listen ? ['listen'] : ['180'],
    Labels: { 'com.docker-dash.smoke': marker, ...(['default', 'drop', 'readded'].includes(suffix) ? { 'com.docker.compose.project': marker } : {}) },
    HostConfig: { NetworkMode: 'bridge', Memory: 64 * 1024 ** 2, PidsLimit: 16,
      SecurityOpt: ['no-new-privileges'], ...hostConfig } });
  owned.push(c);
  const archive = tar.pack(); archive.entry({ name: 'probe', mode: 0o755 }, binary); archive.finalize();
  await c.putArchive(archive, { path: '/' }); await c.start(); return c;
}

async function exec(c, command) {
  const e = await c.exec({ Cmd: command, AttachStdout: true, AttachStderr: true });
  const output = await runner._internals.readOutput(await e.start({}));
  assert.equal((await e.inspect()).ExitCode, 0, output); return output;
}

async function logs(c) {
  const b = await c.logs({ stdout: true, stderr: true });
  const { Readable } = require('node:stream');
  return runner._internals.readOutput(Readable.from([b]));
}

async function waitLog(c, expected) {
  for (let n = 0; n < 40; n++) {
    const text = await logs(c); if (text.includes(expected)) return text;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Receiver did not record ' + expected);
}

async function main() {
  try {
    const receiver = await create('receiver', { CapDrop: ['ALL'] }, true);
    await waitLog(receiver, 'READY');
    const unsafe = await create('default', {});
    const safe = await create('drop', { CapDrop: ['NET_RAW'] });
    const readded = await create('readded', { CapDrop: ['ALL'], CapAdd: ['NET_RAW'] });
    const info = await unsafe.inspect(), receiverInfo = await receiver.inspect();
    const peer = receiverInfo.NetworkSettings.Networks.bridge;
    const control = await create('control', { NetworkMode: 'container:' + unsafe.id, CapDrop: ['ALL'], CapAdd: ['NET_ADMIN'] });
    await exec(control, ['sh', '-c', "printf '%s\n' 'table inet dd_raw_probe { chain output { type filter hook output priority 0; policy drop; }; }' | nft -f -"]);
    assert.match(await exec(unsafe, ['/probe', 'normal-blocked', peer.IPAddress, marker + '-normal']), /UDP_OUTPUT_BLOCKED/);
    await exec(unsafe, ['/probe', 'raw', peer.IPAddress, peer.MacAddress, marker + '-raw']);
    const received = await waitLog(receiver, marker + '-raw');
    assert.ok(!received.includes(marker + '-normal'));
    assert.match(await exec(safe, ['/probe', 'socket-denied']), /AF_PACKET_DENIED/);
    assert.equal(filter.canApplyFilter(info).ok, false);
    assert.equal(filter.canApplyFilter(await readded.inspect()).ok, false);
    assert.equal(filter.canApplyFilter(await safe.inspect()).ok, true);
    await assert.rejects(runner.applyToContainer({ containerId: unsafe.id }), /NET_RAW/);
    await assert.rejects(runner.applyToStack({ stackName: marker }), /NET_RAW/);
    const ownDocker = { listContainers: async () => [{ Id: info.Id, NetworkSettings: info.NetworkSettings }],
      getContainer: () => ({ inspect: async () => info }) };
    await assert.rejects(resolveSource(info.NetworkSettings.Networks.bridge.IPAddress,
      { docker: ownDocker, policies: () => [], matchesHost: () => true }), /safely filtered/);
    await exec(control, ['sh', '-c', 'nft add table ip ddout']);
    assert.deepEqual((await runner.isApplied({ containerId: unsafe.id })).safeToFilter, false);
    await runner.removeFromContainer({ containerId: unsafe.id });
    assert.ok(!(await exec(control, ['nft', 'list', 'tables'])).includes('table ip ddout'));
    await runner.applyToContainer({ containerId: safe.id });
    await runner.removeFromContainer({ containerId: safe.id });
    console.log(JSON.stringify({ marker, image, probeSha256: crypto.createHash('sha256').update(binary).digest('hex'),
      checks: ['normal-output-blocked', 'default-net-raw-bypasses-output-chain', 'explicit-drop-denies-packet-socket',
        'default-and-readded-net-raw-refused', 'unsafe-stack-refused', 'source-authorization-refused',
        'legacy-status-and-removal-available', 'explicit-drop-apply-remove-succeeds'], modifiedOnlyDisposableNamespaces: true }));
  } finally {
    const leftovers = await docker.listContainers({ all: true });
    for (const item of leftovers) {
      if (owned.some(c => c.id === item.Labels?.['com.docker-dash.egress-target'])) owned.push(docker.getContainer(item.Id));
    }
    for (const c of owned.reverse()) {
      try {
        const i = await c.inspect();
        assert.ok(i.Config.Labels['com.docker-dash.smoke'] === marker || owned.some(t => t.id === i.Config.Labels['com.docker-dash.egress-target']));
        await c.remove({ force: true, v: true });
      } catch (error) { if (error.statusCode !== 404) throw error; }
    }
    console.log('Removed all owned capability canary containers');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
