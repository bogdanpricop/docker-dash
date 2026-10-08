'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const platform = require('../services/platform-foundation');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) { if (error.name === 'PlatformFoundationError') return res.status(error.status || 400).json({ error:error.message,code:error.code,details:error.details }); next(error); } }; }
function audit(req, action, targetType, targetId, details = {}) { auditService.log({ userId:req.user.id,username:req.user.username,action,targetType,targetId:String(targetId),details,ip:getClientIp(req) }); }

router.get('/', route((req,res) => res.json(platform.overview(req.user))));
router.post('/events', writeable, route((req,res) => { const event=platform.recordEvent(req.body||{},req.user);audit(req,'platform_event_normalize','provider_event',event.id,{fingerprint:event.fingerprint,duplicate:event.duplicate});res.status(event.duplicate?200:201).json({event}); }));
router.post('/inventory-deltas', writeable, route((req,res) => { const delta=platform.recordInventoryDelta(req.body||{},req.user);audit(req,'platform_inventory_delta','inventory_delta',delta.id,{providerHostId:delta.providerHostId,resourceType:delta.resourceType,cursor:delta.cursor,deltaHash:delta.deltaHash});res.status(delta.duplicate?200:201).json({delta}); }));
router.post('/collections', writeable, route((req,res) => { const collection=platform.saveCollection(req.body||{},req.user);audit(req,'platform_collection_save','resource_collection',collection.id,{version:collection.version,definitionHash:collection.definitionHash});res.json({collection}); }));
router.post('/collections/:id/evaluate', writeable, route((req,res) => res.json(platform.evaluateCollection(req.params.id,req.body||{},req.user))));
router.post('/metadata-schemas', writeable, route((req,res) => { const schema=platform.saveMetadataSchema(req.body||{},req.user);audit(req,'platform_metadata_schema_save','metadata_schema',schema.schemaKey,{version:schema.version,schemaHash:schema.schemaHash});res.json({schema}); }));
router.put('/resources/:resourceKey/metadata/:schemaKey', writeable, route((req,res) => { const value=platform.setMetadata(req.params.resourceKey,req.params.schemaKey,req.body||{},req.user);audit(req,'platform_metadata_value_save','resource_metadata',value.resourceKey,{schemaKey:value.schemaKey,version:value.version,valueHash:value.valueHash});res.json({value}); }));
router.post('/relationship-graphs', writeable, route((req,res) => { const graph=platform.recordRelationshipGraph(req.body||{},req.user);audit(req,'platform_relationship_graph','relationship_graph',graph.id,{graphHash:graph.graphHash,resources:graph.resources.length,edges:graph.edges.length});res.status(graph.duplicate?200:201).json({graph}); }));
router.get('/relationship-graphs/:id/impact/:resourceKey', route((req,res) => res.json(platform.graphImpact(req.params.id,req.params.resourceKey,req.user))));
router.post('/hygiene-scans', writeable, route((req,res) => { const scan=platform.scanHygiene(req.body||{},req.user);audit(req,'platform_hygiene_scan','resource_hygiene_scan',scan.id,{scanHash:scan.scanHash,summary:scan.summary,cleanupStarted:false});res.status(scan.duplicate?200:201).json({scan}); }));
router.post('/rate-budgets/:endpointKey/observations', writeable, route((req,res) => { const budget=platform.observeRateBudget(req.params.endpointKey,req.body||{},req.user);audit(req,'platform_rate_budget_observe','provider_endpoint',budget.endpointKey,{providerHostId:budget.providerHostId,state:budget.state,recommendedConcurrency:budget.recommendedConcurrency});res.status(budget.duplicate?200:201).json({budget}); }));
router.post('/linked-clone-plans', writeable, route((req,res) => { const plan=platform.planLinkedClone(req.body||{},req.user);audit(req,'platform_linked_clone_plan','linked_clone_plan',plan.id,{planHash:plan.planHash,state:plan.state,providerMutationsStarted:0});res.status(201).json({plan}); }));
router.post('/customization-profiles', writeable, route((req,res) => { const profile=platform.saveCustomizationProfile(req.body||{},req.user);audit(req,'platform_customization_profile_save','guest_customization_profile',profile.id,{name:profile.name,version:profile.version,profileHash:profile.profileHash});res.status(profile.duplicate?200:201).json({profile}); }));
router.post('/flavor-mappings', writeable, route((req,res) => { const mapping=platform.mapFlavor(req.body||{},req.user);audit(req,'platform_flavor_mapping','flavor_mapping',mapping.id,{mappingHash:mapping.mappingHash,state:mapping.state,selectedOfferingKey:mapping.selectedOfferingKey});res.status(201).json({mapping}); }));
router.post('/image-observations', writeable, route((req,res) => { const result=platform.recordImageObservations(req.body||{},req.user);audit(req,'platform_image_observations','image_library','aggregate',{received:result.received,inserted:result.inserted,rawProviderReferencesStored:false});res.status(201).json(result); }));
router.post('/image-upload-sessions', writeable, route((req,res) => { const session=platform.createImageUploadSession(req.body||{},req.user);audit(req,'platform_image_upload_session','image_upload_session',session.id,{totalBytes:session.totalBytes,inputFormat:session.inputFormat,targetFormat:session.targetFormat,dataBytesStored:0});res.status(201).json({session}); }));
router.post('/image-upload-sessions/:id/chunk-receipts', writeable, route((req,res) => { const receipt=platform.recordImageChunk(req.params.id,req.body||{},req.user);audit(req,'platform_image_chunk_receipt','image_upload_session',receipt.sessionId,{offsetBytes:receipt.offsetBytes,sizeBytes:receipt.sizeBytes,receiptHash:receipt.receiptHash,dataBytesStored:0});res.status(receipt.duplicate?200:201).json({receipt}); }));
router.post('/image-upload-sessions/:id/finalize', writeable, route((req,res) => { const result=platform.finalizeImageUpload(req.params.id,req.body||{},req.user);audit(req,'platform_image_upload_finalize','image_upload_session',result.sessionId,{state:result.state,planHash:result.planHash,providerMutationsStarted:0});res.json(result); }));

module.exports = router;
