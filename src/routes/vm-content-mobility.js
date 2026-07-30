'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const mobility = require('../services/vm-content-mobility');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router=Router();
function route(handler){return async(req,res,next)=>{try{await handler(req,res);}catch(error){if(error.name==='VmContentMobilityError')return res.status(error.status||400).json({error:error.message,code:error.code,details:error.details});next(error);}};}
function audit(req,action,targetType,targetId,details={}){auditService.log({userId:req.user.id,username:req.user.username,action,targetType,targetId:String(targetId),details,ip:getClientIp(req)});}
function create(path,method,action,targetType){router.post(path,writeable,route((req,res)=>{const result=method(req.body||{},req.user);audit(req,action,targetType,result.id,{state:result.state,planHash:result.planHash||result.policyHash||result.profileHash||result.contractHash||result.workflowHash,providerMutationsStarted:result.providerMutationsStarted||0});res.status(result.duplicate?200:201).json({result});}));}

router.get('/',route((req,res)=>res.json(mobility.overview(req.user))));
create('/image-replication-plans',mobility.planImageReplication.bind(mobility),'image_replication_plan','image_replication_plan');
create('/template-versions',mobility.saveTemplateVersion.bind(mobility),'template_version_save','managed_template_version');
router.post('/template-versions/:id/promotions',writeable,route((req,res)=>{const result=mobility.planTemplatePromotion(req.params.id,req.body||{},req.user);audit(req,'template_promotion_plan','template_promotion_plan',result.id,{state:result.state,planHash:result.planHash,providerMutationsStarted:0});res.status(result.duplicate?200:201).json({result});}));
create('/vm-leases',mobility.createVmLease.bind(mobility),'vm_lease_contract','vm_lease_contract');
create('/guest-command-plans',mobility.planGuestCommand.bind(mobility),'guest_command_plan','guest_command_plan');
create('/console-profiles',mobility.saveConsoleProfile.bind(mobility),'console_protocol_profile','console_protocol_profile');
create('/migrations/live',mobility.planLiveMigration.bind(mobility),'live_migration_control_plan','migration_control_plan');
create('/migrations/cold',mobility.planColdMigration.bind(mobility),'cold_migration_control_plan','migration_control_plan');
create('/migrations/storage',mobility.planStorageMigration.bind(mobility),'storage_migration_control_plan','migration_control_plan');
create('/migrations/cross-pool',mobility.planCrossPool.bind(mobility),'cross_pool_migration_plan','migration_control_plan');
create('/migrations/cross-provider',mobility.planCrossProvider.bind(mobility),'cross_provider_migration_workflow','migration_control_plan');
create('/migrations/bandwidth-policies',mobility.saveBandwidthPolicy.bind(mobility),'migration_bandwidth_policy','migration_policy');
create('/migrations/queue-policies',mobility.saveQueuePolicy.bind(mobility),'migration_queue_policy','migration_policy');
create('/migrations/control-decisions',mobility.planControlDecision.bind(mobility),'migration_control_decision','migration_control_decision');
create('/migrations/rollback-plans',mobility.planStageRollback.bind(mobility),'migration_stage_rollback_plan','migration_rollback_plan');

module.exports=router;
