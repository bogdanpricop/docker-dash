'use strict';

process.env.APP_SECRET = 'infrastructure-delivery-test-secret';
process.env.ENCRYPTION_KEY = 'infrastructure-delivery-encryption-key';

const Database = require('better-sqlite3');
const migration096 = require('../db/migrations/096_procedures');
const migration107 = require('../db/migrations/107_provider_operations');
const migration129 = require('../db/migrations/129_infrastructure_automation_manifests');
const migration130 = require('../db/migrations/130_infrastructure_delivery_gitops');
const { InfrastructureAutomationService, API_VERSION } = require('../services/infrastructure-automation');
const { InfrastructureDeliveryService } = require('../services/infrastructure-delivery');
const { hmacSign } = require('../utils/crypto');
const fs = require('fs');
const path = require('path');

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, environment TEXT, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
  `);
  db.prepare("INSERT INTO users (id,username,role) VALUES (1,'admin','admin')").run();
  db.prepare("INSERT INTO docker_hosts (id,name,daemon_type,environment) VALUES (7,'pve-1','proxmox','production')").run();
  db.prepare("INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin')").run();
  migration096.up(db); migration107.up(db); migration129.up(db); migration130.up(db);
  db.prepare("INSERT INTO procedures (id,name,steps_json,is_active,created_by) VALUES (3,'signed-runbook','[]',1,1)").run();
  return db;
}

const admin = { id: 1, username: 'admin', role: 'admin' };
const hostDocument = () => ({ apiVersion: API_VERSION, kind: 'Host', metadata: { name: 'pve-1', providerHostId: 7 },
  spec: { maintenanceMode: 'normal', tags: { site: 'bucharest' }, policies: [], fabricRefs: [] } });
const storageDocument = (overrides = {}) => ({ apiVersion: API_VERSION, kind: 'StorageResource',
  metadata: { name: 'fast-storage', providerHostId: 7,
    ownership: { mode: 'managed', owner: 'platform-team', deletionProtection: true }, ...(overrides.metadata || {}) },
  spec: { storageType: 'datastore', capacityBytes: 1099511627776, shared: true, policies: ['production'], tags: { tier: 'fast' },
    deletionPolicy: 'retain', ...(overrides.spec || {}) } });

describe('V0.3c infrastructure delivery and GitOps (B236-B245)', () => {
  let db; let automation; let service;
  beforeEach(() => {
    db = database(); automation = new InfrastructureAutomationService(() => db);
    const runner = { run: (procedureId, actor) => { const result = db.prepare(`INSERT INTO procedure_runs
      (procedure_id,procedure_name,status,total_steps,started_by) VALUES (?,'signed-runbook','running',0,?)`).run(procedureId, actor.userId);
    return { id: Number(result.lastInsertRowid) }; } };
    service = new InfrastructureDeliveryService(() => db, { procedureRunner: runner, automationService: automation });
  });
  afterEach(() => db.close());

  test('migration and storage/network manifests enforce ownership and deletion safeguards', () => {
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name LIKE 'infrastructure_%'").get().count).toBe(10);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key LIKE 'infrastructure_%'").get().count).toBe(3);
    const saved = service.saveResourceManifest({ document: storageDocument(), resourceVersions: { datastore: 'rv-1' } }, admin);
    expect(saved).toMatchObject({ kind: 'storage', owner: 'platform-team', ownershipMode: 'managed', deletionProtection: true, revision: 1 });
    expect(() => service.normalizeResourceManifest(storageDocument({ spec: { ...storageDocument().spec, deletionPolicy: 'delete' } }), admin))
      .toThrow(/deletionProtection=false/);
    const network = service.saveResourceManifest({ document: { apiVersion: API_VERSION, kind: 'NetworkResource', metadata: {
      name: 'prod-vlan', providerHostId: 7, ownership: { mode: 'shared', owner: 'network-team' } }, spec: {
      networkType: 'vlan', cidrs: ['10.20.0.0/24'], vlanId: 120, mtu: 1500, policies: [], tags: {}, deletionPolicy: 'retain' } } }, admin);
    expect(network.kind).toBe('network');
  });

  test('live import is deterministic, secret-free and does not persist implicitly', () => {
    const first = service.importLiveResource({ document: hostDocument(), resourceVersions: { host: '42' } }, admin);
    const second = service.importLiveResource({ document: hostDocument(), resourceVersions: { host: '42' } }, admin);
    expect(first).toMatchObject({ documentHash: second.documentHash, imported: true, persisted: false, secretFree: true });
    expect(service.resourceManifests(admin)).toHaveLength(0);
    expect(() => service.importLiveResource({ document: { ...hostDocument(), spec: { ...hostDocument().spec, apiToken: 'leak' } } }, admin))
      .toThrow(/secret material/);
  });

  test('declarative drift respects shared ownership and blocks protected managed deletion', () => {
    const shared = service.saveResourceManifest({ document: storageDocument({ metadata: { ownership: {
      mode: 'shared', owner: 'platform-team', deletionProtection: true } } }) }, admin);
    const sharedPlan = service.drift({ manifestSource: 'resource', manifestId: shared.id,
      liveState: { ...shared.document.spec, legacyField: 'unmanaged' } }, admin);
    expect(sharedPlan.summary.delete).toBe(0); expect(sharedPlan.summary.blocked).toBe(0);
    const managed = service.saveResourceManifest({ document: storageDocument({ metadata: { name: 'managed-two' } }) }, admin);
    const protectedPlan = service.drift({ manifestSource: 'resource', manifestId: managed.id,
      liveState: { ...managed.document.spec, legacyField: 'protected' } }, admin);
    expect(protectedPlan.summary.blocked).toBe(1); expect(protectedPlan.providerMutationsScheduled).toBe(0);
  });

  test('manual reconcile retains commit/diff evidence and only references durable operations', () => {
    const manifest = automation.saveManifest({ document: hostDocument(), resourceVersions: { host: 'rv-1' } }, admin);
    const run = service.createManualReconcile({ manifestSource: 'core', manifestId: manifest.id,
      liveState: { ...manifest.document.spec, maintenanceMode: 'maintenance' }, resourceVersions: { host: 'rv-1' }, commitSha: 'abcdef1234567' }, admin);
    expect(run).toMatchObject({ status: 'planned', commitSha: 'abcdef1234567' });
    const fresh = { ...manifest.document.spec, maintenanceMode: 'maintenance' };
    expect(() => service.approveReconcile(run.id, { planHash: '0'.repeat(64), liveState: fresh }, admin)).toThrow(/stale/);
    const approved = service.approveReconcile(run.id, { planHash: run.planHash, liveState: fresh, resourceVersions: { host: 'rv-1' } }, admin);
    expect(() => service.applyReconcile(run.id, { planHash: run.planHash }, admin)).toThrow(/durable operation/);
    db.prepare(`INSERT INTO provider_operations
      (id,operation_type,provider_type,host_id,resource_kind,resource_id,action,request_hash,request_enc,idempotency_key_hash,
       lock_scopes_json,retry_policy,max_attempts,timeout_seconds,available_at,created_by,state)
      VALUES ('op_cccccccccccccccccccccccccc','host.maintenance','proxmox',7,'host','ddr_host_cccccccccccccccccccccccccc','enter',
       'hash','encrypted','idem','["resource:host"]','transient',3,600,datetime('now'),1,'succeeded')`).run();
    const applied = service.applyReconcile(approved.id, { planHash: run.planHash, operationIds: ['op_cccccccccccccccccccccccccc'] }, admin);
    expect(applied).toMatchObject({ status: 'applied', externalExecutionStarted: false });
    expect(JSON.stringify(applied)).not.toContain('encrypted');
  });

  test('continuous controller pauses when live state changes under a pending plan', () => {
    const manifest = automation.saveManifest({ document: hostDocument() }, admin);
    const controller = service.configureController({ name: 'host-drift', manifestSource: 'core', manifestId: manifest.id,
      scopeType: 'host', scopeKey: 'host:7', mode: 'continuous', enabled: true,
      liveState: { ...manifest.document.spec, maintenanceMode: 'maintenance' } }, admin);
    const first = service.runController(controller.id, admin); expect(first.run.status).toBe('planned');
    expect(service.runController(controller.id, admin)).toMatchObject({ deduplicated: true, run: { id: first.run.id } });
    const conflict = service.updateControllerObservation(controller.id, {
      liveState: { ...manifest.document.spec, maintenanceMode: 'maintenance', tags: { site: 'cluj' } } }, admin);
    expect(conflict).toMatchObject({ conflict: true, controller: { state: 'conflict' }, providerMutationsScheduled: 0 });
    expect(() => service.runController(controller.id, admin)).toThrow(/paused/);
    expect(service.resumeController(controller.id, admin).state).toBe('idle');
  });

  test('pull-request preview includes policy, cost and blast-radius evidence', () => {
    const manifest = automation.saveManifest({ document: hostDocument() }, admin);
    const preview = service.previewPullRequest({ externalRef: 'github/pr/42', manifestSource: 'core', manifestId: manifest.id,
      liveState: { ...manifest.document.spec, maintenanceMode: 'maintenance' }, monthlyRates: { cpuPerMonth: 10 }, currency: 'EUR' }, admin);
    expect(preview).toMatchObject({ sourceKind: 'pull_request', status: 'reviewed', policy: { passed: true },
      cost: { currency: 'EUR', externalBillingQueryPerformed: false }, blastRadius: { changedPaths: 1 } });
  });

  test('Terraform import helper emits canonical mappings without taking state ownership', () => {
    const result = service.terraformImportMappings({ resources: [{ address: 'module.vm.proxmox_vm_qemu.web', type: 'proxmox_vm_qemu',
      canonicalId: 'ddr_vm_aaaaaaaaaaaaaaaaaaaaaaaaaa' }] }, admin);
    expect(result).toMatchObject({ stateOwnershipTaken: false, providerQueriesPerformed: 0 });
    expect(result.mappings[0].command).toContain("terraform import 'module.vm.proxmox_vm_qemu.web'");
  });

  test('Terraform plan ingestion stores only normalized redacted evidence and gates authorization', () => {
    const plan = service.ingestTerraformPlan({ externalRef: 'tfc/run-7', plan: { format_version: '1.2', terraform_version: '1.9.0',
      resource_changes: [{ address: 'proxmox_vm_qemu.legacy', type: 'proxmox_vm_qemu', change: { actions: ['delete'],
        before: { password: 'must-not-persist' }, before_sensitive: { password: true } } }] } }, admin);
    expect(plan).toMatchObject({ sourceKind: 'terraform', status: 'blocked', policy: { sensitiveValuesStored: false },
      plan: { summary: { delete: 1 } } });
    expect(JSON.stringify(plan)).not.toContain('must-not-persist');
    expect(() => service.authorizeExternalPlan(plan.id, { confirmation: `AUTHORIZE TERRAFORM ${plan.id}` }, admin)).toThrow(/override/);
    expect(service.authorizeExternalPlan(plan.id, { confirmation: `AUTHORIZE TERRAFORM ${plan.id}`, allowPolicyOverride: true }, admin))
      .toMatchObject({ status: 'apply_authorized', externalExecutionStarted: false });
  });

  test('Ansible inventory groups hosts and exposes only symbolic secret references', () => {
    const result = service.ansibleInventory(admin);
    expect(result).toMatchObject({ secretValuesIncluded: false, secretReferenceScheme: 'existing-host/<name>' });
    expect(result.inventory._meta.hostvars.pve_1).toMatchObject({ docker_dash_host_id: 7, docker_dash_secret_ref: 'existing-host/pve-1' });
    expect(result.yaml).not.toContain('ENCRYPTION_KEY');
  });

  test('signed webhook allows only configured events and rejects nonce replay', () => {
    const issued = service.createWebhookTrigger({ name: 'incident-hook', procedureId: 3, events: ['incident.opened'] }, admin);
    const rawBody = JSON.stringify({ incidentId: 'inc-7' }); const timestamp = Math.floor(Date.now() / 1000); const nonce = 'nonce-1234567890abcdef';
    const signature = `sha256=${hmacSign(`${timestamp}.${nonce}.incident.opened.${rawBody}`, issued.secret)}`;
    const headers = { 'x-docker-dash-timestamp': String(timestamp), 'x-docker-dash-nonce': nonce,
      'x-docker-dash-event': 'incident.opened', 'x-docker-dash-signature': signature };
    expect(service.receiveWebhook(issued.token, headers, rawBody)).toMatchObject({ accepted: true, replayProtected: true, procedureRunId: 1 });
    expect(() => service.receiveWebhook(issued.token, headers, rawBody)).toThrow(/already used/);
    expect(() => service.receiveWebhook(issued.token, { ...headers, 'x-docker-dash-event': 'incident.closed' }, rawBody)).toThrow(/not allowlisted/);
    expect(JSON.stringify(service.overview(admin))).not.toContain(issued.secret);
  });

  test('API, scheduler and UI expose all B236-B245 contracts', () => {
    const root = path.join(__dirname, '..', '..');
    const route = fs.readFileSync(path.join(root, 'src/routes/infrastructure-automation.js'), 'utf8');
    const receiver = fs.readFileSync(path.join(root, 'src/routes/infrastructure-webhooks.js'), 'utf8');
    const monitor = fs.readFileSync(path.join(root, 'src/services/infrastructure-reconcile-monitor.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'public/js/pages/governance-controls.js'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
    const csrf = fs.readFileSync(path.join(root, 'src/middleware/csrf.js'), 'utf8');
    for (const endpoint of ['/resource-manifests', '/import', '/drift', '/reconcile-runs', '/controllers',
      '/previews/pull-request', '/terraform/import-mappings', '/terraform/plans', '/ansible-inventory', '/webhook-triggers']) expect(route).toContain(endpoint);
    expect(receiver).toContain('receiveWebhook'); expect(monitor).toContain('runDueControllers');
    expect(server).toContain("req.rawBody = buf.toString('utf8')"); expect(csrf).toContain('/api/automation/webhooks/');
    for (const method of ['saveInfrastructureResourceManifest', 'importInfrastructureResource', 'evaluateInfrastructureDrift',
      'createInfrastructureReconcile', 'createInfrastructureController', 'previewInfrastructurePullRequest',
      'createTerraformImportMappings', 'ingestTerraformPlan', 'getAnsibleInfrastructureInventory',
      'createInfrastructureWebhookTrigger']) expect(api).toContain(method);
    for (const label of ['Storage / network manifest', 'Live resource import', 'Declarative drift detection',
      'Manual GitOps reconcile', 'Continuous GitOps reconcile', 'Pull-request preview', 'Terraform import helper',
      'Terraform run integration', 'Ansible inventory export', 'Webhook-triggered runbooks']) expect(page).toContain(label);
  });
});
