'use strict';
// Tenant credentials only enter routes whose resource ownership is enforced.
// New routes remain denied until their ownership and response filtering are added.
const {getDb}=require('../db');
const isScoped=user=>!!user?.serviceToken&&user.tenantId!=null;
function id(value){return (typeof value==='number'||typeof value==='string')&&/^[1-9][0-9]*$/.test(String(value))&&Number.isSafeInteger(Number(value))?Number(value):null;}
function activeTenant(db,user){return isScoped(user)&&id(user.tenantId)!==null&&!!db.prepare("SELECT id FROM tenants WHERE id=? AND status='active'").get(Number(user.tenantId));}
function chain(db,scopeId){
 const rows=[],seen=new Set();let current=id(scopeId);
 while(current!==null){
  if(seen.has(current))return [];seen.add(current);
  const row=db.prepare('SELECT id,parent_id,scope_type,tenant_id FROM governance_scopes WHERE id=?').get(current);
  if(!row)return [];rows.push(row);current=row.parent_id;
 }
 return rows;
}
function scopeWithinTenant(db,scopeId,tenantId){
 const project=chain(db,scopeId).find(row=>row.scope_type==='project');
 return !!project&&project.tenant_id===Number(tenantId);
}
function scopeIds(db,user,{inherit=false}={}){
 if(!activeTenant(db,user))return [];
 const own=db.prepare(`WITH RECURSIVE owned(id) AS (
  SELECT id FROM governance_scopes WHERE scope_type='project' AND tenant_id=?
  UNION SELECT child.id FROM governance_scopes child JOIN owned ON child.parent_id=owned.id
   WHERE child.scope_type!='project' OR child.tenant_id=?
 ) SELECT id FROM owned`).all(Number(user.tenantId),Number(user.tenantId)).map(row=>row.id);
 if(!inherit)return own;
 const project=db.prepare("SELECT id FROM governance_scopes WHERE scope_type='project' AND tenant_id=?").get(Number(user.tenantId));
 return [...new Set([...own,...(project?chain(db,project.id).map(row=>row.id):[])])];
}
function requestVisible(db,request,user){
 if(!isScoped(user))return true;
 if(!activeTenant(db,user)||!request)return false;
 if(request.tenant_id!=null&&request.tenant_id!==Number(user.tenantId))return false;
 return request.scope_id==null?request.tenant_id===Number(user.tenantId):scopeWithinTenant(db,request.scope_id,user.tenantId);
}
function permissions(db,user,scopeId){
 if(!activeTenant(db,user)||!scopeWithinTenant(db,scopeId,user.tenantId))return new Set();
 const scopes=new Set(user.scopes||[]),read=scopes.has('governance.read')||scopes.has('api.read'),write=scopes.has('governance.write')||scopes.has('api.write');
 return new Set([...(read||write?['project.read','governance.read']:[]),...(write?['project.capacity.manage']:[])]);
}
function enforceHttp(req,res,next){
 const user=req.user;if(!isScoped(user))return next();
 const deny=()=>res.status(403).json({error:'Tenant service token cannot access this resource',code:'SERVICE_TENANT_DENIED'});
 const db=getDb();if(!activeTenant(db,user))return deny();
 const tenantId=Number(user.tenantId),path=String(req.originalUrl||req.url||'').split('?')[0].replace(/\/$/,'').toLowerCase();
 if(path.includes('%')||path.includes('\\'))return deny();
 for(const data of [req.query,req.body]){
  if(!data||typeof data!=='object')continue;
  for(const key of ['tenantId','projectId'])if(data[key]!==undefined&&id(data[key])!==tenantId)return deny();
  if(data.scopeId!==undefined&&!scopeWithinTenant(db,data.scopeId,tenantId))return deny();
 }
 const read=['GET','HEAD'].includes(req.method);
 if(read&&['/api/governance/projects','/api/governance/scopes','/api/governance/controls/catalog',
  '/api/governance/controls/approval-policies','/api/governance/controls/approval-requests','/api/governance/controls/blackouts'].includes(path))return next();
 let match=path.match(/^\/api\/governance\/projects\/([1-9][0-9]*)$/);
 if(read&&match&&id(match[1])===tenantId)return next();
 match=path.match(/^\/api\/governance\/controls\/projects\/([1-9][0-9]*)\/(capacity|quota-requests|capacity\/quotas|capacity\/allocations(?:\/[1-9][0-9]*)?)$/);
 if(!match||id(match[1])!==tenantId)return deny();
 const operation=match[2];
 if(read&&['capacity','quota-requests'].includes(operation))return next();
 if(req.method==='PUT'&&operation==='capacity/quotas')return next();
 if(req.method==='POST'&&operation==='capacity/allocations')return next();
 if(req.method==='DELETE'&&/^capacity\/allocations\/[1-9][0-9]*$/.test(operation))return next();
 return deny();
}
module.exports={isScoped,activeTenant,scopeWithinTenant,scopeIds,requestVisible,permissions,enforceHttp};
