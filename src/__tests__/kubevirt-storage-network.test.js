'use strict';

process.env.APP_SECRET = 'test-kubevirt-storage-network';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const Database = require('better-sqlite3');
const migration131 = require('../db/migrations/131_automation_operations_lifecycle_updates');
const migration137 = require('../db/migrations/137_kubevirt_storage_network_convergence');

const mockHttps = {
  _routes: new Map(), _requests: [], reset() { this._routes.clear(); this._requests.length = 0; },
  respond(path, body, status = 200) { if (!this._routes.has(path)) this._routes.set(path, []); this._routes.get(path).push({ body, status }); },
  Agent: function Agent() {},
  request(opts, cb) {
    const req = { _body: null, write(body) { this._body = body; }, on() {}, destroy() {},
      end: () => setImmediate(() => {
        mockHttps._requests.push({ ...opts, body: req._body && req._body.toString() });
        const next = (mockHttps._routes.get(opts.path) || []).shift();
        if (!next) throw new Error(`No mock response for ${opts.method} ${opts.path}`);
        const listeners = {}; cb({ statusCode: next.status, on(event, handler) { listeners[event] = handler; } });
        const encoded = next.body == null ? null : Buffer.from(JSON.stringify(next.body));
        if (encoded && listeners.data) listeners.data(encoded); if (listeners.end) listeners.end();
      }) };
    return req;
  },
};
jest.mock('https', () => mockHttps);

const { KubernetesClient } = require('../services/kubernetes');
const { KubernetesConvergenceService } = require('../services/kubernetes-convergence');
const { InfrastructureOperationsService } = require('../services/infrastructure-operations');

const admin = { id: 1, username: 'requester', role: 'admin' };
const approver = { id: 2, username: 'reviewer', role: 'admin' };
const host = { id: 7, name: 'cluster-a', daemon_type: 'kubernetes', daemon_config: '{}' };
const supported = { state: 'supported', reason: null };

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, daemon_config TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    CREATE TABLE infrastructure_workflows (id INTEGER PRIMARY KEY, enabled INTEGER DEFAULT 1);
    INSERT INTO users (id,username,role,is_active) VALUES (1,'requester','admin',1),(2,'reviewer','admin',1);
    INSERT INTO docker_hosts (id,name,daemon_type,daemon_config,is_active) VALUES (7,'cluster-a','kubernetes','{}',1);
    INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin');
  `);
  migration131.up(db); migration137.up(db); return db;
}
function client() { return new KubernetesClient({ endpoint: 'https://k.example:6443', token: 'test' }); }
function probe(path, body = { items: [] }, status = 200) { mockHttps.respond(path, body, status); }

describe('V5.6b KubeVirt storage and network convergence (B306-B315)', () => {
  beforeEach(() => mockHttps.reset());

  test('migration creates guarded plan, event, policy and evidence tables plus three permissions', () => {
    const db = database();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name LIKE 'kubernetes_virtualization_%'").all('table').map(row => row.name);
    expect(names).toEqual(expect.arrayContaining(['kubernetes_virtualization_change_plans',
      'kubernetes_virtualization_operation_events', 'kubernetes_virtualization_migration_policies',
      'kubernetes_virtualization_convergence_snapshots']));
    expect(db.prepare("SELECT COUNT(*) AS count FROM governance_permissions WHERE permission_key LIKE 'kubernetes_%'").get().count).toBe(3);
    db.close();
  });

  test('DataVolume inventory exposes source, progress, storage and conditions', async () => {
    probe('/apis/cdi.kubevirt.io/v1beta1/namespaces/default/datavolumes', { items: [{ metadata: { namespace: 'default', name: 'ubuntu', uid: 'dv-1' },
      spec: { source: { http: { url: 'https://images.example/ubuntu.qcow2' } }, storage: { storageClassName: 'fast' } },
      status: { phase: 'ImportInProgress', progress: '63.2%', conditions: [{ type: 'Running', status: 'True' }] } }] });
    const result = await client().dataVolumeInventory('default');
    expect(result).toMatchObject({ state: 'supported', items: [{ name: 'ubuntu', sourceKind: 'http', phase: 'ImportInProgress', progress: '63.2%' }], providerMutationsStarted: 0 });
  });

  test('template inventory combines OpenShift templates, instancetypes and preferences with explicit coverage', async () => {
    probe('/apis/template.openshift.io/v1/namespaces/default/templates', { items: [{ metadata: { namespace: 'default', name: 'ubuntu' }, parameters: [{ name: 'MEMORY' }], objects: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine' }] }] });
    probe('/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterinstancetypes', { items: [{ metadata: { name: 'u1.small' }, spec: { cpu: { guest: 1 } } }] });
    probe('/apis/instancetype.kubevirt.io/v1beta1/namespaces/default/virtualmachineinstancetypes');
    probe('/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterpreferences');
    probe('/apis/instancetype.kubevirt.io/v1beta1/namespaces/default/virtualmachinepreferences', { message: 'forbidden' }, 403);
    const result = await client().virtualizationTemplateInventory('default');
    expect(result.templates.items[0]).toMatchObject({ name: 'ubuntu', objectKinds: ['kubevirt.io/v1/VirtualMachine'] });
    expect(result.instancetypes.cluster.items[0].name).toBe('u1.small');
    expect(result.preferences.namespaced.state).toBe('unknown');
  });

  test('node drain analysis identifies eviction and LiveMigratable blockers', async () => {
    probe('/api/v1/nodes', { items: [{ metadata: { name: 'node-a' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] });
    probe('/apis/kubevirt.io/v1/virtualmachines', { items: [{ metadata: { namespace: 'default', name: 'vm-a' }, spec: { template: { spec: { evictionStrategy: 'None' } } } }] });
    probe('/apis/kubevirt.io/v1/virtualmachineinstances', { items: [{ metadata: { namespace: 'default', name: 'vm-a' }, status: { nodeName: 'node-a', conditions: [{ type: 'LiveMigratable', status: 'False', reason: 'PVCNotShared' }] } }] });
    const result = await client().nodeDrainVirtualMachineAwareness();
    expect(result.items[0]).toMatchObject({ name: 'node-a', drainReady: false, blockerCount: 2,
      virtualMachines: [{ evictionStrategy: 'None', liveMigratable: false }] });
  });

  test('CSI map relates snapshot classes to drivers and storage classes', async () => {
    probe('/apis/snapshot.storage.k8s.io/v1/volumesnapshotclasses', { items: [{ metadata: { name: 'snap-fast', annotations: { 'snapshot.storage.kubernetes.io/is-default-class': 'true' } }, driver: 'csi.fast', deletionPolicy: 'Delete' }] });
    probe('/apis/storage.k8s.io/v1/csidrivers', { items: [{ metadata: { name: 'csi.fast' }, spec: { attachRequired: true, volumeLifecycleModes: ['Persistent'] } }] });
    probe('/apis/storage.k8s.io/v1/storageclasses', { items: [{ metadata: { name: 'fast' }, provisioner: 'csi.fast' }] });
    const result = await client().csiSnapshotCapabilityMap();
    expect(result.snapshotClasses[0]).toMatchObject({ name: 'snap-fast', apiDriverKnown: true, isDefault: true });
    expect(result.storageClasses[0].snapshotClasses).toEqual(['snap-fast']);
  });

  test('Multus inventory parses NAD IPAM and maps VM interfaces without exposing credentials', async () => {
    probe('/apis/k8s.cni.cncf.io/v1/namespaces/default/network-attachment-definitions', { items: [{ metadata: { namespace: 'default', name: 'vlan10' }, spec: { config: JSON.stringify({ cniVersion: '0.3.1', type: 'bridge', bridge: 'br10', vlan: 10, ipam: { type: 'whereabouts' } }) } }] });
    probe('/apis/kubevirt.io/v1/namespaces/default/virtualmachines', { items: [{ metadata: { namespace: 'default', name: 'vm-a' }, spec: { template: { spec: { networks: [{ name: 'secondary', multus: { networkName: 'vlan10' } }], domain: { devices: { interfaces: [{ name: 'secondary', bridge: {} }] } } } } } }] });
    const result = await client().multusNetworkInventory('default');
    expect(result.networks[0]).toMatchObject({ pluginType: 'bridge', vlan: 10, ipam: { type: 'whereabouts' }, configValid: true });
    expect(result.attachments[0]).toMatchObject({ vmName: 'vm-a', attachment: 'vlan10', interface: { bridge: {} } });
  });

  test('NMState and VM exposure map intent health and Service/Route/Ingress paths', async () => {
    probe('/apis/nmstate.io/v1beta1/nodenetworkconfigurationpolicies', { items: [{ metadata: { name: 'bond0' }, spec: { nodeSelector: { role: 'worker' }, desiredState: { interfaces: [] } }, status: { lastUnavailableNodeCount: 0, conditions: [{ type: 'Available', status: 'True' }] } }] });
    probe('/apis/nmstate.io/v1beta1/nodenetworkstates', { items: [{ metadata: { name: 'node-a' }, status: { currentState: { interfaces: [{ name: 'eth0', type: 'ethernet', state: 'up' }] } } }] });
    const intent = await client().nmStateNetworkIntent(); expect(intent.policies.items[0]).toMatchObject({ name: 'bond0', enactments: 0 });
    probe('/apis/kubevirt.io/v1/namespaces/default/virtualmachines', { items: [{ metadata: { namespace: 'default', name: 'vm-a' } }] });
    probe('/api/v1/namespaces/default/services', { items: [{ metadata: { namespace: 'default', name: 'web' }, spec: { selector: { 'kubevirt.io/domain': 'vm-a' }, type: 'ClusterIP', ports: [{ port: 80 }] } }] });
    probe('/apis/route.openshift.io/v1/namespaces/default/routes', { items: [{ metadata: { namespace: 'default', name: 'web' }, spec: { to: { name: 'web' }, host: 'vm.example', tls: {} } }] });
    probe('/apis/networking.k8s.io/v1/namespaces/default/ingresses', { items: [{ metadata: { namespace: 'default', name: 'web' }, spec: { rules: [{ host: 'vm2.example', http: { paths: [{ backend: { service: { name: 'web' } } }] } }] } }] });
    const exposure = await client().virtualMachineExposure('default');
    expect(exposure.entries[0].services[0]).toMatchObject({ name: 'web', routes: [{ host: 'vm.example', tls: true }], ingresses: [{ hosts: ['vm2.example'] }] });
  });

  test('DataVolume wizard requires HTTPS/checksum, dry-runs and creates an idempotent hash-bound approval plan', async () => {
    const db = database(); const approvalService = new InfrastructureOperationsService(() => db);
    const stub = { virtualizationCreationPrerequisites: jest.fn().mockResolvedValue({ checks: [{ kind: 'namespace', name: 'default', ...supported }], valid: true, providerMutationsStarted: 0 }),
      dryRunCreateDataVolume: jest.fn().mockImplementation((_namespace, manifest) => Promise.resolve(manifest)) };
    const service = new KubernetesConvergenceService(() => db, { clientFactory: () => stub, approvalService });
    await expect(service.planDataVolume(host, { namespace: 'default', name: 'bad', sourceType: 'http', source: { url: 'http://insecure/image' }, storage: { size: '10Gi' } }, admin)).rejects.toMatchObject({ code: 'INSECURE_IMPORT_URL' });
    await expect(service.planDataVolume(host, { namespace: 'default', name: 'secret-url', sourceType: 'http', source: { url: 'https://images.example/ubuntu?token=inline' }, storage: { size: '10Gi' } }, admin)).rejects.toMatchObject({ code: 'INLINE_SECRET_MATERIAL' });
    const input = { namespace: 'default', name: 'ubuntu', sourceType: 'http', source: { url: 'https://images.example/ubuntu' }, checksum: `sha256:${'a'.repeat(64)}`, storage: { size: '10Gi', storageClassName: 'fast' } };
    const first = await service.planDataVolume(host, input, admin); const duplicate = await service.planDataVolume(host, input, admin);
    expect(first).toMatchObject({ kind: 'datavolume_create', state: 'validated', duplicate: false });
    expect(first.manifest.metadata.annotations['docker-dash.io/source-checksum']).toBe(input.checksum);
    expect(duplicate).toMatchObject({ id: first.id, approvalId: first.approvalId, duplicate: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM infrastructure_approval_requests').get().count).toBe(1); db.close();
  });

  test('template planning substitutes declared parameters and validates storage/network prerequisites', async () => {
    const db = database(); const approvalService = new InfrastructureOperationsService(() => db);
    const template = { parameters: [{ name: 'MEMORY', value: '2Gi' }], objects: [{ apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', metadata: { name: 'placeholder' }, spec: {
      dataVolumeTemplates: [{ spec: { storage: { storageClassName: 'fast' } } }], template: { spec: { domain: { resources: { requests: { memory: '${MEMORY}' } } }, networks: [{ name: 'net', multus: { networkName: 'default/vlan10' } }] } } } }] };
    const stub = { getVirtualizationTemplate: jest.fn().mockResolvedValue(template),
      virtualizationCreationPrerequisites: jest.fn().mockResolvedValue({ checks: [], valid: true, providerMutationsStarted: 0 }),
      dryRunCreateKubeVirtVirtualMachine: jest.fn().mockImplementation((_namespace, manifest) => Promise.resolve(manifest)) };
    const service = new KubernetesConvergenceService(() => db, { clientFactory: () => stub, approvalService });
    const plan = await service.planTemplateInstantiation(host, { namespace: 'default', templateName: 'ubuntu', vmName: 'vm-a', parameters: { MEMORY: '4Gi' } }, admin);
    expect(plan.manifest.spec.template.spec.domain.resources.requests.memory).toBe('4Gi');
    expect(stub.virtualizationCreationPrerequisites).toHaveBeenCalledWith(expect.objectContaining({ storageClassNames: ['fast'], networkAttachments: ['default/vlan10'] }));
    db.close();
  });

  test('execution enforces four-eyes approval and typed confirmation, revalidates, creates and verifies read-back', async () => {
    const db = database(); const approvalService = new InfrastructureOperationsService(() => db); let observed;
    const prereq = { checks: [{ kind: 'namespace', name: 'default', ...supported }], valid: true, providerMutationsStarted: 0 };
    const stub = { virtualizationCreationPrerequisites: jest.fn().mockResolvedValue(prereq),
      dryRunCreateDataVolume: jest.fn().mockImplementation((_namespace, manifest) => Promise.resolve(manifest)),
      createDataVolume: jest.fn().mockImplementation((_namespace, manifest) => { observed = { ...manifest, metadata: { ...manifest.metadata, uid: 'dv-1', resourceVersion: '2' } }; return Promise.resolve(observed); }),
      getDataVolume: jest.fn().mockImplementation(() => Promise.resolve(observed)) };
    const service = new KubernetesConvergenceService(() => db, { clientFactory: () => stub, approvalService });
    const plan = await service.planDataVolume(host, { namespace: 'default', name: 'upload-a', sourceType: 'upload', storage: { size: '5Gi' } }, admin);
    const approval = db.prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(plan.approvalId);
    approvalService.decideApproval(plan.approvalId, { decision: 'approved', payloadHash: approval.payload_hash }, approver);
    await expect(service.executePlan(host, plan.id, { approvalId: plan.approvalId, confirmation: 'wrong' }, approver)).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
    const result = await service.executePlan(host, plan.id, { approvalId: plan.approvalId, confirmation: 'upload-a' }, approver);
    expect(result).toMatchObject({ state: 'succeeded', operationRef: expect.stringMatching(/^kvop_[a-f0-9]{26}$/), executionEvidence: { uid: 'dv-1' } });
    expect(stub.createDataVolume).toHaveBeenCalledTimes(1);
    expect(service.operationEvents(plan.id, approver).map(event => event.state)).toEqual(['queued', 'running', 'succeeded']); db.close();
  });

  test('an ambiguous create outcome stays executing and reconciles by the stored fingerprint', async () => {
    const db = database(); const approvalService = new InfrastructureOperationsService(() => db); let observed;
    const prereq = { checks: [{ kind: 'namespace', name: 'default', ...supported }], valid: true, providerMutationsStarted: 0 };
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    const stub = { virtualizationCreationPrerequisites: jest.fn().mockResolvedValue(prereq),
      dryRunCreateDataVolume: jest.fn().mockImplementation((_namespace, manifest) => Promise.resolve(manifest)),
      createDataVolume: jest.fn().mockRejectedValue(new Error('connection reset after submit')),
      getDataVolume: jest.fn().mockImplementation(() => observed ? Promise.resolve(observed) : Promise.reject(notFound)) };
    const service = new KubernetesConvergenceService(() => db, { clientFactory: () => stub, approvalService });
    const plan = await service.planDataVolume(host, { namespace: 'default', name: 'uncertain-a', sourceType: 'upload', storage: { size: '5Gi' } }, admin);
    const approval = db.prepare('SELECT * FROM infrastructure_approval_requests WHERE id=?').get(plan.approvalId);
    approvalService.decideApproval(plan.approvalId, { decision: 'approved', payloadHash: approval.payload_hash }, approver);
    await expect(service.executePlan(host, plan.id, { approvalId: plan.approvalId, confirmation: 'uncertain-a' }, approver))
      .rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' });
    expect(db.prepare('SELECT state FROM kubernetes_virtualization_change_plans WHERE id=?').get(plan.id).state).toBe('executing');
    observed = { ...plan.manifest, metadata: { ...plan.manifest.metadata, uid: 'dv-uncertain', resourceVersion: '3' } };
    const reconciled = await service.executePlan(host, plan.id, { approvalId: plan.approvalId, confirmation: 'uncertain-a' }, approver);
    expect(reconciled).toMatchObject({ state: 'succeeded', deduplicated: true,
      executionEvidence: { reconciled: true, uid: 'dv-uncertain' } }); db.close();
  });

  test('migration policy is bounded, persistent and compared with read-only KubeVirt evidence', async () => {
    const db = database(); const stub = { migrationConfiguration: jest.fn().mockResolvedValue({ state: 'supported', items: [{ name: 'kubevirt', migrationConfiguration: { bandwidthPerMigration: '32Mi' } }], providerMutationsStarted: 0 }) };
    const service = new KubernetesConvergenceService(() => db, { clientFactory: () => stub });
    const saved = service.saveMigrationPolicy(host, { name: 'production', bandwidthPerMigration: '64Mi', parallelMigrationsPerCluster: 4, parallelOutboundPerNode: 2, completionTimeoutPerGiB: 800, progressTimeoutSeconds: 150 }, admin);
    const overview = await service.migrationPolicies(host, admin);
    expect(saved).toMatchObject({ bandwidthPerMigration: '64Mi', parallelMigrationsPerCluster: 4 });
    expect(overview).toMatchObject({ applySupported: false, providerMutationsStarted: 0, declared: [{ name: 'production' }], observed: { state: 'supported' } }); db.close();
  });
});
