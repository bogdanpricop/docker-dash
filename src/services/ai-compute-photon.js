'use strict';

const ollama = require('./ai-compute-ollama');
const { GiB, ollamaRuntime } = require('./ai-compute-catalog');
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
      || !info.Mounts?.some(m => m.Name === volumeName && m.Destination === '/models')) fail('The Photon cache service identity changed.');
    if (imageId && info.Image !== imageId) {
      const references = [ollamaRuntime, 'nvcr.io/nvidia/vllm@sha256:cb38bbefdbc3e9fe045f931dd72cbd58cd48985c7e09916bcc6c15c10f39b929'];
      const trusted = await Promise.all(references.map(async ref => { try { return (await client.getImage(ref).inspect()).Id; } catch { return null; } }));
      if (!trusted.includes(info.Image) || info.Config.Labels?.['docker-dash.ai-compute.managed'] !== 'true') fail('Review the previous Photon cache image before upgrading it.');
      if (info.State.Running) await container.stop({ t: 5 });
      await container.remove({ v: false });
      return manager(client, imageId, true);
    }
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
    Env: ['HOME=/tmp', 'CUDA_VISIBLE_DEVICES=-1', 'NVIDIA_VISIBLE_DEVICES=void'],
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
  const script = `import os,json,hashlib,pathlib,time,urllib.request,urllib.parse
artifacts=json.loads(${JSON.stringify(JSON.stringify(recipe.artifacts))})
p=pathlib.Path('/models')
class Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  u=urllib.parse.urlsplit(newurl);host=u.hostname or ''
  if u.scheme!='https' or not any(host==h or host.endswith('.'+h) for h in ['huggingface.co','hf.co']):raise RuntimeError('Untrusted model download redirect')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
opener=urllib.request.build_opener(Redirect())
def valid(f,a):
 if not f.is_file() or f.stat().st_size!=a['bytes']:return False
 h=hashlib.sha256()
 with f.open('rb')as src:
  while chunk:=src.read(8*1024*1024):h.update(chunk)
 return h.hexdigest()==a['sha256']
for a in artifacts:
 target=p/a['name']
 if valid(target,a):
  print('Reused verified '+a['name'],flush=True);continue
 print('Downloading '+a['name'],flush=True)
 temporary=p/(a['name']+'.partial')
 for attempt in range(5):
  try:
   offset=temporary.stat().st_size if temporary.exists()else 0
   if offset>a['bytes']:raise RuntimeError('Partial model exceeds expected size')
   if offset<a['bytes']:
    request=urllib.request.Request('https://huggingface.co/'+a['repo']+'/resolve/'+a['revision']+'/'+a['name'],headers={'Range':'bytes='+str(offset)+'-'}if offset else {})
    with opener.open(request,timeout=60)as response:
     if offset and response.status==200:offset=0
     elif offset and (response.status!=206 or not response.headers.get('Content-Range','').startswith('bytes '+str(offset)+'-')):raise RuntimeError('Model server rejected download resume')
     with temporary.open('ab'if offset else'wb')as dest:
      last=time.monotonic()
      while chunk:=response.read(8*1024*1024):
       offset+=len(chunk)
       if offset>a['bytes']:raise RuntimeError('Model download exceeds expected size')
       dest.write(chunk)
       if time.monotonic()-last>2:print(a['name']+': '+str(offset)+' / '+str(a['bytes'])+' bytes',flush=True);last=time.monotonic()
   if not valid(temporary,a):
    if temporary.exists()and temporary.stat().st_size==a['bytes']:temporary.unlink()
    raise RuntimeError('Model artifact checksum mismatch: '+a['name'])
   os.replace(temporary,target);break
  except Exception:
   if attempt==4:raise
   time.sleep(3)
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
