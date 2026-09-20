'use strict';

// An explicit immutable application image is required. All created resources
// belong to a random Compose project; no published ports or existing volumes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const Docker = require('dockerode');
const url = process.env.DD_SMOKE_DOCKER_URL ? new URL(process.env.DD_SMOKE_DOCKER_URL) : null;
const docker = new Docker(url ? { host: url.hostname, port: Number(url.port || 2375),
  protocol: url.protocol.slice(0, -1), timeout: 180000 } : { socketPath: '/var/run/docker.sock', timeout: 180000 });

async function main() {
  const image = process.env.DD_SMOKE_APP_IMAGE;
  assert.match(image || '', /^sha256:[a-f0-9]{64}$/);
  const project = 'dd-compose-smoke-' + crypto.randomBytes(8).toString('hex');
  const label = { 'com.docker-dash.smoke': project };
  const fixture = { services: { fixture: {
    image, pull_policy: 'never', entrypoint: ['node'],
    command: ['-e', "require('fs').writeFileSync('/fixture/ready','verified');setInterval(()=>{},1000)"],
    labels: label, read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges'],
    mem_limit: '96m', cpus: 0.25, pids_limit: 32,
    healthcheck: { test: ['CMD', 'node', '-e', "if(require('fs').readFileSync('/fixture/ready','utf8')!=='verified')process.exit(1)"], interval: '1s', timeout: '3s', retries: 10 },
    volumes: ['fixture:/fixture'],
  } }, volumes: { fixture: { labels: label } }, networks: { default: { internal: true, labels: label } } };
  const program = `const cp=require('node:child_process'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
    const binary='/usr/libexec/docker/cli-plugins/docker-compose';
    const hash=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    assert.equal(hash,fs.readFileSync('/usr/share/docker-dash/scanners/docker-compose.sha256','utf8').trim().split(/\\s+/)[0]);
    const run=(args)=>cp.execFileSync('docker',['compose','-p',${JSON.stringify(project)},'-f','/tmp/fixture.json',...args],{encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
    fs.writeFileSync('/tmp/fixture.json',${JSON.stringify(JSON.stringify(fixture))});
    assert.equal(cp.execFileSync('docker',['compose','version','--short'],{encoding:'utf8'}).trim(),'5.5.1+dd.1');
    try {
      run(['config','--quiet']);
      run(['up','-d','--pull','never','--no-build','--wait','--wait-timeout','30']);
      assert.equal(run(['exec','-T','fixture','node','-p',"require('fs').readFileSync('/fixture/ready','utf8')"]).trim(),'verified');
      run(['restart','--timeout','5']);
      run(['up','-d','--pull','never','--no-build','--wait','--wait-timeout','30']);
      const ps=JSON.parse(run(['ps','--format','json']).trim());
      assert.equal(ps.State,'running');assert.equal(ps.Health,'healthy');
      console.log(JSON.stringify({project:${JSON.stringify(project)},image:${JSON.stringify(image)},compose:'5.5.1+dd.1',sha256:hash,checks:['provenance','config','up','health','exec','volume','restart','ps']}));
    } finally {run(['down','--volumes','--timeout','5']);}`;
  let controller;
  try {
    controller = await docker.createContainer({ name: project + '-controller', Image: image,
      Entrypoint: ['node'], Cmd: ['-e', program], Labels: label,
      HostConfig: { NetworkMode: 'none', Memory: 384 * 1024 ** 2, NanoCpus: 1000000000, PidsLimit: 64,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
        Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock', ReadOnly: true }] } });
    await controller.start();
    const result = await controller.wait();
    const logs = await controller.logs({ stdout: true, stderr: true });
    const sink = new Writable({ write(chunk, encoding, done) { process.stdout.write(chunk); done(); } });
    docker.modem.demuxStream(require('node:stream').Readable.from(logs), sink, sink);
    assert.equal(result.StatusCode, 0, 'Compose lifecycle canary failed');
  } finally {
    // Clean up only resources bearing this invocation's unguessable label,
    // including when the controller exits before Compose can run its finally.
    const filters = { label: ['com.docker-dash.smoke=' + project] };
    for (const item of await docker.listContainers({ all: true, filters })) {
      const c = docker.getContainer(item.Id);
      assert.equal((await c.inspect()).Config.Labels['com.docker-dash.smoke'], project);
      await c.remove({ force: true, v: true });
    }
    for (const item of await docker.listNetworks({ filters })) {
      const network = docker.getNetwork(item.Id);
      assert.equal((await network.inspect()).Labels['com.docker-dash.smoke'], project);
      await network.remove();
    }
    for (const item of (await docker.listVolumes({ filters })).Volumes || []) {
      const volume = docker.getVolume(item.Name);
      assert.equal((await volume.inspect()).Labels['com.docker-dash.smoke'], project);
      await volume.remove();
    }
    console.log('Removed all resources owned by ' + project);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
