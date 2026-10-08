'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const Docker = require('dockerode');
const url = new URL(process.env.DD_SMOKE_DOCKER_URL || 'http://127.0.0.1:2375');
const docker = new Docker({ host: url.hostname, port: Number(url.port || 2375), timeout: 120000 });
const image = process.env.DD_EGRESS_HELPER_IMAGE, controllerImage = process.env.DD_SMOKE_APP_IMAGE;
for (const id of [image, controllerImage]) assert.match(id || '', /^sha256:[a-f0-9]{64}$/);
const source = YAML.parse(fs.readFileSync('docker-compose.yml', 'utf8'));
const template = source.services['dd-egress-helper'];
const dependency = source.services['dd-egress-filter'].depends_on;
assert.equal(template.image, 'docker-dash-egress-helper:local');
assert.equal(template.build.context, './docker/egress-helper');
assert.equal(dependency['dd-egress-helper'].condition, 'service_completed_successfully');
const project = 'dd-helper-profile-' + crypto.randomBytes(6).toString('hex');
const labels = { 'com.docker-dash.smoke': project };
const fixture = { services: {
  'dd-egress-helper': { ...template, build: undefined, image, labels, pull_policy: 'never' },
  proof: { image, depends_on: dependency, profiles: ['egress'], entrypoint: ['sh'],
    command: ['-c', 'set -eu; test ! -e /sbin/apk; test ! -e /lib/libz.so.1; test ! -e /usr/lib/libz.so.1; test -s /lib/apk/db/installed; nft --version'],
    network_mode: 'none', read_only: true, cap_drop: ['ALL'], labels, pull_policy: 'never' },
} };
const program = `(async()=>{const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict');
 fs.writeFileSync('/tmp/profile.json',${JSON.stringify(JSON.stringify(fixture))});
 const run=args=>cp.execFileSync('docker',['compose','-p',${JSON.stringify(project)},'--profile','egress','-f','/tmp/profile.json',...args],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 try {
  run(['config','--quiet']);run(['up','-d','--no-build','--pull','never','proof']);
  let services;
  for(let n=0;n<50;n++){
   services=run(['ps','--all','--format','json']).trim().split('\\n').map(line=>JSON.parse(line));
   if(services.length===2&&services.every(s=>s.State==='exited'))break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(services.length,2);for(const service of services){assert.equal(service.State,'exited');assert.equal(service.ExitCode,0);}
  console.log(JSON.stringify({project:${JSON.stringify(project)},helperImage:${JSON.stringify(image)},bootstrapCompleted:true,dependentCompleted:true,packageDatabaseRetained:true,apkAndZlibAbsent:true}));
 }finally{run(['down','--timeout','5']);}})().catch(error=>{console.error(error.message);process.exitCode=1;});`;

(async () => {
  try {
    const c = await docker.createContainer({ name: project + '-controller', Image: controllerImage,
      Entrypoint: ['node'], Cmd: ['-e', program], Labels: labels, HostConfig: {
        NetworkMode: 'none', Memory: 256 * 1024 ** 2, PidsLimit: 64, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
        Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock', ReadOnly: true }],
      } });
    await c.start();const result = await c.wait();const logs = await c.logs({ stdout: true, stderr: true });
    for (let p = 0; p < logs.length;) { const n = logs.readUInt32BE(p + 4);process.stdout.write(logs.subarray(p + 8, p + 8 + n));p += 8 + n; }
    assert.equal(result.StatusCode, 0, 'Egress helper profile smoke failed');
  } finally {
    for (const item of await docker.listContainers({ all: true, filters: { label: ['com.docker-dash.smoke=' + project] } })) {
      const c = docker.getContainer(item.Id);assert.equal((await c.inspect()).Config.Labels['com.docker-dash.smoke'], project);
      await c.remove({ force: true, v: true });
    }
    console.log('Removed all helper profile test containers');
  }
})().catch(error => { console.error(error.message);process.exitCode = 1; });
