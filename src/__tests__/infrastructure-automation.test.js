'use strict';

const Database = require('better-sqlite3');
const migration107 = require('../db/migrations/107_provider_operations');
const migration129 = require('../db/migrations/129_infrastructure_automation_manifests');
const { InfrastructureAutomationService, API_VERSION } = require('../services/infrastructure-automation');
const fs = require('fs');
const path = require('path');

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
  `);
  db.prepare("INSERT INTO users (id,username,role) VALUES (1,'admin','admin')").run();
  db.prepare("INSERT INTO docker_hosts (id,name,daemon_type) VALUES (7,'pve-1','proxmox')").run();
  db.prepare("INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin')").run();
  migration107.up(db); migration129.up(db); return db;
}

const admin = { id: 1, username: 'admin', role: 'admin' };
const vmDocument = (overrides = {}) => ({ apiVersion: API_VERSION, kind: 'VirtualMachine',
  metadata: { name: 'web-01', providerHostId: 7, authoritative: true, ...(overrides.metadata || {}) },
  spec: { hardware: { cpuCount: 4, memoryBytes: 8 * 1024 ** 3 }, image: { imageRef: 'ubuntu:24.04' },
    networks: [{ networkRef: 'prod-vlan', model: 'virtio', connected: true }],
    storage: [{ name: 'root', sizeBytes: 40 * 1024 ** 3, storageRef: 'fast', boot: true }],
    policies: ['production'], tags: { environment: 'production' }, desiredPowerState: 'running', ...(overrides.spec || {}) } });

describe('V0.3b infrastructure automation foundations (B226-B235)', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new InfrastructureAutomationService(() => db); });
  afterEach(() => db.close());

  test('capability audit reuses the persistent engine, task bridge, idempotency and lock contracts', () => {
    expect(db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN
      ('infrastructure_manifests','infrastructure_change_plans','infrastructure_workflows','infrastructure_plan_jobs')`).get().count).toBe(4);
    expect(db.prepare("SELECT permission_key FROM governance_permissions WHERE permission_key='infrastructure_automation.manage'").get())
      .toEqual({ permission_key: 'infrastructure_automation.manage' });
    db.prepare(`INSERT INTO provider_operations
      (id,operation_type,provider_type,host_id,resource_kind,resource_id,action,request_hash,request_enc,idempotency_key_hash,
       lock_scopes_json,retry_policy,max_attempts,timeout_seconds,available_at,native_task_ref_enc,native_task_state,created_by)
      VALUES ('op_aaaaaaaaaaaaaaaaaaaaaaaaaa','vm.power','proxmox',7,'vm','ddr_vm_aaaaaaaaaaaaaaaaaaaaaaaaaa','start','h','enc','idem',
       '["resource:vm"]','none',1,60,datetime('now'),'native-enc','running',1)`).run();
    db.prepare(`INSERT INTO provider_operation_locks (scope_key,operation_id,lease_owner,lease_expires_at)
      VALUES ('resource:vm','op_aaaaaaaaaaaaaaaaaaaaaaaaaa','worker',datetime('now','+5 minutes'))`).run();
    const result = service.overview(admin);
    expect(result.capabilities).toEqual(expect.objectContaining({ persistentJobEngine: true, providerTaskBridge: true,
      idempotencyKeys: true, resourceLocks: true, dependencyDag: true, compensationFramework: true }));
    expect(result.operationEngine).toMatchObject({ activeLocks: 1, idempotencyProtectedJobs: 1, nativeTaskJobs: 1 });
  });

  test('VM manifest normalizes desired hardware, image, network, storage and policy intent', () => {
    const result = service.validateManifest(vmDocument(), admin);
    expect(result).toMatchObject({ valid: true, secretFree: true, documentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.normalized.spec).toMatchObject({ hardware: { cpuCount: 4, memoryBytes: 8 * 1024 ** 3 },
      image: { imageRef: 'ubuntu:24.04' }, policies: ['production'], desiredPowerState: 'running' });
    expect(() => service.validateManifest({ ...vmDocument(), spec: { ...vmDocument().spec, password: 'never-store-me' } }, admin))
      .toThrow(/may not contain secret material/);
  });

  test('host and fabric schemas validate maintenance, tags and policy references', () => {
    const host = service.validateManifest({ apiVersion: API_VERSION, kind: 'Host', metadata: { name: 'node-1', providerHostId: 7 },
      spec: { maintenanceMode: 'maintenance', tags: { rack: 'r1' }, policies: ['secure-host'], fabricRefs: ['cluster-a'] } }, admin);
    const fabric = service.validateManifest({ apiVersion: API_VERSION, kind: 'Fabric', metadata: { name: 'cluster-a', providerHostId: 7 },
      spec: { maintenanceMode: 'draining', tags: { site: 'bucharest' }, policies: ['ha'], memberRefs: ['node-1', 'node-2'] } }, admin);
    expect(host.normalized.spec).toMatchObject({ maintenanceMode: 'maintenance', policies: ['secure-host'] });
    expect(fabric.normalized.spec).toMatchObject({ maintenanceMode: 'draining', memberRefs: ['node-1', 'node-2'] });
  });

  test('manifest writes are hash-idempotent and changed intent increments revision', () => {
    const first = service.saveManifest({ document: vmDocument(), resourceVersions: { vm: 'rv-1' } }, admin);
    const duplicate = service.saveManifest({ document: vmDocument(), resourceVersions: { vm: 'rv-1' } }, admin);
    const changed = service.saveManifest({ document: vmDocument({ spec: { ...vmDocument().spec,
      hardware: { cpuCount: 6, memoryBytes: 8 * 1024 ** 3 } } }), resourceVersions: { vm: 'rv-2' } }, admin);
    expect(first).toMatchObject({ revision: 1, deduplicated: false });
    expect(duplicate).toMatchObject({ id: first.id, revision: 1, deduplicated: true });
    expect(changed).toMatchObject({ id: first.id, revision: 2, deduplicated: false });
  });

  test('change plans classify create/update/delete/blocked/unchanged and retain hashes', () => {
    const manifest = service.saveManifest({ document: vmDocument(), resourceVersions: { vm: 'rv-1' } }, admin);
    const live = JSON.parse(JSON.stringify(manifest.document.spec)); live.hardware.cpuCount = 2; delete live.tags.environment;
    live.tags.legacy = 'remove'; live.networks.push({ networkRef: 'legacy-vlan', model: 'e1000', connected: true });
    const plan = service.createPlan(manifest.id, { liveState: live, resourceVersions: { vm: 'rv-1' } }, admin);
    expect(plan.summary).toEqual(expect.objectContaining({ create: expect.any(Number), update: expect.any(Number),
      delete: expect.any(Number), unchanged: expect.any(Number), blocked: expect.any(Number) }));
    expect(plan.summary.create).toBeGreaterThan(0); expect(plan.summary.update).toBeGreaterThan(0);
    expect(plan.summary.delete).toBeGreaterThan(0); expect(plan.summary.blocked).toBeGreaterThan(0);
    expect(plan).toMatchObject({ planHash: expect.stringMatching(/^[a-f0-9]{64}$/), stateHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  test('revalidation accepts unchanged evidence but rejects expired or changed versions as stale', () => {
    const hostDocument = { apiVersion: API_VERSION, kind: 'Host', metadata: { name: 'node-1', providerHostId: 7 },
      spec: { maintenanceMode: 'normal', tags: { rack: 'r1' }, policies: [], fabricRefs: [] } };
    const manifest = service.saveManifest({ document: hostDocument, resourceVersions: { host: 'rv-1' } }, admin);
    const live = JSON.parse(JSON.stringify(manifest.document.spec));
    const accepted = service.createPlan(manifest.id, { liveState: live, resourceVersions: { host: 'rv-1' } }, admin);
    expect(service.revalidatePlan(accepted.id, { liveState: live, resourceVersions: { host: 'rv-1' } }, admin))
      .toMatchObject({ status: 'accepted', providerMutationsScheduled: 0 });
    const stale = service.createPlan(manifest.id, { liveState: { ...live, maintenanceMode: 'maintenance' },
      resourceVersions: { host: 'rv-1' } }, admin);
    expect(() => service.revalidatePlan(stale.id, { liveState: { ...live, maintenanceMode: 'maintenance' },
      resourceVersions: { host: 'rv-2' } }, admin)).toThrow(/stale/);
    expect(service.plans(admin).find(item => item.id === stale.id).status).toBe('stale');
  });

  test('workflow DAG rejects cycles and compensation planning is reverse-stage without execution', () => {
    expect(() => service.createWorkflow({ name: 'cyclic', version: '1.0', steps: [
      { id: 'a', stage: 1, actionKey: 'vm.prepare', needs: ['b'] },
      { id: 'b', stage: 1, actionKey: 'vm.apply', needs: ['a'] },
    ] }, admin)).toThrow(/cycle/);
    const workflow = service.createWorkflow({ name: 'vm-change', version: '1.0', steps: [
      { id: 'prepare', stage: 1, actionKey: 'vm.prepare', compensation: { actionKey: 'vm.cleanup', strategy: 'best_effort' } },
      { id: 'apply', stage: 2, needs: ['prepare'], actionKey: 'vm.apply', lockScopes: ['resource:vm'],
        compensation: { actionKey: 'vm.restore', strategy: 'required', input: { checkpoint: 'pre-change' } } },
      { id: 'verify', stage: 3, needs: ['apply'], actionKey: 'vm.verify' },
    ] }, admin);
    const plan = service.compensationPlan(workflow.id, { completedStepIds: ['prepare', 'apply', 'verify'] }, admin);
    expect(plan.actions.map(item => item.stepId)).toEqual(['apply', 'prepare']);
    expect(plan).toMatchObject({ canAutomaticallyCompensate: true, providerMutationsScheduled: 0 });
  });

  test('accepted plans link to durable operations and expose native-task evidence without ciphertext', () => {
    const manifest = service.saveManifest({ document: { apiVersion: API_VERSION, kind: 'Host',
      metadata: { name: 'node-1', providerHostId: 7 }, spec: { maintenanceMode: 'normal', tags: {}, policies: [], fabricRefs: [] } } }, admin);
    const live = JSON.parse(JSON.stringify(manifest.document.spec)); const plan = service.createPlan(manifest.id, { liveState: live }, admin);
    service.revalidatePlan(plan.id, { liveState: live }, admin);
    db.prepare(`INSERT INTO provider_operations
      (id,operation_type,provider_type,host_id,resource_kind,resource_id,action,request_hash,request_enc,idempotency_key_hash,
       lock_scopes_json,retry_policy,max_attempts,timeout_seconds,available_at,native_task_ref_enc,native_task_state,created_by)
      VALUES ('op_bbbbbbbbbbbbbbbbbbbbbbbbbb','host.maintenance','proxmox',7,'host','ddr_host_bbbbbbbbbbbbbbbbbbbbbbbbbb','enter','h','ciphertext','idem',
       '["resource:host"]','transient',3,600,datetime('now'),'native-ciphertext','queued',1)`).run();
    const link = service.linkJob(plan.id, { operationId: 'op_bbbbbbbbbbbbbbbbbbbbbbbbbb', relation: 'executes' }, admin);
    expect(link).toMatchObject({ hasNativeTask: true, nativeTaskState: 'queued', idempotencyProtected: true,
      retryPolicy: 'transient', lockScopes: ['resource:host'] });
    expect(JSON.stringify(service.overview(admin))).not.toContain('ciphertext');
  });

  test('API and Governance UI expose the ten automation contracts', () => {
    const root = path.join(__dirname, '..', '..');
    const route = fs.readFileSync(path.join(root, 'src/routes/infrastructure-automation.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'public/js/pages/governance-controls.js'), 'utf8');
    for (const endpoint of ['/manifests/validate', '/manifests/:id/plans', '/plans/:id/revalidate',
      '/workflows/:id/compensation-plan', '/plans/:id/jobs']) expect(route).toContain(endpoint);
    for (const contract of ['getInfrastructureAutomation', 'saveInfrastructureManifest', 'createInfrastructurePlan',
      'revalidateInfrastructurePlan', 'createInfrastructureWorkflow', 'previewInfrastructureCompensation']) expect(api).toContain(contract);
    for (const label of ['Durable jobs', 'Provider task bridge', 'Idempotency keys', 'Resource locks', 'Operation DAG',
      'Compensation framework', 'Infrastructure change plans', 'Stale-plan rejection', 'VM manifest',
      'Host / fabric manifest']) expect(page).toContain(label);
  });
});
