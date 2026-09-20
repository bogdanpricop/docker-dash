'use strict';

// Only this invocation's disposable containers/netns are modified. Host firewall
// rules and existing application containers are never selected as test targets.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Docker = require('dockerode');
const url = new URL(process.env.DD_SMOKE_DOCKER_URL || 'http://127.0.0.1:2375');
const docker = new Docker({ host: url.hostname, port: Number(url.port || 2375), timeout: 60000 });
const image = process.env.DD_EGRESS_HELPER_IMAGE;
assert.match(image || '', /^sha256:[a-f0-9]{64}$/, 'Set DD_EGRESS_HELPER_IMAGE to an immutable image containing nftables');
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.DD_EGRESS_SIDECAR_ENDPOINT = '192.0.2.10:29193';
require('../src/services/docker').getDocker = () => docker;
const runner = require('../src/services/egress-runner');
const nft = require('../src/services/egress-nft');
const marker = 'dd-egress-atomic-' + crypto.randomBytes(6).toString('hex');
const owned = [], targets = [], controls = [], checks = [];
const originalCreate = docker.createContainer.bind(docker);
let failApplyTarget, failRestoreTarget, commandGate;

docker.createContainer = async options => {
  const helper = await originalCreate(options);
  const target = options.Labels?.['com.docker-dash.egress-target'];
  if (target && targets.some(t => t.id === target)) {
    owned.push(helper);
    const exec = helper.exec.bind(helper);
    helper.exec = async options => {
      let script = options.Cmd[2];
      if (script.includes('DD_RULESET')) {
        if (commandGate) await commandGate();
        if (target === failApplyTarget) script = script.replace('\nDD_RULESET', '\nadd rule ip ddout missing_chain accept\nDD_RULESET');
      }
      if (target === failRestoreTarget && script.includes('dd-restore.nft')) script = 'exit 42';
      return exec({ ...options, Cmd: ['sh', '-c', script] });
    };
  }
  return helper;
};

async function exec(container, script, allowFailure = false) {
  const command = await container.exec({ Cmd: ['sh', '-c', script], AttachStdout: true, AttachStderr: true });
  const output = await runner._internals.readOutput(await command.start({}));
  const state = await command.inspect();
  if (!allowFailure) assert.equal(state.ExitCode, 0, output);
  return { output, exitCode: state.ExitCode };
}

async function baseline(control, n) {
  await exec(control, `nft -f - <<'RULES'
add table ip ddout
delete table ip ddout
table ip ddout {
 chain prior {
  type filter hook output priority 0; policy accept;
  ip daddr 192.0.2.${n} counter drop
 }
}
add table ip dd_untouched
RULES`);
  return (await exec(control, 'nft -snn list table ip ddout')).output;
}

async function main() {
  try {
    for (let n = 1; n <= 2; n++) {
      const target = await originalCreate({ name: marker + '-target-' + n, Image: image,
        Cmd: ['sleep', '600'], Labels: { 'com.docker-dash.smoke': marker, 'com.docker.compose.project': marker },
        HostConfig: { NetworkMode: 'bridge', CapDrop: ['ALL'], Memory: 64 * 1024 ** 2, PidsLimit: 16, SecurityOpt: ['no-new-privileges'] } });
      owned.push(target); targets.push(target); await target.start();
      const control = await originalCreate({ name: marker + '-control-' + n, Image: image,
        Cmd: ['sleep', '600'], Labels: { 'com.docker-dash.smoke': marker },
        HostConfig: { NetworkMode: 'container:' + target.id, CapDrop: ['ALL'], CapAdd: ['NET_ADMIN'],
          Memory: 64 * 1024 ** 2, PidsLimit: 16, SecurityOpt: ['no-new-privileges'] } });
      owned.push(control); controls.push(control); await control.start();
    }
    const versions = (await exec(controls[0], 'nft --version')).output.trim();
    const prior = await Promise.all(controls.map((c, i) => baseline(c, i + 1)));
    const invalid = nft.applyScript('192.0.2.10', 29193).replace('\nDD_RULESET', '\nadd rule ip ddout missing_chain accept\nDD_RULESET');
    assert.notEqual((await exec(controls[0], invalid, true)).exitCode, 0);
    assert.equal((await exec(controls[0], 'nft -snn list table ip ddout')).output, prior[0]);
    checks.push('kernel-reject-preserves-original-table');
    if (process.env.DD_TEST_LEGACY_EGRESS_HELPER === '1') {
      delete require.cache[require.resolve('../src/services/egress-runner')];
      process.env.DD_EGRESS_HELPER_IMAGE = 'alpine:3.24.2';
      const legacyRunner = require('../src/services/egress-runner');
      process.env.DD_EGRESS_HELPER_IMAGE = image;
      await legacyRunner.applyToContainer({ containerId: targets[0].id });
      assert.match((await exec(controls[0], 'nft -snn list table ip ddout')).output, /dnat/);
      await baseline(controls[0], 1);
      checks.push('legacy-alpine-preparation-before-mutation');
    }

    // Sorted canonical IDs determine application order, not fixture names.
    const ordered = targets.map(t => t.id).sort();
    failApplyTarget = ordered[1];
    await assert.rejects(runner.applyToStack({ stackName: marker }), error => {
      assert.equal(error.rollback.restored.length, 2); assert.deepEqual(error.rollback.failed, []); return true;
    });
    for (let i = 0; i < controls.length; i++) assert.equal((await exec(controls[i], 'nft -snn list table ip ddout')).output, prior[i]);
    checks.push('stack-failure-restores-preexisting-tables');

    failApplyTarget = null;
    await runner.applyToStack({ stackName: marker });
    await runner.applyToContainer({ containerId: targets[0].id.slice(0, 12) });
    assert.equal((await runner.isApplied({ containerId: targets[0].id })).applied, true);
    for (const control of controls) await exec(control, 'nft list table ip dd_untouched');
    checks.push('apply-reapply-and-status-preserve-unrelated-tables');

    let release, reached;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { reached = resolve; });
    commandGate = async () => { reached(); await gate; };
    const pending = runner.applyToContainer({ containerId: targets[0].id });
    try {
      await waiting;
      await assert.rejects(runner.applyToContainer({ containerId: targets[0].id }), /already holds/);
    } finally { commandGate = null; release(); await pending; }
    checks.push('daemon-reservation-refuses-concurrent-operation');

    for (const target of targets) await runner.removeFromContainer({ containerId: target.id });
    failApplyTarget = ordered[1];
    await assert.rejects(runner.applyToStack({ stackName: marker }), error => error.rollback.failed.length === 0);
    for (const control of controls) assert.ok(!(await exec(control, 'nft list tables')).output.includes('table ip ddout'));
    checks.push('rollback-restores-absent-table');

    await Promise.all(controls.map((c, i) => baseline(c, i + 1)));
    failRestoreTarget = ordered[0];
    let recovery;
    await assert.rejects(runner.applyToStack({ stackName: marker }), error => {
      assert.equal(error.recoveryRequired, true); assert.deepEqual(error.rollback.failed, [ordered[0]]); recovery = error; return true;
    });
    const retained = await docker.getContainer(recovery.recoveryHelpers[0]).inspect();
    assert.equal(retained.State.Running, false);
    assert.equal(retained.Config.Labels['com.docker-dash.egress-target'], ordered[0]);
    assert.equal(retained.Config.Labels['com.docker-dash.egress-started-at'], (await docker.getContainer(ordered[0]).inspect()).State.StartedAt);
    const archive = await docker.getContainer(retained.Id).getArchive({ path: '/tmp/dd-before.nft' });
    const extract = require('tar-stream').extract();
    const snapshotChunks = [];
    extract.on('entry', (header, entry, next) => {
      assert.equal(header.name, 'dd-before.nft');assert.ok(header.size > 0 && header.size <= 65536);
      entry.on('data', chunk => snapshotChunks.push(chunk));entry.on('end', next);
    });
    await require('node:stream/promises').pipeline(archive, extract);
    assert.equal(Buffer.concat(snapshotChunks).toString('utf8'), prior[targets.findIndex(t => t.id === ordered[0])]);
    await assert.rejects(runner.applyToContainer({ containerId: ordered[0] }), /already holds/);
    checks.push('failed-recovery-retains-stopped-reservation-and-original-snapshot');
    console.log(JSON.stringify({ marker, helperImage: image, nft: versions, checks, modifiedOnlyDisposableNamespaces: true }));
  } finally {
    const allowedTargets = new Set(targets.map(t => t.id));
    for (const container of owned.reverse()) {
      let info;
      try { info = await container.inspect(); } catch (error) { if (error.statusCode === 404) continue; throw error; }
      assert.ok(info.Config.Labels['com.docker-dash.smoke'] === marker || allowedTargets.has(info.Config.Labels['com.docker-dash.egress-target']));
      await container.remove({ force: true, v: true });
    }
    console.log('Removed all disposable egress targets, controls and retained test helpers');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
