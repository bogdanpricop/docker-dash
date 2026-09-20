'use strict';

const Database = require('better-sqlite3');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration125 = require('../db/migrations/125_governance_identity_policy');
const migration126 = require('../db/migrations/126_governance_metrics_foundation');
const { GovernanceLifecycleService } = require('../services/governance-lifecycle');
const { VmMetricsService } = require('../services/vm-metrics');

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT UNIQUE,email TEXT,password_hash TEXT,role TEXT,is_active INTEGER DEFAULT 1);
    CREATE TABLE tenants (id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT,kind TEXT,usage_mode TEXT,is_default INTEGER DEFAULT 0);
    CREATE TABLE user_tenants (user_id INTEGER,tenant_id INTEGER,role TEXT,is_owner INTEGER DEFAULT 0);
    CREATE TABLE teams (id INTEGER PRIMARY KEY,name TEXT UNIQUE,description TEXT,created_by INTEGER);
    CREATE TABLE team_members (team_id INTEGER,user_id INTEGER,is_leader INTEGER DEFAULT 0,added_by INTEGER,PRIMARY KEY(team_id,user_id));`);
  db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (1,'admin','admin@test','x','admin'),(2,'owner','owner@test','x','viewer')").run();
  db.prepare("INSERT INTO tenants (id,slug,name,kind,usage_mode) VALUES (1,'project-a','Project A','internal','production')").run();
  migration124.up(db); migration125.up(db); migration126.up(db); return db;
}
const admin={id:1,username:'admin',role:'admin'};

describe('V4.6c lifecycle and VM metric foundation', () => {
  let db; let lifecycle; let metrics;
  beforeEach(()=>{db=database();lifecycle=new GovernanceLifecycleService(()=>db);metrics=new VmMetricsService(()=>db);});
  afterEach(()=>db.close());
  test('leases, production ownership completeness and export remain control-plane only', () => {
    const resource=db.prepare("INSERT INTO governance_project_resources (tenant_id,resource_type,resource_key,display_name,provider_host_id) VALUES (1,'vm','web-1','Web 1',0)").run().lastInsertRowid;
    lifecycle.saveLeasePolicy(1,{resourceType:'vm',maxTtlSeconds:3600,cleanupOwnerUserId:2},admin);
    const lease=lifecycle.createLease(1,{resourceId:resource,holderUserId:2,expiresAt:new Date(Date.now()+60000).toISOString()},admin);
    expect(lease.state).toBe('active');
    lifecycle.ownershipPolicy(1,{},admin);
    expect(lifecycle.setOwnership(1,resource,{environment:'production'},admin).completeness_state).toBe('incomplete');
    expect(lifecycle.setOwnership(1,resource,{environment:'production',ownerUserId:2,serviceName:'web',costCenter:'cc-1'},admin).completeness_state).toBe('complete');
    const exported=lifecycle.exportTenant(1,admin); expect(exported.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycle.planOffboarding(1,{exportId:exported.id},admin).state).toBe('planned');
  });
  test('normalizes known metric keys and records freshness while bounding labels', () => {
    const result=metrics.ingest({providerHostId:0,provider:'proxmox',adapter:'rrd',samples:[
      {resourceKey:'vm-100',metricKey:'cpu.utilization_ratio',value:0.4,labels:{cluster:'a'},provenance:{source:'rrd'}},
      {resourceKey:'vm-100',metricKey:'unknown.metric',value:1},
    ]},admin);
    expect(result).toMatchObject({accepted:1,dropped:1});
    expect(metrics.freshness(0,admin)).toEqual([expect.objectContaining({resource_key:'vm-100',consecutive_errors:0})]);
    metrics.savePolicies(0,{cardinality:{maxLabelKeys:0}},admin);
    expect(metrics.ingest({provider:'manual',adapter:'normalized-ingest',samples:[{resourceKey:'vm-100',metricKey:'memory.used_bytes',value:1,labels:{bad:'label'}}]},admin).dropped).toBe(1);
  });
});
