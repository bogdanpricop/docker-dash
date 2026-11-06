'use strict';

process.env.APP_SECRET = 'network-advanced-test-secret';
process.env.ENCRYPTION_KEY = 'network-advanced-test-key-32chars';
process.env.DB_PATH = ':memory:';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb, closeDb } = require('../db');
const { NetworkAdvancedService } = require('../services/network-advanced');

const admin = { id: 952, username: 'network-admin', role: 'admin' };
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const pass = name => ({ name, state: 'pass', evidenceHash: sha(name) });
const rule = (ruleKey, source = 'any', action = 'allow') => ({ ruleKey, direction: 'inbound', action, protocol: 'tcp', source, destination: 'any', portStart: 22, portEnd: 22, priority: 100, enabled: true });

describe('advanced network control plane', () => {
  let db; let service;
  beforeAll(() => { db = getDb(); service = new NetworkAdvancedService(() => db); db.prepare(`INSERT INTO users (id,username,email,password_hash,role,is_active) VALUES (?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET role=excluded.role,is_active=1`).run(admin.id, admin.username, 'network@example.test', 'x', 'admin'); });
  afterAll(() => closeDb());

  test('B102 creates a validated NIC attach plan without provider mutation', () => {
    const result = service.planNicAttach({ resourceKey: 'vm:web', networkKey: 'net:frontend', model: 'virtio', macAddress: '02:00:00:00:00:10', vlanId: 120, ipAssignment: { mode: 'static', address: '10.20.0.10', prefixLength: 24, gateway: '10.20.0.1', dnsServers: ['10.20.0.2'] }, capability: { supported: true, hotPlug: true, reason: 'provider evidence' }, checks: [pass('network'), pass('address')] }, admin);
    expect(result).toMatchObject({ action: 'attach', state: 'ready', providerMutationsStarted: 0, executeEndpoint: null });
  });

  test('B103 blocks management and last-NIC detach and preserves address intent', () => {
    const result = service.planNicDetach({ resourceKey: 'vm:web', nicKey: 'nic:0', connectedNicCount: 1, managementNic: true, lastConnectedNic: true, guestDependencyCount: 1, bootDependency: false, keepAddressReservation: true, capabilitySupported: true, checks: [pass('guest')] }, admin);
    expect(result).toMatchObject({ action: 'detach', state: 'blocked', providerMutationsStarted: 0 });
    expect(result.blockers).toEqual(expect.arrayContaining(['management_nic', 'last_connected_nic', 'guest_dependency']));
  });

  test('B105 stores immutable reusable source-to-target network mappings', () => {
    const result = service.saveMappingProfile({ profileKey: 'prod-to-dr', version: 1, description: 'Production disaster recovery map', mappings: [{ sourceNetworkKey: 'net:prod', targetNetworkKey: 'net:dr', sourceVlanId: 120, targetVlanId: 220, ipStrategy: 'remap', securityGroupRefs: ['sg:web'] }], checks: [pass('target')] }, admin);
    expect(result).toMatchObject({ state: 'ready', version: 1, providerMutationsStarted: 0 });
    expect(() => service.saveMappingProfile({ profileKey: 'prod-to-dr', version: 1, description: 'changed', mappings: [{ sourceNetworkKey: 'net:prod', targetNetworkKey: 'net:other', sourceVlanId: 120, targetVlanId: 221, ipStrategy: 'dhcp', securityGroupRefs: [] }], checks: [] }, admin)).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  });

  test('B106 produces provider-neutral VLAN intent with dry-run evidence', () => {
    const result = service.planSegment({ scopeKey: 'cluster:prod', segmentKind: 'vlan', capabilitySupported: true, spec: { name: 'vlan120', bridge: 'bridge:prod', mtu: 1500, vlanId: 120, allowedVlanIds: [], nativeVlanId: null, outerVlanId: null, innerVlanId: null, vni: null, transportNetworkKey: null, transportMtu: null }, checks: [pass('collision')] }, admin);
    expect(result).toMatchObject({ segmentKind: 'vlan', state: 'ready', providerMutationsStarted: 0 });
  });

  test('B107 validates trunk membership and distinct QinQ tags', () => {
    const trunk = service.planSegment({ scopeKey: 'cluster:prod', segmentKind: 'trunk', capabilitySupported: true, spec: { name: 'trunk-a', bridge: 'bridge:prod', mtu: 1500, vlanId: null, allowedVlanIds: [120, 220], nativeVlanId: 120, outerVlanId: null, innerVlanId: null, vni: null, transportNetworkKey: null, transportMtu: null }, checks: [pass('switch')] }, admin);
    const qinq = service.planSegment({ scopeKey: 'cluster:prod', segmentKind: 'qinq', capabilitySupported: true, spec: { name: 'tenant-a', bridge: 'bridge:prod', mtu: 1500, vlanId: null, allowedVlanIds: [], nativeVlanId: null, outerVlanId: 100, innerVlanId: 200, vni: null, transportNetworkKey: null, transportMtu: null }, checks: [pass('provider')] }, admin);
    expect([trunk.state, qinq.state]).toEqual(['ready', 'ready']);
  });

  test('B108 enforces VXLAN VNI, transport and encapsulation MTU headroom', () => {
    const result = service.planSegment({ scopeKey: 'cluster:prod', segmentKind: 'vxlan', capabilitySupported: true, spec: { name: 'overlay-a', bridge: null, mtu: 1500, vlanId: null, allowedVlanIds: [], nativeVlanId: null, outerVlanId: null, innerVlanId: null, vni: 5000, transportNetworkKey: 'net:underlay', transportMtu: 1520 }, checks: [pass('vni')] }, admin);
    expect(result).toMatchObject({ state: 'blocked', blockers: expect.arrayContaining(['vxlan_mtu_headroom_insufficient']) });
  });

  test('B109 plans tenant VPC/subnet creation with CIDR, route and blast-radius evidence', () => {
    const result = service.planTenantNetworkChange({ tenantKey: 'tenant:blue', networkKey: 'vpc:blue', action: 'create', managedOwnership: true, expectedVersion: null, current: null, desired: { cidrs: ['10.30.0.0/16'], subnets: [{ cidr: '10.30.1.0/24', gateway: '10.30.1.1', dhcp: true }], routes: [{ destination: '0.0.0.0/0', nextHop: '10.30.1.1' }], dnsServers: ['10.30.1.2'], mtu: 1500 }, impactedResources: ['project:blue'], checks: [pass('cidr')] }, admin);
    expect(result).toMatchObject({ state: 'ready', impact: { blastRadius: 1 }, providerMutationsStarted: 0, executeEndpoint: null });
  });

  test('B110 reuses a signed connector plan for conflict-checked IPAM reserve', () => {
    const result = service.planAddressChange({ domain: 'ipam', backend: 'connector', action: 'reserve', resourceKey: 'vm:web', ownershipToken: 'owner-blue', expectedVersion: 'v7', address: '10.30.1.10', macAddress: null, hostname: null, recordType: null, fqdn: null, connectorPlanRef: 'plan:ipam:7', conflictState: 'clear', checks: [pass('ipam')] }, admin);
    expect(result).toMatchObject({ state: 'ready', externalMutationsStarted: 0, connectorReuse: 'signed-marketplace-ipam-dns-plan' });
  });

  test('B111 binds DHCP reservation to MAC, IP, hostname, ownership and version', () => {
    const result = service.planAddressChange({ domain: 'dhcp', backend: 'native', action: 'reserve', resourceKey: 'vm:web', ownershipToken: 'owner-blue', expectedVersion: 'v1', address: '10.30.1.10', macAddress: '02:00:00:00:00:10', hostname: 'web.example.test', recordType: null, fqdn: null, connectorPlanRef: null, conflictState: 'clear', checks: [pass('lease')] }, admin);
    expect(result).toMatchObject({ domain: 'dhcp', state: 'ready', executeEndpoint: null });
  });

  test('B112 validates A/AAAA/PTR lifecycle family and FQDN ownership', () => {
    const result = service.planAddressChange({ domain: 'dns', backend: 'infoblox', action: 'create', resourceKey: 'vm:web', ownershipToken: 'owner-blue', expectedVersion: 'v1', address: '10.30.1.10', macAddress: null, hostname: null, recordType: 'A', fqdn: 'web.example.test', connectorPlanRef: null, conflictState: 'clear', checks: [pass('zone')] }, admin);
    expect(result).toMatchObject({ domain: 'dns', state: 'ready', externalMutationsStarted: 0 });
  });

  test('B113 records security group rules, attachments, effective policy and drift', () => {
    const result = service.recordSecurityGroupInventory({ providerHostId: 7, providerType: 'openstack', observedAt: '2026-07-30T06:00:00Z', groups: [{ groupKey: 'sg:web', name: 'Web', rules: [rule('allow-ssh', '10.30.0.0/16')], attachmentKeys: ['vm:web'], effectivePolicyHash: sha('effective'), driftState: 'in_sync' }] }, admin);
    expect(result).toMatchObject({ summary: { groups: 1, rules: 1, attachments: 1 }, providerReadsStarted: 0 });
  });

  test('B114 plans atomic security group diff with management lockout and rollback guards', () => {
    const current = [rule('allow-ssh', '10.30.0.0/16')]; const desired = [rule('allow-ssh', '10.30.0.0/16'), { ...rule('allow-https', 'any'), portStart: 443, portEnd: 443 }];
    const result = service.planSecurityGroupChange({ groupKey: 'sg:web', currentRules: current, desiredRules: desired, managementCidrs: ['10.30.0.0/16'], managementPorts: [22], atomicApplySupported: true, lockoutChecks: [pass('management')], rollbackSteps: ['restore previous ruleset', 'verify management access'] }, admin);
    expect(result).toMatchObject({ state: 'ready', providerMutationsStarted: 0, existingExecutor: 'guarded-platform-firewall-change' }); expect(result.diff.add).toHaveLength(1);
  });

  test('B115 normalizes NSX/Flow/PVE/Neutron/OVN distributed firewall evidence', () => {
    const result = service.recordDistributedFirewall({ providerHostId: 8, providerType: 'ovn', scopeKey: 'tenant:blue', observedAt: '2026-07-30T06:00:00Z', coverage: { complete: true, observedScopes: 2, expectedScopes: 2, reason: 'signed adapter evidence' }, layers: [{ layerKey: 'ovn:acl', defaultAction: 'deny', groupKeys: ['sg:web'], rules: [rule('allow-ssh', '10.30.0.0/16')] }] }, admin);
    expect(result).toMatchObject({ summary: { state: 'observed', layers: 1, groups: 1, rules: 1 }, providerReadsStarted: 0, adapterContract: 'ovn-normalized-read-only' });
  });

  test('B116 stores staged app/tag/identity microsegmentation with enforce approvals', () => {
    const result = service.saveMicrosegmentationPolicy({ policyKey: 'payments-zero-trust', version: 1, stage: 'enforce', defaultAction: 'deny', selectors: [{ selectorKey: 'app:web', kind: 'application', values: ['web'] }, { selectorKey: 'identity:db', kind: 'identity', values: ['db-service'] }], rules: [{ ruleKey: 'web-to-db', sourceSelector: 'app:web', destinationSelector: 'identity:db', action: 'allow', protocol: 'tcp', ports: [5432] }], exceptions: [{ resourceKey: 'vm:legacy', reason: 'migration window', expiresAt: '2099-01-01T00:00:00Z' }], approvals: ['approval:1', 'approval:2'], checks: [pass('shadow')] }, admin);
    expect(result).toMatchObject({ state: 'ready', stage: 'enforce', providerMutationsStarted: 0, executeEndpoint: null });
  });

  test('B117 ingests bounded normalized five-tuple flow evidence without raw payload', () => {
    const result = service.ingestFlowLogs({ source: 'ovn:flows', providerHostId: 8, observedAt: '2026-07-30T06:00:00Z', retentionDays: 30, entries: [{ eventId: 'flow:1', occurredAt: '2026-07-30T05:59:00Z', action: 'allow', protocol: 'tcp', sourceAddress: '10.30.1.10', sourcePort: 50100, destinationAddress: '10.30.2.20', destinationPort: 443, bytes: 4096, packets: 8, sourceResourceKey: 'vm:web', destinationResourceKey: 'vm:api', ruleKey: 'allow-https' }] }, admin);
    expect(result).toMatchObject({ summary: { entries: 1, allowed: 1, bytes: 4096 }, rawPayloadStored: false, networkCallsStarted: 0 });
    expect(() => service.ingestFlowLogs({ source: 'bad', providerHostId: null, observedAt: '2026-07-30T06:00:00Z', retentionDays: 30, entries: [{ eventId: 'flow:2', occurredAt: '2026-07-30T05:59:00Z', action: 'allow', protocol: 'tcp', sourceAddress: '10.0.0.1', sourcePort: 1, destinationAddress: '10.0.0.2', destinationPort: 2, bytes: 1, packets: 1, sourceResourceKey: null, destinationResourceKey: null, ruleKey: null, rawPayload: 'forbidden' }] }, admin)).toThrow(/Unexpected entries/);
  });

  test('migration 152 adds ten tables and four permissions', () => {
    const names = ['network_nic_change_plans', 'network_mapping_profiles', 'network_segment_plans', 'tenant_network_change_plans', 'network_address_change_plans', 'security_group_inventory_observations', 'security_group_change_plans', 'distributed_firewall_observations', 'microsegmentation_policy_versions', 'network_flow_log_batches'];
    const tables = names.filter(name => db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', name)).length;
    const permissions = db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key IN ('network_attachment.manage','network_fabric.manage','network_security.manage','network_flow.ingest')").get().count;
    expect({ tables, permissions }).toEqual({ tables: 10, permissions: 4 });
  });

  test('routes expose twenty audited plan/evidence writes, dependency impact and no execution endpoint', () => {
    const root = path.join(__dirname, '..', '..'); const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'network-advanced.js'), 'utf8'); const api = fs.readFileSync(path.join(root, 'public', 'js', 'api.js'), 'utf8'); const ui = fs.readFileSync(path.join(root, 'public', 'js', 'pages', 'governance-controls.js'), 'utf8');
    expect((route.match(/create\('/g) || [])).toHaveLength(20); expect(route).not.toMatch(/\/execute|\/apply|\/probe/); expect(route).toContain("create('/intent-validations'");
    expect(route).toContain("create('/dependency-address-observations'"); expect(route).toContain("create('/dependency-dns-observations'"); expect(route).toContain("create('/dependency-snapshots'"); expect(route).toContain("router.get('/dependency-snapshots/:snapshotId/impact'");
    expect(route).toContain("create('/reachability-assessments'"); expect(route).toContain("create('/mtu-assessments'"); expect(route).toContain("create('/bond-health-observations'"); expect(route).toContain("create('/load-balancer-observations'"); expect(route).toContain("create('/public-ip-plans'"); expect(api).toContain('getNetworkAdvanced()'); expect(api).toContain('validateNetworkIntent(body)'); expect(api).toContain('buildNetworkDependencyMap(body)'); expect(api).toContain('getNetworkDependencyImpact(snapshotId, resourceKey, maxDepth = 5)'); expect(api).toContain('assessNetworkReachability(body)'); expect(api).toContain('assessNetworkMtu(body)'); expect(api).toContain('recordNetworkBondHealth(body)'); expect(api).toContain('recordNetworkLoadBalancerInventory(body)'); expect(api).toContain('planNetworkPublicIp(body)');
    expect(ui).toContain("_tabButton('network-advanced'"); expect(ui).toContain('Network intent validation'); expect(ui).toContain('no raw payload'); expect(ui).toContain('Network dependency map'); expect(ui).toContain('Observed candidates (non-causal)'); expect(ui).toContain('Reachability simulation (no active probe)'); expect(ui).toContain('Active probes are not run'); expect(ui).toContain('predicted, not data-plane proof'); expect(ui).toContain('Passive MTU path assessments'); expect(ui).toContain('no packet, DF probe, guest command or remediation'); expect(ui).toContain('Passive Bond / LAG health'); expect(ui).toContain('zero traffic is not labeled balanced'); expect(ui).toContain('Load balancer inventory'); expect(ui).toContain('native refs, raw health payloads and active probes are not accepted'); expect(ui).toContain('NAT / public IP lifecycle plans'); expect(ui).toContain('provider/external apply is not exposed');
  });
});
