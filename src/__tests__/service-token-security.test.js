'use strict';
Object.assign(process.env,{APP_ENV:'test',DB_PATH:':memory:',APP_SECRET:'service-token-fixture',ENCRYPTION_KEY:'service-token-fixture-key-32ch'});
const crypto=require('crypto'),express=require('express'),request=require('supertest');
const {getDb,closeDb}=require('../db'),identity=require('../services/identity-governance'),auth=require('../services/auth'),config=require('../config');
const app=express();app.use(express.json());app.use(require('cookie-parser')());app.use('/api/governance/controls',require('../routes/governance-controls'));
app.use((_error,_req,res,_next)=>res.status(500).json({error:'fixture'}));
let db,admin,session,sequence=0;const prior=config.features.governance;
const keys=crypto.generateKeyPairSync('ed25519');
function workload(){
 const issuer='https://service-token-'+(++sequence)+'.example.test';
 const input={name:'fixture',issuer,audience:'dashboard',subjectPattern:'job:*',identityKind:'oidc',
  jwks:{keys:[keys.publicKey.export({format:'jwk'})]},scopes:['api.read'],tokenTtlSeconds:300};
 const trust=identity.saveTrust(null,input,admin),now=Math.floor(Date.now()/1000);
 const data=Buffer.from(JSON.stringify({alg:'EdDSA'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({
  iss:issuer,aud:input.audience,sub:'job:fixture',iat:now,exp:now+300})).toString('base64url');
 const assertion=data+'.'+crypto.sign(null,Buffer.from(data),keys.privateKey).toString('base64url');
 const token=identity.exchange(assertion),id=identity.validateToken(token.accessToken).serviceTokenId;
 return {trust,input,token,id};
}
const manual=()=>identity.issueToken({name:'manual',principal:'fixture',scopes:['api.read'],ttlSeconds:300},admin);
const call=(method,path,body,authorization='Bearer '+session)=>request(app)[method]('/api/governance/controls'+path).set('Authorization',authorization).send(body);
beforeAll(()=>{db=getDb();config.features.governance=true;
 const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES ('service-token-admin','fixture','admin',0)").run().lastInsertRowid;
 admin=db.prepare('SELECT * FROM users WHERE id=?').get(id);session=auth._createSession(admin,'127.0.0.1','fixture').token;
});
afterAll(()=>{config.features.governance=prior;config.features.readOnly=false;closeDb();});
test('personal admin API keys cannot mint independent service credentials',async()=>{
 const key=require('../services/misc').apiKeys.create(admin.id,{name:'fixture',permissions:['write']}).key;
 expect((await call('post','/service-tokens',{name:'escape',principal:'escape',scopes:['scim.write'],ttlSeconds:600},'ApiKey '+key)).status).toBe(403);
});
test('failed issuance audit leaves no usable untracked credential',async()=>{
 const before=db.prepare('SELECT COUNT(*) n FROM governance_service_tokens').get().n;
 db.exec("CREATE TEMP TRIGGER fail_service_issue_audit BEFORE INSERT ON audit_log WHEN NEW.action='service_token_issue' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 try {expect((await call('post','/service-tokens',{name:'audit',principal:'audit',scopes:['api.read'],ttlSeconds:300})).status).toBe(500);}
 finally{db.exec('DROP TRIGGER fail_service_issue_audit');}
 expect(db.prepare('SELECT COUNT(*) n FROM governance_service_tokens').get().n).toBe(before);
});
test('disabled trust revokes existing tokens and rotations',()=>{
 const item=workload(),rotated=identity.rotateToken(item.id,{ttlSeconds:300},admin);
 identity.saveTrust(item.trust.id,{...item.input,enabled:false},admin);
 expect(identity.validateToken(rotated.token)).toBeNull();
});
test('workload rotation cannot outlive its verified proof',()=>{
 const item=workload(),rotated=identity.rotateToken(item.id,{ttlSeconds:86400},admin);
 expect(Date.parse(rotated.expires_at)).toBeLessThanOrEqual(Date.parse(item.token.expiresAt));
});
test('workload rotation cannot expand proof scopes',()=>{
 const item=workload();expect(()=>identity.rotateToken(item.id,{scopes:['api.write']},admin)).toThrow();
 expect(identity.validateToken(item.token.accessToken)).toBeTruthy();
});
test.each(['identity-realms','service-tokens','workload-trusts'])('credential lists require a signed-in administrator: %s',async path=>{
 const key=require('../services/misc').apiKeys.create(admin.id,{name:'fixture-list',permissions:['read','write']}).key;
 expect((await call('get','/'+path,undefined,'ApiKey '+key)).status).toBe(403);
 expect((await call('get','/'+path,undefined,'Bearer '+manual().token)).status).toBe(403);
 expect((await call('get','/'+path)).status).toBe(200);
});
test.each(['identity-realms','workload-trusts'])('personal keys cannot configure new identity authorities: %s',async path=>{
 const key=require('../services/misc').apiKeys.create(admin.id,{name:'fixture-config',permissions:['write']}).key;
 expect((await call('post','/'+path,{},'ApiKey '+key)).status).toBe(403);
});
test('successful issuance audits without persisting its raw credential in audit or list responses',async()=>{
 const response=await call('post','/service-tokens',{name:'http',principal:'http-fixture',scopes:['api.read'],ttlSeconds:300});
 expect(response.status).toBe(201);expect(response.headers['cache-control']).toBe('no-store');
 const event=db.prepare("SELECT * FROM audit_log WHERE action='service_token_issue' AND target_id=?").get(String(response.body.token.id));
 expect(event.username).toBe(admin.username);expect(JSON.stringify(event)).not.toContain(response.body.token.token);
 const list=await call('get','/service-tokens');expect(list.headers['cache-control']).toBe('no-store');
 expect(JSON.stringify(list.body)).not.toContain(response.body.token.token);
});
test('failed rotation audit restores the original credential and creates no replacement',async()=>{
 const token=manual(),before=db.prepare('SELECT COUNT(*) n FROM governance_service_tokens').get().n;
 db.exec("CREATE TEMP TRIGGER fail_rotate_audit BEFORE INSERT ON audit_log WHEN NEW.action='service_token_rotate' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 try{expect((await call('post','/service-tokens/'+token.id+'/rotate',{})).status).toBe(500);}
 finally{db.exec('DROP TRIGGER fail_rotate_audit');}
 expect(identity.validateToken(token.token)).toBeTruthy();expect(db.prepare('SELECT COUNT(*) n FROM governance_service_tokens').get().n).toBe(before);
});
test('explicit revocation stays committed even if audit fails and reaches rotation descendants',async()=>{
 const original=manual(),next=identity.rotateToken(original.id,{},admin),last=identity.rotateToken(next.id,{},admin);
 db.exec("CREATE TEMP TRIGGER fail_revoke_audit BEFORE INSERT ON audit_log WHEN NEW.action='service_token_revoke' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 try{expect((await call('delete','/service-tokens/'+original.id)).status).toBe(500);}
 finally{db.exec('DROP TRIGGER fail_revoke_audit');}
 expect(identity.validateToken(last.token)).toBeNull();expect(()=>identity.rotateToken(last.id,{},admin)).toThrow();
});
test('rotation checks current token state while holding the SQLite write transaction',()=>{
 const token=manual(),original=identity.tokenInfo;
 const spy=jest.spyOn(identity,'tokenInfo').mockImplementation(function(id){expect(db.inTransaction).toBe(true);return original.call(this,id);});
 try{identity.rotateToken(token.id,{},admin);}finally{spy.mockRestore();}
 expect(()=>identity.rotateToken(token.id,{},admin)).toThrow();
});
test('validation reads credential state and trust inside one write transaction',()=>{
 const item=workload(),original=db.prepare;
 const spy=jest.spyOn(db,'prepare').mockImplementation(function(sql){
  if (sql.includes('SELECT * FROM governance_service_tokens')||sql.includes('SELECT * FROM governance_workload_identity_trusts')) expect(db.inTransaction).toBe(true);
  return original.call(this,sql);
 });
 try{expect(identity.validateToken(item.token.accessToken)).toBeTruthy();}finally{spy.mockRestore();}
});
test('trust deletion revokes rotated workload tokens but preserves unrelated manual credentials',()=>{
 const item=workload(),next=identity.rotateToken(item.id,{},admin),last=identity.rotateToken(next.id,{},admin),other=manual();
 identity.deleteTrust(item.trust.id,admin);
 expect(identity.validateToken(last.token)).toBeNull();expect(identity.validateToken(other.token)).toBeTruthy();
 expect(identity.tokenInfo(last.id).revoked_at).toBeTruthy();
});
test.each(['scopes','subjectPattern','audience','issuer','tokenTtlSeconds','jwks'])('changing trust policy revokes issued tokens: %s',field=>{
 const item=workload(),changes={scopes:['scim.read'],subjectPattern:'job:other',audience:'other',issuer:'https://other.example.test',tokenTtlSeconds:60,
  jwks:{keys:[crypto.generateKeyPairSync('ed25519').publicKey.export({format:'jwk'})]}};
 identity.saveTrust(item.trust.id,{...item.input,[field]:changes[field]},admin);
 expect(identity.validateToken(item.token.accessToken)).toBeNull();
});
test('renaming a trust preserves its authority and issued tokens',()=>{
 const item=workload();identity.saveTrust(item.trust.id,{...item.input,name:'renamed'},admin);
 expect(identity.validateToken(item.token.accessToken)).toBeTruthy();
});
test('failed trust update audit rolls back both authority change and revocation; caller must retry',async()=>{
 const item=workload();db.exec("CREATE TEMP TRIGGER fail_trust_audit BEFORE INSERT ON audit_log WHEN NEW.action='workload_trust_update' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 try{expect((await call('put','/workload-trusts/'+item.trust.id,{...item.input,enabled:false})).status).toBe(500);}
 finally{db.exec('DROP TRIGGER fail_trust_audit');}
 expect(identity.validateToken(item.token.accessToken)).toBeTruthy();
 expect((await call('put','/workload-trusts/'+item.trust.id,{...item.input,enabled:false})).status).toBe(200);
 expect(identity.validateToken(item.token.accessToken)).toBeNull();
});
test.each(['null','{}','"api.read"','[]','["api.unknown"]','[null]'])('corrupt stored scopes fail closed: %s',scopes=>{
 const token=manual();db.prepare('UPDATE governance_service_tokens SET scopes_json=? WHERE id=?').run(scopes,token.id);
 expect(identity.validateToken(token.token)).toBeNull();
});
test.each(['invalid','1970-01-01T00:00:00.000Z'])('invalid or expired service credentials cannot authenticate or rotate: %s',expiry=>{
 const token=manual();db.prepare('UPDATE governance_service_tokens SET expires_at=? WHERE id=?').run(expiry,token.id);
 expect(identity.validateToken(token.token)).toBeNull();expect(()=>identity.rotateToken(token.id,{},admin)).toThrow();
});
test('read-only mode denies issue, rotate, revoke and trust changes without state changes',async()=>{
 const token=manual(),item=workload();config.features.readOnly=true;
 try{
  expect((await call('post','/service-tokens',{})).status).toBe(403);
  expect((await call('post','/service-tokens/'+token.id+'/rotate',{})).status).toBe(403);
  expect((await call('delete','/service-tokens/'+token.id)).status).toBe(403);
  expect((await call('put','/workload-trusts/'+item.trust.id,{...item.input,enabled:false})).status).toBe(403);
  expect((await call('delete','/workload-trusts/'+item.trust.id)).status).toBe(403);
 }finally{config.features.readOnly=false;}
 expect(identity.validateToken(token.token)).toBeTruthy();expect(identity.validateToken(item.token.accessToken)).toBeTruthy();
});
test('migration revokes unlinked legacy workload lineages, keeps manual tokens, and never resurrects on downgrade',()=>{
 const item=workload(),rotation=identity.rotateToken(item.id,{},admin),independent=manual();
 const copy=new (require('better-sqlite3'))(db.serialize()),migration=require('../db/migrations/184_service_token_lineage');
 try{
  migration.down(copy);migration.up(copy);
  expect(copy.prepare('SELECT revoked_at FROM governance_service_tokens WHERE id=?').get(rotation.id).revoked_at).toBeTruthy();
  expect(copy.prepare('SELECT revoked_at FROM governance_service_tokens WHERE id=?').get(independent.id).revoked_at).toBeNull();
  migration.down(copy);expect(copy.prepare('SELECT revoked_at FROM governance_service_tokens WHERE id=?').get(rotation.id).revoked_at).toBeTruthy();
 }finally{copy.close();}
});
