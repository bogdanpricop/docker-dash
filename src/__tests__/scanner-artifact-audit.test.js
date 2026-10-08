'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const tar = require('tar-stream');
const { hashArchive, assessArtifact } = require('../../scripts/verify-scanner-artifacts');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function archive(entries) {
  const pack = tar.pack();
  for (const entry of entries) pack.entry(entry.header, entry.body || '');
  pack.finalize(); return pack;
}
function fixture(name = 'grype', extra = [], info = 'scanner: go1.27.1\n') {
  const texts = {
    'packages.txt': [...Array.from({ length: 101 }, (_, i) => 'example.org/pkg/p' + i),
      'github.com/docker/docker/client', 'github.com/docker/docker/api/types',
      'github.com/moby/moby/client/internal', 'github.com/moby/moby/api/types/container',
      'github.com/ProtonMail/go-crypto/openpgp', ...extra].join('\n') + '\n',
    'build-info.txt': info, 'source.json': '{"reviewed":true}\n',
  };
  const metadata = Object.fromEntries(Object.entries(texts).map(([k, text]) => [k, { text, sha256: sha(text) }]));
  const binary = { sha256: sha('binary'), bytes: 6 };
  const lock = { artifacts: { [name]: { path: '/scanner', binarySha256: binary.sha256,
    metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, v.sha256])) } },
  grpc: { version: 'v1.84.0', sum: 'h1:tested' } };
  return { binary, metadata, lock };
}
function assess(name, f) { return assessArtifact(name, f.binary, f.metadata, f.lock); }

describe('installed scanner archive evidence', () => {
  test('hashes exact bytes and captures metadata only on request', async () => {
    const bytes = Buffer.from([0, 255, 128, 42]);
    expect(await hashArchive(archive([{ header: { name: 'scanner' }, body: bytes }]), 'scanner'))
      .toEqual({ sha256: sha(bytes), bytes: 4 });
    expect(await hashArchive(archive([{ header: { name: 'scanner' }, body: 'proof\n' }]), 'scanner', { capture: true }))
      .toEqual({ sha256: sha('proof\n'), bytes: 6, text: 'proof\n' });
  });
  test.each([
    ['unexpected path', [{ header: { name: '../scanner' }, body: 'x' }], {}],
    ['symlink', [{ header: { name: 'scanner', type: 'symlink', linkname: '/elsewhere' } }], {}],
    ['directory', [{ header: { name: 'scanner', type: 'directory' } }], {}],
    ['oversized', [{ header: { name: 'scanner' }, body: '123' }], { limit: 2 }],
    ['duplicates', [{ header: { name: 'scanner' }, body: 'x' }, { header: { name: 'scanner' }, body: 'y' }], {}],
    ['empty', [], {}],
  ])('rejects %s', async (_label, entries, options) => {
    await expect(hashArchive(archive(entries), 'scanner', options)).rejects.toThrow();
  });
  test('rejects a truncated transport', async () => {
    const chunks = [];
    for await (const c of archive([{ header: { name: 'scanner' }, body: 'proof' }])) chunks.push(c);
    await expect(hashArchive(Readable.from([Buffer.concat(chunks).subarray(0, 514)]), 'scanner')).rejects.toThrow();
  });
});

describe('artifact-specific provenance review', () => {
  test('allows API/client packages and distinguishes ProtonMail OpenPGP', () => {
    const result = assess('grype', fixture());
    expect(result.engineImplementationPresent).toBe(false);
    expect(result.deprecatedOpenpgpPresent).toBe(false);
    expect(result.dockerPackages).toContain('github.com/moby/moby/client/internal');
  });
  test('rejects changed binary even when metadata remains valid', () => {
    const f = fixture(); f.binary.sha256 = sha('other');
    expect(() => assess('grype', f)).toThrow('Installed binary differs');
  });
  test('rejects changed provenance', () => {
    const f = fixture(); f.metadata['source.json'] = { text: '{}', sha256: sha('{}') };
    expect(() => assess('grype', f)).toThrow('Build provenance differs');
  });
  test('rejects metadata content inconsistent with declared digest', () => {
    const f = fixture(); f.metadata['packages.txt'].text += 'evil/package\n';
    expect(() => assess('grype', f)).toThrow('Metadata content/hash mismatch');
  });
  test.each(['github.com/docker/docker/daemon', 'github.com/docker/docker/api/server/router',
    'github.com/moby/moby/v2/daemon', 'github.com/moby/moby/plugin', 'github.com/docker/docker/clientevil'])
  ('rejects implementation package %s even in newly reviewed metadata', pkg => {
    expect(() => assess('grype', fixture('grype', [pkg]))).toThrow('Engine implementation package');
  });
  test.each(['golang.org/x/crypto/openpgp', 'golang.org/x/crypto/openpgp/packet'])
  ('rejects deprecated package %s', pkg => {
    expect(() => assess('grype', fixture('grype', [pkg]))).toThrow('Deprecated OpenPGP');
  });
  test('rejects an unknown artifact', () => {
    expect(() => assess('unknown', fixture())).toThrow('Artifact was not reviewed');
  });
  test('rejects a different Go compiler', () => {
    expect(() => assess('grype', fixture('grype', [], 'scanner: go1.26.8\n'))).toThrow();
  });
  test('requires the tested gRPC version and checksum together', () => {
    const info = 'scanner: go1.27.1\n\tdep\tgoogle.golang.org/grpc\tv1.84.0\th1:tested\n';
    expect(assess('trivy', fixture('trivy', [], info)).grpc.testRerunByThisCommand).toBe(false);
    expect(() => assess('trivy', fixture('trivy', [], info.replace('h1:tested', 'h1:other')))).toThrow('gRPC module');
    expect(() => assess('docker-cli', fixture('docker-cli', [], info.replace('v1.84.0', 'v1.83.1')))).toThrow('gRPC module');
  });
});
