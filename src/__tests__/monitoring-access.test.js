'use strict';
Object.assign(process.env,{APP_ENV:'test',DB_PATH:':memory:',APP_SECRET:'monitoring-fixture',ENCRYPTION_KEY:'monitoring-fixture-key-32chars'});
const express=require('express'),request=require('supertest'),{getDb,closeDb}=require('../db');
const auth=require('../services/auth'),identity=require('../services/identity-governance');
const app=express();app.use(express.json());app.use(require('cookie-parser')());app.use('/api',require('../routes/misc'));
let db,admin,viewer,tenant;const session=user=>auth._createSession(user,'127.0.0.1','fixture').token;
const token=(scopes,tenantId=null)=>identity.issueToken({name:'monitor',principal:'fixture-monitor',scopes,tenantId,ttlSeconds:300},admin).token;
beforeAll(()=>{db=getDb();[admin,viewer]=['admin','viewer'].map(role=>{
 const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES (?,'fixture',?,0)").run('monitoring-'+role,role).lastInsertRowid;
 return db.prepare('SELECT * FROM users WHERE id=?').get(id);
});tenant=db.prepare("INSERT INTO tenants(slug,name) VALUES ('monitoring-tenant','Fixture')").run().lastInsertRowid;});
afterAll(()=>closeDb());
describe.each(['/api/metrics','/api/cluster/status'])('%s',path=>{
 test.each(['get','head'])('anonymous %s is denied',async method=>{expect((await request(app)[method](path)).status).toBe(401);});
 test('viewer sessions cannot read global monitoring data',async()=>{expect((await request(app).get(path).set('Authorization','Bearer '+session(viewer))).status).toBe(403);});
 test('tenant service credentials cannot read global monitoring data',async()=>{expect((await request(app).get(path).set('Authorization','Bearer '+token(['api.read'],tenant))).status).toBe(403);});
 test('unrelated service scopes cannot read monitoring data',async()=>{expect((await request(app).get(path).set('Authorization','Bearer '+token(['api.write']))).status).toBe(403);});
 test('dedicated global monitoring credentials work and are not cached',async()=>{
  const response=await request(app).get(path).set('Authorization','Bearer '+token(['monitoring.read']));
  expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  if(path.endsWith('metrics')){expect(response.headers['content-type']).toContain('version=0.0.4');expect(response.text).toContain('docker_dash_');}
  else expect(response.body.mode).toBe('standalone');
 });
 test('global api.read credentials remain compatible',async()=>{expect((await request(app).get(path).set('Authorization','Bearer '+token(['api.read']))).status).toBe(200);});
 test('administrator sessions can read monitoring',async()=>{expect((await request(app).get(path).set('Authorization','Bearer '+session(admin))).status).toBe(200);});
 test('administrator read API keys work; write-only keys do not',async()=>{
  const keys=require('../services/misc').apiKeys;
  const read=keys.create(admin.id,{name:'monitor-read',permissions:['read']}).key,write=keys.create(admin.id,{name:'monitor-write',permissions:['write']}).key;
  expect((await request(app).get(path).set('Authorization','ApiKey '+read)).status).toBe(200);
  expect((await request(app).get(path).set('Authorization','ApiKey '+write)).status).toBe(403);
 });
 test('viewer API keys cannot inherit global monitoring authority',async()=>{
  const key=require('../services/misc').apiKeys.create(viewer.id,{name:'viewer-monitor',permissions:['read']}).key;
  expect((await request(app).get(path).set('Authorization','ApiKey '+key)).status).toBe(403);
 });
 test.each(['invalid','expired','revoked'])('%s credentials are refused without a public fallback',async mode=>{
  let raw='invalid';if(mode!=='invalid'){
   raw=token(['monitoring.read']);const id=identity.validateToken(raw).serviceTokenId;
   if(mode==='expired')db.prepare("UPDATE governance_service_tokens SET expires_at='1970-01-01T00:00:00Z' WHERE id=?").run(id);
   else identity.revokeToken(id,admin);
  }
  const response=await request(app).get(path).set('Authorization','Bearer '+raw);
  expect(response.status).toBe(401);expect(response.headers['cache-control']).toBe('no-store');
 });
 test('authenticated HEAD and case/trailing-slash variants obey the same scope',async()=>{
  const raw=token(['monitoring.read']);
  expect((await request(app).head(path).set('Authorization','Bearer '+raw)).status).toBe(200);
  expect((await request(app).get(path.toUpperCase()+'/').set('Authorization','Bearer '+raw)).status).toBe(200);
 });
 test('tenant monitoring scope is never interpreted as global',async()=>{
  expect((await request(app).get(path).set('Authorization','Bearer '+token(['monitoring.read'],tenant))).status).toBe(403);
 });
});
test('monitoring scope cannot read arbitrary application data',async()=>{
 expect((await request(app).get('/api/settings').set('Authorization','Bearer '+token(['monitoring.read']))).status).toBe(403);
});
test('dedicated collector API keys only allow monitoring GET/HEAD and require an active administrator',async()=>{
 const keys=require('../services/misc').apiKeys;
 const raw=keys.create(admin.id,{name:'collector',permissions:['monitoring.read']}).key;
 const call=(method,path,key=raw)=>request(app)[method](path).set('Authorization','ApiKey '+key);
 for(const path of ['/api/metrics','/api/cluster/status']) {
  expect((await call('get',path)).status).toBe(200);
  expect((await call('head',path.toUpperCase()+'/')).status).toBe(200);
 }
 for(const path of ['/api/settings','/api/api-keys','/api/footprint'])expect((await call('get',path)).status).toBe(403);
 expect((await call('post','/api/api-keys')) .status).toBe(403);
 const viewerKey=keys.create(viewer.id,{name:'collector-viewer',permissions:['monitoring.read']}).key;
 expect((await call('get','/api/metrics',viewerKey)).status).toBe(403);
 const expired=keys.create(admin.id,{name:'collector-expiry',permissions:['monitoring.read']}).key;
 db.prepare("UPDATE api_keys SET expires_at='2000-01-01T00:00:00Z' WHERE key_hash=?").run(require('../utils/crypto').sha256(expired));
 expect((await call('get','/api/metrics',expired)).status).toBe(401);
 db.prepare('UPDATE users SET role=? WHERE id=?').run('viewer',admin.id);
 try {expect((await call('get','/api/metrics')).status).toBe(403);}
 finally {db.prepare('UPDATE users SET role=? WHERE id=?').run('admin',admin.id);}
 db.prepare('UPDATE api_keys SET is_active=0 WHERE key_hash=?').run(require('../utils/crypto').sha256(raw));
 expect((await call('get','/api/metrics')).status).toBe(401);
});
test('denied requests never collect container statistics',async()=>{
 const spy=jest.spyOn(require('../services/stats'),'getOverview');
 try{
  expect((await request(app).get('/api/metrics')).status).toBe(401);
  expect((await request(app).get('/api/metrics').set('Authorization','Bearer '+session(viewer))).status).toBe(403);
  expect(spy).not.toHaveBeenCalled();
 }finally{spy.mockRestore();}
});
test('public health and authenticated read-only-mode scraping remain available',async()=>{
 const config=require('../config'),previous=config.features.readOnly;config.features.readOnly=true;
 try{
  expect((await request(app).get('/api/health')).status).toBe(200);
  expect((await request(app).get('/api/metrics').set('Authorization','Bearer '+token(['monitoring.read']))).status).toBe(200);
 }finally{config.features.readOnly=previous;}
});
test('bundled and generated scrape configurations load the same credential file',()=>{
 const yaml=require('yaml'),fs=require('fs');
 const bundled=yaml.parse(fs.readFileSync('docker/observability/prometheus.yml','utf8'));
 const generated=yaml.parse(require('../services/observability-import').scrapeConfigSnippet());
 for(const configuration of [bundled,generated])expect(configuration.scrape_configs.find(job=>job.job_name==='docker-dash').authorization)
  .toEqual({type:'Bearer',credentials_file:'/run/secrets/monitoring_token'});
 const compose=yaml.parse(fs.readFileSync('docker-compose.yml','utf8'));
 expect(compose.services.prometheus.secrets).toContain('monitoring_token');
 expect(compose.secrets.monitoring_token.file).toContain('MONITORING_TOKEN_FILE');
});
