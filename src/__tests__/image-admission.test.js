'use strict';

jest.mock('node:child_process', () => ({ execFile: Object.assign(jest.fn(), {
  [require('node:util').promisify.custom]: jest.fn(),
}) }));

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { scanImage, assessReport, assessGrypeReport } = require('../services/image-admission');
const tar = require('tar-stream');
const { createHash } = require('node:crypto');
const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', rootfs: { type: 'layers', diff_ids: [] }, config: {} }));
const digest = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const imageId = digest(config);
const inspect = (id = imageId) => async () => ({ Id: id, Os: 'linux', Architecture: 'amd64' });
function archive(blobs = [[imageId, config]]) {
  const pack = tar.pack();
  for (const [id, data] of blobs) pack.entry({ name: `blobs/sha256/${id.slice(7)}`, type: 'file' }, data);
  pack.finalize();
  return pack;
}
const report = (vulnerabilities = []) => ({ SchemaVersion: 2, ArtifactType: 'container_image',
  Metadata: { ImageID: imageId }, Results: [{ Class: 'os-pkgs', Type: 'alpine', Vulnerabilities: vulnerabilities }] });
const grypeReport = (severity) => ({
  matches: severity ? [{ vulnerability: { id: 'test-advisory', severity }, artifact: { name: 'test-package' } }] : [],
  source: { type: 'image', target: { imageID: imageId } },
  descriptor: { name: 'grype', configuration: { 'only-fixed': false, 'only-notfixed': false,
    'ignore-wontfix': '', ignore: [], exclude: [], 'vex-documents': [] },
  db: { status: { valid: true, schemaVersion: 'v6.1.9', built: new Date().toISOString() } } },
});
const scannerPair = trivy => ({ trivy, grype: jest.fn(async () => JSON.stringify(grypeReport())) });
const docker = content => ({ getImage: jest.fn(() => ({ inspect: inspect(), get: async () => content === undefined ? archive() : Readable.from([content]) })) });

test('CLI admission excludes inherited filters and uses the same private archive without registry fallback', async () => {
  const exec = require('node:child_process').execFile[require('node:util').promisify.custom];
  const inherited = { TRIVY_SEVERITY: 'LOW', GRYPE_ONLY_FIXED: 'true', SYFT_EXCLUDE: '**',
    GrYpE_ExClUdE: '**', TrIvY_Ignorefile: '/malicious/ignore' };
  const original = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  const inputs = [];
  exec.mockImplementation(async (command, args, options) => {
    expect(options.shell).toBeUndefined();
    expect(options.timeout).toBe(180000);
    expect(options.maxBuffer).toBe(16 * 1024 ** 2);
    expect(options.signal.aborted).toBe(false);
    expect(typeof options.signal.addEventListener).toBe('function');
    const filename = command === 'trivy' ? args[args.indexOf('--input') + 1] : args[0];
    inputs.push(filename);
    expect(fs.existsSync(filename)).toBe(true);
    expect(args[args.indexOf('--platform') + 1]).toBe('linux/amd64');
    const configuration = args[args.indexOf('--config') + 1];
    expect(path.dirname(configuration)).toBe(path.dirname(filename));
    if (command === 'trivy') {
      expect(Object.keys(options.env).some(key => /^TRIVY_/i.test(key))).toBe(false);
      expect(fs.readFileSync(configuration, 'utf8').trim()).toBe('{}');
      expect(fs.readFileSync(args[args.indexOf('--ignorefile') + 1], 'utf8')).toBe('');
      expect(args).toEqual(expect.arrayContaining(['--scanners', 'vuln', '--format', 'json']));
      return { stdout: JSON.stringify(report()) };
    }
    expect(command).toBe('grype');
    expect(Object.keys(options.env).some(key => /^(GRYPE|SYFT)_/i.test(key))).toBe(false);
    expect(options.cwd).toBe(path.dirname(filename));
    expect(args.filter((_, index) => args[index - 1] === '--from')).toEqual(['docker-archive', 'oci-archive']);
    expect(JSON.parse(fs.readFileSync(configuration, 'utf8'))).toMatchObject({
      'only-fixed': false, 'only-notfixed': false, ignore: [], exclude: [],
      'vex-documents': [], 'vex-add': [], 'match-upstream-kernel-headers': true,
      db: { 'auto-update': true, 'validate-age': true, 'max-allowed-built-age': '120h' },
    });
    return { stdout: JSON.stringify(grypeReport()) };
  });
  try {
    expect(await scanImage(docker(), imageId)).toMatchObject({ passed: true, status: 'passed' });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toBe(inputs[1]);
    expect(fs.existsSync(path.dirname(inputs[0]))).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    exec.mockReset();
  }
});

test.each(['trivy', 'grype'])('CLI timeout or failure in %s remains unavailable despite valid stdout', async failed => {
  const exec = require('node:child_process').execFile[require('node:util').promisify.custom];
  exec.mockImplementation(async command => {
    const stdout = JSON.stringify(command === 'trivy' ? report() : grypeReport());
    if (command === failed) throw Object.assign(new Error('private token'), { killed: true, stdout });
    return { stdout };
  });
  try {
    const result = await scanImage(docker(), imageId);
    expect(result).toMatchObject({ passed: false, status: 'unavailable' });
    expect(result.checks.find(check => check.scanner === failed).status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private token');
    expect(exec).toHaveBeenCalledTimes(2);
  } finally { exec.mockReset(); }
});

test.each(['Critical', 'High', 'Unknown'])('Grype %s blocks when Trivy reports no findings', async severity => {
  const scans = scannerPair(jest.fn(async () => JSON.stringify(report())));
  scans.grype.mockResolvedValue(JSON.stringify(grypeReport(severity)));
  const result = await scanImage(docker(), imageId, { scanners: scans });
  expect(result).toMatchObject({ passed: false, status: 'blocked', scanner: 'trivy+grype', [severity.toLowerCase()]: 1 });
  expect(result.checks).toEqual([expect.objectContaining({ scanner: 'trivy', passed: true }),
    expect.objectContaining({ scanner: 'grype', passed: false })]);
  expect(scans.grype.mock.calls[0]).toEqual(scans.trivy.mock.calls[0]);
});

test('Trivy blocks even when Grype reports no findings', async () => {
  const scans = scannerPair(async () => JSON.stringify(report([{ VulnerabilityID: 'trivy-only', Severity: 'HIGH' }])));
  expect(await scanImage(docker(), imageId, { scanners: scans })).toMatchObject({ passed: false, high: 1, status: 'blocked' });
  expect(scans.grype).toHaveBeenCalledTimes(1);
});

test.each(['trivy', 'grype'])('failure of %s cannot be replaced by a successful second engine', async name => {
  const scans = scannerPair(async () => JSON.stringify(report()));
  scans[name] = jest.fn(async () => { throw new Error('secret database credential'); });
  const result = await scanImage(docker(), imageId, { scanners: scans });
  expect(result).toMatchObject({ passed: false, status: 'unavailable' });
  expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ scanner: name, status: 'unavailable' })]));
  expect(JSON.stringify(result)).not.toContain('credential');
});

test.each(['trivy', 'grype'])('requires %s before exporting an image', async name => {
  const scans = scannerPair(async () => JSON.stringify(report()));
  delete scans[name];
  const client = docker();
  expect(await scanImage(client, imageId, { scanners: scans })).toMatchObject({ passed: false, status: 'unavailable' });
  expect(client.getImage).not.toHaveBeenCalled();
});

test.each(['Medium', 'Low', 'Negligible'])('valid Grype %s findings remain visible', severity => {
  expect(assessGrypeReport(JSON.stringify(grypeReport(severity)), imageId))
    .toMatchObject({ passed: true, [severity.toLowerCase()]: 1 });
});

test.each([
  ['wrong image', r => { r.source.target.imageID = `sha256:${'b'.repeat(64)}`; }],
  ['wrong source', r => { r.source.type = 'directory'; }],
  ['wrong engine', r => { r.descriptor.name = 'syft'; }],
  ['invalid database', r => { r.descriptor.db.status.valid = false; }],
  ['missing database', r => { delete r.descriptor.db; }],
  ['unsupported database', r => { r.descriptor.db.status.schemaVersion = 'v7.0.0'; }],
  ['stale database', r => { r.descriptor.db.status.built = new Date(Date.now() - 121 * 3600000).toISOString(); }],
  ['future database', r => { r.descriptor.db.status.built = new Date(Date.now() + 3600000).toISOString(); }],
  ['invalid database date', r => { r.descriptor.db.status.built = 'invalid'; }],
  ['only fixed', r => { r.descriptor.configuration['only-fixed'] = true; }],
  ['only unfixed', r => { r.descriptor.configuration['only-notfixed'] = true; }],
  ['ignore state', r => { r.descriptor.configuration['ignore-wontfix'] = 'unknown'; }],
  ['ignore rules', r => { r.descriptor.configuration.ignore = [{}]; }],
  ['excluded paths', r => { r.descriptor.configuration.exclude = ['**']; }],
  ['vex', r => { r.descriptor.configuration['vex-documents'] = ['a.vex']; }],
  ['ignored matches', r => { r.ignoredMatches = [{}]; }],
  ['missing matches', r => { delete r.matches; }],
  ['malformed finding', r => { r.matches = [null]; }],
  ['invalid severity', r => { r.matches = [{ vulnerability: { id: 'test', severity: 'surprise' }, artifact: { name: 'pkg' } }]; }],
])('rejects Grype evidence with %s', (_name, corrupt) => {
  const evidence = grypeReport(); corrupt(evidence);
  expect(() => assessGrypeReport(JSON.stringify(evidence), imageId)).toThrow();
});

test.each(['CRITICAL', 'HIGH', 'UNKNOWN'])('%s findings block admission', severity => {
  expect(assessReport(JSON.stringify(report([{ VulnerabilityID: 'test-advisory', Severity: severity }])), imageId))
    .toMatchObject({ passed: false, status: 'blocked', [severity.toLowerCase()]: 1 });
});

test('lower severity findings remain visible when admission passes', () => {
  expect(assessReport(JSON.stringify(report([{ VulnerabilityID: 'test-advisory', Severity: 'MEDIUM' }])), imageId))
    .toMatchObject({ passed: true, medium: 1, imageId });
});

test.each(['', '{}', '[]', JSON.stringify({ ...report(), Results: [] }),
  JSON.stringify({ ...report(), Metadata: { ImageID: `sha256:${'b'.repeat(64)}` } }),
  JSON.stringify(report([{ VulnerabilityID: 'test', Severity: 'invalid' }])),
  JSON.stringify(report([null])), JSON.stringify({ ...report(), Results: [{ Class: 'unsupported' }] }),
])('rejects incomplete, mismatched or malformed scan evidence: %s', text => {
  expect(() => assessReport(text, imageId)).toThrow();
});

test('exports the immutable image from the supplied Docker client and deletes the private archive', async () => {
  const client = docker();
  let archivePath;
  const result = await scanImage(client, imageId, { scanners: scannerPair(async file => {
    archivePath = file;
    expect(fs.statSync(file).size).toBeGreaterThan(config.length);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    return JSON.stringify(report());
  }) });
  expect(result.passed).toBe(true);
  expect(client.getImage).toHaveBeenCalledWith(imageId);
  expect(fs.existsSync(path.dirname(archivePath))).toBe(false);
});

test.each(['failure', 'malformed'])('scanner %s denies admission and cleans the archive', async failure => {
  let directory;
  const result = await scanImage(docker(), imageId, { scanners: scannerPair(async (file, dir) => {
    directory = dir;
    if (failure === 'failure') throw new Error('internal scanner error containing credentials');
    return 'not json';
  }) });
  expect(result).toMatchObject({ passed: false, status: 'unavailable' });
  expect(JSON.stringify(result)).not.toContain('credentials');
  expect(fs.existsSync(directory)).toBe(false);
});

test.each(['', 'oversized archive'])('an empty or oversized export never invokes the scanner', async content => {
  const scanner = jest.fn();
  const result = await scanImage(docker(content), imageId, { maxImageBytes: 3, scanners: scannerPair(scanner) });
  expect(result.passed).toBe(false);
  expect(scanner).not.toHaveBeenCalled();
});

test('an export that sends no headers times out and its late stream is destroyed', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let exportStarted;
  const started = new Promise(resolve => { exportStarted = resolve; });
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    const scanner = jest.fn();
    const scanning = scanImage({ getImage: () => ({ inspect: inspect(), get: () => {
      exportStarted();
      return pending;
    } }) }, imageId, { timeoutMs: 10, scanners: scannerPair(scanner) });
    // Begin the deadline assertion after async filesystem preparation. A real
    // 10ms clock can expire before get() under parallel worker load.
    await started;
    await jest.advanceTimersByTimeAsync(11);
    expect((await scanning).passed).toBe(false);
    const stream = Readable.from(['late archive']);
    finish(stream);
    await new Promise(resolve => setImmediate(resolve));
    expect(stream.destroyed).toBe(true);
    expect(scanner).not.toHaveBeenCalled();
  } finally {
    finish();
    jest.useRealTimers();
  }
});

const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: imageId } }));
const manifestId = digest(manifest);
const index = entries => Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: entries }));
const descriptor = { digest: manifestId, platform: { os: 'linux', architecture: 'amd64' } };

test.each(['manifest', 'index'])('binds an OCI %s digest to the scanned config and platform', async kind => {
  const root = kind === 'index' ? index([descriptor]) : manifest;
  const rootId = digest(root);
  const blobs = [[imageId, config], [manifestId, manifest]];
  if (kind === 'index') blobs.push([rootId, root]);
  const client = { getImage: () => ({ inspect: inspect(rootId), get: async () => archive(blobs) }) };
  const scanner = jest.fn(async (file, directory, signal, platform) => {
    expect(platform).toBe('linux/amd64');
    return JSON.stringify(report());
  });
  expect(await scanImage(client, rootId, { scanners: scannerPair(scanner) })).toMatchObject({ passed: true, imageId: rootId });
  expect(scanner).toHaveBeenCalledTimes(1);
});

test.each(['tampered', 'missing', 'duplicate', 'ambiguous', 'wrong-platform'])('rejects %s OCI metadata before scanning', async kind => {
  const root = kind === 'ambiguous' ? index([descriptor, descriptor]) : manifest;
  const rootId = digest(root);
  const blobs = [[rootId, root], [imageId, config]];
  if (kind === 'tampered') blobs[1][1] = Buffer.from(config.toString().replace('amd64', 'arm64'));
  if (kind === 'missing') blobs.pop();
  if (kind === 'duplicate') blobs.push([imageId, config]);
  if (kind === 'ambiguous') blobs.push([manifestId, manifest]);
  const selected = { Id: rootId, Os: 'linux', Architecture: kind === 'wrong-platform' ? 'arm64' : 'amd64' };
  const scanner = jest.fn();
  const client = { getImage: () => ({ inspect: async () => selected, get: async () => archive(blobs) }) };
  expect(await scanImage(client, rootId, { scanners: scannerPair(scanner) })).toMatchObject({ passed: false, status: 'unavailable' });
  expect(scanner).not.toHaveBeenCalled();
});
