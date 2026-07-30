'use strict';

const Database = require('better-sqlite3');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration125 = require('../db/migrations/125_governance_identity_policy');
const migration142 = require('../db/migrations/142_self_service_portal');
const { GovernanceService } = require('../services/governance');
const { GovernanceApprovalsService } = require('../services/governance-approvals');
const { SelfServiceService, SelfServiceError } = require('../services/self-service');

const admin = { id: 1, username: 'admin', role: 'admin' };
const requester = { id: 2, username: 'requester', role: 'viewer' };
const approver = { id: 3, username: 'approver', role: 'operator' };
const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const ARTIFACT_ID = `dda_art_${'b'.repeat(26)}`;

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT,
      email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1,
      auth_source TEXT NOT NULL DEFAULT 'local', must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT DEFAULT 'internal',
      usage_mode TEXT DEFAULT 'production', status TEXT DEFAULT 'active', is_default INTEGER DEFAULT 0, trial_expires_at TEXT,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_tenants (user_id INTEGER REFERENCES users(id), tenant_id INTEGER REFERENCES tenants(id), role TEXT DEFAULT 'viewer',
      is_owner INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE team_members (team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      is_leader INTEGER DEFAULT 0, added_by INTEGER, added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(team_id,user_id));
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, is_active INTEGER DEFAULT 1);
    INSERT INTO users (id,username,email,password_hash,role) VALUES
      (1,'admin','admin@example.test','x','admin'),(2,'requester','requester@example.test','x','viewer'),(3,'approver','approver@example.test','x','operator');
    INSERT INTO tenants (id,slug,name,usage_mode,status) VALUES (1,'payments','Payments','production','active');
    INSERT INTO user_tenants (user_id,tenant_id,role,is_owner) VALUES (2,1,'operator',0);
    INSERT INTO docker_hosts (id,name,daemon_type,is_active) VALUES (7,'pve-a','proxmox',1);
  `);
  migration124.up(db); migration125.up(db); migration142.up(db);
  const version = db.prepare("SELECT id,offering_json FROM infrastructure_catalog_versions WHERE item_id=(SELECT id FROM infrastructure_catalog_items WHERE slug='standard-vm')").get();
  const offering = JSON.parse(version.offering_json); offering.targets = [{ hostId: 7, providerType: 'proxmox', artifactId: ARTIFACT_ID, storageId: 'ddr_sto_cccccccccccccccccccccccccc', mode: 'full' }];
  db.prepare('UPDATE infrastructure_catalog_versions SET offering_json=? WHERE id=?').run(JSON.stringify(offering), version.id);
  db.prepare(`INSERT INTO governance_project_resources
    (tenant_id,provider_host_id,resource_type,resource_key,display_name,cpu_millicores,memory_bytes,storage_bytes,metadata_json,assigned_by)
    VALUES (1,7,'virtualMachine',?,'payments-01',2000,4294967296,42949672960,'{}',1)`).run(VM_ID);
  return db;
}

function services(db) {
  const governance = new GovernanceService(() => db); const approvals = new GovernanceApprovalsService(() => db);
  const operationStates = new Map();
  const plan = (resource, name) => ({ allowed: true, blockers: [], warnings: [], resource: { id: resource, displayName: name, actions: ['start','shutdown','reboot'] }, vm: { id: resource, displayName: name },
    confirmation: { mode: 'explicit', expected: name }, planHash: 'c'.repeat(64), validUntil: new Date(Date.now() + 300000).toISOString() });
  const submit = result => { operationStates.set(result.operation.id, result.operation); return result; };
  const service = new SelfServiceService({ dbProvider: () => db, governance, approvals,
    operations: { get: id => operationStates.get(id) || null },
    vmProvision: {
      preflightForHost: async (_host, artifactId, input) => ({ ...plan(artifactId, input.name), artifact: { id: artifactId, displayName: 'Ubuntu' } }),
      submitForHost: async (_host, artifactId, input) => submit({ operation: { id: 'op_1234567890abcdef1234567890', state: 'queued' }, plan: plan(artifactId, input.name) }),
    },
    vmPower: {
      preflightForHost: async (_host, resourceId, action) => ({ ...plan(resourceId, 'payments-01'), action }),
      submitForHost: async (_host, resourceId, input) => submit({ operation: { id: 'op_abcdef1234567890abcdef1234', state: 'queued' }, plan: { ...plan(resourceId, 'payments-01'), action: input.action } }),
    },
    vmSnapshots: {
      preflightForHost: async (_host, resourceId) => ({ ...plan(resourceId, 'payments-01'), name: 'before-change' }),
      submitForHost: async (_host, resourceId) => submit({ operation: { id: 'op_99887766554433221100aabbcc', state: 'queued' }, plan: plan(resourceId, 'payments-01') }),
    },
  });
  return { service, governance, approvals, operationStates };
}

function requestValues(overrides = {}) {
  return { name: 'payments-02', cpu: 2, memoryGiB: 4, storageGiB: 40, environment: 'production', backup: true, ...overrides };
}

describe('v8.68 self-service portal (B356-B365)', () => {
  let db; let service; let operationStates;
  beforeEach(() => { db = database(); ({ service, operationStates } = services(db)); });
  afterEach(() => db.close());

  test('B356 command palette returns permission-aware project, catalog and request actions', () => {
    const catalog = service.commandPalette('standard', requester).results.find(item => item.type === 'catalog');
    expect(catalog).toMatchObject({ url: '#/self-service/catalog/standard-vm', action: { available: true } });
    expect(service.commandPalette('payments', requester).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'project', url: '#/self-service/project/1', action: { available: true, key: 'open', reason: null } }),
    ]));
  });

  test('B357 basket persists across resource kinds and explains incompatible bulk selection', () => {
    service.addBasketItem({ resourceKind: 'virtual-machine', hostId: 7, resourceRef: VM_ID, displayName: 'payments-01' }, requester);
    const mixed = service.addBasketItem({ resourceKind: 'container', hostId: 7, resourceRef: 'container-a', displayName: 'api' }, requester);
    expect(mixed.items).toHaveLength(2);
    expect(mixed.preview).toMatchObject({ compatibleActions: [], blockers: [expect.objectContaining({ code: 'MIXED_RESOURCE_KINDS' })] });
    service.removeBasketItem(mixed.items[1].id, requester);
    expect(service.getBasket(requester).preview.compatibleActions).toEqual(expect.arrayContaining(['start', 'snapshot', 'console']));
  });

  test('B358 catalog curates VM, application and cluster offerings without exposing target identifiers', () => {
    const catalog = service.listCatalog(requester);
    expect(catalog.items.map(item => item.kind)).toEqual(['application', 'cluster', 'vm']);
    const vm = catalog.items.find(item => item.kind === 'vm');
    expect(vm.version.offering.targets[0]).toEqual({ providerType: 'proxmox', configured: true });
    expect(JSON.stringify(vm)).not.toContain(ARTIFACT_ID);
  });

  test('B359 owners create immutable-hash versions and explicitly publish lifecycle transitions', () => {
    const item = service.saveCatalogItem(null, { slug: 'gpu-vm', name: 'GPU VM', kind: 'vm', owner: 'ML Platform', description: 'Curated accelerator VM' }, admin).item;
    const created = service.createCatalogVersion(item.id, { version: '1.0.0', changelog: 'Initial', compatibility: { providerTypes: ['proxmox'] },
      formSchema: { fields: [{ key: 'name', label: 'Name', type: 'string', required: true }] }, offering: { requestKind: 'vm_provision', targets: [] }, costModel: { currency: 'EUR', base: 10 } }, admin).version;
    expect(created).toMatchObject({ state: 'draft', versionHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(service.transitionCatalogVersion(item.id, created.id, 'published', admin).item).toMatchObject({ lifecycle: 'active', currentVersionId: created.id });
    expect(service.transitionCatalogVersion(item.id, created.id, 'retired', admin).item.lifecycle).toBe('retired');
    expect(() => service.transitionCatalogVersion(item.id, created.id, 'published', admin)).toThrow(expect.objectContaining({ code: 'CATALOG_VERSION_IMMUTABLE' }));
  });

  test('B360 dynamic forms enforce conditions, bounds and secret-free cost previews', () => {
    const schema = service.listCatalog(admin, { includeAll: true }).items.find(item => item.slug === 'standard-vm').version.formSchema;
    const model = service.listCatalog(admin, { includeAll: true }).items.find(item => item.slug === 'standard-vm').version.costModel;
    const valid = service.evaluateForm(schema, requestValues(), model);
    expect(valid).toMatchObject({ valid: true, normalized: { backup: true }, costPreview: { amount: 22.4, currency: 'EUR', period: 'month', estimate: true } });
    expect(service.evaluateForm(schema, requestValues({ environment: 'nonproduction', backup: true }), model)).toMatchObject({ valid: false, errors: [expect.objectContaining({ code: 'HIDDEN_FIELD_SUPPLIED' })] });
    expect(() => service.evaluateForm(schema, { ...requestValues(), password: 'inline' }, model)).toThrow(expect.objectContaining({ code: 'SECRET_INPUT_REJECTED' }));
  });

  test('B361 request approval inbox binds risk, normalized diff, cost, expiry and distinct decision', () => {
    const request = service.createProvisionRequest('standard-vm', { tenantId: 1, values: requestValues(), reason: 'capacity for payment traffic' }, requester).request;
    expect(request).toMatchObject({ state: 'requested', risk: 3, approvalRequestId: expect.any(Number), diff: { projectedUsage: expect.any(Object) }, costPreview: { estimate: true } });
    expect(service.listRequests(approver, { inbox: true }).requests).toHaveLength(1);
    expect(() => service.decideRequest(request.id, 'approve', 'self approval', requester)).toThrow(SelfServiceError);
    expect(service.decideRequest(request.id, 'approve', 'risk and quota reviewed', approver).request.state).toBe('approved');
  });

  test('B362 fulfillment timeline records ordered requested, approved and running evidence', async () => {
    const request = service.createProvisionRequest('standard-vm', { tenantId: 1, values: requestValues(), reason: 'new payment worker' }, requester).request;
    service.decideRequest(request.id, 'approve', 'reviewed', approver);
    const preflight = await service.preflightFulfillment(request.id, approver);
    expect(preflight.target).toEqual({ providerType: 'proxmox' });
    const running = await service.fulfillRequest(request.id, { planHash: preflight.plan.planHash, confirm: true, confirmName: 'payments-02', idempotencyKey: 'self-service-test-001' }, approver);
    expect(running.request.events.map(event => event.state)).toEqual(['requested', 'approved', 'running']);
    expect(running.request.events[2].evidence).toMatchObject({ operationId: running.request.providerOperationId, planHash: 'c'.repeat(64) });
  });

  test('B363 project dashboard combines resources, quota posture, alerts and request counts', () => {
    db.prepare("INSERT INTO governance_project_quotas (tenant_id,metric,soft_limit,hard_limit) VALUES (1,'cpu_millicores',1000,10000)").run();
    service.createProvisionRequest('standard-vm', { tenantId: 1, values: requestValues(), reason: 'dashboard request' }, requester);
    const dashboard = service.projectDashboard(1, requester);
    expect(dashboard.resources).toHaveLength(1);
    expect(dashboard.alerts).toEqual([expect.objectContaining({ metric: 'cpu_millicores', severity: 'warning' })]);
    expect(dashboard.requests.counts).toEqual({ requested: 1 });
    expect(dashboard.cost.status).toBe('estimate_only');
  });

  test('B364 VM provisioning hides fabric details and reuses durable provider submit after approval', async () => {
    const created = service.createProvisionRequest('standard-vm', { tenantId: 1, values: requestValues(), reason: 'self-service VM' }, requester).request;
    expect(JSON.stringify(created)).not.toContain(ARTIFACT_ID);
    service.decideRequest(created.id, 'approve', 'approved', approver);
    const preflight = await service.preflightFulfillment(created.id, approver);
    const fulfilled = await service.fulfillRequest(created.id, { planHash: preflight.plan.planHash, confirm: true, confirmName: 'payments-02', idempotencyKey: 'self-service-vm-002' }, approver);
    expect(fulfilled.request).toMatchObject({ state: 'running', providerOperationId: 'op_1234567890abcdef1234567890' });
  });

  test('B365 lifecycle actions are project/policy scoped and reconcile durable operation outcomes', async () => {
    const consoleRequest = service.createLifecycleRequest(1, 1, { action: 'console', reason: 'debug incident' }, requester).request;
    expect(consoleRequest).toMatchObject({ state: 'validated', actionKey: 'console', approvalRequestId: null });
    expect(consoleRequest.events[0].evidence.url).toContain(VM_ID);
    const power = service.createLifecycleRequest(1, 1, { action: 'reboot', reason: 'guest patch completion' }, requester).request;
    service.decideRequest(power.id, 'approve', 'approved', approver);
    const preflight = await service.preflightFulfillment(power.id, approver);
    const running = await service.fulfillRequest(power.id, { planHash: preflight.plan.planHash, confirm: true, idempotencyKey: 'self-service-power-003' }, approver);
    operationStates.set(running.request.providerOperationId, { id: running.request.providerOperationId, state: 'succeeded' });
    expect(service.getRequest(power.id, requester).request.state).toBe('validated');
    service.saveProjectPolicy(1, { allowedActions: ['console'], maximumRisk: 1, requireApproval: true }, admin);
    expect(() => service.createLifecycleRequest(1, 1, { action: 'snapshot', reason: 'blocked' }, requester)).toThrow(expect.objectContaining({ code: 'LIFECYCLE_POLICY_BLOCKED' }));
  });
});
