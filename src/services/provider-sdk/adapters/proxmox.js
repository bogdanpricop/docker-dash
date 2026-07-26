'use strict';

const { fromHostRow } = require('../../proxmox');
const { supported, unsupported, conditional, adapterNotImplemented } = require('./helpers');

const NOT_IMPLEMENTED = [
  'inventory.network', 'inventory.task',
  'storage.mutate', 'network.mutate', 'task.read',
  'task.cancel', 'task.cleanup', 'event.stream',
  'backup.restore.disk', 'backup.restore.file',
  'backup.restore.instant', 'backup.restore.differential',
];

function declared() {
  const features = {
    'inventory.vm': supported(),
    'inventory.host': supported(),
    'inventory.cluster': conditional('Cluster identity and quorum are read from the Corosync cluster status API', { readOnly: true }),
    'inventory.storage': supported(),
    'inventory.image': supported(),
    'vm.read': supported(),
    'vm.migration.preflight': conditional('Migration preconditions and target fabric are read without submitting a migration', { perResource: true, readOnly: true }),
    'vm.migration.live': conditional('Online migration depends on guest type, current state, local resources, storage and target networking', { perResource: true }),
    'vm.migration.cold': conditional('Cold migration depends on target storage/network reachability and local resources', { perResource: true }),
    'vm.migration.storage': conditional('Local disk movement requires explicit target storage mapping in the execution batch', { perResource: true }),
    'vm.migration.crossCluster': adapterNotImplemented('Proxmox VE cross-cluster migration'),
    'vm.migrate': conditional('Same-cluster migration uses a durable Proxmox UPID and execution-time compatibility checks', {
      perResource: true, modes: ['live', 'cold', 'storage'], durableTask: true,
      cancel: true, confirmation: 'typed_name', revalidate: true,
    }),
    'host.maintenance': conditional('Controlled drain uses durable per-VM migrations and a Docker Dash placement reservation; native activation is not advertised without a conformance-tested API', {
      goals: ['drain'], pause: true, resume: true, waves: true,
      nativeEnterExit: false, confirmation: 'typed_name',
    }),
    'cluster.ha.read': conditional('Corosync quorum, HA manager/LRM state and protected resources are read without changing HA configuration', {
      readOnly: true, simulations: true, history: true,
    }),
    'placement.affinity.read': conditional('Proxmox VE 9+ HA affinity rules are read without changing HA configuration', {
      readOnly: true, minimumMajorVersion: 9,
    }),
    'placement.recommend': conditional('Common capacity and migration evidence is combined with Proxmox VE 9+ HA rules', { readOnly: true }),
    'placement.rebalance.plan': conditional('A bounded advisory plan is calculated without submitting migrations', { readOnly: true, dryRunOnly: true }),
    'cluster.ha.policy.mutate': conditional('Existing HA workload policy is changed through the PVE cluster HA resource API', {
      fields: ['restartPolicy', 'maxRestarts', 'maxRelocations'], approval: 'four_eyes', postVerify: true,
    }),
    'placement.affinity.mutate': conditional('Proxmox VE 9+ HA resource and node affinity rules use incremental create, update, and delete calls', {
      minimumMajorVersion: 9, kinds: ['vm_vm_affinity', 'vm_vm_anti_affinity', 'vm_host_affinity'],
      approval: 'four_eyes', postVerify: true,
    }),
    'placement.rebalance.apply': conditional('Approved common plans execute through bounded durable VM migrations', {
      waves: true, pauseResume: true, rollbackPlan: true, approval: 'four_eyes',
    }),
    'vm.disk.read': conditional('QEMU and LXC configuration is read live from the current node', { perResource: true, readOnly: true }),
    'vm.disk.hotplug': conditional('The VM hotplug configuration and device type determine availability', { perResource: true, evidenceOnly: true }),
    'vm.nic.read': conditional('Configured NICs are read live; guest IP addresses require the QEMU guest agent', { perResource: true, readOnly: true }),
    'vm.nic.hotplug': conditional('The VM hotplug configuration determines availability', { perResource: true, evidenceOnly: true }),
    'vm.clone': conditional('VM templates support full and storage-dependent linked clones', { fromTemplate: true, modes: ['full', 'linked'], durableTask: true, confirmation: true }),
    'vm.create': conditional('Create-from-template is revalidated against node and storage placement', { fromTemplate: true, durableTask: true, confirmation: true }),
    'vm.guestCustomize': conditional('Cloud-Init settings require a compatible QEMU template and are verified on the cloned VM config', {
      duringProvisioning: true, osFamilies: ['linux'], methods: ['cloud-init'],
      fields: ['hostname', 'user', 'sshAuthorizedKeys', 'ipv4', 'dns', 'searchDomains'],
    }),
    'vm.console': conditional('A short-lived VNC proxy is terminated by the same-origin Docker Dash gateway', {
      perResource: true, protocols: ['rfb'], clients: ['noVNC'],
      singleUseToken: true, credentialIsolation: 'server-side', emergencyLock: true,
    }),
    'backup.read': supported(),
    'backup.run': conditional('Per-workload vzdump jobs use durable UPIDs and require live recovery-point proof', {
      perResource: true, durableTask: true, cancel: true, revalidate: true,
      providers: ['pve-vzdump'], retentionMutation: false,
    }),
    'backup.restore.vm': conditional('Create-only QEMU/LXC restore uses a durable UPID and live target verification', {
      createOnly: true, overwrite: false, startAfterRestore: false, uniqueNetworkIdentity: true,
      durableTask: true, cancel: true, revalidate: true, providers: ['pve-restore'],
    }),
    'backup.restore.drill': conditional('A new restore target is network-isolated before bounded boot and guest-agent checks', {
      createOnly: true, isolated: 'all_nics_link_down', durableTask: true,
      assertions: ['boot', 'qemu-guest-agent'], cleanup: ['on_success', 'never'],
      preserveFailures: true, arbitraryGuestCommands: false,
    }),
    'vm.power.start': conditional('Availability is checked from current guest state', { perResource: true, durableTask: true }),
    'vm.power.shutdown': conditional('Availability is checked from current guest state', { perResource: true, durableTask: true }),
    'vm.power.force': conditional('Forced power requires typed confirmation', { perResource: true, confirmation: true, durableTask: true }),
    'vm.power.reboot': conditional('Availability is checked from current guest state', { perResource: true, durableTask: true }),
    'vm.snapshot.list': conditional('Snapshot availability depends on guest type and storage backend', { perResource: true }),
    'vm.snapshot.create': conditional('Storage support is revalidated before snapshot creation', { perResource: true, durableTask: true, consistency: ['crash'] }),
    'vm.snapshot.revert': conditional('Snapshot ownership and dependencies are revalidated before revert', { perResource: true, durableTask: true, confirmation: true }),
    'vm.snapshot.delete': conditional('Snapshot ownership and child dependencies are revalidated before delete', { perResource: true, durableTask: true, confirmation: true }),
  };
  for (const key of NOT_IMPLEMENTED) features[key] = adapterNotImplemented('Proxmox VE');
  return features;
}

async function listArtifacts(host) {
  const client = fromHostRow(host);
  try { return await client.listArtifacts(); }
  finally { client._agent?.destroy?.(); }
}

async function listRecoveryPoints(host) {
  const client = fromHostRow(host);
  try { return await client.listRecoveryPoints(); }
  finally { client._agent?.destroy?.(); }
}

async function probe(host) {
  const client = fromHostRow(host);
  try {
    const version = await client.version();
    const major = Number.parseInt(String(version?.version || '').split('.')[0], 10);
    const features = declared();
    if (!Number.isFinite(major) || major < 9) {
      features['placement.affinity.read'] = unsupported('Native HA affinity rules require Proxmox VE 9 or newer');
      features['placement.affinity.mutate'] = unsupported('Native HA affinity rule mutation requires Proxmox VE 9 or newer');
    }
    return {
      provider: {
        type: 'proxmox', variant: 'pve', product: 'Proxmox VE',
        version: version?.version || null, apiVersion: version?.repoid || null,
      },
      features,
    };
  } finally {
    client._agent?.destroy?.();
  }
}

async function listResources(kind, host) {
  const client = fromHostRow(host);
  try {
    if (kind === 'virtualMachine') return (await client.listVMs())
      .filter(row => Number(row?.template) !== 1)
      .map(row => ({
        ...row, allowedActions: [..._allowedVmActions(row), ..._allowedSnapshotActions(row)],
      }));
    if (kind === 'host') return (await client.listNodes()).map(row => ({ ...row, id: row.node || row.id }));
    if (kind === 'cluster') {
      const rows = await client.getClusterStatus();
      const cluster = rows.find(row => row?.type === 'cluster');
      return cluster ? [{
        id: cluster.id || cluster.name, name: cluster.name || cluster.id || 'Proxmox cluster',
        haEnabled: null, health: Number(cluster.quorate) === 1 ? 'healthy' : 'degraded',
      }] : [];
    }
    if (kind === 'storage') return (await client.listStorages()).map(row => ({
      ...row,
      name: row.storage || row.name || row.id,
      accessible: row.active === 1 || row.active === true || String(row.status || '').toLowerCase() === 'available',
      contentType: row.content || row.contentType || null,
    }));
    throw new Error(`Proxmox resource kind is unavailable: ${kind}`);
  } finally {
    client._agent?.destroy?.();
  }
}

function _splitRefs(value) {
  if (Array.isArray(value)) return value.flatMap(_splitRefs);
  if (value === null || value === undefined) return [];
  return String(value).split(/[;,\s]+/).map(item => item.replace(/^(?:vm|ct|qemu|lxc|node):/, '').split(':')[0]).filter(Boolean).slice(0, 500);
}

async function placementInventory(host) {
  const client = fromHostRow(host);
  try {
    const rows = await client.getHaRules();
    return {
      rules: rows.slice(0, 500).map((row, index) => {
        const type = String(row.type || row.kind || '').toLowerCase();
        const affinity = String(row.affinity || '').toLowerCase();
        const anti = type.includes('anti') || affinity === 'separate'
          || row.negative === 1 || row.negative === true;
        const hostRule = type.includes('node') || type.includes('host');
        return {
          nativeId: row.rule || row.id || row.name || `rule-${index}`,
          name: row.name || row.rule || `HA rule ${index + 1}`,
          kind: hostRule ? (anti ? 'vm-host-anti-affinity' : 'vm-host-affinity')
            : (anti ? 'vm-anti-affinity' : 'vm-affinity'),
          enabled: row.disable === 1 || row.disable === true ? false : row.enabled !== false,
          mandatory: row.strict === 1 || row.strict === true,
          vmRefs: _splitRefs(row.resources ?? row.vms ?? row.guests),
          hostRefs: _splitRefs(row.nodes ?? row.hosts),
          source: 'proxmox-ha-rules',
        };
      }),
      nativeRecommendations: [],
      limitations: ['Only HA-managed resources participate in Proxmox HA affinity rules'],
    };
  } finally { client._agent?.destroy?.(); }
}

async function readVmHardware(host, context) {
  const client = fromHostRow(host);
  try {
    const match = /^(qemu|lxc)\/(\d+)$/.exec(String(context.identity.nativeRef || ''));
    const vmid = match ? Number(match[2]) : Number(context.identity.nativeRef);
    const guestType = match?.[1] || (context.resource?.extensions?.guestType === 'lxc' ? 'lxc' : 'qemu');
    let node = context.resource?.extensions?.node || null;
    if (!node) {
      const row = (await client.listVMs()).find(item => Number(item.vmid) === vmid
        && String(item.type || 'qemu') === guestType);
      node = row?.node || null;
    }
    return await client.getVmHardware(node, guestType, vmid);
  } finally { client._agent?.destroy?.(); }
}

async function migrationCompatibility(host, context) {
  const client = fromHostRow(host);
  try {
    const match = /^(qemu|lxc)\/(\d+)$/.exec(String(context.identity.nativeRef || ''));
    const vmid = match ? Number(match[2]) : Number(context.identity.nativeRef);
    const guestType = match?.[1] || (context.resource?.extensions?.guestType === 'lxc' ? 'lxc' : 'qemu');
    let sourceNode = context.resource?.extensions?.node || null;
    let vmRow = null;
    if (!sourceNode) {
      vmRow = (await client.listVMs()).find(item => Number(item.vmid) === vmid && String(item.type || 'qemu') === guestType);
      sourceNode = vmRow?.node || null;
    }
    const warnings = [];
    const config = sourceNode ? await client.getVmConfig(sourceNode, guestType, vmid) : {};
    let preconditions = {};
    try { preconditions = sourceNode ? await client.getVmMigrationPreconditions(sourceNode, guestType, vmid) : {}; }
    catch { warnings.push('Proxmox migration preconditions could not be read; target checks are incomplete'); }
    const storageIds = new Set();
    const bridges = new Set();
    for (const [key, value] of Object.entries(config || {})) {
      if (/^(?:ide|sata|scsi|virtio)\d+$|^(?:rootfs|mp\d+)$/.test(key) && typeof value === 'string') {
        const storage = /^([^:,]+):/.exec(value)?.[1]; if (storage) storageIds.add(storage);
      }
      if (/^net\d+$/.test(key) && typeof value === 'string') {
        const bridge = /(?:^|,)bridge=([^,]+)/.exec(value)?.[1]; if (bridge) bridges.add(bridge);
      }
    }
    const localResources = [
      ...(Array.isArray(preconditions?.local_resources) ? preconditions.local_resources : []),
      ...Object.keys(config || {}).filter(key => /^(?:hostpci|usb)\d+$/.test(key)),
    ];
    const candidates = [];
    for (const target of context.targets) {
      const node = String(target.identity.nativeRef || target.resource.displayName || '');
      const current = node === sourceNode;
      const blockers = [];
      const candidateWarnings = [{ type: 'CPU_COMPATIBILITY_UNKNOWN', reason: 'CPU compatibility must be revalidated immediately before execution', modes: ['live'] }];
      const checks = [];
      let inventory = null;
      if (!current) {
        try { inventory = await client.getNodeMigrationInventory(node); }
        catch { warnings.push(`Target fabric inventory is unavailable for ${target.resource.displayName}`); }
      }
      if (inventory) {
        const targetStorages = new Set(inventory.storages.filter(item => item.enabled !== 0 && item.active !== 0).map(item => String(item.storage)));
        const missingStorage = [...storageIds].filter(id => !targetStorages.has(id));
        checks.push({ key: 'storage.mapping', state: missingStorage.length ? 'fail' : 'pass',
          reason: missingStorage.length ? 'Target is missing one or more source storage IDs' : 'All source storage IDs are visible on the target', confidence: 'high' });
        if (missingStorage.length) {
          blockers.push({ type: 'STORAGE_MAPPING_REQUIRED', reason: 'Target storage mapping is incomplete', modes: ['live', 'cold'] });
          candidateWarnings.push({ type: 'TARGET_STORAGE_SELECTION_REQUIRED', reason: 'Storage-assisted migration requires an explicit destination mapping', modes: ['storage'] });
        }
        const targetBridges = new Set(inventory.networks.filter(item => /bridge/i.test(String(item.type || item.iface || '')) || item.bridge_ports !== undefined)
          .map(item => String(item.iface || item.name || '')));
        const missingBridges = [...bridges].filter(name => !targetBridges.has(name));
        checks.push({ key: 'network.mapping', state: missingBridges.length ? 'fail' : 'pass',
          reason: missingBridges.length ? 'Target is missing one or more VM bridges' : 'All configured VM bridges exist on the target', confidence: 'high' });
        if (missingBridges.length) blockers.push({ type: 'NETWORK_MAPPING_REQUIRED', reason: 'Target network bridge mapping is incomplete', modes: ['live', 'cold', 'storage'] });
      } else if (!current) checks.push({ key: 'target.fabric', state: 'unknown', reason: 'Target storage and network inventory could not be read', confidence: 'low' });
      if (localResources.length) {
        checks.push({ key: 'device.localResources', state: 'fail', reason: 'VM has host-local or passthrough resources', confidence: 'high' });
        blockers.push({ type: 'LOCAL_RESOURCE_BLOCKED', reason: 'Host-local or passthrough devices require an explicit target mapping', modes: ['live', 'cold', 'storage'] });
      } else checks.push({ key: 'device.localResources', state: 'pass', reason: 'No host-local passthrough resources were reported', confidence: 'medium' });
      checks.push({ key: 'cpu.compatibility', state: 'unknown', reason: 'Proxmox does not expose a side-effect-free per-target CPU compatibility result', confidence: 'low' });
      candidates.push({
        targetId: target.resource.id, current, blockers, checks,
        warnings: candidateWarnings,
        modes: {
          live: current ? 'unsupported' : (guestType === 'qemu' && context.resource.status?.powerState === 'running' ? 'conditional' : 'unsupported'),
          cold: current ? 'unsupported' : 'conditional',
          storage: current ? 'unsupported' : (storageIds.size ? 'conditional' : 'unknown'),
        },
      });
    }
    return {
      sourceTargetId: context.targets.find(target => String(target.identity.nativeRef) === sourceNode)?.resource.id || null,
      candidates, warnings,
    };
  } finally { client._agent?.destroy?.(); }
}

function _allowedVmActions(row) {
  const state = String(row?.status || row?.powerState || '').toLowerCase();
  if (['stopped', 'halted', 'poweredoff'].includes(state)) return ['start'];
  if (!['running', 'paused', 'poweredon'].includes(state)) return [];
  const actions = ['shutdown', 'reboot', 'forceShutdown'];
  if (row?.type !== 'lxc') actions.push('forceReboot');
  return actions;
}

function _allowedSnapshotActions(row) {
  const state = String(row?.status || row?.powerState || '').toLowerCase();
  return !row?.lock && ['stopped', 'running', 'paused', 'poweredon', 'poweredoff'].includes(state)
    ? ['snapshot'] : [];
}

module.exports = { type: 'proxmox', declared, probe, listResources, listArtifacts, listRecoveryPoints, readVmHardware, migrationCompatibility, placementInventory, _internals: { _allowedVmActions, _allowedSnapshotActions, _splitRefs } };
