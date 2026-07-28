'use strict';

const xen = require('../../xen');
const {
  supported, unsupported, conditional, adapterNotImplemented,
} = require('./helpers');

function _fromCapabilities(capabilities = {}) {
  const features = {
    'inventory.vm': capabilities.vms ? supported() : unsupported('VM inventory is unavailable for this Xen provider'),
    'inventory.host': capabilities.hosts ? supported() : unsupported('Host inventory is unavailable for this Xen provider'),
    'inventory.cluster': capabilities.pools ? supported() : unsupported('Pools are unavailable for standalone raw Xen'),
    'inventory.storage': capabilities.storages ? supported() : unsupported('Storage inventory is unavailable for this Xen provider'),
    'inventory.network': capabilities.networks ? supported() : unsupported('Network inventory is unavailable for this Xen provider'),
    'inventory.task': capabilities.tasks ? supported() : unsupported('Native tasks are unavailable for this Xen provider'),
    'inventory.image': capabilities.templates
      ? supported() : unsupported('Template inventory is unavailable for this Xen provider'),
    'vm.read': capabilities.vms ? supported() : unsupported('VM detail is unavailable for this Xen provider'),
    'vm.migration.preflight': capabilities.migrationPreflight
      ? conditional('Migration targets are evaluated inside the active Xen pool management boundary', { perResource: true, readOnly: true })
      : unsupported('Migration preflight is unavailable without a multi-host Xen management plane'),
    'vm.migration.live': capabilities.migrationLive
      ? conditional('Live migration depends on per-VM XAPI/XO operations and target compatibility', { perResource: true })
      : unsupported('Live migration readiness is unavailable for this Xen provider'),
    'vm.migration.cold': capabilities.migrationCold
      ? conditional('Cold migration depends on target boot, SR and network compatibility', { perResource: true })
      : unsupported('Cold migration readiness is unavailable for this Xen provider'),
    'vm.migration.storage': capabilities.migrationStorage
      ? conditional('Storage movement requires SR mapping and execution-time revalidation', { perResource: true })
      : unsupported('Storage migration readiness is unavailable for this Xen provider'),
    'vm.migration.crossCluster': unsupported('Cross-pool and cross-endpoint migration mapping is deferred to the dedicated workflow'),
    'vm.disk.read': capabilities.hardwareDetails
      ? conditional('Disk topology is read from the active Xen management plane', { perResource: true, readOnly: true })
      : unsupported('Disk topology is unavailable for this Xen provider'),
    'vm.disk.hotplug': capabilities.diskHotplug
      ? conditional('VBD allowed operations are evaluated per device', { perResource: true, evidenceOnly: true })
      : unsupported('Disk hot-plug is not safely advertised by this Xen provider'),
    'vm.disk.create': capabilities.provider === 'xapi'
      ? conditional('XAPI VDI/VBD creation uses Async methods and post-read verification', {
        perResource: true, durableTask: true, postVerify: true, shrink: false,
      }) : unsupported('Disk creation requires a conformance-tested XenAPI endpoint'),
    'vm.disk.attach': unsupported('Managed-volume reattachment is not released for this Xen provider'),
    'vm.disk.detach': capabilities.provider === 'xapi'
      ? conditional('XAPI VBD unplug and destroy retains the VDI backing', {
        perResource: true, durableTask: true, retainBacking: true, postVerify: true,
      }) : unsupported('Disk detach requires a conformance-tested XenAPI endpoint'),
    'vm.disk.resize': capabilities.provider === 'xapi'
      ? conditional('XAPI VDI resize is grow-only; online resize is not assumed across releases/backends', {
        perResource: true, durableTask: true, shrink: false, online: false, guestExpansionRequired: true,
      }) : unsupported('Disk resize requires a conformance-tested XenAPI endpoint'),
    'vm.disk.move': unsupported('XAPI VDI copy requires a multi-stage swap workflow that is not released'),
    'vm.disk.delete': capabilities.provider === 'xapi'
      ? conditional('Only a detached Docker Dash-owned VDI can be destroyed after recovery checks', {
        perResource: true, durableTask: true, ownershipRequired: true, recoveryPointRequired: true,
      }) : unsupported('Disk delete requires a conformance-tested XenAPI endpoint'),
    'vm.disk.convert': unsupported('XenAPI exposes no portable rollback-safe format conversion contract'),
    'storage.orphan.read': capabilities.provider === 'xapi'
      ? conditional('Inventory is limited to Docker Dash-managed detached VDIs', { readOnly: true, managedOnly: true })
      : unsupported('Managed detached-volume inventory requires XenAPI'),
    'storage.snapshotRisk.read': capabilities.snapshots
      ? conditional('Snapshot inventory is correlated with disk mutation preflight', { readOnly: true })
      : unsupported('Snapshot risk evidence is unavailable for this Xen provider'),
    'storage.health.read': capabilities.storages
      ? conditional('Storage repository attachment and capacity posture are read from the active Xen management plane', { readOnly: true, signals: ['accessibility', 'capacity', 'overcommit'] })
      : unsupported('Storage posture is unavailable for this Xen provider'),
    'storage.policy.read': capabilities.storages
      ? conditional('Storage repository type and shared-storage evidence are read from the active Xen management plane', { readOnly: true, evidenceOnly: true })
      : unsupported('Storage policy evidence is unavailable for this Xen provider'),
    'storage.sharedTopology.read': capabilities.hardwareDetails && capabilities.storages
      ? conditional('VM VDI backings are correlated read-only; only provider-declared sharable VDIs are confirmed shared', { readOnly: true, bounded: true, evidenceOnly: true })
      : unsupported('Shared-disk topology requires VM hardware and storage inventory'),
    'storage.placement.read': capabilities.storages
      ? conditional('Storage repository attachment and reported free capacity are checked read-only for an advisory disk size', { readOnly: true, bounded: true, advisoryOnly: true })
      : unsupported('Storage placement evidence is unavailable for this Xen provider'),
    'storage.qos.read': adapterNotImplemented('Xen storage QoS telemetry'),
    'storage.multipath.read': adapterNotImplemented('Xen multipath telemetry'),
    'network.health.read': capabilities.networks
      ? conditional('Virtual network bridge, MTU and management observations are read from the active Xen management plane', { readOnly: true, evidenceOnly: true })
      : unsupported('Virtual network posture is unavailable for this Xen provider'),
    'network.policy.read': capabilities.networks
      ? conditional('Virtual network configuration evidence is evaluated read-only against an operator-selected transient policy', { readOnly: true, evidenceOnly: true })
      : unsupported('Virtual network policy evidence is unavailable for this Xen provider'),
    'network.attachmentTopology.read': capabilities.networks && capabilities.hardwareDetails
      ? conditional('VM VIFs are correlated to provider-reported virtual-network evidence read-only', { readOnly: true, bounded: true, evidenceOnly: true })
      : unsupported('Network attachment topology requires virtual-network and VM hardware inventory'),
    'network.placement.read': capabilities.networks
      ? conditional('Virtual-network accessibility and configuration evidence are evaluated read-only for placement review', { readOnly: true, advisoryOnly: true })
      : unsupported('Virtual-network placement evidence is unavailable for this Xen provider'),
    'network.ipInventory.read': capabilities.hardwareDetails
      ? conditional('Provider-visible VIF addresses are collected read-only when available', { readOnly: true, bounded: true, evidenceOnly: true })
      : unsupported('Virtual-machine IP evidence requires NIC inventory'),
    'vm.nic.read': capabilities.hardwareDetails
      ? conditional('NIC topology is read from the active Xen management plane', { perResource: true, readOnly: true })
      : unsupported('NIC topology is unavailable for this Xen provider'),
    'vm.nic.hotplug': capabilities.nicHotplug
      ? conditional('VIF allowed operations are evaluated per device', { perResource: true, evidenceOnly: true })
      : unsupported('NIC hot-plug is not safely advertised by this Xen provider'),
    'cluster.ha.read': capabilities.pools
      ? conditional('HA evidence depends on pool configuration and shared storage', { requiresPool: true })
      : unsupported('HA is unavailable for standalone raw Xen'),
    'placement.affinity.read': capabilities.vmGroups
      ? conditional('Xen VM home-host affinity and VM-group placement policy are read from the management plane', { readOnly: true, advisory: true })
      : unsupported('Affinity inventory is unavailable for standalone raw Xen'),
    'placement.recommend': capabilities.migrationPreflight
      ? conditional('Xen placement hints are combined with common migration and capacity evidence', { readOnly: true })
      : unsupported('Placement recommendations require a multi-host Xen management plane'),
    'placement.rebalance.plan': capabilities.migrationPreflight
      ? conditional('A bounded dry-run is generated without submitting Xen migration operations', { readOnly: true, dryRunOnly: true })
      : unsupported('Rebalance planning requires a multi-host Xen management plane'),
    'cluster.ha.policy.mutate': capabilities.provider === 'xapi'
      ? conditional('XAPI workload restart policy and ordering fields are changed independently and post-read verified', {
        fields: ['restartPolicy', 'startOrder', 'startDelaySeconds'], approval: 'four_eyes', postVerify: true,
      }) : unsupported('HA policy mutation requires a conformance-tested XAPI endpoint'),
    'placement.affinity.mutate': capabilities.provider === 'xapi' && capabilities.vmGroups
      ? conditional('XAPI anti-affinity VM groups and home-server affinity are changed with documented methods', {
        kinds: ['vm_vm_anti_affinity', 'home_host_preference'], approval: 'four_eyes', postVerify: true,
      }) : unsupported('Affinity mutation requires a conformance-tested XAPI endpoint with VM groups'),
    'placement.rebalance.apply': capabilities.provider === 'xapi' && capabilities.migrationExecute
      ? conditional('Approved plans execute through bounded durable XAPI migration child operations', {
        waves: true, pauseResume: true, rollbackPlan: true, approval: 'four_eyes',
      }) : unsupported('Rebalance apply requires a conformance-tested XAPI migration endpoint'),
    'task.read': capabilities.tasks ? supported() : unsupported('Native tasks are unavailable for this Xen provider'),
    'task.cleanup': capabilities.taskCleanup ? supported() : unsupported('Task cleanup is unavailable for this Xen provider'),
    'event.stream': capabilities.events ? supported() : adapterNotImplemented('Xen'),
    'backup.read': capabilities.backups
      ? conditional('Xen Orchestra recovery archives and repositories are read through discovered public REST routes', { readOnly: true, provider: 'xo' })
      : adapterNotImplemented('Xen'),
    'backup.run': adapterNotImplemented('Xen'),
    'backup.restore.vm': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra JSON-RPC restore transport' : 'Xen'),
    'backup.restore.disk': adapterNotImplemented('Xen'),
    'backup.restore.file': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra file-restore transport' : 'Xen'),
    'backup.restore.instant': adapterNotImplemented('Xen'),
    'backup.restore.differential': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra differential restore transport' : 'Xen'),
    'backup.restore.drill': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra health-check mutation transport' : 'Xen'),
    'replication.read': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra replication-job inventory transport' : 'Xen'),
    'replication.configure': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra replication policy mutation transport' : 'Xen'),
    'dr.failover': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra recovery-plan mutation transport' : 'Xen'),
    'dr.failback': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra reverse-protection transport' : 'Xen'),
    'dr.test': adapterNotImplemented(capabilities.provider === 'xo'
      ? 'Xen Orchestra isolated multi-workload test transport' : 'Xen'),
  };

  const actions = new Set(capabilities.vmActions || []);
  const actionEvidence = action => actions.has(action)
    ? conditional('Availability is checked again from per-VM allowed operations', { perResource: true })
    : unsupported(`The ${action} action is unavailable for this Xen provider`);
  features['vm.power.start'] = actionEvidence('start');
  features['vm.power.shutdown'] = actionEvidence('shutdown');
  features['vm.power.force'] = actions.has('forceShutdown') || actions.has('forceReboot')
    ? conditional('Forced power is capability-gated per VM and requires explicit confirmation', { perResource: true, confirmation: true })
    : unsupported('Forced power operations are unavailable for this Xen provider');
  features['vm.power.reboot'] = actionEvidence('reboot');
  features['vm.console'] = capabilities.console
    ? conditional(capabilities.provider === 'raw'
      ? 'The standalone Xen serial console is relayed over the pinned SSH connection'
      : 'RFB or VT100 is relayed through the same-origin gateway without exposing the management session', {
      perResource: true,
      protocols: capabilities.provider === 'raw' ? ['serial'] : ['rfb', 'serial'],
      clients: capabilities.provider === 'raw' ? ['xterm'] : ['noVNC', 'xterm'],
      singleUseToken: true, credentialIsolation: 'server-side', emergencyLock: true,
    })
    : unsupported(capabilities.provider === 'xo'
      ? 'Xen Orchestra console access requires a scoped authentication token'
      : 'Console access is unavailable for this Xen provider');

  for (const action of ['list', 'create', 'revert', 'delete']) {
    features[`vm.snapshot.${action}`] = capabilities.snapshots
      ? conditional('Snapshot support is checked per VM and storage backend', {
        perResource: true,
        ...(action === 'create' ? { durableTask: true, consistency: capabilities.snapshotQuiesce ? ['crash', 'quiesced'] : ['crash'] } : {}),
        ...(['revert', 'delete'].includes(action) ? { durableTask: true, confirmation: true } : {}),
      })
      : unsupported('Portable snapshots are unavailable for this Xen provider');
  }
  features['vm.snapshot.consolidate'] = adapterNotImplemented('Xen snapshot consolidation');

  features['vm.migrate'] = capabilities.migrationExecute
    ? conditional('Same-pool migration uses a native task and execution-time target validation', {
      perResource: true, modes: ['live', 'cold'], durableTask: true,
      cancel: capabilities.taskCancel === true, confirmation: 'typed_name', revalidate: true,
    })
    : unsupported(capabilities.provider === 'xo'
      ? 'Xen Orchestra migration execution requires a recognized task-backed OpenAPI action'
      : 'Migration execution requires a managed XAPI task boundary');
  features['host.maintenance'] = capabilities.hostMaintenance
    ? conditional('XAPI host disable/enable tasks bracket controlled per-VM evacuation and live post-checks', {
      goals: ['drain', 'enter'], pause: true, resume: true, waves: true,
      nativeEnterExit: true, durableTask: true, confirmation: 'typed_name',
    })
    : adapterNotImplemented('Xen');
  for (const key of ['storage.mutate', 'network.mutate']) {
    features[key] = adapterNotImplemented('Xen');
  }
  features['task.cancel'] = capabilities.taskCancel
    ? conditional('Cancellation is accepted only while the native task remains cancelable')
    : adapterNotImplemented('Xen');
  const xoProvisioning = capabilities.provider === 'xo';
  features['vm.clone'] = capabilities.provisioning
    ? conditional(xoProvisioning
      ? 'Xen Orchestra template creation uses the discovered task-backed pool create endpoint'
      : 'XAPI template clone/copy is followed by durable VM.provision reconciliation',
    { fromTemplate: true, modes: xoProvisioning ? ['full'] : ['full', 'linked'], durableTask: true, confirmation: true })
    : unsupported('Template provisioning is unavailable for this Xen management provider');
  features['vm.create'] = capabilities.provisioning
    ? conditional(xoProvisioning
      ? 'Create-from-template requires the discovered Xen Orchestra pool task workflow'
      : 'Create-from-template requires a managed XAPI task workflow',
    { fromTemplate: true, durableTask: true, confirmation: true })
    : unsupported('Template provisioning is unavailable for this Xen management provider');
  features['vm.guestCustomize'] = capabilities.guestCustomization
    ? conditional('Xen Orchestra creates a NoCloud/ConfigDrive payload through its task-backed pool create endpoint', {
      duringProvisioning: true, osFamilies: ['linux'], methods: ['cloud-init'],
      fields: ['hostname', 'domain', 'timezone', 'user', 'sshAuthorizedKeys', 'ipv4', 'dns', 'searchDomains'],
    })
    : unsupported(capabilities.provider === 'xapi'
      ? 'Direct XAPI has no portable config-drive upload method; use a compatible Xen Orchestra endpoint'
      : 'Guest customization is unavailable for this Xen management provider');
  return features;
}

function declared(host) {
  const client = xen.clientForHost(host);
  return _fromCapabilities(client.capabilities());
}

async function probe(host) {
  const client = xen.clientForHost(host);
  const info = await client.info();
  const capabilities = info?.capabilities || client.capabilities();
  return {
    provider: {
      type: 'xen', variant: client.provider || capabilities.provider || 'unknown',
      product: info?.product || 'Xen', version: info?.version || null,
      apiVersion: info?.apiVersion || info?.protocol || null,
    },
    features: _fromCapabilities(capabilities),
  };
}

async function listResources(kind, host) {
  const client = xen.clientForHost(host);
  if (kind === 'virtualMachine') return client.listVMs();
  if (kind === 'host') return client.listHosts();
  if (kind === 'cluster') return client.listPools();
  if (kind === 'storage') return client.listStorages();
  if (kind === 'network') return client.listNetworks();
  if (kind === 'task') return client.listTasks();
  throw new Error(`Xen resource kind is unavailable: ${kind}`);
}

async function listArtifacts(host) {
  const client = xen.clientForHost(host);
  return client.listTemplates();
}

async function listRecoveryPoints(host) {
  const client = xen.clientForHost(host);
  if (client.provider !== 'xo' || typeof client.listRecoveryPoints !== 'function') {
    throw Object.assign(new Error('Recovery-point inventory requires Xen Orchestra public REST routes'), {
      code: 'PROVIDER_BACKUP_INVENTORY_UNAVAILABLE', status: 400,
    });
  }
  return client.listRecoveryPoints();
}

async function readVmHardware(host, context) {
  const client = xen.clientForHost(host);
  const target = client.provider === 'xapi'
    ? (context.identity.uuid || context.identity.nativeRef) : context.identity.nativeRef;
  return client.getVmHardware(target);
}

async function migrationCompatibility(host, context) {
  const client = xen.clientForHost(host);
  const vmTarget = client.provider === 'xapi'
    ? (context.identity.uuid || context.identity.nativeRef) : context.identity.nativeRef;
  const targetRefs = context.targets.map(target => String(target.identity.nativeRef));
  const result = await client.getVmMigrationCompatibility(vmTarget, targetRefs);
  const byRef = new Map((result.candidates || []).map(item => [String(item.targetRef), item]));
  return {
    sourceTargetId: context.targets.find(target => String(target.identity.nativeRef) === String(result.sourceRef))?.resource.id || null,
    warnings: result.warnings || [],
    candidates: context.targets.map(target => ({
      targetId: target.resource.id,
      ...(byRef.get(String(target.identity.nativeRef)) || {
        current: false, checks: [{ key: 'xen.compatibility', state: 'unknown', reason: 'Xen returned no target compatibility evidence', confidence: 'low' }],
        blockers: [], warnings: [], modes: { live: 'unknown', cold: 'unknown', storage: 'unknown' },
      }),
      targetRef: undefined,
    })),
  };
}

async function placementInventory(host) {
  const client = xen.clientForHost(host);
  if (client.provider === 'raw') return {
    rules: [], nativeRecommendations: [], limitations: ['Standalone raw Xen exposes no portable pool placement policy'],
  };
  const [vms, groups] = await Promise.all([
    client.listVMs(), typeof client.listVmGroups === 'function' ? client.listVmGroups() : Promise.resolve([]),
  ]);
  const rules = [];
  for (const vm of vms.slice(0, 500)) {
    if (!vm.affinityRef) continue;
    rules.push({
      nativeId: `home:${vm.ref || vm.id}`, name: `${vm.name || 'VM'} home-server affinity`,
      kind: 'home-host-preference', enabled: true, mandatory: false,
      vmRefs: [vm.ref, vm.uuid, vm.id].filter(Boolean), hostRefs: [vm.affinityRef], source: 'xen-home-server',
    });
  }
  for (const group of groups.slice(0, 500)) {
    if (!/anti[_-]?affinity/i.test(String(group.placement || ''))) continue;
    rules.push({
      nativeId: group.ref || group.uuid || group.id, name: group.name || 'Xen VM anti-affinity group',
      kind: 'vm-anti-affinity', enabled: true, mandatory: false,
      vmRefs: group.vmRefs || [], hostRefs: [], source: 'xen-vm-group',
    });
  }
  return {
    rules: rules.slice(0, 500), nativeRecommendations: [],
    limitations: ['Xen affinity is advisory; WLB and availability constraints can take precedence'],
  };
}

module.exports = { type: 'xen', declared, probe, listResources, listArtifacts, listRecoveryPoints, readVmHardware, migrationCompatibility, placementInventory, _internals: { _fromCapabilities } };
