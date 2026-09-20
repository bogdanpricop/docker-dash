'use strict';
Object.assign(process.env,{APP_ENV:'test',DB_PATH:':memory:',APP_SECRET:'workload-replay-fixture',ENCRYPTION_KEY:'workload-replay-fixture-key-32ch'});
const crypto=require('crypto'),{getDb,closeDb}=require('../db'),identity=require('../services/identity-governance');
let db,sequence=0;const actor={id:null,role:'admin'};
const rsa=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),ec=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
function fixture(algorithm='RS256',overrides={}) {
 const keys=algorithm==='ES256'?ec:rsa,issuer='https://workload-'+(++sequence)+'.example.test';
 const trustInput={name:'fixture',issuer,audience:'docker-dash',subjectPattern:'repo:org/*',identityKind:'oidc',
  jwks:{keys:[{...keys.publicKey.export({format:'jwk'}),kid:'fixture'}]},scopes:['api.read'],tokenTtlSeconds:300};
 const trust=identity.saveTrust(null,trustInput,actor);
 const now=Math.floor(Date.now()/1000),claims={iss:issuer,aud:'docker-dash',sub:'repo:org/app',iat:now,exp:now+300,...overrides};
 const sign=(payload=claims,header={alg:algorithm,kid:'fixture'})=>{
  const data=Buffer.from(JSON.stringify(header)).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature=crypto.sign('sha256',Buffer.from(data),algorithm==='ES256'?{key:keys.privateKey,dsaEncoding:'ieee-p1363'}:keys.privateKey).toString('base64url');
  return data+'.'+signature;
 };return {claims,sign,assertion:sign(),trust,trustInput};
}
beforeAll(()=>{db=getDb();});afterAll(()=>closeDb());
test('padding cannot turn an exchanged assertion into another credential',()=>{
 const {assertion}=fixture();identity.exchange(assertion);
 expect(()=>identity.exchange(assertion+'=')).toThrow();
});
test('the alternate valid ECDSA signature cannot replay the same signed assertion',()=>{
 const {assertion}=fixture('ES256');identity.exchange(assertion);
 const parts=assertion.split('.'),signature=Buffer.from(parts[2],'base64url');
 const order=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
 const alternate=Buffer.from((order-BigInt('0x'+signature.subarray(32).toString('hex'))).toString(16).padStart(64,'0'),'hex');
 parts[2]=Buffer.concat([signature.subarray(0,32),alternate]).toString('base64url');
 expect(()=>identity.exchange(parts.join('.'))).toThrow(expect.objectContaining({code:'ASSERTION_REPLAY'}));
});
test('an issuer JWT id cannot be redeemed again with newly signed claims',()=>{
 const item=fixture('RS256',{jti:'one-run'});identity.exchange(item.assertion);
 expect(()=>identity.exchange(item.sign({...item.claims,sub:'repo:org/other'}))).toThrow(expect.objectContaining({code:'ASSERTION_REPLAY'}));
});

test.each([{iat:'123'},{exp:'9999999999'},{nbf:'later'},{nbf:null},{iat:1.5},{exp:Number.MAX_SAFE_INTEGER+1},
 {iss:[]},{sub:{}},{aud:[]},{aud:['docker-dash',null]},{jti:''},{jti:123},{sub:'repo:org/\napp'}])('invalid claim types fail closed: %j',overrides=>{
 const item=fixture('RS256',overrides);expect(()=>identity.exchange(item.assertion)).toThrow(expect.objectContaining({status:401}));
});
test.each([{alg:'none'},{alg:'RS256',crit:[]},{alg:'RS256',b64:true},{alg:'RS256',kid:123}])('unsupported header fails closed: %j',header=>{
 const item=fixture();expect(()=>identity.exchange(item.sign(item.claims,header))).toThrow(expect.objectContaining({status:401}));
});
test.each([{alg:'ES256'},{use:'enc'},{key_ops:['sign']}])('key metadata must authorize verification: %j',metadata=>{
 const item=fixture();item.trustInput.jwks.keys[0]={...item.trustInput.jwks.keys[0],...metadata};
 identity.saveTrust(item.trust.id,item.trustInput,actor);
 expect(()=>identity.exchange(item.assertion)).toThrow(expect.objectContaining({code:'ASSERTION_SIGNATURE_INVALID'}));
});
test('disabled trust is checked inside the issuance transaction',()=>{
 const item=fixture();
 identity.saveTrust(item.trust.id,{...item.trustInput,enabled:false},actor);
 const original=identity._verifyAssertion;
 const spy=jest.spyOn(identity,'_verifyAssertion').mockImplementation(function(assertion){expect(db.inTransaction).toBe(true);return original.call(this,assertion);});
 try {expect(()=>identity.exchange(item.assertion)).toThrow(expect.objectContaining({code:'WORKLOAD_TRUST_NOT_FOUND'}));}finally{spy.mockRestore();}
});
test.each(['weak-rsa','wrong-curve'])('incompatible cryptographic keys are refused: %s',kind=>{
 const item=fixture(),weak=kind==='weak-rsa'?crypto.generateKeyPairSync('rsa',{modulusLength:1024}):crypto.generateKeyPairSync('ec',{namedCurve:'P-384'});
 item.trustInput.jwks={keys:[weak.publicKey.export({format:'jwk'})]};identity.saveTrust(item.trust.id,item.trustInput,actor);
 const data=Buffer.from(JSON.stringify({alg:kind==='weak-rsa'?'RS256':'ES256'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(item.claims)).toString('base64url');
 const signature=crypto.sign('sha256',Buffer.from(data),kind==='weak-rsa'?weak.privateKey:{key:weak.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 expect(()=>identity.exchange(data+'.'+signature)).toThrow(expect.objectContaining({code:'ASSERTION_SIGNATURE_INVALID'}));
});
test('recreating a trust does not erase replay history',()=>{
 const item=fixture();identity.exchange(item.assertion);identity.deleteTrust(item.trust.id,actor);
 identity.saveTrust(null,item.trustInput,actor);
 expect(()=>identity.exchange(item.assertion)).toThrow(expect.objectContaining({code:'ASSERTION_REPLAY'}));
});
test('independent issuers may use the same JWT id',()=>{
 identity.exchange(fixture('RS256',{jti:'shared'}).assertion);
 expect(identity.exchange(fixture('RS256',{jti:'shared'}).assertion).accessToken).toMatch(/^ddst_/);
});
test('short remaining validity is accepted without extending proof expiry',()=>{
 const item=fixture('RS256',{exp:Math.floor(Date.now()/1000)+20});
 const token=identity.exchange(item.assertion);expect(Date.parse(token.expiresAt)).toBeLessThanOrEqual(item.claims.exp*1000);
});
test('audit failure rolls back the token and replay slots; retry succeeds once',()=>{
 const item=fixture(),before=db.prepare('SELECT count(*) n FROM governance_service_tokens').get().n;
 expect(()=>identity.exchange(item.assertion,()=>{throw new Error('audit unavailable');})).toThrow('audit unavailable');
 expect(db.prepare('SELECT count(*) n FROM governance_service_tokens').get().n).toBe(before);
 expect(identity.exchange(item.assertion).accessToken).toMatch(/^ddst_/);
 expect(()=>identity.exchange(item.assertion)).toThrow(expect.objectContaining({code:'ASSERTION_REPLAY'}));
});
test('HTTP exchange enforces read-only, audit atomicity and no-store',async()=>{
 const express=require('express'),request=require('supertest'),config=require('../config');
 const app=express();app.use(express.json());app.use('/workload',require('../routes/workload-identity'));
 app.use((_error,_req,res,_next)=>res.status(500).json({error:'fixture'}));
 const item=fixture(),prior=config.features.governance;config.features.governance=true;
 const call=()=>request(app).post('/workload/exchange').send({assertion:item.assertion});
 try {
  config.features.readOnly=true;expect((await call()).status).toBe(403);config.features.readOnly=false;
  db.exec("CREATE TEMP TRIGGER fail_workload_audit BEFORE INSERT ON audit_log WHEN NEW.action='workload_identity_exchange' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  try {expect((await call()).status).toBe(500);}finally{db.exec('DROP TRIGGER fail_workload_audit');}
  const response=await call();expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const event=db.prepare("SELECT * FROM audit_log WHERE action='workload_identity_exchange' ORDER BY id DESC LIMIT 1").get();
  expect(JSON.parse(event.details)).toEqual({trustId:item.trust.id,scopes:['api.read']});
  expect(JSON.stringify(event)).not.toContain(response.body.accessToken);expect(JSON.stringify(event)).not.toContain(item.assertion);
  expect((await call()).status).toBe(409);
 }finally{config.features.governance=prior;config.features.readOnly=false;}
});
test('upgrade revokes workload descendants and rejects old assertions when replay history exists',()=>{
 const Database=require('better-sqlite3'),migration=require('../db/migrations/183_workload_replay_identity'),isolated=new Database(':memory:');
 try {
  isolated.exec(`CREATE TABLE governance_service_tokens(id INTEGER PRIMARY KEY,issued_via TEXT,rotated_from INTEGER,revoked_at TEXT);
   CREATE TABLE governance_workload_assertions(expires_at TEXT);
   INSERT INTO governance_service_tokens VALUES(1,'workload_exchange',NULL,NULL),(2,'rotation',1,NULL),(3,'rotation',2,NULL),(4,'manual',NULL,NULL),(5,'rotation',4,NULL);
   INSERT INTO governance_workload_assertions VALUES(datetime('now','+5 minutes'));`);
  migration.up(isolated);
  expect(isolated.prepare('SELECT id FROM governance_service_tokens WHERE revoked_at IS NOT NULL').all().map(row=>row.id)).toEqual([1,2,3]);
  expect(isolated.prepare('SELECT minimum_iat FROM governance_workload_replay_policy').get().minimum_iat).toBeGreaterThan(Math.floor(Date.now()/1000));
  migration.down(isolated);expect(isolated.prepare('SELECT revoked_at FROM governance_service_tokens WHERE id=1').get().revoked_at).toBeTruthy();
  isolated.exec('DELETE FROM governance_workload_assertions');migration.up(isolated);
  expect(isolated.prepare('SELECT minimum_iat FROM governance_workload_replay_policy').get().minimum_iat).toBe(0);
 }finally{isolated.close();}
});
test('upgrade cutoff fails closed and requires a newly issued proof',()=>{
 const item=fixture(),old=db.prepare('SELECT minimum_iat FROM governance_workload_replay_policy').get().minimum_iat;
 try {
  db.prepare('UPDATE governance_workload_replay_policy SET minimum_iat=?').run(item.claims.iat);
  expect(()=>identity.exchange(item.assertion)).toThrow(expect.objectContaining({code:'ASSERTION_UPGRADE_CUTOFF'}));
  expect(identity.exchange(item.sign({...item.claims,iat:item.claims.iat+1})).accessToken).toMatch(/^ddst_/);
 }finally{db.prepare('UPDATE governance_workload_replay_policy SET minimum_iat=?').run(old);}
});
