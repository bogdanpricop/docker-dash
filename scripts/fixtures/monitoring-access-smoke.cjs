'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
module.exports=async(db,checks)=>{
 const express=require('express'),auth=require('/app/src/services/auth'),identity=require('/app/src/services/identity-governance');
 const users=['admin','viewer'].map(role=>{
  const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES (?,'fixture',?,0)").run('native-monitor-'+role,role).lastInsertRowid;
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
 });
 const app=express();app.use(express.json());app.use(require('cookie-parser')());app.use('/api',require('/app/src/routes/misc'));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const call=async(path,credential,method='GET',scheme='Bearer')=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{method,
   headers:credential?{authorization:scheme+' '+credential}:{},signal:AbortSignal.timeout(2500)});
  return {status:response.status,type:response.headers.get('content-type'),cache:response.headers.get('cache-control'),body:await response.text()};
 };
 const issue=()=>identity.issueToken({name:'native-monitor',principal:'native-monitor',scopes:['monitoring.read'],ttlSeconds:300},users[0]);
 try{
  const viewer=auth._createSession(users[1],'127.0.0.1','fixture').token;
  for(const path of ['/metrics','/cluster/status']){
   assert.equal((await call(path)).status,401);assert.equal((await call(path,undefined,'HEAD')).status,401);
   assert.equal((await call(path,viewer)).status,403);
  }
  checks.push('native-global-monitoring-denies-anonymous-and-restricted-users');
  const original=issue();fs.writeFileSync('/tmp/monitoring-token',original.token,{mode:0o600});
  const response=await call('/metrics',fs.readFileSync('/tmp/monitoring-token','utf8'));
  assert.equal(response.status,200);assert.equal(response.cache,'no-store');assert.match(response.type,/version=0\.0\.4/);assert.match(response.body,/docker_dash_/);
  assert.equal((await call('/cluster/status',original.token)).status,200);assert.equal((await call('/settings',original.token)).status,403);
  const replacement=identity.rotateToken(original.id,{},users[0]);fs.writeFileSync('/tmp/monitoring-token',replacement.token);
  assert.equal((await call('/metrics',original.token)).status,401);assert.equal((await call('/metrics',fs.readFileSync('/tmp/monitoring-token','utf8'))).status,200);
  identity.revokeToken(replacement.id,users[0]);assert.equal((await call('/metrics',replacement.token)).status,401);
  checks.push('native-global-monitoring-scope-format-rotation-and-revocation');
  assert.equal((await call('/health')).status,200);
  const admin=auth._createSession(users[0],'127.0.0.1','fixture').token;
  assert.equal((await call('/cluster/status',admin)).status,200);
  const tenant=db.prepare("INSERT INTO tenants(slug,name) VALUES ('native-monitor-tenant','Monitor')").run().lastInsertRowid;
  const scoped=identity.issueToken({name:'tenant',principal:'tenant',scopes:['monitoring.read'],tenantId:tenant,ttlSeconds:300},users[0]);
  assert.equal((await call('/metrics',scoped.token)).status,403);assert.equal((await call('/cluster/status',scoped.token)).status,403);
  checks.push('native-monitoring-keeps-health-public-and-denies-tenant-scope');
  const keys=require('/app/src/services/misc').apiKeys;
  const key=keys.create(users[0].id,{name:'native-collector',permissions:['monitoring.read']}).key;
  assert.equal((await call('/metrics',key,'GET','ApiKey')).status,200);
  assert.equal((await call('/cluster/status',key,'HEAD','ApiKey')).status,200);
  assert.equal((await call('/settings',key,'GET','ApiKey')).status,403);
  assert.equal((await call('/api-keys',key,'POST','ApiKey')).status,403);
  db.prepare('UPDATE users SET role=? WHERE id=?').run('viewer',users[0].id);
  assert.equal((await call('/metrics',key,'GET','ApiKey')).status,403);
  db.prepare('UPDATE users SET role=? WHERE id=?').run('admin',users[0].id);
  db.prepare('UPDATE api_keys SET is_active=0 WHERE key_hash=?').run(require('/app/src/utils/crypto').sha256(key));
  assert.equal((await call('/metrics',key,'GET','ApiKey')).status,401);
  checks.push('native-dedicated-collector-key-restriction-demotion-and-revocation');
 }finally{await new Promise(resolve=>server.close(resolve));}
};
