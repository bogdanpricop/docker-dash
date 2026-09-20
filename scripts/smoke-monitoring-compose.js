'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),Docker=require('dockerode');
const url=new URL(process.env.DD_SMOKE_DOCKER_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'http:');
const image=process.env.DD_SMOKE_APP_IMAGE;assert.match(image||'',/^sha256:[a-f0-9]{64}$/);
const docker=new Docker({host:url.hostname,port:Number(url.port),timeout:30000});
const marker='dd-monitor-config-'+crypto.randomBytes(6).toString('hex'),source=fs.readFileSync('docker-compose.yml','utf8');
const hash=crypto.createHash('sha256').update(source).digest('hex');
const program=`const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict'),crypto=require('crypto');
 const binary='/usr/libexec/docker/cli-plugins/docker-compose';
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),fs.readFileSync('/usr/share/docker-dash/scanners/docker-compose.sha256','utf8').trim().split(/\\s+/)[0]);
 fs.writeFileSync('/tmp/compose.yml',${JSON.stringify(source)});fs.writeFileSync('/tmp/.env','');
 const config=(args=[])=>JSON.parse(cp.execFileSync('docker',['compose','--env-file','/tmp/.env','-p',${JSON.stringify(marker)},'-f','/tmp/compose.yml',...args,'config','--format','json'],{encoding:'utf8',timeout:20000}));
 const plain=config();assert.ok(plain.services.app);assert.equal(plain.services.app.secrets,undefined);
 fs.mkdirSync('/tmp/.secrets',{mode:0o700});fs.writeFileSync('/tmp/.secrets/monitoring-token','fixture-not-a-credential');
 const profile=config(['--profile','observability']);assert.ok(profile.services.prometheus);
 assert.ok(profile.services.prometheus.secrets.some(item=>item.source==='monitoring_token'));
 assert.equal(profile.secrets.monitoring_token.file,'/tmp/.secrets/monitoring-token');
 console.log(JSON.stringify({checks:['compose-provenance','app-config-without-monitoring-credential','observability-secret-mapping'],composeSha256:${JSON.stringify(hash)}}));`;
(async()=>{
 const container=await docker.createContainer({name:marker,Image:image,Entrypoint:['node'],Cmd:['-e',program],Labels:{'com.docker-dash.monitoring-config':marker},
  HostConfig:{NetworkMode:'none',Memory:268435456,NanoCpus:1000000000,PidsLimit:64,CapDrop:['ALL'],SecurityOpt:['no-new-privileges']}});
 try{
  await container.start();const result=await container.wait();const logs=await container.logs({stdout:true,stderr:true});let output='';
  for(let offset=0;offset<logs.length;){const size=logs.readUInt32BE(offset+4);output+=logs.subarray(offset+8,offset+8+size).toString();offset+=8+size;}
  assert.equal(result.StatusCode,0,output.slice(-4096));
  console.log(JSON.stringify({at:new Date().toISOString(),image,...JSON.parse(output.split('\n').find(line=>line.startsWith('{"checks":')))}));
 }finally{
  assert.equal((await container.inspect()).Config.Labels['com.docker-dash.monitoring-config'],marker);
  await container.remove({force:true,v:true});console.log('Removed owned monitoring config canary '+marker);
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
