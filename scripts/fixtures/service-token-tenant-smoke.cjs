'use strict';
const assert=require('node:assert/strict');
module.exports=async(db,checks,raceRedeem)=>{
 const governance=require('/app/src/services/governance'),identity=require('/app/src/services/identity-governance');
 const approvals=require('/app/src/services/governance-approvals'),config=require('/app/src/config');
 const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES ('native-tenant-admin','fixture','admin',0)").run().lastInsertRowid;
 const actor=db.prepare('SELECT * FROM users WHERE id=?').get(id);
 const a=governance.createProject({slug:'native-tenant-a',name:'Native A'},actor),b=governance.createProject({slug:'native-tenant-b',name:'Native B'},actor);
 const issue=tenantId=>identity.issueToken({name:'native-tenant',principal:'native-tenant',tenantId,scopes:['governance.read','governance.write'],ttlSeconds:300},actor);
 const token=issue(a.id);
 const ra=approvals.createRequest({tenantId:a.id,scopeId:a.scopeId,actionKey:'native:tenant:a',reason:'fixture'},actor,{fallbackApprovals:1});
 const rb=approvals.createRequest({tenantId:b.id,scopeId:b.scopeId,actionKey:'native:tenant:b',reason:'fixture'},actor,{fallbackApprovals:1});
 const express=require('express'),app=express();app.use(express.json());
 app.use('/api/governance/controls',require('/app/src/routes/governance-controls'));app.use('/api/governance',require('/app/src/routes/governance'));
 app.use((_error,_req,res,_next)=>res.status(500).json({error:'fixture'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const prior=config.features.governance;config.features.governance=true;
 const call=async(path,method='GET',body)=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/governance'+path,{method,
   headers:{authorization:'Bearer '+token.token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(2500)});
  return {status:response.status,body:await response.json()};
 };
 try{
  const list=await call('/projects');assert.equal(list.status,200);assert.deepEqual(list.body.projects.map(row=>row.id),[a.id]);
  assert.equal((await call('/projects/'+a.id)).status,200);assert.equal((await call('/projects/'+b.id)).status,403);
  assert.equal((await call('/roles')).status,403);
  assert.deepEqual((await call('/controls/approval-requests')).body.requests.map(row=>row.id),[ra.id]);
  assert.equal((await call('/controls/approval-requests?requestId='+rb.id)).status,404);
  assert.equal((await call('/controls/approval-requests?tenantId='+b.id)).status,403);
  checks.push('native-tenant-token-http-ownership-and-filtered-approval-lists');
  const path='/controls/projects/'+a.id+'/capacity/quotas';
  assert.equal((await call(path,'PUT',{quotas:{gpu_count:{hardLimit:2}}})).status,200);
  assert.equal((await call('/controls/projects/'+b.id+'/capacity/quotas','PUT',{quotas:{gpu_count:{hardLimit:99}}})).status,403);
  db.exec("CREATE TEMP TRIGGER fail_native_capacity_audit BEFORE INSERT ON audit_log WHEN NEW.action='governance_extended_quota_update' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  try{assert.equal((await call(path,'PUT',{quotas:{gpu_count:{hardLimit:99}}})).status,500);}finally{db.exec('DROP TRIGGER fail_native_capacity_audit');}
  assert.equal((await call('/controls/projects/'+a.id+'/capacity')).body.metrics.gpu_count.hardLimit,2);
  const details=JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action='governance_extended_quota_update' AND target_id=? ORDER BY id DESC LIMIT 1").get(String(a.id)).details);
  assert.equal(details.serviceTokenId,token.id);assert.equal(details.tenantId,a.id);
  checks.push('native-tenant-capacity-write-audit-and-rollback');
 }finally{config.features.governance=prior;await new Promise(resolve=>server.close(resolve));}
 const old=issue(b.id),code=`const db=require('/app/src/db').getDb(),identity=require('/app/src/services/identity-governance'),governance=require('/app/src/services/governance');
  process.stdin.once('data',()=>{let result;try{const tenantId=Number(process.env.TENANT_ID);
   if(process.env.OPERATION==='suspend')governance.updateProjectLifecycle(tenantId,'suspended');
   else identity.issueToken({name:'race',principal:'race',tenantId,scopes:['governance.read'],ttlSeconds:300},{id:Number(process.env.ACTOR_ID),role:'admin'});
   result={accepted:true};}catch(error){result={accepted:false,code:error.code}}
   console.log('RESULT:'+JSON.stringify(result));db.close();process.exit(0)});console.log('READY');`;
 const environment={TENANT_ID:String(b.id),ACTOR_ID:String(id)};
 const race=await raceRedeem(code,[environment,{...environment,OPERATION:'suspend'}]);assert.equal(race[1].accepted,true);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM governance_service_tokens WHERE tenant_id=? AND revoked_at IS NULL').get(b.id).n,0);
 governance.updateProjectLifecycle(b.id,'active');assert.equal(identity.validateToken(old.token),null);
 checks.push('native-cross-process-tenant-suspension-prevents-surviving-credentials');
};
