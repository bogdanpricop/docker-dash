'use strict';

// Explicit, disposable Docker integration test. No existing workloads are changed.
// DD_SMOKE_DOCKER_URL=http://host:2375 (or a local Docker socket by default)
// DD_SMOKE_APP_IMAGE and DD_SMOKE_EGRESS_IMAGE must already exist on that daemon.
// DD_SMOKE_SUBNET optionally selects a subnet verified free of host route conflicts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const Docker = require('dockerode');

const run = `dd-egress-smoke-${crypto.randomBytes(6).toString('hex')}`;
const label = 'com.docker-dash.smoke';
const labels = { [label]: run };
const endpoint = process.env.DD_SMOKE_DOCKER_URL;
const url = endpoint ? new URL(endpoint) : null;
const docker = new Docker(url ? { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  protocol: url.protocol.slice(0, -1), timeout: 30000 } : { socketPath: '/var/run/docker.sock', timeout: 30000 });
const appImage = process.env.DD_SMOKE_APP_IMAGE;
const proxyImage = process.env.DD_SMOKE_EGRESS_IMAGE;
const resources = [];
let network, volume;

async function execute(container, code) {
  const command = await container.exec({ Cmd: ['node', '-e', code], AttachStdout: true, AttachStderr: true });
  const stream = await command.start({});
  let output = '';
  const sink = new Writable({ write(chunk, encoding, callback) {
    output += chunk.toString();
    callback(output.length > 65536 ? new Error('Smoke output too large') : null);
  } });
  await new Promise((resolve, reject) => {
    sink.on('error', reject); stream.on('error', reject); stream.on('end', resolve);
    docker.modem.demuxStream(stream, sink, sink);
  });
  const status = await command.inspect();
  if (status.ExitCode !== 0) {
    const info = await container.inspect();
    const logs = await container.logs({ stdout: true, stderr: true, tail: 15 });
    throw new Error(`${info.Name}: exec exit ${status.ExitCode}; state=${JSON.stringify(info.State)}; ${output}; ${logs.toString()}`);
  }
  return output.trim();
}

async function create(name, code, { image = appImage, entrypoint = ['node'], env = [], mounts = [], aliases = [], extraLabels = {}, ip } = {}) {
  const container = await docker.createContainer({
    name: `${run}-${name}`, Image: image, Entrypoint: entrypoint,
    Cmd: code == null ? [] : ['-e', code], Env: env, Labels: { ...labels, ...extraLabels },
    HostConfig: { NetworkMode: network.id, Memory: 536870912, NanoCpus: 1000000000,
      PidsLimit: 128, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Mounts: mounts },
    NetworkingConfig: { EndpointsConfig: { [network.id]: { Aliases: aliases,
      ...(ip ? { IPAMConfig: { IPv4Address: ip } } : {}) } } },
  });
  resources.push(container);
  await container.start();
  return container;
}

async function probe(container, hostname, expected, scenario) {
  const output = await execute(container, `
    const net=require('net');let data='';
    const socket=net.connect(29193,'proxy.audit.test',()=>socket.write(
      'GET / HTTP/1.1\\r\\nHost: ${hostname}:8080\\r\\nConnection: close\\r\\n\\r\\n'));
    socket.setTimeout(8000,()=>{console.error('timeout');process.exit(2)});
    socket.on('data',chunk=>data+=chunk);socket.on('error',error=>{
      if(error.code!=='ECONNRESET'){console.error(error.code);process.exit(2)}
    });socket.on('close',()=>console.log(data.startsWith('HTTP/1.1 200')?'ALLOW':'DENY'));
  `);
  assert.equal(output, expected, scenario);
  console.log(`PASS ${scenario}`);
}

async function cleanup() {
  const failures = [];
  for (const container of resources.reverse()) {
    try {
      const info = await container.inspect();
      assert.equal(info.Config.Labels[label], run, 'Refuse cleanup of unrelated container');
      await container.remove({ force: true, v: true });
    } catch (error) { if (error.statusCode !== 404) failures.push(error.message); }
  }
  for (const resource of [volume, network].filter(Boolean)) {
    try {
      const info = await resource.inspect();
      assert.equal(info.Labels[label], run, 'Refuse cleanup of unrelated resource');
      await resource.remove();
    } catch (error) { if (error.statusCode !== 404) failures.push(error.message); }
  }
  if (failures.length) throw new Error(`Cleanup failed for ${run}: ${failures.join('; ')}`);
  console.log(`Cleaned up ${run}`);
}

async function main() {
  assert.ok(appImage && proxyImage, 'Set DD_SMOKE_APP_IMAGE and DD_SMOKE_EGRESS_IMAGE to locally built images');
  await docker.getImage(appImage).inspect(); await docker.getImage(proxyImage).inspect();
  console.log(`Starting disposable smoke ${run}`);
  network = await docker.createNetwork({ Name: run, Driver: 'bridge', Internal: true, Labels: labels,
    ...(process.env.DD_SMOKE_SUBNET ? { IPAM: { Config: [{ Subnet: process.env.DD_SMOKE_SUBNET }] } } : {}) });
  volume = await docker.createVolume({ Name: run, Labels: labels });
  const mount = { Type: 'volume', Source: run, Target: '/data/egress-policy' };
  const idle = 'setInterval(()=>{},1000)';
  await create('origin', `require('http').createServer((req,res)=>res.end('origin')).listen(8080)`,
    { aliases: ['allowed-a.audit.test', 'allowed-b.audit.test', 'shared.audit.test'] });
  const a = await create('a', idle, { extraLabels: { 'com.docker.compose.project': run } });
  const b = await create('b', idle);
  const aIp = Object.values((await a.inspect()).NetworkSettings.Networks)[0].IPAddress;
  const env = ['APP_ENV=test', 'LOG_LEVEL=error', 'DB_PATH=/data/smoke.db',
    `APP_SECRET=${crypto.randomBytes(32).toString('hex')}`, `ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`,
    'DD_EGRESS_POLICY_PATH=/data/egress-policy/policy.json'];
  const controller = await create('controller', `
    const filter=require('/app/src/services/egress-filter');
    filter.createPolicy({scopeType:'container',scopeKey:'${a.id}',preset:'custom',customAllowlist:['allowed-a.audit.test','shared.audit.test']});
    filter.createPolicy({scopeType:'container',scopeKey:'${b.id}',preset:'custom',customAllowlist:['allowed-b.audit.test']});
    require('/app/src/services/egress-authorization').start().then(()=>{require('fs').writeFileSync('/tmp/ready','ok');setInterval(()=>{},1000)}).catch(e=>{console.error(e);process.exit(1)});
  `, { env, mounts: [mount, { Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock', ReadOnly: true }] });
  // The controller imports only the resolver and policy store: Docker access is
  // limited by the exercised code to live list/inspect, with no server jobs.
  await execute(controller, `const fs=require('fs');let n=0;const t=setInterval(()=>{
    if(fs.existsSync('/tmp/ready')){clearInterval(t);process.exit(0)}if(++n>100)process.exit(1)},100)`);
  const proxy = await create('proxy', null, { image: proxyImage, entrypoint: ['/out/dd-egress-proxy'],
    mounts: [{ ...mount, Target: '/etc/dd-egress', ReadOnly: true }], aliases: ['proxy.audit.test'] });
  await execute(a, `let n=0;function check(){const s=require('net').connect(29193,'proxy.audit.test',()=>{s.destroy();process.exit(0)});
    s.on('error',()=>{if(++n>50)process.exit(1);setTimeout(check,100)})}check()`);
  await probe(a, 'allowed-a.audit.test', 'ALLOW', 'container A own allowlist');
  await probe(b, 'allowed-b.audit.test', 'ALLOW', 'container B own allowlist');
  await probe(a, 'allowed-b.audit.test', 'DENY', 'container A cannot inherit B policy');
  await probe(b, 'allowed-a.audit.test', 'DENY', 'container B cannot inherit A policy');
  await execute(controller, `require('/app/src/services/egress-filter').createPolicy({scopeType:'stack',scopeKey:'${run}',preset:'custom',customAllowlist:['shared.audit.test']});process.exit(0)`);
  await probe(a, 'allowed-a.audit.test', 'DENY', 'enforced stack/container intersection');
  await probe(a, 'shared.audit.test', 'ALLOW', 'destination allowed by both scopes');
  await execute(controller, `const f=require('/app/src/services/egress-filter');const p=f.getPolicyForScope({scopeType:'stack',scopeKey:'${run}'});f.updatePolicy(p.id,{mode:'audit-only'});process.exit(0)`);
  await probe(a, 'allowed-a.audit.test', 'ALLOW', 'audit stack does not block enforced allowlist');
  await probe(a, 'allowed-b.audit.test', 'DENY', 'audit stack cannot override enforced denial');
  await execute(controller, `const f=require('/app/src/services/egress-filter');f.removePolicy(f.getPolicyForScope({scopeType:'container',scopeKey:'${b.id}'}).id);process.exit(0)`);
  await probe(b, 'allowed-b.audit.test', 'DENY', 'policy revocation affects next connection');
  await a.remove({ force: true, v: true });
  const replacement = await create('replacement', idle, { ip: aIp });
  await probe(replacement, 'allowed-a.audit.test', 'DENY', 'IP reuse cannot inherit old container policy');
  await execute(controller, `require('/app/src/services/egress-filter').createPolicy({scopeType:'container',scopeKey:'${b.id}',preset:'custom',customAllowlist:['allowed-b.audit.test']});process.exit(0)`);
  await probe(b, 'allowed-b.audit.test', 'ALLOW', 'recreated policy is visible without cached denial');
  await controller.stop({ t: 1 });
  await probe(b, 'allowed-b.audit.test', 'DENY', 'unavailable authorization revokes previously allowed destination');
  assert.equal((await proxy.inspect()).State.Running, true, 'Proxy remains available after rejected requests');
}

main().finally(cleanup).catch(error => { console.error(error.message); process.exitCode = 1; });
