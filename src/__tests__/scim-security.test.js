'use strict';
Object.assign(process.env,{APP_ENV:'test',DB_PATH:':memory:',APP_SECRET:'scim-fixture',ENCRYPTION_KEY:'scim-fixture-encryption-key-32ch'});
const express=require('express'),request=require('supertest'),{getDb,closeDb}=require('../db'),auth=require('../services/auth');
const scim=require('../services/scim'),identity=require('../services/identity-governance'),config=require('../config');
const app=express();app.use(express.json());app.use(require('cookie-parser')());app.use('/api/scim/v2',require('../routes/scim'));
app.use((err,_req,res,_next)=>res.status(500).json({error:err.name}));
let db,admin,viewer,operator,team;const prior=config.features.governance;
const session=user=>auth._createSession(user,'127.0.0.1','scim-fixture').token;
const token=scopes=>identity.issueToken({name:'fixture',principal:'fixture-scim',scopes,ttlSeconds:600},admin).token;
const call=(method,path,credential,body)=>request(app)[method]('/api/scim/v2'+path).set('Authorization','Bearer '+credential).send(body);
beforeAll(()=>{
 db=getDb();config.features.governance=true;
 [admin,viewer,operator]=['admin','viewer','operator'].map(role=>{
  const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES (?,'fixture',?,0)").run('scim-security-'+role,role).lastInsertRowid;
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
 });
 team=Number(db.prepare("INSERT INTO teams(name,description) VALUES ('local-security-team','local')").run().lastInsertRowid);
});
afterAll(()=>{config.features.governance=prior;config.features.readOnly=false;closeDb();});
test.each(['viewer','operator'])('%s cannot modify local users through SCIM',async role=>{
 const before=db.prepare('SELECT * FROM users WHERE id=?').get(admin.id);
 expect((await call('patch','/Users/'+admin.id,session(role==='viewer'?viewer:operator),{Operations:[{op:'replace',path:'active',value:false}]})).status).toBe(403);
 expect(db.prepare('SELECT * FROM users WHERE id=?').get(admin.id)).toEqual(before);
});
test('SCIM cannot claim a local team',()=>{
 expect(()=>scim.replaceGroup(team,{displayName:'claimed',members:[]})).toThrow();
 expect(db.prepare('SELECT name FROM teams WHERE id=?').get(team).name).toBe('local-security-team');
});
test('SCIM cannot claim a local user',()=>{
 expect(()=>scim.replaceUser(viewer.id,{userName:'claimed',active:true})).toThrow();
 expect(db.prepare('SELECT auth_source FROM users WHERE id=?').get(viewer.id).auth_source).toBe('local');
});
test('SCIM provisioning scope is required for service tokens',async()=>{
 expect((await call('post','/Users',token(['scim.read']),{userName:'should-not-exist'})).status).toBe(403);
});
test('admin sessions and broad API service scopes cannot substitute for SCIM credentials',async()=>{
 expect((await call('get','/Users',session(admin))).status).toBe(403);
 expect((await call('get','/Users',token(['api.read']))).status).toBe(403);
 expect((await call('post','/Users',token(['api.write']),{userName:'generic-api-denied'})).status).toBe(403);
});
test('personal admin API keys cannot substitute for a scoped service credential',async()=>{
 const raw=require('../services/misc').apiKeys.create(admin.id,{name:'admin-scim-denied',permissions:['read','write']}).key;
 expect((await request(app).get('/api/scim/v2/Users').set('Authorization','ApiKey '+raw)).status).toBe(403);
});
test.each(['get','post','put','patch','delete'])('ordinary users cannot access SCIM via %s',async method=>{
 expect((await call(method,method==='post'||method==='get'?'/Groups':'/Groups/'+team,session(viewer),{})).status).toBe(403);
});
test('service scopes cannot be used as a global tenant escape',async()=>{
 const tenant=db.prepare("INSERT INTO tenants(slug,name) VALUES ('scim-security-tenant','SCIM tenant')").run().lastInsertRowid;
 const scoped=identity.issueToken({name:'tenant',principal:'tenant-scim',scopes:['scim.read','scim.write'],tenantId:tenant,ttlSeconds:600},admin).token;
 expect((await call('get','/Users',scoped)).status).toBe(403);
 expect((await call('post','/Users',scoped,{userName:'tenant-escape'})).status).toBe(403);
});
test('SCIM discovery and lists exclude local users and groups',async()=>{
 const credential=token(['scim.read']);
 expect((await call('get','/ServiceProviderConfig',credential)).status).toBe(200);
 expect((await call('get','/Users/'+admin.id,credential)).status).toBe(404);
 expect((await call('get','/Groups/'+team,credential)).status).toBe(404);
 expect((await call('get','/Users',credential)).body.Resources.some(item=>item.id===String(admin.id))).toBe(false);
 expect((await call('get','/Groups',credential)).body.Resources.some(item=>item.id===String(team))).toBe(false);
});
test.each(['put','patch','delete'])('authorized SCIM cannot mutate local resources with %s',async method=>{
 const credential=token(['scim.write']);
 const userBefore=db.prepare('SELECT * FROM users WHERE id=?').get(admin.id);
 expect((await call(method,'/Users/'+admin.id,credential,{userName:'claimed',Operations:[{op:'replace',path:'active',value:false}]})).status).toBe(404);
 expect((await call(method,'/Groups/'+team,credential,{displayName:'claimed',members:[],Operations:[{op:'replace',path:'displayName',value:'claimed'}]})).status).toBe(404);
 expect(db.prepare('SELECT * FROM users WHERE id=?').get(admin.id)).toEqual(userBefore);
});
test('authorized provisioning and deactivation audit the service principal',async()=>{
 const credential=token(['scim.read','scim.write']);
 const created=await call('post','/Users',credential,{userName:'managed-http',roles:[{value:'admin'}]});
 expect(created.status).toBe(201);expect(created.body.roles).toEqual([{value:'viewer'}]);
 const id=Number(created.body.id),key=require('../services/misc').apiKeys.create(id,{name:'deactivation'}).key;
 const userSession=session(db.prepare('SELECT * FROM users WHERE id=?').get(id));
 expect((await call('patch','/Users/'+id,credential,{Operations:[{op:'replace',path:'active',value:false}]})).status).toBe(200);
 expect(auth.validateSession(userSession)).toBeNull();expect(require('../services/misc').apiKeys.validate(key)).toBeNull();
 const events=db.prepare("SELECT username,action,details FROM audit_log WHERE target_id=? AND action LIKE 'scim_%' ORDER BY id").all(String(id));
 expect(events.map(item=>item.action)).toEqual(['scim_user_create','scim_user_patch']);
 expect(events.every(item=>item.username==='fixture-scim'&&JSON.parse(item.details).serviceTokenId)).toBe(true);
});
test('group mutation cannot enroll local members or leave stale ownership after deletion',()=>{
 const member=scim.createUser({userName:'managed-member'}),group=scim.createGroup({displayName:'managed-group',members:[{value:member.id}]});
 expect(()=>scim.replaceGroup(group.id,{displayName:'changed',members:[{value:admin.id}]})).toThrow('SCIM-managed');
 expect(scim.getGroup(group.id).displayName).toBe('managed-group');expect(scim.getGroup(group.id).members).toHaveLength(1);
 scim.deleteGroup(group.id);expect(db.prepare("SELECT 1 FROM governance_scim_resources WHERE resource_type='Group' AND local_id=?").get(Number(group.id))).toBeUndefined();
});
test('a stale SCIM mapping cannot claim an account moved to another auth source',()=>{
 const user=scim.createUser({userName:'managed-moved'});
 db.prepare("UPDATE users SET auth_source='local' WHERE id=?").run(Number(user.id));
 expect(()=>scim.patchUser(user.id,{Operations:[{op:'replace',path:'active',value:false}]})).toThrow('not found');
});
test('duplicate external identity rolls user creation back',()=>{
 scim.createUser({userName:'managed-original',externalId:'external-shared'});
 expect(()=>scim.createUser({userName:'managed-duplicate',externalId:'external-shared'})).toThrow();
 expect(db.prepare("SELECT 1 FROM users WHERE username='managed-duplicate'").get()).toBeUndefined();
});
test('audit failure rolls provisioning back without an untracked account',async()=>{
 db.exec("CREATE TEMP TRIGGER fail_scim_audit BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'scim_%' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
 try {
  expect((await call('post','/Users',token(['scim.write']),{userName:'managed-audit-failed'})).status).toBe(500);
  expect(db.prepare("SELECT 1 FROM users WHERE username='managed-audit-failed'").get()).toBeUndefined();
 } finally {db.exec('DROP TRIGGER fail_scim_audit');}
});
test('read-only mode prevents authorized provisioning',async()=>{
 config.features.readOnly=true;
 try {expect((await call('post','/Users',token(['scim.write']),{userName:'managed-readonly'})).status).toBe(403);}
 finally {config.features.readOnly=false;}
});
