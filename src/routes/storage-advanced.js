'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const storage = require('../services/storage-advanced');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router=Router();
function route(handler){return async(req,res,next)=>{try{await handler(req,res);}catch(error){if(error.name==='StorageAdvancedError')return res.status(error.status||400).json({error:error.message,code:error.code,details:error.details});next(error);}};}
function audit(req,action,targetType,result){auditService.log({userId:req.user.id,username:req.user.username,action,targetType,targetId:String(result.id),details:{state:result.state||result.summary?.state,hash:result.planHash||result.observationHash||result.heatmapHash||result.recommendationHash||result.registryHash,providerMutationsStarted:result.providerMutationsStarted||0},ip:getClientIp(req)});}
function create(path,method,action,targetType){router.post(path,writeable,route((req,res)=>{const result=method(req.body||{},req.user);audit(req,action,targetType,result);res.status(result.duplicate?200:201).json({result});}));}

router.get('/',route((req,res)=>res.json(storage.overview(req.user))));
create('/format-conversion-plans',storage.planFormatConversion.bind(storage),'storage_format_conversion_plan','storage_format_conversion_plan');
create('/policy-observations',storage.recordPolicyCatalog.bind(storage),'storage_policy_catalog_observation','storage_policy_catalog');
create('/policy-assignment-plans',storage.planPolicyAssignment.bind(storage),'storage_policy_assignment_plan','storage_policy_assignment_plan');
create('/latency-heatmaps',storage.recordLatencyHeatmap.bind(storage),'storage_latency_heatmap','storage_latency_heatmap');
create('/path-health-observations',storage.recordPathHealth.bind(storage),'storage_path_health_observation','storage_path_health');
create('/orphan-cleanup-plans',storage.planOrphanCleanup.bind(storage),'storage_orphan_cleanup_plan','storage_orphan_cleanup_plan');
create('/qos-change-plans',storage.planQos.bind(storage),'storage_qos_change_plan','storage_qos_change_plan');
create('/tiering-recommendations',storage.recommendTier.bind(storage),'storage_tiering_recommendation','storage_tiering_recommendation');
create('/object-stores',storage.registerObjectStore.bind(storage),'object_storage_registry_save','object_storage_registry');
create('/suite-health-observations',storage.recordSuiteHealth.bind(storage),'storage_suite_health_observation','storage_suite_health');
create('/change-plans',storage.planStorageChange.bind(storage),'storage_change_plan','storage_change_plan');

module.exports=router;
