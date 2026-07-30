'use strict';

process.env.APP_SECRET='storage-advanced-test-secret';
process.env.ENCRYPTION_KEY='storage-advanced-test-key-32chars';
process.env.DB_PATH=':memory:';

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const { getDb,closeDb }=require('../db');
const { StorageAdvancedService }=require('../services/storage-advanced');

const admin={id:951,username:'storage-admin',role:'admin'};
const sha=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const pass=name=>({name,state:'pass',evidenceHash:sha(name)});

describe('advanced storage control plane',()=>{
  let db;let service;
  beforeAll(()=>{db=getDb();service=new StorageAdvancedService(()=>db);db.prepare(`INSERT INTO users (id,username,email,password_hash,role,is_active) VALUES (?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET role=excluded.role,is_active=1`).run(admin.id,admin.username,'storage@example.test','x','admin');});
  afterAll(()=>closeDb());

  test('B082 plans digest-verified disk format conversion without data-plane execution',()=>{
    const result=service.planFormatConversion({resourceKey:'disk:db',sourceFormat:'vmdk',targetFormat:'qcow2',inputDigestSha256:sha('a'),outputDigestSha256:sha('b'),sourceReadOnly:true,availableBytes:2000,requiredBytes:1000,toolEvidence:[pass('qemu')],checks:[pass('digest'),pass('disk')]},admin);
    expect(result).toMatchObject({state:'ready',sourceFormat:'vmdk',targetFormat:'qcow2',providerMutationsStarted:0,executeEndpoint:null});
    expect(result.workflow.stages).toContain('retain_source_until_approval');
  });

  test('B083 records policy classes, capabilities and compliance state',()=>{
    const result=service.recordPolicyCatalog({providerHostId:7,providerType:'vsphere',observedAt:'2026-07-30T05:00:00Z',policies:[{policyKey:'gold',name:'Gold',class:'replicated',capabilities:['encryption','iops'],complianceState:'compliant',reason:'All rules satisfied'},{policyKey:'legacy',name:'Legacy',class:'local',capabilities:[],complianceState:'noncompliant',reason:'Replication missing'}]},admin);
    expect(result.summary).toEqual({policies:2,compliant:1,noncompliant:1,unknown:0});
  });

  test('B084 binds assignment diff, compatibility, migration capacity and downtime',()=>{
    const ready=service.planPolicyAssignment({resourceKey:'disk:db',currentPolicyKey:'silver',targetPolicyKey:'gold',compatible:true,compatibilityChecks:[pass('format')],migrationRequired:true,requiredBytes:1000,availableBytes:2000,downtimeMinutes:5},admin);
    expect(ready).toMatchObject({state:'ready',diff:{before:'silver',after:'gold'},migration:{required:true,downtimeMinutes:5},providerMutationsStarted:0});
    expect(service.planPolicyAssignment({resourceKey:'disk:web',currentPolicyKey:'silver',targetPolicyKey:'gold',compatible:false,compatibilityChecks:[pass('format')],migrationRequired:true,requiredBytes:2000,availableBytes:1000,downtimeMinutes:5},admin).blockers).toEqual(expect.arrayContaining(['policy_incompatible','migration_capacity_insufficient']));
  });

  test('B087 correlates workload, datastore and path latency into bounded heatmap cells',()=>{
    const result=service.recordLatencyHeatmap({scopeKey:'site:dc1',observedAt:'2026-07-30T05:00:00Z',warningLatencyMs:10,criticalLatencyMs:20,samples:[{resourceKey:'vm:db',storageKey:'store:gold',pathKey:'path:a',latencyMs:5,iops:1000,throughputBytes:1000000,observedAt:'2026-07-30T04:59:00Z'},{resourceKey:'vm:web',storageKey:'store:gold',pathKey:'path:a',latencyMs:25,iops:500,throughputBytes:500000,observedAt:'2026-07-30T04:59:30Z'}]},admin);
    expect(result.summary).toMatchObject({samples:2,critical:1});
    expect(result.summary.cells).toHaveLength(1);
    expect(result.summary.cells[0]).toMatchObject({latencyP95Ms:25,state:'critical'});
  });

  test('B088 reports degraded paths and multipath policy mismatches distinctly',()=>{
    const result=service.recordPathHealth({providerHostId:7,observedAt:'2026-07-30T05:00:00Z',paths:[{storageKey:'store:gold',pathKey:'path:a',state:'active',active:true,expectedPolicy:'round-robin',actualPolicy:'round-robin'},{storageKey:'store:gold',pathKey:'path:b',state:'degraded',active:false,expectedPolicy:'round-robin',actualPolicy:'fixed'}]},admin);
    expect(result.summary).toMatchObject({paths:2,healthy:1,degraded:1,policyMismatches:1});
  });

  test('B089 keeps orphan cleanup dry-run behind age, ownership, dependency and restore guards',()=>{
    const result=service.planOrphanCleanup({scopeKey:'site:dc1',minAgeDays:30,restoreWindowDays:14,candidates:[{resourceKey:'disk:managed',ageDays:90,ownerRef:'team:db',attached:false,snapshotDependencies:0,replicaDependencies:0,recoveryPointVerified:true,managedOwnership:true},{resourceKey:'disk:foreign',ageDays:90,ownerRef:null,attached:false,snapshotDependencies:1,replicaDependencies:0,recoveryPointVerified:false,managedOwnership:false}]},admin);
    expect(result).toMatchObject({state:'blocked',cleanupStarted:0,executeEndpoint:null});
    expect(result.candidates[0].eligible).toBe(true);expect(result.candidates[1].eligible).toBe(false);
  });

  test('B091 reuses the native durable snapshot consolidation workflow instead of duplicating it',()=>{
    expect(service.overview(admin).capabilities.snapshotConsolidation).toBe(true);
    const routes=fs.readFileSync(path.join(__dirname,'..','routes','providers.js'),'utf8');
    expect(routes).toContain("snapshots/consolidate/preflight");expect(routes).toContain("snapshots/consolidate");
  });

  test('B092 produces a capability-gated QoS diff without an apply endpoint',()=>{
    const result=service.planQos({resourceKey:'disk:db',capabilitySupported:true,current:{iopsLimit:1000,throughputBytesLimit:1000000,burstIops:2000,burstSeconds:30},desired:{iopsLimit:2000,throughputBytesLimit:2000000,burstIops:4000,burstSeconds:30}},admin);
    expect(result).toMatchObject({state:'ready',providerMutationsStarted:0,executeEndpoint:null});
    expect(result.diff.after.iopsLimit).toBe(2000);
  });

  test('B093 ranks tier candidates by latency, capacity, resilience, cost and policy',()=>{
    const result=service.recommendTier({workloadKey:'vm:db',requirements:{maxLatencyMs:10,requiredBytes:1000,minResilienceScore:80,maxCostScore:70,policyKey:'gold'},candidates:[{storageKey:'store:fast',latencyMs:3,freeBytes:5000,resilienceScore:95,costScore:60,policyCompliant:true},{storageKey:'store:cheap',latencyMs:30,freeBytes:5000,resilienceScore:70,costScore:10,policyCompliant:false}]},admin);
    expect(result).toMatchObject({state:'ready',selectedStorageKey:'store:fast',providerMutationsStarted:0,executeEndpoint:null});
  });

  test('B094 reuses the bounded opaque shared-disk topology endpoint',()=>{
    expect(service.overview(admin).capabilities.sharedDiskTopology).toBe(true);
    const routes=fs.readFileSync(path.join(__dirname,'..','routes','providers.js'),'utf8');
    expect(routes).toContain("storage-topology");
  });

  test('B095 registers an HTTPS object store with secret reference and no implicit probe',()=>{
    const result=service.registerObjectStore({endpointKey:'archive-primary',origin:'https://objects.example.test',providerType:'s3',region:'eu-central-1',secretRef:'vault://kv/object/archive',capabilities:{versioning:true,objectLock:true,multipart:true,checksum:true,capacityReporting:false},health:{state:'healthy',observedAt:'2026-07-30T05:00:00Z',latencyMs:20,capacityBytes:null,freeBytes:null,policyState:'compliant',certificateExpiresAt:'2027-07-30T00:00:00Z'}},admin);
    expect(result).toMatchObject({origin:'https://objects.example.test',networkCallsStarted:0});
    expect(()=>service.registerObjectStore({endpointKey:'bad-store',origin:'https://admin:secret@objects.example.test',providerType:'s3',region:null,secretRef:'vault://kv/object/archive',capabilities:{versioning:true,objectLock:true,multipart:true,checksum:true,capacityReporting:false},health:{state:'unknown',observedAt:'2026-07-30T05:00:00Z',latencyMs:0,capacityBytes:null,freeBytes:null,policyState:'unknown',certificateExpiresAt:'2027-07-30T00:00:00Z'}},admin)).toThrow(/HTTPS origin/);
  });

  test('B097 normalizes Ceph MON, OSD, PG and pool evidence',()=>{
    const result=service.recordSuiteHealth({providerHostId:7,suite:'ceph',observedAt:'2026-07-30T05:00:00Z',capacity:{totalBytes:10000,usedBytes:4000,freeBytes:6000},components:[{kind:'mon',total:3,healthy:3,degraded:0,failed:0},{kind:'osd',total:6,healthy:6,degraded:0,failed:0},{kind:'pg',total:128,healthy:128,degraded:0,failed:0},{kind:'pool',total:2,healthy:2,degraded:0,failed:0}],resyncBytes:0,faultDomains:3,replicationState:'healthy',backupTargetState:'not_applicable'},admin);
    expect(result).toMatchObject({suite:'ceph',summary:{state:'healthy',failed:0,degraded:0},providerMutationsStarted:0});
  });

  test('B098 normalizes Longhorn replicas, rebuild and backup target evidence',()=>{
    const result=service.recordSuiteHealth({providerHostId:8,suite:'longhorn',observedAt:'2026-07-30T05:00:00Z',capacity:{totalBytes:10000,usedBytes:7000,freeBytes:3000},components:[{kind:'volume',total:10,healthy:8,degraded:2,failed:0},{kind:'replica',total:30,healthy:28,degraded:2,failed:0},{kind:'rebuild',total:1,healthy:0,degraded:1,failed:0}],resyncBytes:1000,faultDomains:3,replicationState:'degraded',backupTargetState:'healthy'},admin);
    expect(result.summary).toMatchObject({state:'degraded',resyncBytes:1000});
  });

  test('B099 normalizes vSAN, S2D and AOS capacity, resync and fault-domain evidence',()=>{
    const inputs={vsan:['host','object'],s2d:['pool','repair'],aos:['cvm','rebuild']};
    for(const [suite,kinds] of Object.entries(inputs)){const result=service.recordSuiteHealth({providerHostId:9,suite,observedAt:`2026-07-30T05:0${Object.keys(inputs).indexOf(suite)}:00Z`,capacity:{totalBytes:10000,usedBytes:5000,freeBytes:5000},components:kinds.map(kind=>({kind,total:2,healthy:2,degraded:0,failed:0})),resyncBytes:0,faultDomains:2,replicationState:'healthy',backupTargetState:'not_applicable'},admin);expect(result.summary.state).toBe('healthy');}
  });

  test('B100 binds semantic diff, blast radius, downtime and rollbackability without apply',()=>{
    const result=service.planStorageChange({scopeKey:'cluster:prod',changeKind:'policy_assignment',current:{policy:'silver'},desired:{policy:'gold'},impactedResources:['vm:db','disk:db'],rollbackable:true,rollbackSteps:['restore silver policy','verify compliance'],downtimeMinutes:5,prechecks:[pass('capacity')]},admin);
    expect(result).toMatchObject({state:'ready',impact:{blastRadius:2},rollback:{rollbackable:true},downtimeMinutes:5,providerMutationsStarted:0,executeEndpoint:null});
    expect(()=>service.planStorageChange({scopeKey:'cluster:prod',changeKind:'bad',current:{password:'nope'},desired:{policy:'gold'},impactedResources:[],rollbackable:false,rollbackSteps:[],downtimeMinutes:1,prechecks:[]},admin)).toThrow(expect.objectContaining({code:'SECRET_FIELD'}));
  });

  test('migration 151 adds eleven tables and three permissions',()=>{
    const names=['storage_format_conversion_plans','storage_policy_catalog_observations','storage_policy_assignment_plans','storage_latency_heatmaps','storage_path_health_observations','storage_orphan_cleanup_plans','storage_qos_change_plans','storage_tiering_recommendations','object_storage_registries','storage_suite_health_observations','storage_change_plans'];
    const tables=names.filter(name=>db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table',name)).length;
    const permissions=db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key IN ('storage_content.manage','storage_policy.manage','storage_health.manage')").get().count;
    expect({tables,permissions}).toEqual({tables:11,permissions:3});
  });

  test('routes, browser API and governance UI expose the bounded control plane',()=>{
    const root=path.join(__dirname,'..','..');
    const route=fs.readFileSync(path.join(__dirname,'..','routes','storage-advanced.js'),'utf8');
    const api=fs.readFileSync(path.join(root,'public','js','api.js'),'utf8');
    const ui=fs.readFileSync(path.join(root,'public','js','pages','governance-controls.js'),'utf8');
    expect((route.match(/create\('/g)||[])).toHaveLength(11);
    expect(route).not.toMatch(/\/execute|\/apply|\/delete/);
    expect(api).toContain('getStorageAdvanced()');
    expect(api).toContain('recordStorageSuiteHealth(body)');
    expect(ui).toContain("_tabButton('storage-advanced'");
    expect(ui).toContain('Advanced storage execution boundary');
    expect(ui).toContain('no implicit probe');
  });
});
