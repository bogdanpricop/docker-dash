'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tar = require('tar-stream');
const { GiB } = require('./ai-compute-catalog');
const profile = 'ollama-0.40.16-security1';
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };

function descriptor() {
  const dockerfile = fs.readFileSync(path.join(__dirname, '../../docker/ai-compute/ollama.Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
  if (Buffer.byteLength(dockerfile) > 65536) fail('The reviewed runtime build recipe exceeds its limit.');
  const hash = crypto.createHash('sha256').update(dockerfile).digest('hex');
  return { dockerfile, hash, tag: 'docker-dash-ai-ollama:0.40.16-' + hash.slice(0,12), lock: 'dd-ai-runtime-build-' + hash.slice(0,12) + '-gateway' };
}

async function find(client, recipe = descriptor()) {
  try {
    const info = await client.getImage(recipe.tag).inspect();
    if (info.Config?.Labels?.['docker-dash.ai-compute.recipe'] !== recipe.hash
      || info.Config?.Labels?.['docker-dash.ai-compute.runtime'] !== profile) fail('The security runtime image identity changed. Review it before continuing.');
    return info;
  } catch (error) { if (error.statusCode === 404) return null; throw error; }
}

async function context(recipe) {
  const archive = tar.pack(), chunks = [];
  archive.on('data', chunk => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => { archive.once('end', resolve); archive.once('error', reject); });
  archive.entry({ name: 'Dockerfile', mode: 0o644 }, recipe.dockerfile);
  archive.finalize();
  await ended;
  return Buffer.concat(chunks);
}

async function build(client, recipe, check, progress) {
  const stream = await client.buildImage(await context(recipe), { t: recipe.tag, version: '1',
    buildargs: { DOCKER_DASH_RECIPE_HASH: recipe.hash }, memory: 4 * GiB, cpuquota: 200000, cpushares: 256, rm: true, forcerm: true });
  stream.setTimeout?.(0);
  let pending = '', lastProgress = 0, phase = 'Preparing the security-patched runtime.', tail = '';
  const timer = setTimeout(() => stream.destroy(new Error('Security runtime build timed out. Cached build layers are retained.')), 30 * 60 * 1000);
  try {
    for await (const chunk of stream) {
      pending += chunk.toString('utf8');
      if (pending.length > 1024 * 1024) fail('Runtime build output exceeded its framing limit.');
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0,end); pending = pending.slice(end+1);
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        const output = String(item.stream || item.status || '');
        tail = (tail + output).slice(-2000);
        if (/RUN git clone/.test(output)) phase = 'Verifying the pinned runtime source.';
        else if (/RUN go mod|go build/.test(output)) phase = 'Compiling the security-patched runtime; this can take several minutes.';
        else if (/RUN apt-get/.test(output)) phase = 'Applying runtime operating-system security updates.';
        else if (/COPY --from=server/.test(output)) phase = 'Assembling the security-patched runtime image.';
        else if (/Successfully tagged/.test(output)) phase = 'Security-patched runtime image ready.';
        if (item.error || item.errorDetail) fail(String(item.errorDetail?.message || item.error).slice(-400) + ' ' + tail.slice(-600));
        if (Date.now() - lastProgress > 1500) {
          lastProgress = Date.now(); check();
          progress(phase);
        }
      }
    }
    if (pending.trim()) {
      const item = JSON.parse(pending);
      if (item.error || item.errorDetail) fail(String(item.errorDetail?.message || item.error).slice(-1000));
    }
    check();
  } finally { clearTimeout(timer); stream.destroy(); }
}

async function ensure(client, baseImageId, check, progress) {
  const recipe = descriptor(), deadline = Date.now() + 35 * 60 * 1000;
  let lock;
  while (!lock) {
    check();
    const existing = await find(client, recipe);
    if (existing) return existing.Id;
    try {
      // A Docker name reservation serializes builds across separate Dash
      // installations connected to the same host. This container never starts.
      lock = await client.createContainer({ name: recipe.lock, Image: baseImageId, Cmd: ['--version'],
        Labels: { 'docker-dash.ai-compute.role': 'cache', 'docker-dash.ai-compute.build': recipe.hash },
        HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 32 * 1024 ** 2, PidsLimit: 16, RestartPolicy: { Name: 'no' } } });
    } catch (error) {
      if (error.statusCode !== 409) throw error;
      const owner = await client.getContainer(recipe.lock).inspect();
      if (owner.Config?.Labels?.['docker-dash.ai-compute.build'] !== recipe.hash || owner.State?.Running) fail('The runtime build reservation identity changed.');
      if (Date.now() - Date.parse(owner.Created) > 35 * 60 * 1000 || Date.now() > deadline) fail('A runtime build was interrupted. Review its cache-only reservation in Containers before retrying.');
      progress('Another Docker Dash instance is preparing the same security runtime. Waiting for its verified image.');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  try {
    // Recheck after taking the cross-instance reservation.
    let image = await find(client, recipe);
    if (!image) { await build(client, recipe, check, progress); image = await find(client, recipe); }
    if (!image) fail('The security runtime build did not produce its verified image.');
    return image.Id;
  } finally { await lock.remove(); }
}

module.exports = { descriptor, find, ensure, profile, build };
