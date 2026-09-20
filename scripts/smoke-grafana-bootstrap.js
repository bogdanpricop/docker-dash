'use strict';
const fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto'),tar=require('tar-stream'),Docker=require('dockerode');
const url=new URL(process.env.DD_SMOKE_DOCKER_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'http:');
const grafanaImage=process.env.OBS_GRAFANA_IMAGE,runnerImage=process.env.DD_SMOKE_APP_IMAGE;
for(const image of [grafanaImage,runnerImage])assert.match(image||'',/^sha256:[a-f0-9]{64}$/);
const docker=new Docker({host:url.hostname,port:Number(url.port),timeout:30000}),marker='dd-grafana-bootstrap-'+crypto.randomBytes(6).toString('hex');
const labels={'com.docker-dash.grafana-bootstrap':marker},guard=fs.readFileSync('docker/observability/grafana/start.sh');
async function output(c){const raw=await c.logs({stdout:true,stderr:true});let text='';for(let n=0;n<raw.length;){const size=raw.readUInt32BE(n+4);text+=raw.subarray(n+8,n+8+size).toString();n+=8+size;}return text;}
async function remove(c){assert.equal((await c.inspect()).Config.Labels['com.docker-dash.grafana-bootstrap'],marker);await c.remove({force:true,v:true});}
async function finished(c,seconds){const deadline=Date.now()+seconds*1000;while(true){const info=await c.inspect();if(!info.State.Running)return info;assert.ok(Date.now()<deadline,'Container did not finish before deadline');await new Promise(r=>setTimeout(r,200));}}
(async()=>{
 const checks=[];
 for(const [name,secret] of [['missing',null],['empty',''],['default','admin'],['whitespace',' '.repeat(24)],['multiline','x'.repeat(24)+'\nsecond'],['oversized','x'.repeat(300)],['valid',crypto.randomBytes(36).toString('base64url')]]){
  const c=await docker.createContainer({name:marker+'-'+name,Image:grafanaImage,Entrypoint:['/bin/sh','/tmp/docker-dash-start.sh'],Labels:labels,
   Env:['GF_SECURITY_ADMIN_PASSWORD__FILE=/tmp/bootstrap-password','GF_AUTH_ANONYMOUS_ENABLED=false','GF_USERS_ALLOW_SIGN_UP=false','GF_PLUGINS_PREINSTALL_DISABLED=true','GF_ANALYTICS_REPORTING_ENABLED=false','GF_ANALYTICS_CHECK_FOR_UPDATES=false'],
   HostConfig:{NetworkMode:'none',Memory:536870912,NanoCpus:1000000000,PidsLimit:128,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Tmpfs:{'/var/lib/grafana':'rw,nosuid,nodev,size=128m,uid=472,gid=0,mode=0700'}}});
  try{
   const pack=tar.pack();pack.entry({name:'docker-dash-start.sh',mode:0o444,uid:472,gid:0},guard);if(secret!==null)pack.entry({name:'bootstrap-password',mode:0o400,uid:472,gid:0},secret);pack.finalize();await c.putArchive(pack,{path:'/tmp'});await c.start();
   if(name!=='valid'){
    const info=await finished(c,8);assert.equal(info.State.ExitCode,1);assert.equal(info.State.OOMKilled,false);assert.match(await output(c),/Grafana (requires|bootstrap password)/);checks.push('refuses-'+name+'-bootstrap-secret');continue;
   }
   const code=`(async()=>{let response;for(let n=0;n<80;n++){try{response=await fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(1000)});if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,500));}if(!response?.ok)throw Error('Grafana did not become ready');const health=await response.json();const headers={authorization:'Basic '+Buffer.from('admin:'+process.env.FIXTURE_PASSWORD).toString('base64')};const user=await fetch('http://127.0.0.1:3000/api/user',{headers,signal:AbortSignal.timeout(5000)});if(user.status!==200)throw Error('Configured credential rejected');if(!(await user.json()).isGrafanaAdmin)throw Error('Wrong bootstrap role');for(const headers of [{},{authorization:'Basic '+Buffer.from('admin:admin').toString('base64')}]){const denied=await fetch('http://127.0.0.1:3000/api/user',{headers,signal:AbortSignal.timeout(5000)});if(denied.status!==401)throw Error('Unconfigured access accepted');await denied.arrayBuffer();}console.log(JSON.stringify({version:health.version,database:health.database,bootstrapAccepted:true,anonymousDenied:true,defaultDenied:true}));})().catch(e=>{console.error(e.message);process.exit(1)});`;
   const probe=await docker.createContainer({name:marker+'-probe',Image:runnerImage,Entrypoint:['node'],Cmd:['-e',code],Labels:labels,Env:['FIXTURE_PASSWORD='+secret],HostConfig:{NetworkMode:'container:'+c.id,Memory:134217728,NanoCpus:1000000000,PidsLimit:64,CapDrop:['ALL'],SecurityOpt:['no-new-privileges']}});
   try{await probe.start();const info=await finished(probe,55);assert.equal(info.State.ExitCode,0,await output(probe));checks.push('fresh-grafana-authenticates-file-secret-and-denies-default');console.log(JSON.stringify({native:JSON.parse((await output(probe)).trim())}));}finally{await remove(probe);}
  }finally{await remove(c);}
 }
 console.log(JSON.stringify({at:new Date().toISOString(),grafanaImage,guardSha256:crypto.createHash('sha256').update(guard).digest('hex'),checks}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
