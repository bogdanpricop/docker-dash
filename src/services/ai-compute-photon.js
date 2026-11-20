'use strict';

const ollama = require('./ai-compute-ollama');
const { GiB } = require('./ai-compute-catalog');
const volumeName = 'docker-dash-photon-model-cache';
const managerName = 'dd-ai-photon-cache-gateway';
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };

async function manager(client, imageId, create = false) {
  let container = client.getContainer(managerName), info;
  try { info = await container.inspect(); }
  catch (error) { if (error.statusCode !== 404) throw error; if (!create) return null; }
  if (info) {
    if (info.Config.Labels?.['docker-dash.ai-compute.role'] !== 'cache' || info.HostConfig.Privileged || info.HostConfig.NetworkMode === 'host'
      || info.HostConfig.DeviceRequests?.length || Object.values(info.HostConfig.PortBindings || {}).some(ports => ports?.length)
      || (imageId && info.Image !== imageId) || !info.Mounts?.some(m => m.Name === volumeName && m.Destination === '/models')) fail('The Photon cache service identity changed.');
    if (!info.State.Running) { if (!create) return null; await container.start(); }
    return container;
  }
  try {
    const volume = await client.getVolume(volumeName).inspect();
    if (volume.Labels?.['docker-dash.ai-compute.cache'] !== 'photon') fail('An unrecognized volume uses the Photon cache name.');
  } catch (error) {
    if (error.statusCode !== 404) throw error;
    await client.createVolume({ Name: volumeName, Labels: { 'docker-dash.ai-compute.cache': 'photon', 'docker-dash.ai-compute.managed': 'true' } });
  }
  container = await client.createContainer({ name: managerName, Image: imageId,
    Entrypoint: ['python3', '-u', '-c'], Cmd: ['import time; time.sleep(31536000)'],
    Env: ['HF_HOME=/models/hf', 'HF_HUB_OFFLINE=0', 'HF_HUB_DISABLE_TELEMETRY=1', 'HOME=/tmp'],
    Labels: { 'docker-dash.ai-compute.role': 'cache', 'docker-dash.ai-compute.managed': 'true' },
    HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 2 * GiB, NanoCpus: 1000000000, PidsLimit: 128,
      RestartPolicy: { Name: 'unless-stopped' }, Tmpfs: { '/tmp': 'rw,nosuid,size=64m,mode=1777' }, Mounts: [{ Type: 'volume', Source: volumeName, Target: '/models' }],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } } } });
  await container.start();
  return container;
}

async function state(client, recipe) {
  const container = await manager(client);
  if (!container) return false;
  try {
    const proof = JSON.parse(await ollama.exec(container, ['python3', '-c', "import json,pathlib; p=pathlib.Path('/models'); v=json.loads((p/'verified.json').read_text()); assert all((p/a['name']).is_file() and (p/a['name']).stat().st_size==a['bytes'] for a in v['artifacts']); print(json.dumps(v))"]));
    return proof.revision === recipe.revision && JSON.stringify(proof.artifacts) === JSON.stringify(recipe.artifacts);
  } catch { return false; }
}

async function download(client, recipe, imageId, check, progress) {
  const container = await manager(client, imageId, true);
  // Coordinates come exclusively from the reviewed catalog. Python never runs
  // model repository code. Hash every artifact before recording a ready cache.
  const script = `import os,json,hashlib,pathlib
from huggingface_hub import hf_hub_download
artifacts=json.loads(${JSON.stringify(JSON.stringify(recipe.artifacts))})
p=pathlib.Path('/models')
for a in artifacts:
 print('Downloading '+a['name'],flush=True)
 f=pathlib.Path(hf_hub_download(a['repo'],filename=a['name'],revision=a['revision']))
 h=hashlib.sha256()
 with f.open('rb') as src:
  while chunk:=src.read(8*1024*1024):h.update(chunk)
 if f.stat().st_size!=a['bytes'] or h.hexdigest()!=a['sha256']:raise RuntimeError('Model artifact checksum mismatch: '+a['name'])
 target=p/a['name']; temporary=p/(a['name']+'.tmp')
 if os.path.lexists(temporary):temporary.unlink()
 os.link(f.resolve(strict=True),temporary)
 os.replace(temporary,target)
 print('Verified '+a['name'],flush=True)
proof={'revision':${JSON.stringify(recipe.revision)},'artifacts':artifacts}
(p/'verified.tmp').write_text(json.dumps(proof))
os.replace(p/'verified.tmp',p/'verified.json')
print('Downloaded and verified all model artifacts.',flush=True)`;
  check();
  await ollama.exec(container, ['python3', '-u', '-c', script], { timeout: 4 * 60 * 60 * 1000, progress: message => { check(); progress(message); } });
  check();
  if (!await state(client, recipe)) fail('The Photon cache verification record is incomplete.');
}

module.exports = { state, download, volumeName, managerName };
