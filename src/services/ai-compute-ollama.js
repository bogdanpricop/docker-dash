'use strict';

const { PassThrough } = require('node:stream');
const { isDeepStrictEqual } = require('node:util');
const catalog = require('./ai-compute-catalog');
const managerName = 'dd-ai-ollama-cache-gateway';
const volumeName = 'docker-dash-ollama-model-cache';
const statuses = new WeakMap();
const clean = (value, max = 2000) => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(-max);
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };

// Native Ollama CLI talks only to the server in this container. No shell or
// client-supplied commands/URLs are accepted. Keep streaming output bounded.
async function exec(container, args, { timeout = 10000, progress } = {}) {
  const operation = await container.exec({ Cmd: args, AttachStdout: true, AttachStderr: true, AttachStdin: false });
  const stream = await operation.start({ hijack: true, stdin: false });
  stream.setTimeout?.(0);
  let stdout = '', stderr = '', lastProgress = 0;
  const out = new PassThrough(), err = new PassThrough();
  const append = (text, error) => {
    if (error) stderr = (stderr + text).slice(-65536);
    else stdout = (stdout + text).slice(-65536);
    if (progress && Date.now() - lastProgress >= 1500) {
      lastProgress = Date.now();
      try { progress(clean(text).trim().slice(-500)); } catch (error) { stream.destroy(error); }
    }
  };
  out.on('data', chunk => append(chunk.toString('utf8'), false));
  err.on('data', chunk => append(chunk.toString('utf8'), true));
  await new Promise((resolve, reject) => {
    let ended = false;
    const timer = setTimeout(() => { stream.destroy(); reject(new Error('Ollama command timed out; cached partial downloads are retained.')); }, timeout);
    stream.once('error', error => { clearTimeout(timer); reject(error); });
    stream.once('end', () => { ended = true; clearTimeout(timer); resolve(); });
    stream.once('close', () => { if (!ended) { clearTimeout(timer); reject(new Error('The Ollama connection closed; partial downloads are retained.')); } });
    container.modem.demuxStream(stream, out, err);
  });
  const result = await operation.inspect();
  if (result.ExitCode !== 0) fail(clean(stderr || stdout).trim().slice(-1000) || 'Ollama command failed');
  return clean(stdout, 65536);
}

function parseList(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const [name, digest] = line.trim().split(/\s+/);
    return name && /^[a-z0-9][a-z0-9./:_-]{0,250}$/i.test(name) && /^[a-f0-9]{12,64}$/.test(digest || '') ? [{ name, digest }] : [];
  });
}

async function manager(client, create = false, imageId) {
  let instance = client.getContainer(managerName), info;
  try { info = await instance.inspect(); }
  catch (error) {
    if (error.statusCode !== 404) throw error;
    if (!create) return null;
  }
  if (info) {
    if (info.Config.Labels?.['docker-dash.ai-compute.role'] !== 'cache'
      || info.HostConfig.Privileged || info.HostConfig.NetworkMode === 'host' || info.HostConfig.DeviceRequests?.length
      || Object.values(info.HostConfig.PortBindings || {}).some(ports => ports?.length) || (imageId && info.Image !== imageId)
      || !info.Mounts?.some(m => m.Name === volumeName && m.Destination === '/models')) fail('The model cache service identity changed. Review it before continuing.');
    if (!info.State.Running) { if (!create) return null; await instance.start(); }
  } else {
    try {
      const volume = await client.getVolume(volumeName).inspect();
      if (volume.Labels?.['docker-dash.ai-compute.cache'] !== 'ollama') fail('An unrecognized volume uses the model-cache name.');
    } catch (error) {
      if (error.statusCode !== 404) throw error;
      await client.createVolume({ Name: volumeName, Labels: { 'docker-dash.ai-compute.cache': 'ollama', 'docker-dash.ai-compute.managed': 'true' } });
    }
    instance = await client.createContainer({ name: managerName, Image: imageId, Cmd: ['serve'],
      Env: ['OLLAMA_HOST=127.0.0.1:11434', 'OLLAMA_MODELS=/models', 'OLLAMA_NO_CLOUD=1', 'OLLAMA_NOPRUNE=1', 'OLLAMA_KEEP_ALIVE=0', 'OLLAMA_VULKAN=0', 'CUDA_VISIBLE_DEVICES=-1', 'NVIDIA_VISIBLE_DEVICES=void'],
      Labels: { 'docker-dash.ai-compute.role': 'cache', 'docker-dash.ai-compute.managed': 'true', 'docker-dash.ai-compute.runtime': '0.40.16' },
      HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 2 * catalog.GiB, NanoCpus: 1000000000, PidsLimit: 128,
        RestartPolicy: { Name: 'unless-stopped' }, Tmpfs: { '/root/.ollama': 'rw,noexec,nosuid,size=16m,mode=0700', '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777' },
        Mounts: [{ Type: 'volume', Source: volumeName, Target: '/models' }], LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } } });
    await instance.start();
  }
  return instance;
}

async function states(client, force = false) {
  const previous = statuses.get(client);
  if (!force && previous && Date.now() - previous.at < 10000) return previous.models;
  const instance = await manager(client);
  const models = instance ? parseList(await exec(instance, ['ollama', 'list'])) : [];
  statuses.set(client, { at: Date.now(), models });
  return models;
}

async function verified(instance, recipe) {
  const aliasPath = '/models/manifests-v2/ollama.com/library/' + recipe.alias.replace(':', '/');
  return verifyManifest(instance, aliasPath, recipe.revision);
}

async function verifyManifest(instance, path, revision) {
  const sum = (await exec(instance, ['sha256sum', path])).trim().split(/\s+/)[0];
  if ('sha256:' + sum === revision) return true;
  // Ollama 0.40 retains the original registry manifest as a provenance layer.
  // Verify that immutable blob, then require every serving layer to match it.
  const manifest = JSON.parse(await exec(instance, ['cat', path]));
  if (!Array.isArray(manifest.layers)) return false;
  const proofs = manifest.layers.filter(layer => layer.mediaType === 'application/vnd.docker.distribution.manifest.v2+json' && layer.digest === revision);
  if (proofs.length !== 1) return false;
  const originalPath = '/models/blobs/' + revision.replace(':', '-');
  if ('sha256:' + (await exec(instance, ['sha256sum', originalPath])).trim().split(/\s+/)[0] !== revision) return false;
  const original = JSON.parse(await exec(instance, ['cat', originalPath]));
  return isDeepStrictEqual({ ...manifest, layers: manifest.layers.filter(layer => layer !== proofs[0]) }, original);
}

async function download(client, recipe, imageId, check, progress) {
  check();
  const instance = await manager(client, true, imageId);
  for (let n = 0; n < 30; n++) {
    try { await exec(instance, ['ollama', 'list']); break; }
    catch (error) { if (n === 29) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  const cached = (await states(client, true)).some(m => m.name === recipe.alias);
  if (cached && await verified(instance, recipe)) return;
  progress('Downloading model weights; existing partial files are reused.');
  await exec(instance, ['ollama', 'pull', recipe.model], { timeout: 4 * 60 * 60 * 1000, progress: message => { check(); progress(message); } });
  check();
  if (!await verifyManifest(instance, recipe.manifestPath, recipe.revision)) fail('The upstream model revision changed after catalog verification. Refresh the reviewed recipe before deploying.');
  await exec(instance, ['ollama', 'cp', recipe.model, recipe.alias]);
  if (!await verified(instance, recipe)) fail('The cached model manifest failed revision verification.');
  statuses.delete(client);
  progress('Model downloaded and revision verified. Ready for deployment.');
}

function createOptions(recipe, plan, imageId, jobId) {
  return { name: plan.target.name, Image: imageId, Cmd: ['serve'], User: '1000:1000',
    Env: ['HOME=/tmp/ollama', 'OLLAMA_HOST=0.0.0.0:11434', 'OLLAMA_MODELS=/models', 'OLLAMA_NO_CLOUD=1', 'OLLAMA_NOPRUNE=1', 'OLLAMA_KEEP_ALIVE=-1', 'OLLAMA_MAX_LOADED_MODELS=1', 'OLLAMA_NUM_PARALLEL=1', 'OLLAMA_VULKAN=0', 'OLLAMA_CONTEXT_LENGTH=' + plan.contextLength],
    Labels: { 'docker-dash.ai-compute.engine': 'ollama', 'docker-dash.ai-compute.job': jobId, 'docker-dash.ai-compute.catalog': recipe.id, 'docker-dash.ai-compute.model': recipe.model, 'docker-dash.ai-compute.alias': recipe.alias, 'docker-dash.ai-compute.capability': recipe.capability },
    ExposedPorts: { '11434/tcp': {} }, HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: plan.target.memoryBytes,
      PidsLimit: 512, RestartPolicy: { Name: 'unless-stopped' }, DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }], ShmSize: catalog.GiB,
      Tmpfs: { '/tmp': 'rw,nosuid,size=1g,mode=1777' }, Mounts: [{ Type: 'volume', Source: volumeName, Target: '/models', ReadOnly: true }],
      PortBindings: { '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: String(plan.port) }] }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } } };
}

async function warm(container, recipe, progress) {
  progress('Loading model into memory and checking its API.');
  for (let n = 0; n < 30; n++) {
    try { await exec(container, ['ollama', 'list']); break; }
    catch (error) { if (n === 29) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  const input = recipe.capability === 'embedding' ? 'Docker Dash readiness check' : '';
  const response = await exec(container, ['ollama', 'run', recipe.alias, input, '--keepalive=-1m'], { timeout: 15 * 60 * 1000 });
  if (recipe.capability === 'embedding') {
    let vector;
    try { vector = JSON.parse(response); } catch { fail('The embedding API returned invalid JSON.'); }
    if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) fail('The embedding API did not return a valid vector.');
  }
}

async function probe(container) {
  const info = await container.inspect(), alias = info.Config.Labels?.['docker-dash.ai-compute.alias'];
  const models = parseList(await exec(container, ['ollama', alias ? 'ps' : 'list']));
  return { ready: alias ? models.some(m => m.name === alias) : models.length > 0,
    detail: alias ? 'Checked the selected model is resident in Ollama.' : 'Ollama API returned a non-empty model list.', checkedAt: new Date().toISOString() };
}

module.exports = { states, download, createOptions, warm, probe, exec, parseList, verifyManifest, managerName, volumeName };
