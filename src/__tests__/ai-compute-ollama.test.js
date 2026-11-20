'use strict';

const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const driver = require('../services/ai-compute-ollama');
const catalog = require('../services/ai-compute-catalog');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function container(respond) {
  const calls = [];
  return { calls, modem: { demuxStream: (s, out) => s.pipe(out) }, exec: jest.fn(async options => {
    calls.push(options);
    const response = respond(options.Cmd);
    return { start: async () => { const stream = new PassThrough(); setImmediate(() => stream.end(response)); return stream; }, inspect: async () => ({ ExitCode: 0 }) };
  }) };
}

test('native CLI parsing ignores headers and malformed entries', () => {
  expect(driver.parseList('NAME ID SIZE\nfoo:latest abcdef123456 1GB\n<script>:x bad\n')).toEqual([{ name: 'foo:latest', digest: 'abcdef123456' }]);
});

test('legacy registry manifest is verified by its complete SHA256', async () => {
  const raw = '{"layers":[]}', revision = 'sha256:' + digest(raw);
  const c = container(() => digest(raw) + ' /models/manifest');
  expect(await driver.verifyManifest(c, '/models/manifest', revision)).toBe(true);
  expect(c.calls).toEqual([{ Cmd: ['sha256sum', '/models/manifest'], AttachStdout: true, AttachStderr: true, AttachStdin: false }]);
});

test('Ollama 0.40 provenance must preserve every source layer and configuration', async () => {
  const original = { schemaVersion: 2, config: { digest: 'sha256:config' }, layers: [{ digest: 'sha256:weights', size: 10 }] };
  const raw = JSON.stringify(original), revision = 'sha256:' + digest(raw);
  const proof = { mediaType: 'application/vnd.docker.distribution.manifest.v2+json', digest: revision, size: raw.length };
  let current = { ...original, layers: [...original.layers, proof] };
  const c = container(args => args[0] === 'sha256sum' ? (args[1] === '/manifest' ? '0'.repeat(64) : digest(raw)) : args[1] === '/manifest' ? JSON.stringify(current) : raw);
  expect(await driver.verifyManifest(c, '/manifest', revision)).toBe(true);
  current = { ...current, config: { digest: 'sha256:changed' } };
  expect(await driver.verifyManifest(c, '/manifest', revision)).toBe(false);
  current = { ...original, layers: [...original.layers, proof, proof] };
  expect(await driver.verifyManifest(c, '/manifest', revision)).toBe(false);
});

test('unrecognized provenance and checksum substitution are rejected', async () => {
  const c = container(args => args[0] === 'sha256sum' ? '0'.repeat(64) : JSON.stringify({ layers: [] }));
  expect(await driver.verifyManifest(c, '/manifest', 'sha256:' + '1'.repeat(64))).toBe(false);
});

test('inference uses a read-only model cache, unprivileged user and loopback publication', () => {
  const recipe = catalog.entries.find(e => e.id === 'ollama-nomic-embed-text');
  const options = driver.createOptions(recipe, { target: { name: 'test', memoryBytes: 3 * catalog.GiB }, contextLength: 2048, port: 18000 }, 'sha256:image', 'job');
  expect(options.User).toBe('1000:1000');
  expect(options.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: driver.volumeName, Target: '/models', ReadOnly: true }]);
  expect(options.HostConfig.PortBindings).toEqual({ '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: '18000' }] });
  expect(options.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] });
  expect(options.Env).toEqual(expect.arrayContaining(['OLLAMA_NO_CLOUD=1', 'OLLAMA_NOPRUNE=1', 'OLLAMA_MAX_LOADED_MODELS=1']));
});

test('embedding readiness checks a finite vector and generation readiness checks residency', async () => {
  const recipe = catalog.entries.find(e => e.id === 'ollama-nomic-embed-text');
  const c = container(args => args[1] === 'run' ? '[0.1,0.2,-0.3]' : '');
  await driver.warm(c, recipe, jest.fn());
  expect(c.calls.at(-1).Cmd).toEqual(['ollama', 'run', recipe.alias, 'Docker Dash readiness check', '--keepalive=-1m']);
  const bad = container(args => args[1] === 'run' ? '{"error":"not a vector"}' : '');
  await expect(driver.warm(bad, recipe, jest.fn())).rejects.toThrow('valid vector');
  c.inspect = async () => ({ Config: { Labels: { 'docker-dash.ai-compute.alias': recipe.alias } } });
  expect((await driver.probe(c)).ready).toBe(false);
});

test('reading cache state never creates or starts infrastructure', async () => {
  const inspect = jest.fn().mockRejectedValue(Object.assign(new Error('Missing'), { statusCode: 404 }));
  const client = { getContainer: () => ({ inspect }), createContainer: jest.fn() };
  expect(await driver.states(client)).toEqual([]);
  expect(client.createContainer).not.toHaveBeenCalled();
});

test('cached aliases are verified through the v2 canonical path before reuse', async () => {
  const recipe = catalog.entries.find(e => e.id === 'ollama-nomic-embed-text');
  const c = container(args => args[0] === 'sha256sum' ? recipe.revision.slice(7) : recipe.alias + ' ' + recipe.revision.slice(7,19));
  c.inspect = async () => ({ Image: 'image', State: { Running: true }, Config: { Labels: { 'docker-dash.ai-compute.role': 'cache' } }, HostConfig: {}, Mounts: [{ Name: driver.volumeName, Destination: '/models' }] });
  await driver.download({ getContainer: () => c }, recipe, 'image', jest.fn(), jest.fn());
  expect(c.calls.some(c => c.Cmd[1] === '/models/manifests-v2/ollama.com/library/' + recipe.alias.replace(':','/'))).toBe(true);
  expect(c.calls.some(c => c.Cmd[1] === 'pull')).toBe(false);
});
