'use strict';

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';
jest.mock('../services/docker', () => ({ getDocker: jest.fn(), pullImage: jest.fn() }));
jest.mock('../services/ai-compute-metrics', () => ({ sample: jest.fn() }));
jest.mock('../services/provider-operations/policy', () => ({ assertAllowed: jest.fn() }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/ai-compute-ollama', () => ({ ...jest.requireActual('../services/ai-compute-ollama'), states: jest.fn(), download: jest.fn(), warm: jest.fn(), probe: jest.fn() }));
jest.mock('../services/ai-compute-photon', () => ({ ...jest.requireActual('../services/ai-compute-photon'), state: jest.fn() }));
jest.mock('../services/ai-compute-runtime', () => ({ ...jest.requireActual('../services/ai-compute-runtime'), find: jest.fn(), ensure: jest.fn() }));
const { getDb, closeDb } = require('../db');
const docker = require('../services/docker');
const metrics = require('../services/ai-compute-metrics');
const policy = require('../services/provider-operations/policy');
const service = require('../services/ai-compute');
const ollama = require('../services/ai-compute-ollama');
const catalog = require('../services/ai-compute-catalog');
const secureRuntime = require('../services/ai-compute-runtime');
const { PassThrough } = require('stream');
const GiB = 1024 ** 3;
let db, user, host, otherHost, containers, calls, client;

function makeContainer(name, engine, running, memory = 24) {
  const id = name.padEnd(64, 'a');
  const state = { Id: id, Name: '/' + name, Image: 'sha256:' + name,
    Config: { Image: `${engine}:test`, Cmd: ['vllm', 'serve', 'Qwen/Qwen3-4B'], Env: ['SECRET=not-returned'], Labels: {} },
    HostConfig: { Memory: memory * GiB, RestartPolicy: { Name: 'unless-stopped' } },
    State: { Running: running, Status: running ? 'running' : 'exited' } };
  containers.set(id, state);
  return state;
}
function profile(c, exclusive = true) {
  return db.prepare('INSERT INTO ai_compute_profiles(host_id,container_id,name,engine,memory_bytes,ready_port,exclusive,created_at,restart_policy) VALUES (?,?,?,?,?,8000,?,?,?)')
    .run(host, c.Id, c.Name, service._internals.engineOf(c), c.HostConfig.Memory, Number(exclusive), new Date().toISOString(), JSON.stringify(c.HostConfig.RestartPolicy)).lastInsertRowid;
}
beforeAll(() => {
  db = getDb();
  user = { id: db.prepare("INSERT INTO users(username,password_hash,role) VALUES ('compute-test','x','admin')").run().lastInsertRowid };
  host = db.prepare("INSERT INTO docker_hosts(name,connection_type,daemon_type) VALUES ('Spark test','socket','docker')").run().lastInsertRowid;
  otherHost = db.prepare("INSERT INTO docker_hosts(name,connection_type,daemon_type) VALUES ('Other host','socket','docker')").run().lastInsertRowid;
});
afterAll(() => closeDb());
beforeEach(() => {
  jest.clearAllMocks();
  db.exec('DELETE FROM ai_compute_jobs; DELETE FROM ai_compute_profiles; DELETE FROM ai_compute_hosts;');
  db.exec('DELETE FROM ai_compute_samples;');
  containers = new Map(); calls = [];
  client = {
    info: async () => ({ Architecture: 'aarch64', MemTotal: 128 * GiB }),
    listContainers: async () => [...containers.values()].map(c => ({ Id: c.Id, Names: [c.Name], Image: c.Config.Image })),
    getContainer: id => ({
      inspect: async () => { if (!containers.has(id)) throw Object.assign(new Error('Missing'), { statusCode: 404 }); return JSON.parse(JSON.stringify(containers.get(id))); },
      update: async opts => { calls.push(['update', id, opts]); containers.get(id).HostConfig.RestartPolicy = opts.RestartPolicy; },
      stop: async opts => { if (opts.t >= 30) throw new Error('Host transport idle timeout'); calls.push(['stop', id]); containers.get(id).State.Running = false; containers.get(id).State.Status = 'exited'; },
      start: async () => { calls.push(['start', id]); containers.get(id).State.Running = true; containers.get(id).State.Status = 'running'; },
      exec: async opts => { calls.push(['exec', id, opts]); return {
        start: async () => { const stream = new PassThrough(); setImmediate(() => stream.end('AI_COMPUTE_READY\n')); return stream; },
        inspect: async () => ({ ExitCode: 0 }),
      }; },
    }),
  };
  docker.getDocker.mockReturnValue(client);
  metrics.sample.mockReset().mockResolvedValue({ sampledAt: new Date().toISOString(), memory: { totalBytes: 128 * GiB, availableBytes: 80 * GiB },
    disk: { availableBytes: 100 * GiB }, cacheDisk: { availableBytes: 100 * GiB }, gpu: { name: 'NVIDIA GB10' } });
  policy.assertAllowed.mockReset();
  ollama.states.mockResolvedValue([]);
  ollama.download.mockReset().mockResolvedValue();
  ollama.warm.mockReset().mockResolvedValue();
  secureRuntime.find.mockReset().mockResolvedValue({ Id: 'hardened', Architecture: 'arm64' });
  secureRuntime.ensure.mockReset().mockResolvedValue('hardened');
});

test('requested Ollama families have distinct immutable artifacts and explicit runtime eligibility', () => {
  const entries = catalog.entries.filter(e => e.engine === 'ollama' && !e.integrationRequired);
  expect(entries).toHaveLength(14);
  expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
  for (const e of entries) {
    expect(e.downloadable).toBe(true);
    expect(e.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(e.runtime).toMatch(/^ollama\/ollama@sha256:[a-f0-9]{64}$/);
    expect(e.downloadBytes).toBeGreaterThan(0);
    expect(e.model).not.toMatch(/mlx/i);
  }
  expect(entries.find(e => e.id === 'ollama-moondream').successorId).toBe('photon-moondream31');
  expect(entries.filter(e => e.deployable)).toHaveLength(13);
  expect(entries.find(e => e.id === 'ollama-llama3-2-vision')).toMatchObject({ deployable: false, reason: expect.stringContaining('mllama') });
});

test('model download is CPU-only and does not require a GPU or snapshot running engines', async () => {
  makeContainer('current-vllm', 'vllm', true);
  metrics.sample.mockResolvedValue({ sampledAt: new Date().toISOString(), memory: null, gpu: null, cacheDisk: { availableBytes: 1000 * GiB } });
  const op = await service.prepare(host, { action: 'download', catalogId: 'ollama-qwen3-8-flash-next' }, user);
  expect(op.plan).toMatchObject({ stop: [], snapshots: [], target: { memoryBytes: 0, exclusive: false } });
  expect(calls).toEqual([]);
  expect(op.plan.downloadBytes).toBeGreaterThan(100 * GiB);
});

test('oversized Flash GGUF stays downloadable but deploy respects the host reserve', async () => {
  metrics.sample.mockResolvedValue({ sampledAt: new Date().toISOString(), memory: { totalBytes: 121.7 * GiB, availableBytes: 121 * GiB }, gpu: { name: 'GB10' }, cacheDisk: { availableBytes: 1000 * GiB } });
  await expect(service.prepare(host, { action: 'deploy', catalogId: 'ollama-qwen3-8-flash-next', contextLength: 4096, port: 18000 }, user)).rejects.toThrow('Insufficient estimated memory');
});

test('download queue accepts different models and prevents duplicate model requests', async () => {
  const first = await service.prepare(host, { action: 'download', catalogId: 'ollama-nomic-embed-text' }, user);
  const second = await service.prepare(host, { action: 'download', catalogId: 'ollama-moondream' }, user);
  const duplicate = await service.prepare(host, { action: 'download', catalogId: 'ollama-nomic-embed-text' }, user);
  service.execute(host, first.id, user); service.execute(host, second.id, user);
  expect(() => service.execute(host, duplicate.id, user)).toThrow('already queued');
  expect(service.jobs(host).filter(j => j.status === 'queued')).toHaveLength(2);
});

test('long-running download does not block a confirmed stop on the same host', async () => {
  const target = makeContainer('current-vllm', 'vllm', true), profileId = profile(target);
  const op = await service.prepare(host, { action: 'download', catalogId: 'ollama-nomic-embed-text' }, user);
  client.getImage = () => ({ inspect: async () => ({ Id: 'image', Architecture: 'arm64' }) });
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  ollama.download.mockImplementation(async (_client,_recipe,_image,check,progress) => { check(); progress('42%'); started(); await new Promise(resolve => { finish = resolve; }); });
  service.execute(host, op.id, user);
  const active = service.downloadTick();
  await ready;
  try {
    expect(service.getJob(host, op.id)).toMatchObject({ status: 'running', progress: { message: '42%' } });
    const stop = await service.prepare(host, { action: 'stop', profileId }, user);
    service.execute(host, stop.id, user); await service.tick();
    expect(service.getJob(host, stop.id).status).toBe('completed');
    expect(target.State.Running).toBe(false);
  } finally { finish(); await active; }
  expect(service.getJob(host, op.id).status).toBe('completed');
  expect(calls.filter(c => c[0] === 'stop')).toHaveLength(1);
});

test('catalog drift rejects an already reviewed download before pulling or mutating engines', async () => {
  const op = await service.prepare(host, { action: 'download', catalogId: 'ollama-nomic-embed-text' }, user);
  const plan = { ...op.plan, recipeRevision: 'sha256:' + '0'.repeat(64) };
  db.prepare('UPDATE ai_compute_jobs SET plan_json=? WHERE id=?').run(JSON.stringify(plan), op.id);
  service.execute(host, op.id, user); await service.downloadTick();
  expect(service.getJob(host, op.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('catalog recipe changed') });
  expect(docker.pullImage).not.toHaveBeenCalled(); expect(ollama.download).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

test('Moondream 3.1 remains download-only after the GPU kernel qualification failure', async () => {
  await expect(service.prepare(host, { action: 'deploy', catalogId: 'photon-moondream31', contextLength: 4096, port: 18000 }, user)).rejects.toThrow('Select a standard recipe');
  const op = await service.prepare(host, { action: 'download', catalogId: 'photon-moondream31' }, user);
  expect(op.plan).toMatchObject({ recipeId: 'photon-moondream31', stop: [], target: { memoryBytes: 0 } });
});

test('the incompatible upstream mllama artifact cannot be deployed but can still be downloaded', async () => {
  await expect(service.prepare(host, { action: 'deploy', catalogId: 'ollama-llama3-2-vision', contextLength: 4096, port: 18000 }, user)).rejects.toThrow('Select a standard recipe');
  expect((await service.prepare(host, { action: 'download', catalogId: 'ollama-llama3-2-vision' }, user)).plan.stop).toEqual([]);
});

test('catalog cache status does not claim verification for a mislabeled alias', async () => {
  client.getImage = () => ({ inspect: async () => ({}) });
  const entry = catalog.entries.find(e => e.id === 'ollama-nomic-embed-text');
  ollama.states.mockResolvedValue([{ name: entry.alias, digest: '0'.repeat(12) }]);
  expect((await service.catalogForHost(host)).find(e => e.id === entry.id).cacheState).toBe('not_downloaded');
  ollama.states.mockResolvedValue([{ name: entry.alias, digest: entry.revision.slice(7,19) }]);
  expect((await service.catalogForHost(host)).find(e => e.id === entry.id).cacheState).toBe('downloaded');
});

test('an offline host still exposes reviewed catalog metadata without cache side effects', async () => {
  docker.getDocker.mockImplementationOnce(() => { throw new Error('SSH connection not ready'); });
  const result = await service.catalogForHost(host);
  expect(result.find(e => e.id === 'ollama-nomic-embed-text')).toMatchObject({ cacheState: 'unavailable', cacheError: 'SSH connection not ready', downloadable: true });
  expect(ollama.states).not.toHaveBeenCalled();
});

test('the first security runtime build requires a real CPU memory budget', async () => {
  secureRuntime.find.mockResolvedValue(null);
  metrics.sample.mockResolvedValue({ sampledAt: new Date().toISOString(), memory: { availableBytes: 4 * GiB }, gpu: null, cacheDisk: { availableBytes: 100 * GiB } });
  await expect(service.prepare(host, { action: 'download', catalogId: 'ollama-nomic-embed-text' }, user)).rejects.toThrow('8 GiB');
  expect(secureRuntime.ensure).not.toHaveBeenCalled(); expect(calls).toEqual([]);
});

test('large model cache space cannot hide a full Docker runtime build filesystem', async () => {
  secureRuntime.find.mockResolvedValue(null);
  metrics.sample.mockResolvedValue({ sampledAt: new Date().toISOString(), memory: { availableBytes: 80 * GiB }, gpu: null,
    cacheDisk: { availableBytes: 1000 * GiB }, runtimeDisk: { availableBytes: GiB } });
  await expect(service.prepare(host, { action: 'download', catalogId: 'ollama-nomic-embed-text' }, user)).rejects.toThrow('Docker runtime filesystem');
  expect(secureRuntime.ensure).not.toHaveBeenCalled();
});

test('a stale security build recipe is rejected before pulling or modifying services', async () => {
  const op = await service.prepare(host, { action: 'download', catalogId: 'ollama-nomic-embed-text' }, user);
  db.prepare('UPDATE ai_compute_jobs SET plan_json=? WHERE id=?').run(JSON.stringify({ ...op.plan, runtimeRecipe: 'changed' }), op.id);
  service.execute(host, op.id, user); await service.downloadTick();
  expect(service.getJob(host, op.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('security runtime recipe changed') });
  expect(docker.pullImage).not.toHaveBeenCalled(); expect(calls).toEqual([]);
});

test('legacy managed runtimes can be stopped but cannot silently restart without the security update', async () => {
  const c = makeContainer('legacy-managed-ollama','ollama',true);c.Config.Labels['docker-dash.ai-compute.catalog']='ollama-nomic-embed-text';
  const id=profile(c,false); client.getImage=()=>({inspect:async()=>({Config:{Labels:{}}})});
  await expect(service.prepare(host,{action:'restart',profileId:id},user)).rejects.toThrow('predates the current security runtime');
  expect((await service.prepare(host,{action:'stop',profileId:id},user)).plan.target.id).toBe(c.Id);
  expect(calls).toEqual([]);
});

test('a cache container is excluded even when its name contains an engine', async () => {
  const c = makeContainer('ollama-cache', 'ollama', true);
  c.Config.Labels['docker-dash.ai-compute.role'] = 'cache';
  expect(service._internals.engineOf(c)).toBeNull();
});

test('inventory recognizes engines but excludes speech gateway and tunnel infrastructure', async () => {
  makeContainer('foliantstudio-vllm', 'vllm', true);
  makeContainer('dgx-speech-engine', 'speech', true);
  makeContainer('dgx-speech-api', 'speech', true);
  makeContainer('dgx-vllm-gateway', 'vllm', true);
  makeContainer('dgx-vllm-tunnel', 'vllm', true);
  const result = await service.inventory(host);
  expect(result.containers.map(c => c.engine)).toEqual(['vllm', 'speech']);
  expect(JSON.stringify(result)).not.toContain('not-returned');
});

test('host discovery prioritizes configured AI devices without connecting or disclosing credentials', () => {
  db.prepare('INSERT INTO ai_compute_hosts(host_id,monitoring,updated_at) VALUES (?,1,?)').run(host,new Date().toISOString());
  db.prepare('UPDATE docker_hosts SET ssh_config=? WHERE id=?').run('private-credential-must-not-leak',host);
  const result=service.hosts();
  expect(result[0]).toMatchObject({ id: host, recommended: true, reason: 'Recording enabled', sshConfigured: true });
  expect(JSON.stringify(result)).not.toContain('private-credential');
  expect(docker.getDocker).not.toHaveBeenCalled();
  db.prepare('UPDATE docker_hosts SET ssh_config=? WHERE id=?').run('{}',host);
  expect(service.hosts().find(h=>h.id===host).sshConfigured).toBe(false);
  db.prepare('UPDATE docker_hosts SET ssh_config=NULL WHERE id=?').run(host);
});

test('profiles are host-scoped and validate memory, ports and speech exclusion', async () => {
  const c = makeContainer('speech-engine', 'speech', true);
  await expect(service.register(host, { containerId: c.Id, name: 'Speech', memoryGiB: 10, exclusive: true }, user)).rejects.toThrow('Speech');
  await expect(service.register(host, { containerId: c.Id, name: 'Speech', memoryGiB: 'NaN', exclusive: false }, user)).rejects.toThrow('memory');
  await service.register(host, { containerId: c.Id, name: 'Speech', memoryGiB: 10, exclusive: false, readyPort: null }, user);
  expect((await service.inventory(host)).containers[0].profileName).toBe('Speech');
  expect((await service.inventory(otherHost)).profiles).toHaveLength(0);
});

test('a normal start cannot silently stop a running LLM', async () => {
  makeContainer('current-vllm', 'vllm', true);
  const target = profile(makeContainer('next-vllm', 'vllm', false));
  await expect(service.prepare(host, { action: 'start', profileId: target }, user)).rejects.toThrow('Another LLM');
  expect(calls).toEqual([]);
});

test('reviewed stop unloads only its service without needing GPU metrics and retains restart policy for start', async () => {
  const target = makeContainer('current-vllm', 'vllm', true);
  const speech = makeContainer('dgx-speech-engine', 'speech', true);
  await service.register(host, { containerId: target.Id, name: 'Qwen', memoryGiB: 24, readyPort: 8000, exclusive: true }, user);
  const id = (await service.inventory(host)).containers.find(c => c.id === target.Id).profileId;
  metrics.sample.mockResolvedValue({ sampledAt: new Date().toISOString(), memory: null, gpu: null });
  const op = await service.prepare(host, { action: 'stop', profileId: id }, user);
  expect(calls).toEqual([]);
  service.execute(host, op.id, user); await service.tick();
  expect(service.getJob(host, op.id).status).toBe('completed');
  expect(target.State.Running).toBe(false); expect(speech.State.Running).toBe(true);
  expect(target.HostConfig.RestartPolicy.Name).toBe('no');
  expect(service.getJob(host, op.id).stopped[0].restartPolicy.Name).toBe('unless-stopped');
  metrics.sample.mockResolvedValue({ sampledAt: new Date().toISOString(), memory: { availableBytes: 80 * GiB }, gpu: { name: 'NVIDIA GB10' } });
  const start = await service.prepare(host, { action: 'start', profileId: id }, user);
  service.execute(host, start.id, user); await service.tick();
  expect(service.getJob(host, start.id).status).toBe('completed');
  expect(target.State.Running).toBe(true);
  expect(target.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
});

test('switch preview lists exact LLM conflicts, preserving speech and leaving containers untouched', async () => {
  const old = makeContainer('current-vllm', 'vllm', true);
  makeContainer('dgx-speech-engine', 'speech', true);
  const target = profile(makeContainer('next-vllm', 'vllm', false));
  const operation = await service.prepare(host, { action: 'switch', profileId: target }, user);
  expect(operation.plan.stop.map(c => c.id)).toEqual([old.Id]);
  expect(calls).toEqual([]);
});

test('missing fresh GPU/memory metrics and insufficient capacity fail closed', async () => {
  const target = profile(makeContainer('next-vllm', 'vllm', false));
  metrics.sample.mockResolvedValue({ memory: null, gpu: null });
  await expect(service.prepare(host, { action: 'start', profileId: target }, user)).rejects.toThrow('Fresh SSH');
  metrics.sample.mockResolvedValue({ memory: { availableBytes: GiB }, gpu: {} });
  await expect(service.prepare(host, { action: 'start', profileId: target }, user)).rejects.toThrow('Insufficient');
  expect(calls).toEqual([]);
});

test('plans are owner-bound, expiring and cannot be replayed', async () => {
  const target = profile(makeContainer('next-vllm', 'vllm', false));
  const op = await service.prepare(host, { action: 'start', profileId: target }, user);
  expect(() => service.execute(host, op.id, { id: 999999 })).toThrow('administrator');
  const plan = { ...op.plan, expiresAt: new Date(0).toISOString() };
  db.prepare('UPDATE ai_compute_jobs SET plan_json=? WHERE id=?').run(JSON.stringify(plan), op.id);
  expect(() => service.execute(host, op.id, user)).toThrow('expired');
  db.prepare('UPDATE ai_compute_jobs SET plan_json=? WHERE id=?').run(JSON.stringify(op.plan), op.id);
  service.execute(host, op.id, user);
  expect(() => service.execute(host, op.id, user)).toThrow('already');
});

test('per-host durable lock includes interrupted operations requiring review', async () => {
  const target = profile(makeContainer('next-vllm', 'vllm', false));
  const a = await service.prepare(host, { action: 'start', profileId: target }, user);
  const b = await service.prepare(host, { action: 'start', profileId: target }, user);
  service.execute(host, a.id, user);
  expect(() => service.execute(host, b.id, user)).toThrow('Another operation');
  db.prepare("UPDATE ai_compute_jobs SET status='needs_review' WHERE id=?").run(a.id);
  expect(() => service.execute(host, b.id, user)).toThrow('Another operation');
});

test('worker rejects a changed container configuration before mutation', async () => {
  const c = makeContainer('next-vllm', 'vllm', false), id = profile(c);
  const op = await service.prepare(host, { action: 'start', profileId: id }, user);
  service.execute(host, op.id, user);
  c.Config.Env.push('MODIFIED=1');
  await service.tick();
  expect(service.getJob(host, op.id).status).toBe('failed');
  expect(calls).toEqual([]);
});

test('successful switch saves restart policies and verifies a real-shaped API response', async () => {
  const old = makeContainer('current-vllm', 'vllm', true);
  const speech = makeContainer('dgx-speech-engine', 'speech', true);
  const next = makeContainer('next-vllm', 'vllm', false), id = profile(next);
  const op = await service.prepare(host, { action: 'switch', profileId: id }, user);
  service.execute(host, op.id, user); await service.tick();
  expect(service.getJob(host, op.id).status).toBe('completed');
  expect(old.State.Running).toBe(false); expect(next.State.Running).toBe(true); expect(speech.State.Running).toBe(true);
  expect(old.HostConfig.RestartPolicy.Name).toBe('no');
  expect(service.getJob(host, op.id).stopped[0].restartPolicy.Name).toBe('unless-stopped');
  expect(calls.some(c => c[0] === 'exec')).toBe(true);
});

test('failed post-stop memory check restores the previous engine and its restart policy', async () => {
  const old = makeContainer('current-vllm', 'vllm', true);
  const next = makeContainer('next-vllm', 'vllm', false), id = profile(next);
  const op = await service.prepare(host, { action: 'switch', profileId: id }, user);
  metrics.sample.mockRejectedValue(new Error('Host unavailable'));
  service.execute(host, op.id, user); await service.tick();
  expect(service.getJob(host, op.id).status).toBe('rolled_back');
  expect(old.State.Running).toBe(true); expect(old.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
  expect(next.State.Running).toBe(false);
});

test('revoked administrator or emergency operation policy stops queued work', async () => {
  const id = profile(makeContainer('next-vllm', 'vllm', false));
  const op = await service.prepare(host, { action: 'start', profileId: id }, user);
  service.execute(host, op.id, user);
  policy.assertAllowed.mockImplementation(() => { throw new Error('Emergency stop'); });
  await service.tick();
  expect(service.getJob(host, op.id).status).toBe('failed');
  expect(calls).toEqual([]);
});

test('readiness uses container loopback and does not equate running with ready', async () => {
  const c = makeContainer('next-vllm', 'vllm', true);
  expect((await service.readiness(host, c.Id, 8000, 'vllm')).ready).toBe(true);
  const command = calls.find(c => c[0] === 'exec')[2].Cmd;
  expect(command[0]).toBe('python3'); expect(command[2]).toContain('http://127.0.0.1:8000/v1/models');
  expect((await service.readiness(host, c.Id, null, 'speech')).ready).toBe(false);
  await expect(service.readiness(host, c.Id, -1, 'vllm')).rejects.toThrow('Invalid');
});

test('catalog rejects experimental auto-deploy and arbitrary context/ports', async () => {
  await expect(service.prepare(host, { action: 'deploy', catalogId: 'ncm-tinystories', contextLength: 4096 }, user)).rejects.toThrow('standard');
  await expect(service.prepare(host, { action: 'deploy', catalogId: 'qwen3-4b', contextLength: 4096, port: 22 }, user)).rejects.toThrow('loopback');
});

test('a newly appeared LLM invalidates a preview before any stop', async () => {
  const id = profile(makeContainer('next-vllm', 'vllm', false));
  const op = await service.prepare(host, { action: 'start', profileId: id }, user);
  makeContainer('unexpected-vllm', 'vllm', true);
  service.execute(host, op.id, user); await service.tick();
  expect(service.getJob(host, op.id).status).toBe('failed');
  expect(calls).toEqual([]);
});

test('wrong runtime architecture is rejected before touching an existing engine', async () => {
  makeContainer('current-vllm', 'vllm', true);
  client.getImage = () => ({ inspect: async () => ({ Architecture: 'amd64', Id: 'wrong-image' }) });
  const op = await service.prepare(host, { action: 'deploy', catalogId: 'qwen3-4b', contextLength: 4096, port: 18000, stopConflicts: true }, user);
  service.execute(host, op.id, user); await service.tick();
  expect(service.getJob(host, op.id).status).toBe('failed');
  expect(calls).toEqual([]);
});

test('standard deployment pins image and model revisions, restricts exposure and keeps shared cache', async () => {
  client.getImage = () => ({ inspect: async () => ({ Architecture: 'arm64', Id: 'sha256:pinned-image' }) });
  let options;
  client.createContainer = async opts => {
    options = opts;
    const c = makeContainer(opts.name, 'vllm', false);
    c.Config = { ...c.Config, ...opts, Image: opts.Image }; c.Image = opts.Image;
    return { id: c.Id };
  };
  const op = await service.prepare(host, { action: 'deploy', catalogId: 'qwen3-4b', contextLength: 4096, port: 18000 }, user);
  service.execute(host, op.id, user); await service.tick();
  expect(service.getJob(host, op.id).status).toBe('completed');
  expect(options.Image).toBe('sha256:pinned-image');
  expect(options.Cmd).toContain('--tokenizer-revision');
  expect(options.HostConfig.PortBindings['8000/tcp'][0].HostIp).toBe('127.0.0.1');
  expect(options.HostConfig.Mounts[0]).toEqual({ Type: 'volume', Source: 'docker-dash-ai-model-cache', Target: '/models' });
  expect(options.HostConfig.CapDrop).toEqual(['ALL']);
  expect(options.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
  expect(options.Cmd).not.toContain('--trust-remote-code');
});

test('interrupted work retains its host lock and rollback evidence', async () => {
  const id = profile(makeContainer('next-vllm', 'vllm', false));
  const op = await service.prepare(host, { action: 'start', profileId: id }, user);
  service.execute(host, op.id, user);
  db.prepare("UPDATE ai_compute_jobs SET status='running',updated_at=? WHERE id=?").run(new Date(0).toISOString(), op.id);
  await service.tick();
  expect(service.getJob(host, op.id).status).toBe('needs_review');
  expect(service.getJob(host, op.id).plan.snapshots).toHaveLength(1);
  await service.rollback(host, op.id, user);
  expect(service.getJob(host, op.id).status).toBe('rolled_back');
});

test('rollback restores the stopped target restart policy so a failed start cannot reappear after reboot', async () => {
  const c = makeContainer('next-vllm', 'vllm', false);
  c.HostConfig.RestartPolicy = { Name: 'no' };
  const id = profile(c), op = await service.prepare(host, { action: 'start', profileId: id }, user);
  c.State.Running = true; c.HostConfig.RestartPolicy = { Name: 'always' };
  const row = db.prepare('SELECT * FROM ai_compute_jobs WHERE id=?').get(op.id);
  await service._internals.restore(row, client);
  expect(c.State.Running).toBe(false);
  expect(c.HostConfig.RestartPolicy.Name).toBe('no');
});


test('specialist catalog entries remain informative and cannot bypass download or deploy qualification', async () => {
  const entries = catalog.entries.filter(e => e.integrationRequired);
  expect(entries).toHaveLength(14);
  const cards = await service.catalogForHost(host);
  for (const entry of entries) {
    expect(cards.find(e => e.id === entry.id)).not.toHaveProperty('cacheState');
    for (const action of ['deploy', 'download']) {
      await expect(service.prepare(host, { action, catalogId: entry.id, contextLength: 4096, port: 18000 }, user)).rejects.toThrow('Select a standard recipe');
    }
  }
  expect(service.jobs(host)).toEqual([]);
  expect(docker.pullImage).not.toHaveBeenCalled();
  expect(secureRuntime.ensure).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});
