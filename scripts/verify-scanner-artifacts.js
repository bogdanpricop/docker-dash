'use strict';

// Read-only audit of installed scanner artifacts. This does not change scanner
// reports, image admission, publication gates or vulnerability ignore policies.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const tar = require('tar-stream');
const reviewed = require('../docker/scanners/reviewed-artifacts.json');

async function hashArchive(stream, expectedName, { capture = false, limit = 512 * 1024 ** 2 } = {}) {
  const extract = tar.extract(), digest = crypto.createHash('sha256'), chunks = [];
  let count = 0, bytes = 0;
  extract.on('entry', (header, entry, next) => {
    entry.on('error', error => extract.destroy(error));
    if (++count !== 1 || header.type !== 'file' || header.name !== expectedName || header.size > limit) {
      extract.destroy(new Error('Unexpected or oversized artifact archive entry')); return;
    }
    entry.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limit) { extract.destroy(new Error('Artifact exceeds byte limit')); return; }
      digest.update(chunk); if (capture) chunks.push(chunk);
    });
    entry.on('end', () => {
      if (bytes !== header.size) { extract.destroy(new Error('Truncated artifact')); return; }
      next();
    });
  });
  await pipeline(stream, extract, { signal: AbortSignal.timeout(60000) });
  assert.equal(count, 1, 'Artifact absent from archive');
  return { sha256: digest.digest('hex'), bytes, ...(capture ? { text: Buffer.concat(chunks).toString('utf8') } : {}) };
}

function assessArtifact(name, binary, metadata, lock = reviewed) {
  const expected = lock.artifacts[name]; assert.ok(expected, 'Artifact was not reviewed');
  assert.equal(binary.sha256, expected.binarySha256, 'Installed binary differs from reviewed source build');
  for (const suffix of ['packages.txt', 'build-info.txt', 'source.json']) {
    assert.equal(metadata[suffix]?.sha256, expected.metadata[suffix], 'Build provenance differs from reviewed evidence: ' + suffix);
    assert.equal(crypto.createHash('sha256').update(metadata[suffix].text).digest('hex'), metadata[suffix].sha256, 'Metadata content/hash mismatch');
  }
  const packages = metadata['packages.txt'].text.trim().split('\n');
  assert.ok(packages.length > 100 && packages.every(p => p && !/\s/.test(p)), 'Incomplete compiled package inventory');
  const info = metadata['build-info.txt'].text;
  assert.match(info.split('\n')[0], /go1\.27\.1$/);
  const openpgp = packages.filter(p => p === 'golang.org/x/crypto/openpgp' || p.startsWith('golang.org/x/crypto/openpgp/'));
  assert.deepEqual(openpgp, [], 'Deprecated OpenPGP package is compiled into this artifact');
  const result = { path: expected.path, binarySha256: binary.sha256, bytes: binary.bytes,
    metadataSha256: expected.metadata, compiledPackages: packages.length, deprecatedOpenpgpPresent: false };
  if (name === 'grype') {
    const docker = packages.filter(p => /^(github\.com\/(docker\/docker|moby\/moby)(\/v2)?)(\/|$)/.test(p));
    assert.ok(docker.includes('github.com/docker/docker/client'));
    assert.ok(docker.every(p => /^github\.com\/(docker\/docker|moby\/moby)\/(client($|\/)|api($|\/types($|\/)))/.test(p)),
      'Engine implementation package is present');
    result.dockerPackages = docker;
    result.engineImplementationPresent = false;
  }
  if (['docker-cli', 'trivy'].includes(name)) {
    assert.ok(info.includes('\tdep\tgoogle.golang.org/grpc\t' + lock.grpc.version + '\t' + lock.grpc.sum + '\n'), 'gRPC module does not match tested source');
    result.grpc = { ...lock.grpc, regressionEvidence: 'docs/audits/2026-09-20-scanner-rebuild.md',
      testRerunByThisCommand: false };
  }
  return result;
}

async function main() {
  const fs = require('node:fs'), Docker = require('dockerode');
  const url = new URL(process.env.DD_SCANNER_AUDIT_DOCKER_URL);
  assert.equal(url.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a local Docker endpoint or verified SSH forward');
  const image = process.env.DD_SCANNER_AUDIT_IMAGE;
  assert.match(image || '', /^sha256:[a-f0-9]{64}$/);
  const name = process.env.DD_SCANNER_AUDIT_CONTAINER;
  assert.match(name || '', /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
  const docker = new Docker({ host: url.hostname, port: Number(url.port || 2375), timeout: 30000 });
  const container = docker.getContainer(name), before = await container.inspect();
  assert.equal(before.Image, image); assert.equal(before.State.Running, true);
  const imageInfo = await docker.getImage(image).inspect();
  assert.equal(imageInfo.Architecture, 'amd64'); assert.equal(imageInfo.Os, 'linux');
  const artifacts = {};
  for (const [artifact, expected] of Object.entries(reviewed.artifacts)) {
    const binary = await hashArchive(await container.getArchive({ path: expected.path }), path.posix.basename(expected.path));
    const metadata = {};
    for (const suffix of Object.keys(expected.metadata)) {
      const basename = artifact + '.' + suffix;
      metadata[suffix] = await hashArchive(await container.getArchive({ path: '/usr/share/docker-dash/scanners/' + basename }), basename,
        { capture: true, limit: 2 * 1024 ** 2 });
    }
    artifacts[artifact] = assessArtifact(artifact, binary, metadata);
  }
  const after = await docker.getContainer(name).inspect();
  assert.equal(after.Id, before.Id); assert.equal(after.Image, image);
  assert.equal(after.State.StartedAt, before.State.StartedAt); assert.equal(after.State.Running, true);
  const report = { at: new Date().toISOString(), image, containerId: before.Id, platform: 'linux/amd64',
    readOnly: true, changedAdmissionRules: false, artifacts };
  if (process.env.DD_SCANNER_AUDIT_OUTPUT) fs.writeFileSync(process.env.DD_SCANNER_AUDIT_OUTPUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  // JSON is also convenient when piping the report to an independently named file.
  await pipeline(require('node:stream').Readable.from([JSON.stringify(report) + '\n']),
    new Writable({ write(chunk, _encoding, done) { process.stdout.write(chunk, done); } }));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { hashArchive, assessArtifact };
