'use strict';
Object.assign(process.env,{APP_ENV:'test',DB_PATH:':memory:',APP_SECRET:'tenant-token-fixture',ENCRYPTION_KEY:'tenant-token-fixture-key-32ch'});
const express=require('express'),request=require('supertest'),{getDb,closeDb}=require('../db');
const identity=require('../services/identity-governance'),governance=require('../services/governance'),approvals=require('../services/governance-approvals'),config=require('../config');
const app=express();app.use(express.json());app.use('/api/governance/controls',require('../routes/governance-controls'));app.use('/api/governance',require('../routes/governance'));
app.use((_error,_req,res,_next)=>res.status(500).json({error:'fixture'}));
let db,admin,a,b,ta,tb,ra,rb,pa,pb;const prior=config.features.governance;
const token=(tenantId,scopes=['governance.read','governance.write'])=>identity.issueToken({name:'tenant',principal:'fixture-tenant',tenantId,scopes,ttlSeconds:300},admin).token;
const call=(method,path,credential=ta,body)=>request(app)[method]('/api/governance'+path).set('Authorization','Bearer '+credential).send(body);
beforeAll(()=>{db=getDb();config.features.governance=true;
 const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES ('tenant-token-admin','fixture','admin',0)").run().lastInsertRowid;
 admin=db.prepare('SELECT * FROM users WHERE id=?').get(id);
 a=governance.createProject({slug:'tenant-token-a',name:'Project A'},admin);b=governance.createProject({slug:'tenant-token-b',name:'Project B'},admin);
 ta=token(a.id);tb=token(b.id);
 pa=approvals.savePolicy(null,{name:'only-a',scopeId:a.scopeId,actionPattern:'fixture:a',environment:'any'},admin);
 pb=approvals.savePolicy(null,{name:'only-b',scopeId:b.scopeId,actionPattern:'fixture:b',environment:'any'},admin);
 ra=approvals.createRequest({scopeId:a.scopeId,tenantId:a.id,actionKey:'fixture:a',reason:'A',summary:{marker:'only-project-a'}},admin,{fallbackApprovals:1});
 rb=approvals.createRequest({scopeId:b.scopeId,tenantId:b.id,actionKey:'fixture:b',reason:'B',summary:{marker:'only-project-b'}},admin,{fallbackApprovals:1});
});
afterAll(()=>{config.features.governance=prior;closeDb();});
test('tenant approval list never includes another project',async()=>{
 const response=await call('get','/controls/approval-requests');expect(response.status).toBe(200);
 expect(response.body.requests.map(row=>row.id)).toEqual([ra.id]);
});
test('a foreign approval id cannot expose its decisions',async()=>{
 expect((await call('get','/controls/approval-requests?requestId='+rb.id)).status).toBe(404);
});
test('policy list is restricted to policies applying to the token project',async()=>{
 const response=await call('get','/controls/approval-policies');expect(response.status).toBe(200);
 expect(response.body.policies.map(row=>row.id)).toContain(pa.id);expect(response.body.policies.map(row=>row.id)).not.toContain(pb.id);
});
test('tenant credentials cannot access unscoped global role listings',async()=>{
 expect((await call('get','/roles')).status).toBe(403);
});
test('tenant project listing and detail remain usable within the assigned project',async()=>{
 const list=await call('get','/projects');expect(list.status).toBe(200);expect(list.body.projects.map(row=>row.id)).toEqual([a.id]);
 expect((await call('get','/projects/'+a.id)).status).toBe(200);
 expect((await call('get','/projects/'+b.id)).status).toBe(403);
});
test('a write token can manage capacity accounting in its own tenant',async()=>{
 const response=await call('put','/controls/projects/'+a.id+'/capacity/quotas',ta,{quotas:{gpu_count:{softLimit:2,hardLimit:3}}});
 expect(response.status).toBe(200);expect(response.body.metrics.gpu_count.hardLimit).toBe(3);
 expect((await call('get','/controls/projects/'+a.id+'/capacity')).status).toBe(200);
});
test('suspending a tenant permanently revokes its issued credentials',()=>{
 const extra=governance.createProject({slug:'tenant-token-suspend',name:'Suspend'},admin),raw=token(extra.id);
 governance.updateProjectLifecycle(extra.id,'suspended');expect(identity.validateToken(raw)).toBeNull();
 governance.updateProjectLifecycle(extra.id,'active');expect(identity.validateToken(raw)).toBeNull();
});
test.each(['?tenantId=foreign','?tenantId=duplicate','?projectId=foreign','?scopeId=foreign'])('query selectors cannot override token ownership: %s',kind=>{
 const query=kind.replace('foreign',String(kind.includes('scopeId')?b.scopeId:b.id)).replace('duplicate',a.id+'&tenantId='+b.id);
 return call('get','/controls/approval-requests'+query).then(response=>expect(response.status).toBe(403));
});
test.each([{tenantId:'foreign'},{projectId:'foreign'},{scopeId:'foreign'},{tenantId:[1]},{tenantId:{id:1}}])('body selectors cannot override token ownership: %j',data=>{
 const body=Object.fromEntries(Object.entries(data).map(([key,value])=>[key,value==='foreign'?(key==='scopeId'?b.scopeId:b.id):value]));
 return call('put','/controls/projects/'+a.id+'/capacity/quotas',ta,{...body,quotas:{gpu_count:{hardLimit:99}}}).then(response=>expect(response.status).toBe(403));
});
test('a read-only service scope cannot mutate even its own tenant',async()=>{
 const raw=token(a.id,['governance.read']);
 expect((await call('put','/controls/projects/'+a.id+'/capacity/quotas',raw,{quotas:{gpu_count:{hardLimit:99}}})).status).toBe(403);
 expect((await call('get','/controls/projects/'+a.id+'/capacity',raw)).status).toBe(200);
});
test('a write-only service scope can mutate but cannot call read endpoints',async()=>{
 const raw=token(a.id,['governance.write']);
 expect((await call('put','/controls/projects/'+a.id+'/capacity/quotas',raw,{quotas:{gpu_count:{softLimit:2,hardLimit:4}}})).status).toBe(200);
 expect((await call('get','/controls/projects/'+a.id+'/capacity',raw)).status).toBe(403);
});
test('capacity allocation ids stay bound to the target project',async()=>{
 const body={providerHostId:0,resourceType:'fixture',resourceKey:'tenant-only-b',metric:'gpu_count',amount:1};
 const created=await call('post','/controls/projects/'+b.id+'/capacity/allocations',tb,body);expect(created.status).toBe(201);
 const allocation=created.body.allocations.find(row=>row.resource_key===body.resourceKey);
 expect((await call('delete','/controls/projects/'+a.id+'/capacity/allocations/'+allocation.id)).status).toBe(404);
 expect((await call('delete','/controls/projects/'+b.id+'/capacity/allocations/'+allocation.id)).status).toBe(403);
 expect(db.prepare('SELECT tenant_id FROM governance_project_capacity_allocations WHERE id=?').get(allocation.id).tenant_id).toBe(b.id);
 expect((await call('delete','/controls/projects/'+b.id+'/capacity/allocations/'+allocation.id,tb)).status).toBe(200);
});
test('foreign scope records cannot hide behind a matching approval tenant id',async()=>{
 const mixed=approvals.createRequest({scopeId:b.scopeId,tenantId:a.id,actionKey:'fixture:b',reason:'mixed'},admin,{fallbackApprovals:1});
 const response=await call('get','/controls/approval-requests');expect(response.body.requests.some(row=>row.id===mixed.id)).toBe(false);
 expect((await call('get','/controls/approval-requests?requestId='+mixed.id)).status).toBe(404);
});
test('approval visibility is applied before pagination and preserves same-project decisions',async()=>{
 const response=await call('get','/controls/approval-requests?limit=1&requestId='+ra.id);expect(response.status).toBe(200);
 expect(response.body.requests).toHaveLength(1);expect(response.body.requests[0].id).toBe(ra.id);expect(response.body.decisions).toEqual([]);
});
test('scope listing excludes other projects and preserves descendants',async()=>{
 const child=governance.createScope({scopeType:'resource',scopeKey:'tenant-resource-a',displayName:'A child',parentId:a.scopeId},admin);
 const response=await call('get','/scopes');expect(response.status).toBe(200);
 expect(response.body.scopes.map(row=>row.id).sort()).toEqual([a.scopeId,child.id].sort());
});
test('inherited policies and global blackouts remain visible, foreign project blackouts do not',async()=>{
 const policy=approvals.savePolicy(null,{name:'organization-policy',scopeId:1,actionPattern:'fixture:global'},admin);
 const start=new Date(Date.now()+3600000).toISOString(),end=new Date(Date.now()+7200000).toISOString();
 const own=approvals.saveBlackout(null,{name:'own',scopeId:a.scopeId,startsAt:start,endsAt:end,reason:'A'},admin);
 const foreign=approvals.saveBlackout(null,{name:'foreign',scopeId:b.scopeId,startsAt:start,endsAt:end,reason:'B'},admin);
 const global=approvals.saveBlackout(null,{name:'global',startsAt:start,endsAt:end,reason:'all'},admin);
 const policies=await call('get','/controls/approval-policies');expect(policies.body.policies.map(row=>row.id)).toContain(policy.id);
 const windows=(await call('get','/controls/blackouts')).body.windows.map(row=>row.id);
 expect(windows).toContain(own.id);expect(windows).toContain(global.id);expect(windows).not.toContain(foreign.id);
});
test.each(['/roles','/subjects','/controls/identity-realms','/controls/service-tokens','/controls/workload-trusts','/lifecycle/leases'])('unreviewed/global endpoints refuse tenant tokens: %s',async path=>{
 expect((await call('get',path)).status).toBe(403);
});
test('tenant service identities cannot approve requests or request user membership changes',async()=>{
 expect((await call('post','/controls/approval-requests/'+ra.id+'/decision',ta,{decision:'approve'})).status).toBe(403);
 expect((await call('post','/projects/'+a.id+'/members',ta,{userId:admin.id,role:'admin'})).status).toBe(403);
});
test('an audit failure rolls a tenant capacity change back',async()=>{
 const before=db.prepare('SELECT * FROM governance_project_extended_quotas WHERE tenant_id=?').all(a.id);
 db.exec("CREATE TEMP TRIGGER fail_tenant_capacity_audit BEFORE INSERT ON audit_log WHEN NEW.action='governance_extended_quota_update' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 try{expect((await call('put','/controls/projects/'+a.id+'/capacity/quotas',ta,{quotas:{gpu_count:{hardLimit:88}}})).status).toBe(500);}
 finally{db.exec('DROP TRIGGER fail_tenant_capacity_audit');}
 expect(db.prepare('SELECT * FROM governance_project_extended_quotas WHERE tenant_id=?').all(a.id)).toEqual(before);
 expect((await call('put','/controls/projects/'+a.id+'/capacity/quotas',ta,{quotas:{gpu_count:{hardLimit:4}}})).status).toBe(200);
 const event=db.prepare("SELECT details FROM audit_log WHERE action='governance_extended_quota_update' AND target_id=? ORDER BY id DESC LIMIT 1").get(String(a.id));
 expect(JSON.parse(event.details)).toMatchObject({tenantId:a.id,serviceTokenId:identity.validateToken(ta).serviceTokenId});
});
test('inactive tenants cannot receive credentials and global credentials stay independent',()=>{
 const project=governance.createProject({slug:'tenant-inactive-issue',name:'Inactive'},admin),global=token(null);
 governance.updateProjectLifecycle(project.id,'suspended');expect(()=>token(project.id)).toThrow(expect.objectContaining({code:'SERVICE_TENANT_DENIED'}));
 expect(identity.validateToken(global)).toBeTruthy();
});
test.each(['0','-1','2suffix','%32','9007199254740992'])('noncanonical project selectors are refused: %s',selector=>{
 return call('get','/controls/projects/'+selector+'/capacity').then(response=>expect(response.status).toBe(403));
});
test('tenant headers cannot override the stored credential tenant',async()=>{
 const response=await request(app).get('/api/governance/projects').set('Authorization','Bearer '+ta).set('x-tenant-id',String(b.id));
 expect(response.status).toBe(200);expect(response.body.projects.map(row=>row.id)).toEqual([a.id]);
});
test('migration backfills suspended-tenant tokens and downgrade never revives them',()=>{
 const copy=new (require('better-sqlite3'))(db.serialize()),migration=require('../db/migrations/185_service_token_tenant_lifecycle');
 try{
  migration.down(copy);copy.prepare("UPDATE tenants SET status='suspended' WHERE id=?").run(a.id);
  migration.up(copy);expect(copy.prepare('SELECT revoked_at FROM governance_service_tokens WHERE id=?').get(identity.validateToken(ta).serviceTokenId).revoked_at).toBeTruthy();
  migration.down(copy);copy.prepare("UPDATE tenants SET status='active' WHERE id=?").run(a.id);
  expect(copy.prepare('SELECT revoked_at FROM governance_service_tokens WHERE id=?').get(identity.validateToken(ta).serviceTokenId).revoked_at).toBeTruthy();
 }finally{copy.close();}
});
