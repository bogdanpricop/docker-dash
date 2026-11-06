'use strict';

// Uses an in-memory policy database and only this run's labeled containers.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Docker = require('dockerode');
const image = process.env.DD_EGRESS_HELPER_IMAGE;
assert.match(image || '', /^sha256:[a-f0-9]{64}$/);
const marker = 'dd-egress-overlap-' + crypto.randomBytes(6).toString('hex');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), marker + '-'));
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.DD_EGRESS_POLICY_PATH = path.join(directory, 'policy.json');
process.env.DD_EGRESS_SIDECAR_ENDPOINT = '192.0.2.10:29193';
const url = new URL(process.env.DD_SMOKE_DOCKER_URL || 'http://127.0.0.1:2375');
const docker = new Docker({ host: url.hostname, port: Number(url.port || 2375), timeout: 30000 });
require('../src/services/docker').getDocker = () => docker;
const filter = require('../src/services/egress-filter');
const runner = require('../src/services/egress-runner');
const db = require('../src/db').getDb();
const owned = [], targets = [], controls = [], checks = [];

async function exec(c, script) {
  const e = await c.exec({ Cmd: ['sh', '-c', script], AttachStdout: true, AttachStderr: true });
  const output = await runner._internals.readOutput(await e.start({}));
  assert.equal((await e.inspect()).ExitCode, 0, output); return output;
}

async function main() {
  try {
    for (let n = 0; n < 2; n++) {
      const target = await docker.createContainer({ name: marker + '-target-' + n, Image: image, Cmd: ['sleep', '300'],
        Labels: { 'com.docker-dash.smoke': marker, 'com.docker.compose.project': marker },
        HostConfig: { NetworkMode: 'bridge', CapDrop: ['ALL'], Memory: 64 * 1024 ** 2, PidsLimit: 16, SecurityOpt: ['no-new-privileges'] } });
      owned.push(target); targets.push(target); await target.start();
      const control = await docker.createContainer({ name: marker + '-control-' + n, Image: image, Cmd: ['sleep', '300'],
        Labels: { 'com.docker-dash.smoke': marker }, HostConfig: { NetworkMode: 'container:' + target.id,
          CapDrop: ['ALL'], CapAdd: ['NET_ADMIN'], Memory: 64 * 1024 ** 2, PidsLimit: 16, SecurityOpt: ['no-new-privileges'] } });
      owned.push(control); controls.push(control); await control.start();
    }
    const hostId = db.prepare('SELECT id FROM docker_hosts WHERE is_default=1').get().id;
    const otherHostId = Number(db.prepare("INSERT INTO docker_hosts (name, connection_type) VALUES ('Disposable policy-only host', 'socket')").run().lastInsertRowid);
    const containerConfig = { scopeType: 'container', scopeKey: targets[0].id, hostId: 0, preset: 'registry-only' };
    const containerPolicy = filter.createPolicy(containerConfig).policyId;
    const stackPolicy = filter.createPolicy({ scopeType: 'stack', scopeKey: marker, hostId, preset: 'registry-only' }).policyId;
    const remotePolicy = filter.createPolicy({ ...containerConfig, hostId: otherHostId }).policyId;
    await runner.applyToStack({ stackName: marker, hostId: 0 });
    const before = await exec(controls[0], 'nft -snn list table ip ddout');
    const retained = await runner.removeFromContainer({ containerId: targets[0].id, policyId: containerPolicy });
    assert.deepEqual(retained.retainedFor, [stackPolicy]); assert.equal(retained.applied, true);
    assert.equal(await exec(controls[0], 'nft -snn list table ip ddout'), before);
    checks.push('container-unapply-retains-stack-table-across-default-host-alias');
    filter.removePolicy(containerPolicy);
    assert.equal(await exec(controls[0], 'nft -snn list table ip ddout'), before);
    checks.push('container-disable-preserves-stack-filter');
    filter.createPolicy(containerConfig);
    const stack = await runner.removeFromStack({ stackName: marker, policyId: stackPolicy });
    assert.deepEqual(stack.retained.map(c => c.id), [targets[0].id]);
    assert.deepEqual(stack.removed.map(c => c.id), [targets[1].id]); assert.deepEqual(stack.failed, []);
    assert.equal(await exec(controls[0], 'nft -snn list table ip ddout'), before);
    assert.ok(!(await exec(controls[1], 'nft list tables')).includes('table ip ddout'));
    checks.push('stack-unapply-retains-container-filter-and-removes-exclusive-member');
    filter.removePolicy(stackPolicy);
    assert.equal(await exec(controls[0], 'nft -snn list table ip ddout'), before);
    checks.push('stack-disable-preserves-container-filter');
    await assert.rejects(runner.removeFromContainer({ containerId: targets[0].id, policyId: remotePolicy }), /does not cover/);
    assert.equal(await exec(controls[0], 'nft -snn list table ip ddout'), before);
    checks.push('foreign-policy-cannot-be-excluded-to-remove-rules');
    assert.deepEqual((await runner.removeFromContainer({ containerId: targets[0].id })).retainedFor, [containerPolicy]);
    checks.push('unscoped-removal-protects-all-active-policies');
    const last = await runner.removeFromContainer({ containerId: targets[0].id, policyId: containerPolicy });
    assert.equal(last.removed, true); assert.equal(last.applied, false);
    assert.ok(!(await exec(controls[0], 'nft list tables')).includes('table ip ddout'));
    checks.push('last-policy-removal-ignores-other-host-and-inactive-policies');
    console.log(JSON.stringify({ marker, image, checks, usedInMemoryPolicyDatabase: true, modifiedOnlyDisposableNamespaces: true }));
  } finally {
    for (const item of await docker.listContainers({ all: true })) {
      if (targets.some(c => c.id === item.Labels?.['com.docker-dash.egress-target'])) owned.push(docker.getContainer(item.Id));
    }
    for (const c of owned.reverse()) {
      try {
        const i = await c.inspect();
        assert.ok(i.Config.Labels['com.docker-dash.smoke'] === marker || targets.some(t => t.id === i.Config.Labels['com.docker-dash.egress-target']));
        await c.remove({ force: true, v: true });
      } catch (error) { if (error.statusCode !== 404) throw error; }
    }
    // Delete only the known file inside this invocation's mkdtemp directory.
    assert.equal(path.dirname(process.env.DD_EGRESS_POLICY_PATH), directory);
    if (fs.existsSync(process.env.DD_EGRESS_POLICY_PATH)) fs.unlinkSync(process.env.DD_EGRESS_POLICY_PATH);
    fs.rmdirSync(directory);
    console.log('Removed all owned overlap canary containers and temporary policy file');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
