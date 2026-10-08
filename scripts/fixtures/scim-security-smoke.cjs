'use strict';
const assert=require('node:assert/strict');
module.exports=async(db,checks)=>{
 const express=require('express'),config=require('/app/src/config'),auth=require('/app/src/services/auth');
 const identity=require('/app/src/services/identity-governance'),scim=require('/app/src/services/scim');
 const prior=config.features.governance;config.features.governance=true;
 const actors=['admin','viewer'].map(role=>{
  const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES (?,'fixture',?,0)").run('native-scim-'+role,role).lastInsertRowid;
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
 });
 const app=express();app.use(express.json());app.use(require('cookie-parser')());app.use('/api/scim/v2',require('/app/src/routes/scim'));
 app.use((_error,_req,res,_next)=>res.status(500).json({error:'fixture server error'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port+'/api/scim/v2';
 const call=async(path,token,method='GET',body)=>{
  const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
 };
 try {
  const viewer=auth._createSession(actors[1],'127.0.0.1','fixture').token;
  assert.equal((await call('/Users/'+actors[0].id,viewer,'PATCH',{Operations:[{op:'replace',path:'active',value:false}]})).status,403);
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(actors[0].id).is_active,1);
  assert.equal((await call('/Users',auth._createSession(actors[0],'127.0.0.1','fixture').token)).status,403);
  const broad=identity.issueToken({name:'broad',principal:'native-api',scopes:['api.read'],ttlSeconds:600},actors[0]).token;
  assert.equal((await call('/Users',broad)).status,403);
  checks.push('native-scim-ordinary-user-cannot-deactivate-admin');
  const token=identity.issueToken({name:'native-scim',principal:'native-scim',scopes:['scim.read','scim.write'],ttlSeconds:600},actors[0]).token;
  assert.equal((await call('/Users/'+actors[0].id,token,'DELETE')).status,404);
  const team=db.prepare("INSERT INTO teams(name) VALUES ('native-scim-local-team')").run().lastInsertRowid;
  assert.throws(()=>scim.replaceGroup(team,{displayName:'claimed',members:[]}));
  assert.equal((await call('/Users',token)).body.Resources.some(item=>item.id===String(actors[0].id)),false);
  checks.push('native-scim-managed-resource-boundary');
  const result=await call('/Users',token,'POST',{userName:'native-scim-managed'});assert.equal(result.status,201);
  assert.ok(db.prepare("SELECT id FROM audit_log WHERE action='scim_user_create' AND target_id=?").get(result.body.id));
  db.exec("CREATE TEMP TRIGGER fail_native_scim_audit BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'scim_%' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  try {
   assert.equal((await call('/Users',token,'POST',{userName:'native-scim-audit-failed'})).status,500);
   assert.equal(db.prepare("SELECT id FROM users WHERE username='native-scim-audit-failed'").get(),undefined);
  } finally {db.exec('DROP TRIGGER fail_native_scim_audit');}
  checks.push('native-scim-provisioning-and-audit-commit-together');
 } finally {config.features.governance=prior;await new Promise(resolve=>server.close(resolve));}
};
