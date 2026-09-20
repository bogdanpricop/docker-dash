'use strict';

process.env.APP_SECRET = 'test-kubevirt-convergence';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const Database = require('better-sqlite3');
const migration136 = require('../db/migrations/136_sustainability_kubevirt');

const mockHttps = {
  _routes: new Map(), _requests: [],
  reset() { this._routes.clear(); this._requests.length = 0; },
  respond(path, body, status = 200) {
    if (!this._routes.has(path)) this._routes.set(path, []);
    this._routes.get(path).push({ body, status });
  },
  Agent: function Agent() {},
  request(opts, cb) {
    const req = { _body: null, write(body) { this._body = body; }, on() {}, destroy() {},
      end: () => setImmediate(() => {
        mockHttps._requests.push({ ...opts, body: req._body && req._body.toString() });
        const queue = mockHttps._routes.get(opts.path) || []; const next = queue.shift();
        if (!next) throw new Error(`No mock response for ${opts.method} ${opts.path}`);
        const listeners = {}; const response = { statusCode: next.status,
          on(event, handler) { listeners[event] = handler; } };
        cb(response);
        const encoded = next.body == null ? null : Buffer.from(JSON.stringify(next.body));
        if (encoded && listeners.data) listeners.data(encoded);
        if (listeners.end) listeners.end();
      }) };
    return req;
  },
};
jest.mock('https', () => mockHttps);

const { KubernetesClient } = require('../services/kubernetes');
const { KubernetesVirtualizationService } = require('../services/kubernetes-virtualization');

const admin = { id: 1, username: 'admin', role: 'admin' };
const host = { id: 7, name: 'cluster-a', daemon_type: 'kubernetes', daemon_config: '{}' };
const vm = { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine',
  metadata: { namespace: 'default', name: 'vm-a', uid: 'uid-a', resourceVersion: '42' },
  spec: { runStrategy: 'Always', template: { spec: { domain: { cpu: { cores: 2 }, resources: { requests: { memory: '4Gi' } } } } } },
  status: { printableStatus: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, daemon_config TEXT);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    INSERT INTO users (id,username,role) VALUES (1,'admin','admin');
    INSERT INTO docker_hosts (id,name,daemon_type,daemon_config) VALUES (7,'cluster-a','kubernetes','{}');
    INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin');
  `);
  migration136.up(db); return db;
}
function client() { return new KubernetesClient({ endpoint: 'https://k.example:6443', token: 'test' }); }
function apiGroups(names) {
  return { groups: names.map(name => ({ name, preferredVersion: { groupVersion: `${name}/v1` } })) };
}

describe('V5.6a Kubernetes virtualization convergence (B301-B305)', () => {
  beforeEach(() => mockHttps.reset());

  test('discovers KubeVirt, CDI, snapshots, consoles, OpenShift and Harvester from API groups and CRDs', async () => {
    mockHttps.respond('/apis', apiGroups(['kubevirt.io','cdi.kubevirt.io','snapshot.kubevirt.io','subresources.kubevirt.io',
      'route.openshift.io','project.openshift.io','operators.coreos.com','harvesterhci.io','longhorn.io','k8s.cni.cncf.io']));
    mockHttps.respond('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500', { items: [
      { metadata: { name: 'virtualmachines.kubevirt.io' } }, { metadata: { name: 'datavolumes.cdi.kubevirt.io' } },
    ] });
    const result = await client().discoverVirtualizationCapabilities();
    expect(result.platform).toBe('harvester');
    expect(Object.values(result.capabilities).every(item => item.state === 'supported')).toBe(true);
    expect(result).toMatchObject({ crdDiscovery: { state: 'supported', count: 2 }, providerMutationsStarted: 0 });
  });

  test('capability discovery reports unknown rather than unsupported when CRD listing is forbidden', async () => {
    mockHttps.respond('/apis', apiGroups([]));
    mockHttps.respond('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500',
      { message: 'forbidden', reason: 'Forbidden' }, 403);
    const result = await client().discoverVirtualizationCapabilities();
    expect(result.capabilities.virtualMachines).toMatchObject({ state: 'unknown', reason: 'crd_discovery_forbidden' });
  });

  test('normalizes VM, instance and migration identity and state', async () => {
    mockHttps.respond('/apis/kubevirt.io/v1/namespaces/default/virtualmachines', { items: [vm] });
    mockHttps.respond('/apis/kubevirt.io/v1/namespaces/default/virtualmachineinstances', { items: [{
      metadata: { namespace: 'default', name: 'vm-a' }, status: { phase: 'Running', nodeName: 'worker-1',
        interfaces: [{ name: 'default', ipAddress: '10.0.0.5', mac: '02:00:00:00:00:01' }] },
    }] });
    mockHttps.respond('/apis/kubevirt.io/v1/namespaces/default/virtualmachineinstancemigrations', { items: [{
      metadata: { uid: 'mig-uid', namespace: 'default', name: 'mig-a' }, spec: { vmiName: 'vm-a' },
      status: { phase: 'Succeeded', migrationState: { sourceNode: 'worker-1', targetNode: 'worker-2' } },
    }] });
    const result = await client().kubeVirtInventory('default');
    expect(result.virtualMachines[0]).toMatchObject({ uid: 'uid-a', namespace: 'default', name: 'vm-a',
      desiredRunning: true, state: 'Running', ready: true, nodeName: 'worker-1',
      migrations: [{ phase: 'Succeeded', sourceNode: 'worker-1', targetNode: 'worker-2' }] });
    expect(result.coverage).toEqual({ virtualMachines: 'supported', instances: 'supported', migrations: 'supported' });
  });

  test('OpenShift adapter exposes projects, routes, operator conditions and namespace RBAC', async () => {
    mockHttps.respond('/apis', apiGroups(['kubevirt.io','route.openshift.io','project.openshift.io','operators.coreos.com']));
    mockHttps.respond('/apis/project.openshift.io/v1/projects', { items: [{ metadata: { name: 'project-a' } }] });
    mockHttps.respond('/apis/route.openshift.io/v1/namespaces/default/routes', { items: [{ metadata: { name: 'console' },
      spec: { host: 'console.example' }, status: { ingress: [{ conditions: [{ type: 'Admitted', status: 'True' }] }] } }] });
    mockHttps.respond('/apis/operators.coreos.com/v1alpha1/clusterserviceversions', { items: [{ metadata: { name: 'kubevirt-hco' },
      spec: { displayName: 'OpenShift Virtualization' }, status: { phase: 'Succeeded', conditions: [{ phase: 'Succeeded', reason: 'InstallSuccessful' }] } }] });
    mockHttps.respond('/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', { status: { resourceRules: [{
      apiGroups: ['kubevirt.io'], resources: ['virtualmachines'], verbs: ['get','list'],
    }] } });
    mockHttps.respond('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500', { items: [] });
    const result = await client().openShiftVirtualizationOverview('default');
    expect(result).toMatchObject({ platform: 'openshift-virtualization', projects: { state: 'supported', count: 1 },
      routes: { state: 'supported', items: [{ name: 'console', admitted: true }] },
      operators: { state: 'supported', items: [{ phase: 'Succeeded' }] }, rbac: { state: 'supported' },
      providerMutationsStarted: 0 });
  });

  test('Harvester adapter reports image, network, backup and Longhorn coverage without mutations', async () => {
    mockHttps.respond('/apis', apiGroups(['harvesterhci.io','longhorn.io','k8s.cni.cncf.io']));
    mockHttps.respond('/apis/harvesterhci.io/v1beta1/namespaces/default/virtualmachineimages', { items: [{
      metadata: { name: 'ubuntu' }, spec: { displayName: 'Ubuntu', url: 'https://images.example/ubuntu.qcow2' },
      status: { progress: 100, storageClassName: 'longhorn' },
    }] });
    mockHttps.respond('/apis/k8s.cni.cncf.io/v1/namespaces/default/network-attachment-definitions', { items: [{ metadata: { name: 'vlan-10' }, spec: { config: '{}' } }] });
    mockHttps.respond('/apis/harvesterhci.io/v1beta1/namespaces/default/virtualmachinebackups', { items: [{ metadata: { name: 'backup-a' }, spec: { source: { name: 'vm-a' } }, status: { readyToUse: true } }] });
    mockHttps.respond('/apis/longhorn.io/v1beta2/volumes', { items: [{ metadata: { name: 'vol-a' }, spec: { size: '10Gi' }, status: { state: 'attached', robustness: 'healthy' } }] });
    mockHttps.respond('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500', { items: [] });
    const result = await client().harvesterOverview('default');
    expect(result).toMatchObject({ platform: 'harvester', images: { items: [{ name: 'ubuntu', state: 'ready' }] },
      networks: { items: [{ name: 'vlan-10', type: 'cni' }] }, backups: { items: [{ state: 'ready' }] },
      longhornVolumes: { items: [{ state: 'attached', robustness: 'healthy' }] }, providerMutationsStarted: 0 });
  });

  test('server dry-run uses apply-patch YAML and dryRun=All', async () => {
    const path = '/apis/kubevirt.io/v1/namespaces/default/virtualmachines/vm-a?dryRun=All&fieldManager=docker-dash&force=false';
    mockHttps.respond(path, vm);
    await client().dryRunKubeVirtVirtualMachine('default', 'vm-a', 'apiVersion: kubevirt.io/v1\nkind: VirtualMachine\n');
    expect(mockHttps._requests[0]).toMatchObject({ method: 'PATCH', path });
    expect(mockHttps._requests[0].headers['Content-Type']).toBe('application/apply-patch+yaml');
    expect(mockHttps._requests[0].body).toContain('kind: VirtualMachine');
  });

  test('persists idempotent capability and inventory evidence snapshots', async () => {
    const db = database(); const stub = { discoverVirtualizationCapabilities: jest.fn().mockResolvedValue({
      platform: 'kubevirt', capabilities: { virtualMachines: { state: 'supported' } }, observedAt: '2026-07-01T00:00:00.000Z', providerMutationsStarted: 0 }),
    kubeVirtInventory: jest.fn().mockResolvedValue({ namespace: 'default', virtualMachines: [{ name: 'vm-a' }],
      orphanInstances: [], migrations: [], coverage: { virtualMachines: 'supported' }, observedAt: '2026-07-01T00:00:00.000Z', providerMutationsStarted: 0 }) };
    const service = new KubernetesVirtualizationService(() => db, () => stub);
    const capability = await service.refreshDiscovery(host, admin); const duplicate = await service.refreshDiscovery(host, admin);
    const inventory = await service.refreshInventory(host, 'default', admin);
    expect(capability).toMatchObject({ platform: 'kubevirt', duplicate: false });
    expect(duplicate).toMatchObject({ id: capability.id, duplicate: true });
    expect(inventory).toMatchObject({ vmCount: 1, vmiCount: 1, migrationCount: 0, duplicate: false });
    db.close();
  });

  test('VM editor strips server fields and blocks inline cloud-init secrets', async () => {
    const db = database(); const stub = { getKubeVirtVirtualMachine: jest.fn().mockResolvedValue(vm) };
    const service = new KubernetesVirtualizationService(() => db, () => stub);
    const result = await service.virtualMachineYaml(host, 'default', 'vm-a');
    expect(result.yaml).not.toContain('resourceVersion'); expect(result.yaml).not.toContain('status:');
    stub.getKubeVirtVirtualMachine.mockResolvedValue({ ...vm, spec: { template: { spec: { domain: {},
      volumes: [{ cloudInitNoCloud: { userData: 'password: bad' } }] } } } });
    await expect(service.virtualMachineYaml(host, 'default', 'vm-a')).rejects.toMatchObject({ code: 'INLINE_SECRET_MATERIAL' });
    db.close();
  });

  test('VM YAML validation persists diff and accepted server evidence but never applies', async () => {
    const db = database(); const stub = { getKubeVirtVirtualMachine: jest.fn().mockResolvedValue(vm),
      dryRunKubeVirtVirtualMachine: jest.fn().mockResolvedValue({ ...vm, metadata: { ...vm.metadata, resourceVersion: '43' } }) };
    const service = new KubernetesVirtualizationService(() => db, () => stub);
    const desired = `apiVersion: kubevirt.io/v1\nkind: VirtualMachine\nmetadata:\n  namespace: default\n  name: vm-a\nspec:\n  runStrategy: Halted\n  template:\n    spec:\n      domain:\n        cpu:\n          cores: 1\n`;
    const first = await service.dryRunVirtualMachine(host, 'default', 'vm-a', desired, admin);
    const duplicate = await service.dryRunVirtualMachine(host, 'default', 'vm-a', desired, admin);
    expect(first).toMatchObject({ status: 'valid', applied: false, serverResponse: { accepted: true, dryRun: 'All' }, duplicate: false });
    expect(first.diff).toContain('runStrategy'); expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(db.prepare('SELECT applied FROM kubernetes_virtualization_dry_runs').get().applied).toBe(0);
    db.close();
  });

  test('server rejection is evidence and identity or inline-secret changes fail before API calls', async () => {
    const db = database(); const rejection = Object.assign(new Error('invalid CPU'), { status: 422,
      kubernetesResponse: { reason: 'Invalid', message: 'spec CPU is invalid', details: { group: 'kubevirt.io' } } });
    const stub = { getKubeVirtVirtualMachine: jest.fn().mockResolvedValue(vm),
      dryRunKubeVirtVirtualMachine: jest.fn().mockRejectedValue(rejection) };
    const service = new KubernetesVirtualizationService(() => db, () => stub);
    const desired = `apiVersion: kubevirt.io/v1\nkind: VirtualMachine\nmetadata:\n  namespace: default\n  name: vm-a\nspec:\n  template:\n    spec:\n      domain:\n        cpu:\n          cores: 0\n`;
    const rejected = await service.dryRunVirtualMachine(host, 'default', 'vm-a', desired, admin);
    expect(rejected).toMatchObject({ status: 'rejected', applied: false,
      serverResponse: { accepted: false, status: 422, reason: 'Invalid' } });
    const wrongIdentity = desired.replace('name: vm-a', 'name: vm-b');
    await expect(service.dryRunVirtualMachine(host, 'default', 'vm-a', wrongIdentity, admin))
      .rejects.toMatchObject({ code: 'VM_IDENTITY_MISMATCH' });
    const inlineSecret = desired.replace('cores: 0', 'cores: 1\n        userData: password');
    await expect(service.dryRunVirtualMachine(host, 'default', 'vm-a', inlineSecret, admin))
      .rejects.toMatchObject({ code: 'INLINE_SECRET_MATERIAL' });
    expect(stub.dryRunKubeVirtVirtualMachine).toHaveBeenCalledTimes(1);
    db.close();
  });
});
