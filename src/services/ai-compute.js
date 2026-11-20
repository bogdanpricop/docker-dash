'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const docker = require('./docker');
const metrics = require('./ai-compute-metrics');
const catalog = require('./ai-compute-catalog');
const policy = require('./provider-operations/policy');
const audit = require('./audit');
const config = require('../config');

const now = () => new Date().toISOString();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max = 120) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
const fingerprint = c => crypto.createHash('sha256').update(JSON.stringify([c.Id, c.Image, c.Config, c.HostConfig, c.State?.Running])).digest('hex');
const configurationFingerprint = c => {
  const { RestartPolicy: _restart, ...hostConfig } = c.HostConfig || {};
  return crypto.createHash('sha256').update(JSON.stringify([c.Id, c.Image, c.Config, hostConfig])).digest('hex');
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const engines = ['vllm', 'ollama', 'llama', 'strata', 'basalt', 'ncm', 'speech'];

function hosts() {
  const rows = getDb().prepare(`SELECT h.id,h.name,h.connection_type,
    CASE WHEN h.ssh_config IS NOT NULL AND h.ssh_config<>'' THEN 1 ELSE 0 END AS ssh_configured,
    COALESCE(a.monitoring,0) AS monitoring,
    EXISTS(SELECT 1 FROM ai_compute_profiles p WHERE p.host_id=h.id) AS has_profiles,
    (SELECT sample_json FROM ai_compute_samples s WHERE s.host_id=h.id ORDER BY bucket DESC LIMIT 1) AS sample
    FROM docker_hosts h LEFT JOIN ai_compute_hosts a ON a.host_id=h.id
    WHERE h.is_active=1 AND COALESCE(h.daemon_type,'docker') IN ('docker','podman')`).all();
  const candidates = rows.map(row => {
    let gpu = false;
    try { gpu = Boolean(JSON.parse(row.sample)?.gpu); } catch { /* No successful sample yet. */ }
    const rank = gpu ? 4 : row.monitoring ? 3 : row.has_profiles ? 2 : row.ssh_configured ? 1 : 0;
    return { id: row.id, name: row.name, connectionType: row.connection_type, sshConfigured: Boolean(row.ssh_configured),
      rank, reason: gpu ? 'GPU detected' : row.monitoring ? 'Recording enabled' : row.has_profiles ? 'AI profiles configured' : row.ssh_configured ? 'SSH configured' : 'Docker connection' };
  }).sort((a,b) => b.rank-a.rank || a.name.localeCompare(b.name) || a.id-b.id);
  return candidates.map(({ rank, ...host }, index) => ({ ...host, recommended: index === 0 && rank > 0 }));
}
async function stopContainer(container) {
  // Stay below the host client's 30s idle timeout, including SSH overhead.
  try { await container.stop({ t: 10 }); }
  catch (err) { if ((await container.inspect()).State.Running) throw err; }
}

function engineOf(c) {
  const hint = `${c.Name || c.Names?.[0] || ''} ${c.Config?.Image || c.Image || ''}`.toLowerCase();
  // Infrastructure and HTTP gateways are never candidates for engine switching.
  if (/gateway|tunnel|speech-api/.test(hint)) return null;
  const declared = c.Config?.Labels?.['docker-dash.ai-compute.engine'] || c.Labels?.['docker-dash.ai-compute.engine'];
  if (engines.includes(declared)) return declared;
  return engines.find(engine => hint.includes(engine === 'speech' ? 'speech-engine' : engine)) || null;
}

function describe(c, profile, totalMemory) {
  const cmd = [...(c.Config?.Entrypoint || []), ...(c.Config?.Cmd || [])];
  const arg = flag => { const at = cmd.indexOf(flag); return at >= 0 ? cmd[at + 1] : null; };
  const env = c.Config?.Env || [];
  const model = arg('--model') || (cmd.includes('serve') ? cmd[cmd.indexOf('serve') + 1] : null)
    || env.find(v => /^(MODEL_ID|VLLM_MODEL)=/.test(v))?.split('=').slice(1).join('=');
  const fraction = Number(arg('--gpu-memory-utilization'));
  const estimate = fraction > 0 && fraction <= 1 && totalMemory ? fraction * totalMemory : 0;
  const engine = engineOf(c);
  return { id: c.Id, name: text(c.Name?.replace(/^\//, '')), image: text(c.Config?.Image, 250),
    imageId: c.Image, state: c.State?.Status, health: c.State?.Health?.Status || null,
    engine, model: text(profile?.model || model) || null, profileId: profile?.id || null, profileName: profile?.name || null,
    memoryBytes: profile?.memory_bytes || Math.ceil(c.HostConfig?.Memory || estimate) || null,
    exclusive: profile ? Boolean(profile.exclusive) : ['vllm', 'ollama', 'llama', 'strata', 'basalt'].includes(engine),
    desiredRestartPolicy: profile ? JSON.parse(profile.restart_policy) : c.HostConfig?.RestartPolicy,
    readyPort: profile ? profile.ready_port : Number(arg('--port')) || ({ vllm: 8000, ollama: 11434, llama: 8080, strata: 8080 }[engine] || null) };
}

async function inventory(hostId) {
  const client = docker.getDocker(hostId);
  const [info, list] = await Promise.all([client.info(), client.listContainers({ all: true })]);
  const profiles = getDb().prepare('SELECT * FROM ai_compute_profiles WHERE host_id=?').all(hostId);
  const selected = list.filter(c => engineOf(c) || profiles.some(p => p.container_id === c.Id));
  if (selected.length > 64) fail('More than 64 AI workloads found. Narrow this host inventory first.', 409);
  const containers = [];
  for (const row of selected) {
    try { containers.push(describe(await client.getContainer(row.Id).inspect(), profiles.find(p => p.container_id === row.Id), info.MemTotal)); }
    catch (err) { if (err.statusCode !== 404) throw err; }
  }
  return { hostId, architecture: info.Architecture, containers, profiles,
    monitoring: Boolean(getDb().prepare('SELECT monitoring FROM ai_compute_hosts WHERE host_id=?').get(hostId)?.monitoring) };
}

async function register(hostId, body, user) {
  const { containers } = await inventory(hostId);
  const c = containers.find(c => c.id === body.containerId);
  if (!c) fail('Select a detected AI workload');
  const name = text(body.name).trim();
  const memory = Number(body.memoryGiB) * catalog.GiB;
  const rawPort = body.readyPort === undefined ? c.readyPort : body.readyPort;
  const readyPort = rawPort === null || rawPort === '' ? null : Number(rawPort);
  if (!name || !Number.isSafeInteger(memory) || memory < catalog.GiB || memory > 2048 * catalog.GiB
    || (readyPort !== null && (!Number.isInteger(readyPort) || readyPort < 1 || readyPort > 65535))
    || typeof body.exclusive !== 'boolean') fail('A name, memory budget (1–2048 GiB), valid port and exclusive setting are required');
  if (c.engine === 'speech' && body.exclusive) fail('Speech workloads cannot be stopped as exclusive LLM conflicts');
  getDb().prepare(`INSERT INTO ai_compute_profiles(host_id,container_id,name,engine,model,memory_bytes,ready_port,exclusive,created_by,created_at,restart_policy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(host_id,container_id) DO UPDATE SET name=excluded.name,
    memory_bytes=excluded.memory_bytes,ready_port=excluded.ready_port,exclusive=excluded.exclusive`)
    .run(hostId, c.id, name, c.engine, c.model, memory, readyPort, Number(body.exclusive), user.id, now(), JSON.stringify(c.desiredRestartPolicy || { Name: 'no' }));
  return inventory(hostId);
}

function monitoring(hostId, enabled) {
  if (typeof enabled !== 'boolean') fail('monitoring must be true or false');
  getDb().prepare('INSERT INTO ai_compute_hosts(host_id,monitoring,updated_at) VALUES (?,?,?) ON CONFLICT(host_id) DO UPDATE SET monitoring=excluded.monitoring,updated_at=excluded.updated_at')
    .run(hostId, Number(enabled), now());
  return { monitoring: enabled };
}

async function execPython(container, script) {
  const exec = await container.exec({ Cmd: ['python3', '-c', script], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => { stream.destroy(); reject(new Error('Container inspection timed out')); }, 7000);
    stream.on('data', chunk => { length += chunk.length; if (length > 16384) { stream.destroy(); clearTimeout(timer); reject(new Error('Inspection response exceeded its limit')); } else chunks.push(chunk); });
    stream.on('end', () => {
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      // Docker multiplexed stdout/stderr frames can split across transport chunks.
      if (data[0] !== 1 && data[0] !== 2) { resolve(data.toString()); return; }
      let offset = 0, result = '';
      while (offset < data.length) {
        if (offset + 8 > data.length || ![1, 2].includes(data[offset]) || data.readUIntBE(offset + 1, 3) !== 0) { reject(new Error('Invalid exec response')); return; }
        const size = data.readUInt32BE(offset + 4), channel = data[offset];
        offset += 8;
        if (offset + size > data.length) { reject(new Error('Incomplete exec response')); return; }
        if (channel === 1) result += data.subarray(offset, offset + size).toString();
        offset += size;
      }
      resolve(result);
    });
    stream.on('error', e => { clearTimeout(timer); reject(e); });
  });
  return { output, exitCode: (await exec.inspect()).ExitCode };
}

async function cache(hostId, containerId) {
  const state = await inventory(hostId);
  const c = state.containers.find(c => c.id === containerId && c.state === 'running');
  if (!c) fail('Choose a running AI workload to inspect its model cache');
  const script = `import os,json,itertools
roots=[os.path.join(os.environ.get('HF_HOME','/root/.cache/huggingface'),'hub'),'/models/hub','/root/.cache/huggingface/hub']
models={}
for root in dict.fromkeys(roots):
 if not os.path.isdir(root): continue
 for entry in itertools.islice(os.scandir(root),128):
  if not entry.name.startswith('models--') or not entry.is_dir(): continue
  name=entry.name[8:].replace('--','/')
  folder=os.path.join(entry.path,'snapshots')
  revisions=[]
  if os.path.isdir(folder):
   for revision in itertools.islice(os.scandir(folder),16):
    if revision.is_dir() and any(f.name.endswith(('.safetensors','.bin','.gguf')) and f.is_file() for f in itertools.islice(os.scandir(revision.path),256)): revisions.append(revision.name)
  models[name]={'model':name,'cachedRevisions':revisions,'state':'cached weights present' if revisions else 'download incomplete or metadata only'}
print('AI_CACHE_JSON'+json.dumps(list(models.values())[:64]))`;
  try {
    const result = await execPython(docker.getDocker(hostId).getContainer(c.id), script);
    const marker = result.output.indexOf('AI_CACHE_JSON');
    if (result.exitCode !== 0 || marker < 0) throw new Error('Inspection unavailable');
    const models = JSON.parse(result.output.slice(marker + 13).trim());
    return { containerId, checkedAt: now(), models: models.map(m => ({ model: text(m.model), state: text(m.state), cachedRevisions: m.cachedRevisions.map(v => text(v, 64)) })),
      note: 'Cached weight files do not prove all shards are complete or that the model API is ready.' };
  } catch { fail('Cache inspection failed. Check that this engine has Python 3 and a Hugging Face cache.', 409); }
}

// Only loopback inside the selected container. No URLs, shell strings or arbitrary commands from the client.
async function readiness(hostId, containerId, port, engine) {
  const client = docker.getDocker(hostId), container = client.getContainer(containerId);
  const state = await container.inspect();
  if (!state.State?.Running) return { ready: false, detail: 'Container is not running', checkedAt: now() };
  if (!port) return { ready: state.State?.Health?.Status === 'healthy', detail: state.State?.Health?.Status || 'No API probe or Docker healthcheck configured', checkedAt: now() };
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Invalid API port');
  const path = engine === 'ollama' ? '/api/tags' : '/v1/models';
  const script = `import urllib.request,json\nr=urllib.request.urlopen('http://127.0.0.1:${port}${path}',timeout=4)\nd=json.loads(r.read(65536))\nprint('AI_COMPUTE_READY' if isinstance(d,dict) and isinstance(d.get('${engine === 'ollama' ? 'models' : 'data'}'),list) and len(d.get('${engine === 'ollama' ? 'models' : 'data'}'))>0 else 'AI_COMPUTE_NOT_READY')`;
  try {
    const result = await execPython(container, script);
    const ready = result.exitCode === 0 && result.output.includes('AI_COMPUTE_READY');
    return { ready, detail: ready ? 'Model API returned a non-empty model list' : 'Model API is not ready. Check the container logs and API port.', checkedAt: now() };
  } catch { return { ready: false, detail: 'API probe failed. Check the container logs; Python 3 is required for this probe.', checkedAt: now() }; }
}

function job(row) {
  if (!row) fail('Operation not found', 404);
  return { id: row.id, hostId: row.host_id, action: row.action, status: row.status, plan: JSON.parse(row.plan_json),
    stopped: JSON.parse(row.stopped_json), createdContainer: row.created_container, error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function jobs(hostId) { return getDb().prepare('SELECT * FROM ai_compute_jobs WHERE host_id=? ORDER BY created_at DESC LIMIT 20').all(hostId).map(job); }
function getJob(hostId, id) { return job(getDb().prepare('SELECT * FROM ai_compute_jobs WHERE host_id=? AND id=?').get(hostId, id)); }
function allowed(hostId, userId, creating = false) {
  policy.assertAllowed({ providerType: 'docker', hostId });
  const user = getDb().prepare('SELECT id,username,role,is_active FROM users WHERE id=?').get(userId);
  if (!user?.is_active || user.role !== 'admin') fail('An active administrator is required', 403);
  const host = getDb().prepare('SELECT is_active,daemon_type FROM docker_hosts WHERE id=?').get(hostId);
  if (!host?.is_active || !['docker', 'podman'].includes(host.daemon_type || 'docker')) fail('An active Docker host is required', 409);
  if (creating && !config.features.create) fail('Container creation is disabled', 403);
  return user;
}
const auditJob = (row, action, details = {}) => audit.log({ userId: row.user_id, action,
  targetType: 'ai_compute', targetId: row.id, details: { hostId: row.host_id, ...details } });

async function prepare(hostId, body, user) {
  const action = body.action;
  if (!['start', 'stop', 'restart', 'switch', 'deploy'].includes(action)) fail('Invalid operation');
  allowed(hostId, user.id, action === 'deploy');
  const client = docker.getDocker(hostId);
  const state = await inventory(hostId);
  let target, recipe;
  if (action === 'deploy') {
    recipe = catalog.entries.find(e => e.id === body.catalogId && e.deployable);
    if (!recipe || !recipe.contextLengths.includes(Number(body.contextLength))) fail('Select a standard recipe and supported context length');
    if (!['aarch64', 'arm64'].includes(state.architecture)) fail('These Spark recipes require an ARM64 host');
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('Choose a loopback port between 1024 and 65535');
    target = { name: `dd-ai-${recipe.id}-${crypto.randomBytes(3).toString('hex')}`, engine: recipe.engine, model: recipe.model,
      memoryBytes: recipe.memoryBytes + Math.max(0, Number(body.contextLength) / 4096 - 1) * 2 * catalog.GiB,
      exclusive: true, readyPort: 8000 };
  } else {
    target = state.containers.find(c => c.profileId === Number(body.profileId));
    if (!target) fail('Register a profile for the selected workload first');
    if (action === 'restart' && target.state !== 'running') fail('Only a running workload can be restarted');
    if (action === 'switch' && !target.exclusive) fail('Switch is only available for exclusive LLM profiles');
  }
  const conflicts = target.exclusive && action !== 'stop' ? state.containers.filter(c => c.id !== target.id && c.exclusive && c.state === 'running') : [];
  if (conflicts.length && !(action === 'switch' || (action === 'deploy' && body.stopConflicts === true))) {
    fail('Another LLM is running. Use Switch or explicitly include stopping conflicting LLMs in the deployment plan.', 409);
  }
  const targets = [...conflicts, ...(target.id ? [target] : [])];
  const snapshots = [];
  for (const c of targets) {
    const inspect = await client.getContainer(c.id).inspect();
    snapshots.push({ id: c.id, name: c.name, fingerprint: fingerprint(inspect), configurationFingerprint: configurationFingerprint(inspect), image: inspect.Image,
      wasRunning: Boolean(inspect.State.Running), restartPolicy: inspect.HostConfig.RestartPolicy });
  }
  const sample = await metrics.sample(hostId, true);
  const starts = ['start', 'switch', 'deploy', 'restart'].includes(action);
  if (starts && (!sample.memory || !sample.gpu)) fail('Fresh SSH memory and NVIDIA GPU metrics are required before starting an engine', 409);
  const reclaimable = conflicts.reduce((sum, c) => sum + (c.memoryBytes || 0), 0)
    + (target.state === 'running' ? target.memoryBytes : 0);
  if (starts && target.memoryBytes + 4 * catalog.GiB > sample.memory.availableBytes + reclaimable) fail('Insufficient estimated memory including the 4 GiB host reserve', 409);
  if (recipe && (!sample.cacheDisk || sample.cacheDisk.availableBytes < recipe.diskBytes)) fail('Cannot verify sufficient free space on the Docker model-cache filesystem', 409);
  const plan = { target, snapshots, stop: conflicts.map(c => ({ id: c.id, name: c.name, memoryBytes: c.memoryBytes })),
    recipeId: recipe?.id, contextLength: recipe ? Number(body.contextLength) : undefined, port: recipe ? Number(body.port) : undefined,
    estimated: true, sampledAt: sample.sampledAt, warning: 'Memory and disk budgets are estimates. Weight downloads may take several minutes. Failed starts restore the previous running engines. Model caches are retained.',
    expiresAt: new Date(Date.now() + 600000).toISOString() };
  const id = crypto.randomUUID(), at = now();
  getDb().prepare('INSERT INTO ai_compute_jobs(id,host_id,user_id,action,status,plan_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, hostId, user.id, action, 'prepared', JSON.stringify(plan), at, at);
  auditJob({ id, host_id: hostId, user_id: user.id }, 'ai_compute_plan', { action, stop: plan.stop.map(c => c.id) });
  return getJob(hostId, id);
}

function execute(hostId, id, user) {
  const db = getDb(), row = db.prepare('SELECT * FROM ai_compute_jobs WHERE id=? AND host_id=?').get(id, hostId);
  const operation = job(row);
  allowed(hostId, user.id, row.action === 'deploy');
  if (row.user_id !== user.id || Date.parse(operation.plan.expiresAt) < Date.now()) fail('This plan expired or belongs to another administrator', 409);
  try {
    const changed = db.prepare("UPDATE ai_compute_jobs SET status='queued',updated_at=? WHERE id=? AND status='prepared'").run(now(), id);
    if (!changed.changes) fail('This plan has already been submitted', 409);
  } catch (err) { if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') fail('Another operation is active on this host', 409); throw err; }
  auditJob(row, 'ai_compute_execute');
  return getJob(hostId, id);
}

async function restore(row, client) {
  const stopped = JSON.parse(row.stopped_json);
  const plan = JSON.parse(row.plan_json);
  const targetId = row.created_container || plan.target.id;
  const targetSnapshot = plan.snapshots.find(s => s.id === targetId);
  if (targetId && (!targetSnapshot || !targetSnapshot.wasRunning || row.action === 'restart')) {
    const c = client.getContainer(targetId), current = await c.inspect();
    if (row.created_container && current.Config.Labels?.['docker-dash.ai-compute.job'] !== row.id) fail('Replacement identity changed; manual review is required', 409);
    if (targetSnapshot && current.Image !== targetSnapshot.image) fail('Target identity changed; manual review is required', 409);
    await c.update({ RestartPolicy: targetSnapshot?.restartPolicy || { Name: 'no', MaximumRetryCount: 0 } });
    if (current.State.Running) await stopContainer(c);
  }
  for (const item of stopped) {
    const c = client.getContainer(item.id), current = await c.inspect();
    if (current.Image !== item.image || configurationFingerprint(current) !== item.configurationFingerprint) fail('Previous engine configuration changed; manual review is required', 409);
    await c.update({ RestartPolicy: item.restartPolicy });
    if (!current.State.Running) await c.start();
  }
}

async function rollback(hostId, id, user) {
  const row = getDb().prepare('SELECT * FROM ai_compute_jobs WHERE id=? AND host_id=?').get(id, hostId);
  job(row); allowed(hostId, user.id);
  if (row.status !== 'needs_review') fail('Only interrupted operations can be reconciled here', 409);
  const changed = getDb().prepare("UPDATE ai_compute_jobs SET status='running',updated_at=? WHERE id=? AND status='needs_review'").run(now(), id);
  if (!changed.changes) fail('Another administrator is reconciling this operation', 409);
  try {
    await restore(row, docker.getDocker(hostId));
    getDb().prepare("UPDATE ai_compute_jobs SET status='rolled_back',updated_at=? WHERE id=?").run(now(), id);
    auditJob(row, 'ai_compute_rollback');
  } catch (err) { getDb().prepare("UPDATE ai_compute_jobs SET status='needs_review',error=?,updated_at=? WHERE id=?").run(text(err.message, 500), now(), id); throw err; }
  return getJob(hostId, id);
}

async function run(row) {
  const db = getDb(), plan = JSON.parse(row.plan_json);
  let client;
  const touch = () => db.prepare('UPDATE ai_compute_jobs SET updated_at=? WHERE id=?').run(now(), row.id);
  const check = () => allowed(row.host_id, row.user_id, row.action === 'deploy');
  let mutated = false;
  const heartbeat = setInterval(touch, 10000);
  heartbeat.unref();
  try {
    check();
    client = docker.getDocker(row.host_id);
    for (const snapshot of plan.snapshots) {
      if (fingerprint(await client.getContainer(snapshot.id).inspect()) !== snapshot.fingerprint) fail('Workload changed after the preview. Create a new plan.', 409);
    }
    // Image download and architecture checks happen before any existing engine is stopped.
    let imageId;
    if (row.action === 'deploy') {
      const recipe = catalog.entries.find(e => e.id === plan.recipeId);
      await docker.pullImage(recipe.runtime, row.host_id);
      const image = await client.getImage(recipe.runtime).inspect();
      if (image.Architecture !== 'arm64') fail('The selected image is not ARM64 compatible', 409);
      imageId = image.Id; touch(); check();
    }
    const currentInventory = await inventory(row.host_id);
    const expectedConflicts = plan.stop.map(c => c.id).sort().join(',');
    const actualConflicts = plan.target.exclusive && row.action !== 'stop'
      ? currentInventory.containers.filter(c => c.exclusive && c.state === 'running' && c.id !== plan.target.id).map(c => c.id).sort().join(',') : '';
    if (actualConflicts !== expectedConflicts) fail('The running LLM inventory changed after the preview. Create a new plan.', 409);
    const stopIds = [...plan.stop.map(c => c.id), ...(['stop', 'restart'].includes(row.action) && plan.target.state === 'running' ? [plan.target.id] : [])];
    for (const id of stopIds) {
      check();
      const snapshot = plan.snapshots.find(s => s.id === id);
      if (fingerprint(await client.getContainer(id).inspect()) !== snapshot.fingerprint) fail('An engine changed while preparing the switch', 409);
      const stopped = JSON.parse(db.prepare('SELECT stopped_json FROM ai_compute_jobs WHERE id=?').get(row.id).stopped_json);
      stopped.push(snapshot);
      db.prepare('UPDATE ai_compute_jobs SET stopped_json=?,updated_at=? WHERE id=?').run(JSON.stringify(stopped), now(), row.id);
      mutated = true;
      const c = client.getContainer(id);
      // A deliberately stopped prior engine must not reappear on a host reboot.
      await c.update({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } });
      await stopContainer(c);
    }
    if (row.action !== 'stop') {
      let sample;
      for (let attempt = 0; attempt < 12; attempt++) {
        check(); touch(); sample = await metrics.sample(row.host_id, true);
        if (sample.memory?.availableBytes >= plan.target.memoryBytes + 4 * catalog.GiB
          || (plan.target.state === 'running' && row.action === 'start')) break;
        await wait(5000);
      }
      if (row.action === 'deploy') {
        const recipe = catalog.entries.find(e => e.id === plan.recipeId);
        if (!sample.cacheDisk || sample.cacheDisk.availableBytes < recipe.diskBytes) fail('Model-cache free space changed. Previous engines will be restored.', 409);
      }
      if (!sample.memory || sample.memory.availableBytes < plan.target.memoryBytes + 4 * catalog.GiB) {
        if (!(plan.target.state === 'running' && row.action === 'start')) fail('Memory was not released in time. Previous engines will be restored.', 409);
      }
      check();
      let targetId = plan.target.id;
      if (row.action === 'deploy') {
        const recipe = catalog.entries.find(e => e.id === plan.recipeId);
        const share = Math.max(0.05, Math.min(0.8, plan.target.memoryBytes / sample.memory.totalBytes));
        const container = await client.createContainer({ name: plan.target.name, Image: imageId,
          Cmd: ['vllm', 'serve', recipe.model, '--revision', recipe.revision, '--tokenizer-revision', recipe.revision,
            '--served-model-name', recipe.id, '--host', '0.0.0.0', '--port', '8000', '--load-format', 'safetensors',
            '--max-model-len', String(plan.contextLength), '--max-num-seqs', '4', '--gpu-memory-utilization', share.toFixed(3), '--attention-backend', 'TRITON_ATTN'],
          Env: ['HF_HOME=/models', 'XDG_CACHE_HOME=/tmp/cache'],
          Labels: { 'docker-dash.ai-compute.engine': 'vllm', 'docker-dash.ai-compute.job': row.id },
          ExposedPorts: { '8000/tcp': {} },
          HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
            DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }], ShmSize: catalog.GiB,
            Mounts: [{ Type: 'volume', Source: 'docker-dash-ai-model-cache', Target: '/models' }],
            PortBindings: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(plan.port) }] },
            LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } } });
        targetId = container.id;
        db.prepare('UPDATE ai_compute_jobs SET created_container=?,updated_at=? WHERE id=?').run(targetId, now(), row.id);
        mutated = true;
        db.prepare(`INSERT INTO ai_compute_profiles(host_id,container_id,name,engine,model,memory_bytes,ready_port,exclusive,created_by,created_at,restart_policy)
          VALUES (?,?,?,?,?,?,?,1,?,?,?)`).run(row.host_id, targetId, plan.target.name, 'vllm', recipe.model, plan.target.memoryBytes, 8000, row.user_id, now(), JSON.stringify({ Name: 'unless-stopped' }));
      }
      const c = client.getContainer(targetId), current = await c.inspect();
      mutated = true;
      if (!current.State.Running) {
        const original = plan.snapshots.find(s => s.id === targetId);
        if (original) await c.update({ RestartPolicy: plan.target.desiredRestartPolicy || original.restartPolicy });
        await c.start();
      }
      let ready = false;
      for (let attempt = 0; attempt < 180; attempt++) {
        check(); touch();
        const probe = await readiness(row.host_id, targetId, plan.target.readyPort, plan.target.engine);
        if (probe.ready) { ready = true; break; }
        if (!(await c.inspect()).State.Running) break;
        await wait(5000);
      }
      if (!ready) fail('Model API did not become ready within 15 minutes. Inspect container logs for loading or compatibility errors.', 409);
    }
    db.prepare("UPDATE ai_compute_jobs SET status='completed',updated_at=? WHERE id=?").run(now(), row.id);
    auditJob(row, 'ai_compute_completed');
  } catch (err) {
    let status = 'failed', detail = text(err.message, 500);
    if (mutated) {
      try {
        const current = db.prepare('SELECT * FROM ai_compute_jobs WHERE id=?').get(row.id);
        await restore(current, client); status = 'rolled_back';
      } catch (rollbackError) { status = 'needs_review'; detail += ' Rollback: ' + text(rollbackError.message, 500); }
    }
    db.prepare('UPDATE ai_compute_jobs SET status=?,error=?,updated_at=? WHERE id=?').run(status, detail, now(), row.id);
    auditJob(row, 'ai_compute_failed', { status, error: detail });
  } finally { clearInterval(heartbeat); }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const db = getDb();
    // Never replay a partially completed switch after a crash or lose its rollback evidence.
    db.prepare("UPDATE ai_compute_jobs SET status='needs_review',error='Interrupted operation. Review and restore the previous engines before proceeding.' WHERE status='running' AND updated_at < ?")
      .run(new Date(Date.now() - 1800000).toISOString());
    const row = db.prepare("SELECT * FROM ai_compute_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
    if (row && db.prepare("UPDATE ai_compute_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'").run(now(), row.id).changes) await run(row);
    db.prepare("DELETE FROM ai_compute_jobs WHERE status='prepared' AND created_at < ?").run(new Date(Date.now() - 86400000).toISOString());
  } finally { ticking = false; }
}

module.exports = { hosts, inventory, register, monitoring, readiness, cache, prepare, execute, jobs, getJob, rollback, tick,
  _internals: { engineOf, describe, fingerprint, run, restore } };
