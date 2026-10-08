'use strict';

process.env.APP_SECRET = 'test-kubernetes-unified-platform';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const Database = require('better-sqlite3');
const migration138 = require('../db/migrations/138_unified_kubernetes_platform');

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
const { KubernetesUnifiedPlatformService } = require('../services/kubernetes-unified-platform');

const admin = { id: 1, username: 'platform-admin', role: 'admin' };
const host = { id: 7, name: 'cluster-a', daemon_type: 'kubernetes', daemon_config: '{}' };

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, daemon_config TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    INSERT INTO users (id,username,role,is_active) VALUES (1,'platform-admin','admin',1);
    INSERT INTO docker_hosts (id,name,daemon_type,daemon_config,is_active) VALUES
      (7,'cluster-a','kubernetes','{}',1),(8,'docker-a','docker','{}',1);
    INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin');
  `);
  migration138.up(db); return db;
}
function client() { return new KubernetesClient({ endpoint: 'https://k.example:6443', token: 'test' }); }
function probe(path, body = { items: [] }, status = 200) { mockHttps.respond(path, body, status); }
function vmManifest(name = 'vm-a') {
  return { apiVersion: 'kubevirt.io/v1', kind: 'VirtualMachine', metadata: { namespace: 'default', name,
    labels: { 'app.kubernetes.io/name': 'web', 'app.kubernetes.io/part-of': 'portal',
      'docker-dash.io/owner': 'platform', 'docker-dash.io/environment': 'production' } },
  spec: { template: { spec: { domain: { firmware: { bootloader: { efi: { secureBoot: true } } },
    features: { smm: { enabled: true } }, cpu: { cores: 2 }, memory: { guest: '4Gi' } },
  networks: [{ name: 'secondary', multus: { networkName: 'default/vlan10' } }],
  volumes: [{ name: 'root', containerDisk: { image: 'registry.example/trusted/vm:v1' } }] } } } };
}

describe('V5.6c/V6.1a unified Kubernetes platform (B316-B325)', () => {
  beforeEach(() => mockHttps.reset());

  test('migration creates nine stores, four permissions and curated policy/provider catalogs idempotently', () => {
    const db = database(); migration138.up(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name IN ('kubernetes_unified_evidence_snapshots','kubernetes_vm_gitops_plans','kubernetes_vm_admission_policies','kubernetes_vm_admission_evaluations','kubernetes_cluster_provisioning_catalog','kubernetes_cluster_provisioning_plans','virtualization_modernization_maps','shared_image_provenance','unified_application_environments')")
      .all('table').map(row => row.name);
    expect(tables).toHaveLength(9);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key IN ('kubernetes_unified.manage','kubernetes_vm_policy.manage','kubernetes_cluster_catalog.manage','application_environment.manage')").get().count).toBe(4);
    expect(db.prepare('SELECT COUNT(*) count FROM kubernetes_vm_admission_policies').get().count).toBe(5);
    expect(db.prepare('SELECT COUNT(*) count FROM kubernetes_cluster_provisioning_catalog').get().count).toBe(5);
    expect(db.prepare('SELECT COUNT(*) count FROM governance_role_permissions WHERE role_id=1').get().count).toBe(4); db.close();
  });

  test('unified topology relates pods and VMs to namespace, service, node, storage and Multus network', async () => {
    probe('/api/v1/nodes', { items: [{ metadata: { name: 'node-a' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] });
    probe('/api/v1/namespaces/default/pods', { items: [{ metadata: { namespace: 'default', name: 'web-1', labels: { app: 'web' },
      annotations: { 'k8s.v1.cni.cncf.io/networks': 'vlan10' } }, spec: { nodeName: 'node-a', volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'web-data' } }] }, status: { phase: 'Running' } }] });
    probe('/api/v1/namespaces/default/services', { items: [{ metadata: { namespace: 'default', name: 'web' }, spec: { selector: { app: 'web' } } },
      { metadata: { namespace: 'default', name: 'vm-web' }, spec: { selector: { 'kubevirt.io/domain': 'vm-a' } } }] });
    probe('/api/v1/namespaces/default/persistentvolumeclaims', { items: [{ metadata: { namespace: 'default', name: 'web-data' }, spec: { storageClassName: 'fast' }, status: { phase: 'Bound' } }] });
    probe('/apis/kubevirt.io/v1/namespaces/default/virtualmachines', { items: [{ metadata: { namespace: 'default', name: 'vm-a' }, spec: { template: { spec: {
      volumes: [{ name: 'root', dataVolume: { name: 'vm-root' } }], networks: [{ name: 'net', multus: { networkName: 'vlan10' } }] } } }, status: { printableStatus: 'Running' } }] });
    probe('/apis/kubevirt.io/v1/namespaces/default/virtualmachineinstances', { items: [{ metadata: { namespace: 'default', name: 'vm-a' }, status: { nodeName: 'node-a' } }] });
    probe('/apis/cdi.kubevirt.io/v1beta1/namespaces/default/datavolumes', { items: [{ metadata: { namespace: 'default', name: 'vm-root' }, status: { phase: 'Succeeded' } }] });
    probe('/apis/k8s.cni.cncf.io/v1/namespaces/default/network-attachment-definitions', { items: [{ metadata: { namespace: 'default', name: 'vlan10' } }] });
    const result = await client().unifiedWorkloadTopology('default');
    expect(result.summary).toMatchObject({ namespace: 1, node: 1, pod: 1, vm: 1, service: 2, storage: 2, network: 1 });
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'service:default/web', to: 'pod:default/web-1', kind: 'selects' }),
      expect.objectContaining({ from: 'service:default/vm-web', to: 'vm:default/vm-a', kind: 'selects' }),
      expect.objectContaining({ from: 'vm:default/vm-a', to: 'datavolume:default/vm-root', kind: 'mounts' }),
      expect.objectContaining({ from: 'vm:default/vm-a', to: 'network:default/vlan10', kind: 'attaches' }),
    ]));
    expect(result.providerMutationsStarted).toBe(0);
  });

  test('unified metrics normalize Kubernetes quantities, attribute virt-launcher pods and flag contention', async () => {
    probe('/apis/metrics.k8s.io/v1beta1/namespaces/default/pods', { items: [{ metadata: { namespace: 'default', name: 'virt-launcher-vm-a' },
      timestamp: '2026-07-29T10:00:00Z', window: '30s', containers: [{ usage: { cpu: '750m', memory: '1536Mi' } }, { usage: { cpu: '250m', memory: '512Mi' } }] }] });
    probe('/apis/metrics.k8s.io/v1beta1/nodes', { items: [{ metadata: { name: 'node-a' }, usage: { cpu: '3600m', memory: '15Gi' } }] });
    probe('/api/v1/namespaces/default/pods', { items: [{ metadata: { namespace: 'default', name: 'virt-launcher-vm-a', labels: { 'kubevirt.io/domain': 'vm-a' } }, spec: { nodeName: 'node-a' } }] });
    probe('/api/v1/nodes', { items: [{ metadata: { name: 'node-a' }, status: { allocatable: { cpu: '4', memory: '16Gi' } } }] });
    const result = await client().unifiedWorkloadMetrics('default');
    expect(result.workloads[0]).toMatchObject({ kind: 'vm', name: 'vm-a', sourcePod: 'virt-launcher-vm-a', cpuCores: 1, memoryBytes: 2 * 1024 ** 3 });
    expect(result.contention[0]).toMatchObject({ cpuUtilizationPercent: 90, memoryUtilizationPercent: 93.75, pressure: true });
  });

  test('policy, GitOps and lifecycle evidence preserve coverage while redacting controller credentials', async () => {
    probe('/api/v1/namespaces/default/resourcequotas', { items: [{ metadata: { namespace: 'default', name: 'quota' }, status: { hard: { pods: '10' }, used: { pods: '2' } } }] });
    probe('/apis/networking.k8s.io/v1/namespaces/default/networkpolicies', { items: [{ metadata: { namespace: 'default', name: 'default-deny' }, spec: { policyTypes: ['Ingress','Egress'] } }] });
    probe('/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations', { items: [{}] });
    probe('/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations');
    probe('/apis/kyverno.io/v1/clusterpolicies', { items: [{ metadata: { name: 'baseline' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] });
    probe('/apis/templates.gatekeeper.sh/v1beta1/constrainttemplates', { items: [{ metadata: { name: 'requiredlabels' } }] });
    probe('/api/v1/namespaces/default/pods', { items: [{ metadata: { namespace: 'default', name: 'pod-a', labels: { 'app.kubernetes.io/name': 'app' } } }] });
    probe('/apis/kubevirt.io/v1/namespaces/default/virtualmachines', { items: [{ metadata: vmManifest().metadata }] });
    const policy = await client().unifiedPolicyEvidence('default');
    expect(policy).toMatchObject({ quotas: { items: [{ name: 'quota' }] }, admission: { validating: { count: 1 }, kyverno: { items: [{ name: 'baseline', ready: true }] } } });
    expect(policy.workloads).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'pod', compliant: false }), expect.objectContaining({ kind: 'vm', compliant: true })]));

    probe('/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/default/kustomizations', { items: [{ metadata: { namespace: 'default', name: 'vms' }, status: { conditions: [{ type: 'Ready', status: 'False', message: 'fetch https://user:pass@git.example/repo?token=abc failed' }] } }] });
    probe('/apis/argoproj.io/v1alpha1/namespaces/default/applications', { items: [{ metadata: { namespace: 'default', name: 'portal' }, status: { sync: { status: 'Synced', revision: 'abc' }, health: { status: 'Healthy' } } }] });
    const gitops = await client().gitOpsControllerStatus('default');
    expect(gitops.flux.items[0].conditions[0].message).toBe('fetch https://[redacted]@git.example/repo?token=[redacted] failed');

    probe('/version', { gitVersion: 'v1.34.1', platform: 'linux/amd64' });
    probe('/api/v1/nodes', { items: [{ metadata: { name: 'node-a' }, status: { conditions: [{ type: 'Ready', status: 'False' }], nodeInfo: { kubeletVersion: 'v1.34.1' } }, spec: {} }] });
    probe('/apis', { groups: [{ name: 'kubevirt.io' }] });
    probe('/apis/apps/v1/namespaces/kube-system/deployments', { items: [{ metadata: { name: 'coredns' }, spec: { replicas: 2, template: { spec: { containers: [{ image: 'coredns:v1' }] } } }, status: { readyReplicas: 1 } }] });
    probe('/apis/config.openshift.io/v1/clusteroperators', { items: [] });
    probe('/apis/config.openshift.io/v1/clusterversions', { items: [] });
    const lifecycle = await client().clusterLifecycleDashboard();
    expect(lifecycle.upgradeReadiness).toMatchObject({ state: 'blocked', blockers: ['One or more nodes are not Ready'] });
    expect(lifecycle.addons.items[0]).toMatchObject({ name: 'coredns', ready: 1, desired: 2 });
  });

  test('evidence snapshots deduplicate unchanged observations despite collection timestamps', async () => {
    const db = database(); let second = 0;
    const stub = { unifiedWorkloadTopology: jest.fn().mockImplementation(() => Promise.resolve({ nodes: [], observedAt: `2026-07-29T10:00:0${second++}Z`, providerMutationsStarted: 0 })) };
    const service = new KubernetesUnifiedPlatformService(() => db, () => stub);
    const first = await service.refreshEvidence(host, 'topology', 'default', admin);
    const duplicate = await service.refreshEvidence(host, 'topology', 'default', admin);
    expect(duplicate).toMatchObject({ id: first.id, evidenceHash: first.evidenceHash, duplicate: true });
    expect(db.prepare('SELECT COUNT(*) count FROM kubernetes_unified_evidence_snapshots').get().count).toBe(1); db.close();
  });

  test('VM GitOps creates only stable dry-run plans and rejects credential-bearing sources or manifests', async () => {
    const db = database(); let observed = 0; const desired = vmManifest();
    const stub = { getKubeVirtVirtualMachine: jest.fn().mockResolvedValue(desired),
      dryRunKubeVirtVirtualMachine: jest.fn().mockResolvedValue({ kind: 'VirtualMachine', metadata: { namespace: 'default', name: 'vm-a' } }),
      gitOpsControllerStatus: jest.fn().mockImplementation(() => Promise.resolve({ flux: { state: 'supported', items: [] }, argo: { state: 'unsupported', items: [] }, observedAt: `2026-07-29T10:00:0${observed++}Z`, providerMutationsStarted: 0 })) };
    const service = new KubernetesUnifiedPlatformService(() => db, () => stub); const input = { sourceKind: 'flux',
      repositoryUrl: 'https://git.example/platform/vms.git', repositoryPath: 'clusters/prod/vm-a.yaml', revision: 'main', manifest: desired };
    const first = await service.planVmGitOps(host, input, admin); const duplicate = await service.planVmGitOps(host, input, admin);
    expect(first).toMatchObject({ state: 'in_sync', providerMutationsStarted: 0, duplicate: false, dryRun: { accepted: true, dryRun: 'All' } });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(stub.dryRunKubeVirtVirtualMachine).toHaveBeenCalledTimes(2);
    expect(stub).not.toHaveProperty('applyKubeVirtVirtualMachine');
    await expect(service.planVmGitOps(host, { ...input, repositoryUrl: 'https://user:pass@git.example/vms.git' }, admin)).rejects.toMatchObject({ code: 'UNSAFE_SOURCE_URL' });
    const secretManifest = vmManifest(); secretManifest.spec.template.spec.domain.devices = { interfaces: [] };
    secretManifest.spec.template.spec.accessCredentials = [{ sshPublicKey: { source: { secret: { secretName: 'ssh-key' } }, propagationMethod: {} } }];
    secretManifest.spec.template.spec.volumes.push({ name: 'cloudinit', cloudInitNoCloud: { userData: 'password: inline' } });
    await expect(service.planVmGitOps(host, { ...input, manifest: secretManifest }, admin)).rejects.toMatchObject({ code: 'INLINE_SECRET_MATERIAL' }); db.close();
  });

  test('admission library evaluates five policies without enforcement and deduplicates evidence', () => {
    const db = database(); const service = new KubernetesUnifiedPlatformService(() => db, () => ({}));
    const profile = { trustedImagePrefixes: ['registry.example/trusted/'], allowedNetworks: ['default/vlan10'], maxCpu: 8, maxMemoryGiB: 16 };
    const first = service.evaluateAdmission(host, { manifest: vmManifest(), profile }, admin);
    const duplicate = service.evaluateAdmission(host, { manifest: vmManifest(), profile }, admin);
    expect(service.admissionPolicies(admin)).toHaveLength(5);
    expect(first).toMatchObject({ decision: 'pass', enforced: false, duplicate: false });
    expect(first.results).toHaveLength(5); expect(first.results.every(result => result.outcome === 'pass')).toBe(true);
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true, enforced: false });
    expect(db.prepare('SELECT enforced FROM kubernetes_vm_admission_evaluations').get().enforced).toBe(0); db.close();
  });

  test('cluster catalog produces blocked, idempotent plans and never starts provider mutations', () => {
    const db = database(); const service = new KubernetesUnifiedPlatformService(() => db, () => ({}));
    expect(service.clusterCatalog(admin).map(item => item.slug)).toEqual(['aks-arc','nutanix-nke','openshift','cloudstack-cks','rancher']);
    const input = { catalogSlug: 'rancher', planName: 'portal-cluster', parameters: { clusterName: 'portal-cluster', provider: 'vsphere',
      nodeCount: 3, kubernetesVersion: 'v1.34.1', networkRef: 'network/prod', credentialProfileRef: 'credential/prod' } };
    const first = service.planCluster(input, admin); const duplicate = service.planCluster(input, admin);
    expect(first).toMatchObject({ state: 'blocked', executionSupported: false, providerMutationsStarted: 0, duplicate: false });
    expect(first.prechecks.length).toBeGreaterThan(0); expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(db.prepare('SELECT provider_mutations_started FROM kubernetes_cluster_provisioning_plans').get().provider_mutations_started).toBe(0); db.close();
  });

  test('modernization maps expose blockers and score without mutating source or target platforms', () => {
    const db = database(); const service = new KubernetesUnifiedPlatformService(() => db, () => ({}));
    const map = service.createModernizationMap({ name: 'Legacy portal', sourceVmRef: 'default/vm-a', targetPlatform: 'kubernetes',
      dependencies: [{ id: 'db', kind: 'database', ref: 'postgres/legacy', protocol: 'tcp', port: 5432, criticality: 'critical', state: 'unknown' }],
      stages: { discovery: 'complete' } }, admin);
    expect(map).toMatchObject({ providerMutationsStarted: 0, duplicate: false });
    expect(map.blockers).toEqual(expect.arrayContaining(['Dependencies remain unknown or blocked', 'Stateful dependency lacks a target mapping', 'Application owner is missing', 'Rollback validation is incomplete']));
    expect(map.readinessScore).toBeLessThan(50); db.close();
  });

  test('shared OCI/VM provenance records external verification, rejects secret URLs and deduplicates', () => {
    const db = database(); const service = new KubernetesUnifiedPlatformService(() => db, () => ({}));
    const input = { imageKind: 'oci', imageRef: 'registry.example/app:v1', digest: `sha256:${'a'.repeat(64)}`,
      sourceUrl: 'https://registry.example/artifacts/app', sbom: { format: 'cyclonedx', digest: `sha256:${'b'.repeat(64)}`, packageCount: 42, generatedAt: '2026-07-29T10:00:00Z' },
      signatures: [{ type: 'cosign', signer: 'platform-key', digest: `sha256:${'a'.repeat(64)}`, verified: true, verifier: 'rekor', verifiedAt: '2026-07-29T10:01:00Z' }],
      links: [{ kind: 'vm-image', ref: 'images/vm-a' }] };
    const first = service.ingestImageProvenance(input, admin); const duplicate = service.ingestImageProvenance(input, admin);
    expect(first).toMatchObject({ trustState: 'externally_verified', duplicate: false });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(() => service.ingestImageProvenance({ ...input, sourceUrl: 'https://registry.example/app?token=inline' }, admin)).toThrow(expect.objectContaining({ code: 'UNSAFE_SOURCE_URL' })); db.close();
  });

  test('application environments validate host types and join provenance plus modernization evidence', () => {
    const db = database(); const service = new KubernetesUnifiedPlatformService(() => db, () => ({}));
    service.ingestImageProvenance({ imageKind: 'oci', imageRef: 'registry.example/app:v1', digest: `sha256:${'a'.repeat(64)}`,
      sourceUrl: 'https://registry.example/app', sbom: {}, signatures: [], links: [] }, admin);
    service.createModernizationMap({ name: 'Portal VM', sourceVmRef: 'default/vm-a', owner: 'platform', dependencies: [],
      stages: { discovery: 'complete', baseline: 'complete', containerize: 'complete', data_migration: 'complete', parallel_validation: 'complete', cutover: 'complete', rollback_validation: 'complete' } }, admin);
    const body = { slug: 'portal-prod', name: 'Portal production', environment: 'production', owner: 'platform', components: [
      { id: 'vm', type: 'kubevirt_vm', ref: 'default/vm-a', hostId: 7, namespace: 'default' },
      { id: 'image', type: 'oci_image', ref: 'registry.example/app:v1' },
      { id: 'stack', type: 'compose_stack', ref: 'portal', hostId: 8 }], relationships: [
      { from: 'stack', to: 'image', kind: 'uses_image' }, { from: 'stack', to: 'vm', kind: 'replaces' }] };
    const saved = service.saveApplicationEnvironment(body, admin);
    expect(saved.components.find(item => item.id === 'vm').modernization).toHaveLength(1);
    expect(saved.components.find(item => item.id === 'image').provenance).toHaveLength(1);
    expect(saved.coverage).toMatchObject({ liveRefreshRequired: true, provenanceRecords: 1, modernizationMaps: 1 });
    const invalid = { ...body, slug: 'invalid-host', components: [{ id: 'pod', type: 'kubernetes_workload', ref: 'default/pod', hostId: 8 }] };
    expect(() => service.saveApplicationEnvironment(invalid, admin)).toThrow(expect.objectContaining({ code: 'COMPONENT_HOST_MISMATCH' })); db.close();
  });
});
