'use strict';
const {requireAuth}=require('./auth');
function requireMonitoringRead(req,res,next){
 const user=req.user;
 if(user?.serviceToken){
  if(user.tenantId==null&&(user.scopes.includes('monitoring.read')||user.scopes.includes('api.read')))return next();
 }else if(user?.role==='admin')return next();
 return res.status(403).json({error:'Global monitoring access required',code:'MONITORING_ACCESS_DENIED'});
}
module.exports=[(_req,res,next)=>{res.set('Cache-Control','no-store');next();},requireAuth,requireMonitoringRead];
