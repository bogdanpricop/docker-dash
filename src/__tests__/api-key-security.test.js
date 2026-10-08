'use strict';
Object.assign(process.env,{APP_ENV:'test',DB_PATH:':memory:',APP_SECRET:'api-key-fixture',ENCRYPTION_KEY:'api-key-fixture-encryption-key-32'});
const {getDb,closeDb}=require('../db'),{apiKeys}=require('../services/misc'),auth=require('../services/auth');
const express=require('express'),request=require('supertest'),config=require('../config'),{sha256}=require('../utils/crypto');
const app=express();app.use(express.json());app.use(require('cookie-parser')());
app.use('/api/api-keys',require('../routes/misc-api-keys'));
app.get('/api/private',require('../middleware/auth').requireAuth,(_req,res)=>res.json({ok:true}));
let db,user,key,session;const priorAge=config.security.passwordMaxAgeDays;
beforeAll(()=>{db=getDb();});
beforeEach(()=>{
  config.security.passwordMaxAgeDays=0;config.features.readOnly=false;
  const id=Number(db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES (?,'fixture','operator',0)").run('api-key-'+Math.random()).lastInsertRowid);
  user=db.prepare('SELECT * FROM users WHERE id=?').get(id);
  key=apiKeys.create(id,{name:'fixture',permissions:['read','write']}).key;
  session=auth._createSession(user,'127.0.0.1','fixture').token;
});
afterAll(()=>{config.security.passwordMaxAgeDays=priorAge;config.features.readOnly=false;closeDb();});
function expiry(value){db.prepare('UPDATE api_keys SET expires_at=? WHERE key_hash=?').run(value,sha256(key));}
test.each(['invalid','', '2026-garbage'])('invalid persisted expiry %j refuses authentication',value=>{
  expiry(value);expect(apiKeys.validate(key)).toBeNull();
  expect(db.prepare('SELECT last_used_at FROM api_keys WHERE key_hash=?').get(sha256(key)).last_used_at).toBeNull();
});
test.each(['iso','sqlite','offset'])('expired %s key is denied by real HTTP',async format=>{
  let value=new Date(Date.now()-10000).toISOString();
  if(format==='sqlite')value=db.prepare("SELECT datetime('now','-10 seconds') value").get().value;
  if(format==='offset')value=new Date(Date.now()-10000+3*3600000).toISOString().replace('Z','+03:00');
  expiry(value);expect((await request(app).get('/api/private').set('Authorization','ApiKey '+key)).status).toBe(401);
});
test.each([null,'iso','sqlite','offset'])('valid expiry %j authenticates',kind=>{
  let value=kind;if(kind==='iso')value=new Date(Date.now()+60000).toISOString();
  if(kind==='sqlite')value=db.prepare("SELECT datetime('now','+1 minute') value").get().value;
  if(kind==='offset')value=new Date(Date.now()+60000+3*3600000).toISOString().replace('Z','+03:00');
  expiry(value);expect(apiKeys.validate(key).id).toBe(user.id);
});
test.each(['{', 'null', '"read"', '{"includes":true}', '["admin"]', '["read",42]'])('malformed stored permissions %s fail closed',value=>{
  db.prepare('UPDATE api_keys SET permissions=? WHERE key_hash=?').run(value,sha256(key));
  expect(apiKeys.validate(key)).toBeNull();
});
test('forced password change applies to API-key requests',async()=>{
  db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(user.id);
  expect((await request(app).get('/api/private').set('Authorization','ApiKey '+key)).status).toBe(403);
});
test.each(['expired','invalid','future'])('local password age policy rejects %s metadata for sessions and keys',async kind=>{
  config.security.passwordMaxAgeDays=1;
  const value=kind==='expired'?db.prepare("SELECT datetime('now','-2 days') value").get().value:kind==='future'?new Date(Date.now()+86400000).toISOString():'invalid';
  db.prepare('UPDATE users SET password_changed_at=? WHERE id=?').run(value,user.id);
  expect(auth.validateSession(session).mustChangePassword).toBe(true);expect(apiKeys.validate(key).mustChangePassword).toBe(true);
});
test('new local accounts use creation time when password_changed_at is absent',()=>{
  config.security.passwordMaxAgeDays=1;expect(auth.validateSession(session).mustChangePassword).toBe(false);
  expect(apiKeys.validate(key).mustChangePassword).toBe(false);
});
test.each(['password_hash','auth_source','is_active','external_subject'])('changing %s permanently revokes personal keys',field=>{
  const values={password_hash:'new-hash',auth_source:'ldap',is_active:0,external_subject:'new-subject'};
  db.prepare('UPDATE users SET '+field+'=? WHERE id=?').run(values[field],user.id);
  db.prepare("UPDATE users SET is_active=1,auth_source='local' WHERE id=?").run(user.id);
  expect(apiKeys.validate(key)).toBeNull();
});
test.each(['invalid',42,'2099-02-30T10:00:00Z','2099-10-01T24:00:00Z','2026-10-01','2026-10-01T10:00:00',new Date(Date.now()-1000).toISOString()])('issuance rejects invalid expiry %j without writing',expiresAt=>{
  const before=db.prepare('SELECT COUNT(*) n FROM api_keys').get().n;
  expect(()=>apiKeys.create(user.id,{name:'invalid',expiresAt})).toThrow();expect(db.prepare('SELECT COUNT(*) n FROM api_keys').get().n).toBe(before);
});
test('a key cannot issue another key or manage credentials',async()=>{
  for(const [method,path] of [['post','/api/api-keys'],['delete','/api/api-keys/1']]) {
    expect((await request(app)[method](path).set('Authorization','ApiKey '+key).send({name:'derived',permissions:['*']})).status).toBe(403);
  }
});
test('external accounts skip local password age but respect explicit password-change requirements',()=>{
  db.prepare("UPDATE users SET auth_source='oidc',password_changed_at='invalid' WHERE id=?").run(user.id);
  config.security.passwordMaxAgeDays=1;
  const external=apiKeys.create(user.id,{name:'external',permissions:['*']}).key;
  expect(apiKeys.validate(external).mustChangePassword).toBe(false);
  db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(user.id);
  expect(apiKeys.validate(external).mustChangePassword).toBe(true);
  expect(()=>apiKeys.create(user.id,{name:'blocked'})).toThrow('Account cannot issue');
});
test('key revocation preserves keys owned by another account',async()=>{
  const foreign=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES ('foreign-owner','fixture','viewer',0)").run().lastInsertRowid;
  const other=apiKeys.create(foreign,{name:'foreign'}).key;
  const row=db.prepare('SELECT id FROM api_keys WHERE key_hash=?').get(sha256(other));
  expect((await request(app).delete('/api/api-keys/'+row.id).set('Authorization','Bearer '+session)).status).toBe(404);
  expect(apiKeys.validate(other)).toBeTruthy();
});
test('migration backfill revokes inactive and legacy keys while preserving active accounts',()=>{
  const migration=require('../db/migrations/182_api_key_credential_revocation');
  migration.down(db);
  try {
    const keys=['active','inactive','legacy'].map((kind,i)=>{
      const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES (?,'fixture','viewer',0)").run('backfill-'+kind).lastInsertRowid;
      const value=apiKeys.create(id,{name:kind}).key;
      if(i===1)db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(id);
      if(i===2)db.prepare("UPDATE users SET auth_source='sso_legacy' WHERE id=?").run(id);
      return {id,value};
    });
    migration.up(db);
    expect(apiKeys.validate(keys[0].value)).toBeTruthy();
    for(const item of keys.slice(1)) {
      db.prepare("UPDATE users SET is_active=1,auth_source='local' WHERE id=?").run(item.id);
      expect(apiKeys.validate(item.value)).toBeNull();
    }
  } finally {
    if(!db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='users_api_key_credential_revocation'").get())migration.up(db);
  }
});
test('interactive creation validates input and audits revocation of an owned key',async()=>{
  expect((await request(app).post('/api/api-keys').set('Authorization','Bearer '+session).send({name:'bad',permissions:'write'})).status).toBe(400);
  const result=await request(app).post('/api/api-keys').set('Authorization','Bearer '+session).send({name:'valid',permissions:['read'],expiresAt:new Date(Date.now()+60000).toISOString()});
  expect(result.status).toBe(201);const row=db.prepare('SELECT id FROM api_keys WHERE key_hash=?').get(sha256(result.body.key));
  expect((await request(app).delete('/api/api-keys/'+row.id).set('Authorization','Bearer '+session)).status).toBe(200);
  expect(apiKeys.validate(result.body.key)).toBeNull();expect(db.prepare("SELECT id FROM audit_log WHERE action='apikey_revoke' AND target_id=?").get(String(row.id))).toBeTruthy();
});
test('read-only mode blocks key creation and revocation',async()=>{
  config.features.readOnly=true;
  for(const [method,path] of [['post','/api/api-keys'],['delete','/api/api-keys/1']]) expect((await request(app)[method](path).set('Authorization','Bearer '+session).send({name:'blocked'})).status).toBe(403);
});
test('audit failure rolls back issuance but does not restore a revoked key',async()=>{
  const count=db.prepare('SELECT COUNT(*) n FROM api_keys').get().n,row=db.prepare('SELECT id FROM api_keys WHERE key_hash=?').get(sha256(key));
  db.exec("CREATE TEMP TRIGGER fail_key_audit BEFORE INSERT ON audit_log WHEN NEW.action IN ('apikey_create','apikey_revoke') BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  try {
    expect((await request(app).post('/api/api-keys').set('Authorization','Bearer '+session).send({name:'audit-fails'})).status).toBe(500);
    expect(db.prepare('SELECT COUNT(*) n FROM api_keys').get().n).toBe(count);
    expect((await request(app).delete('/api/api-keys/'+row.id).set('Authorization','Bearer '+session)).status).toBe(500);
    expect(apiKeys.validate(key)).toBeNull();
  }finally{db.exec('DROP TRIGGER fail_key_audit');}
});
