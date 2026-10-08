'use strict';

// Scan existing immutable images in a disposable controller. Images and existing
// workloads are never changed. Network access is needed for both databases.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Docker = require('dockerode');
const url = process.env.DD_SMOKE_DOCKER_URL ? new URL(process.env.DD_SMOKE_DOCKER_URL) : null;
const docker = new Docker(url ? { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  protocol: url.protocol.slice(0, -1), timeout: 30000 } : { socketPath: '/var/run/docker.sock', timeout: 30000 });
const marker = `dd-admission-smoke-${crypto.randomBytes(6).toString('hex')}`;

async function main() {
  const controller = process.env.DD_SMOKE_APP_IMAGE;
  const allowed = process.env.DD_ADMISSION_ALLOW_IMAGE;
  const denied = process.env.DD_ADMISSION_DENY_IMAGE;
  const disagreement = process.env.DD_ADMISSION_DISAGREEMENT_IMAGE;
  for (const id of [controller, allowed, denied]) assert.match(id || '', /^sha256:[a-f0-9]{64}$/, 'Supply immutable image IDs');
  if (disagreement) assert.match(disagreement, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(allowed, denied);
  const scenarios = [[denied, false], [allowed, true]];
  if (disagreement) scenarios.push([disagreement, false, true]);
  const program = `const assert=require('node:assert/strict'),fs=require('node:fs'),Docker=require('dockerode');
    const admission=require('/app/src/services/image-admission');
    (async()=>{const docker=new Docker({socketPath:'/var/run/docker.sock',timeout:30000});
      for(const [id,expected,disagreement] of ${JSON.stringify(scenarios)}) {
        const result=await admission.scanImage(docker,id); console.log(JSON.stringify(result));
        assert.equal(result.passed,expected);assert.equal(result.status,expected?'passed':'blocked');
        assert.equal(result.scanner,'trivy+grype');assert.equal(result.imageId,id);
        assert.deepEqual(result.checks.map(check=>check.scanner),['trivy','grype']);
        for(const check of result.checks) assert.equal(check.imageId,id);
        if(expected) assert.ok(result.checks.every(check=>check.passed));
        if(disagreement) {
          assert.equal(result.checks[0].passed,true);assert.equal(result.checks[1].status,'blocked');
          assert.ok(result.checks[1].high>0);
        }
        assert.equal(fs.readdirSync('/tmp').some(name=>name.startsWith('dd-image-admission-')),false);
      }
      console.log('PASS immutable Docker export, Trivy+Grype deny/allow, independent verdicts and temporary cleanup');
    })().catch(error=>{console.error(error.message);process.exitCode=1});`;
  const container = await docker.createContainer({ name: marker, Image: controller, Entrypoint: ['node'], Cmd: ['-e', program],
    Labels: { 'com.docker-dash.smoke': marker },
    HostConfig: { Memory: 2 * 1024 ** 3, NanoCpus: 1000000000, PidsLimit: 128,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock', ReadOnly: true }] },
  });
  try {
    await container.start();
    for (let i = 0; i < scenarios.length * 100; i++) {
      const state = (await container.inspect()).State;
      if (!state.Running) {
        const logs = await container.logs({ stdout: true, stderr: true, tail: 50 });
        // Iterative Docker framing parser avoids recursive demux on a buffered log.
        for (let offset = 0; offset < logs.length;) {
          assert.ok(offset + 8 <= logs.length, 'Truncated Docker log frame');
          const length = logs.readUInt32BE(offset + 4);
          assert.ok(offset + 8 + length <= logs.length, 'Truncated Docker log payload');
          process.stdout.write(logs.subarray(offset + 8, offset + 8 + length)); offset += 8 + length;
        }
        assert.equal(state.ExitCode, 0, 'Image admission smoke failed');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('Image admission smoke deadline exceeded');
  } finally {
    assert.equal((await container.inspect()).Config.Labels['com.docker-dash.smoke'], marker);
    await container.remove({ force: true, v: true });
    console.log('Removed admission smoke controller');
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
