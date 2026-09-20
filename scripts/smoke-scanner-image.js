'use strict';

// Read-only scans of an existing image in a disposable controller. No image
// pulls, workload updates, published ports or persistent scanner cache.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Docker = require('dockerode');
const url = process.env.DD_SMOKE_DOCKER_URL ? new URL(process.env.DD_SMOKE_DOCKER_URL) : null;
const docker = new Docker(url ? { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  protocol: url.protocol.slice(0, -1), timeout: 30000 } : { socketPath: '/var/run/docker.sock', timeout: 30000 });

async function main() {
  const image = process.env.DD_SMOKE_APP_IMAGE;
  const target = process.env.DD_SCANNER_TARGET_IMAGE || image;
  for (const id of [image, target]) assert.match(id || '', /^sha256:[a-f0-9]{64}$/, 'Supply immutable image IDs');
  const marker = `dd-scanner-smoke-${crypto.randomBytes(6).toString('hex')}`;
  const program = `const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
    for(const [name,executable] of [['trivy','trivy'],['grype','grype'],['docker-cli','docker']]) {
      const actual=crypto.createHash('sha256').update(fs.readFileSync('/usr/local/bin/'+executable)).digest('hex');
      const expected=fs.readFileSync('/usr/share/docker-dash/scanners/'+name+'.sha256','utf8').trim().split(/\\s+/)[0];
      assert.equal(actual,expected,'Installed scanner differs from its build provenance');
      console.log(JSON.stringify({scanner:name,sha256:actual,version:cp.execFileSync(executable,[name==='grype'?'version':'--version'],{encoding:'utf8',timeout:10000}).trim()}));
    }
    for(const file of ['/usr/lib/docker/cli-plugins/docker-scout','/usr/local/lib/docker/cli-plugins/docker-scout','/usr/libexec/docker/cli-plugins/docker-scout','/usr/local/bin/docker-scout'])assert.equal(fs.existsSync(file),false);
    const target=${JSON.stringify(target)};
    const trivy=JSON.parse(cp.execFileSync('trivy',['image','--image-src','docker','--scanners','vuln','--format','json','--quiet','--timeout','5m',target],{encoding:'utf8',timeout:310000,maxBuffer:32*1024*1024}));
    assert.equal(trivy.SchemaVersion,2);assert.ok(trivy.Results?.length>0);assert.ok(trivy.Metadata?.ImageID);
    console.log(JSON.stringify({scanner:'trivy',image:trivy.Metadata.ImageID,findings:trivy.Results.flatMap(r=>(r.Vulnerabilities||[]).map(v=>({id:v.VulnerabilityID,package:v.PkgName,severity:v.Severity})))}));
    const grype=JSON.parse(cp.execFileSync('grype',['docker:'+target,'-o','json','--quiet'],{encoding:'utf8',timeout:310000,maxBuffer:32*1024*1024}));
    assert.ok(Array.isArray(grype.matches));assert.equal(grype.descriptor?.name,'grype');assert.ok(grype.source?.target?.imageID);
    console.log(JSON.stringify({scanner:'grype',image:grype.source.target.imageID,findings:grype.matches.map(m=>({id:m.vulnerability.id,package:m.artifact.name,severity:m.vulnerability.severity}))}));
    console.log('PASS both scanners produce actual image reports; provenance hashes match; Scout absent');`;
  const container = await docker.createContainer({ name: marker, Image: image, Entrypoint: ['node'], Cmd: ['-e', program],
    Labels: { 'com.docker-dash.smoke': marker },
    HostConfig: { Memory: 2 * 1024 ** 3, NanoCpus: 1000000000, PidsLimit: 128,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock', ReadOnly: true }] },
  });
  try {
    await container.start();
    for (let i = 0; i < 135; i++) {
      const state = (await container.inspect()).State;
      if (!state.Running) {
        const logs = await container.logs({ stdout: true, stderr: true });
        for (let offset = 0; offset < logs.length;) {
          assert.ok(offset + 8 <= logs.length, 'Truncated Docker log frame');
          const length = logs.readUInt32BE(offset + 4);
          assert.ok(offset + 8 + length <= logs.length, 'Truncated Docker log payload');
          process.stdout.write(logs.subarray(offset + 8, offset + 8 + length)); offset += 8 + length;
        }
        assert.equal(state.ExitCode, 0, 'Scanner functional smoke failed');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('Scanner smoke deadline exceeded');
  } finally {
    assert.equal((await container.inspect()).Config.Labels['com.docker-dash.smoke'], marker);
    await container.remove({ force: true, v: true });
    console.log('Removed scanner smoke controller');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
