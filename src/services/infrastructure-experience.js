'use strict';

const { getDb } = require('../db');
const hostPermissions = require('./host-permissions');
const providerSdk = require('./provider-sdk/registry');
const providerOperations = require('./provider-operations');

const VM_DAEMONS = new Set(['proxmox', 'vsphere', 'xen']);
const CONTAINER_DAEMONS = new Set(['docker', 'podman']);
const LIVE_BLOCKED_STATES = new Set(['unreachable', 'auth_failed', 'error']);
const ACTIVE_OPERATION_STATES = new Set(['queued', 'running', 'waiting_retry', 'reconciling', 'cancel_requested']);
const ACTIONS = Object.freeze({
  virtualMachine: Object.freeze([
    ['start', 'Start', 'vm.power.start'], ['stop', 'Shut down', 'vm.power.shutdown'], ['reboot', 'Reboot', 'vm.power.reboot'],
    ['snapshot', 'Snapshot', 'vm.snapshot.create'], ['migrate', 'Migrate', 'vm.migrate'],
    ['backup', 'Backup', 'backup.run'], ['console', 'Console', 'vm.console'],
  ]),
  container: Object.freeze([
    ['start', 'Start', null], ['stop', 'Stop', null], ['restart', 'Restart', null], ['logs', 'Logs', null],
  ]),
  kubernetesWorkload: Object.freeze([
    ['scale', 'Scale', null], ['rollout', 'Rollout restart', null], ['logs', 'Logs', null],
  ]),
});

function _isAdmin(actor) {
  return actor?.isAdmin === true || actor?.role === 'admin'
    || (Array.isArray(actor?.roles) && actor.roles.includes('admin'));
}

function _tableExists(db, table) {
  return !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
}

function _placeholders(values) { return values.map(() => '?').join(','); }

function _statusForHost(row) {
  if (!row.is_active) return 'disabled';
  if (LIVE_BLOCKED_STATES.has(row.conn_state)) return 'unhealthy';
  if (row.conn_state === 'ok' || row.conn_reachable === 1) return 'healthy';
  return 'unknown';
}

function _resourceLink(operation) {
  if (operation.resource?.kind === 'artifact') return '#/virtualization-catalog';
  if (operation.resource?.kind === 'virtualMachine' && VM_DAEMONS.has(operation.provider?.type)) {
    return `#/virtual-machines/${operation.provider.endpointId}/${operation.resource?.id}`;
  }
  return '#/activity';
}

class InfrastructureExperienceService {
  constructor(options = {}) {
    this._dbProvider = options.dbProvider || getDb;
    this._permissions = options.hostPermissions || hostPermissions;
    this._registry = options.registry || providerSdk;
    this._operations = options.operations || providerOperations;
    this._policy = options.policy || providerOperations.policy;
  }

  _db() { return this._dbProvider(); }

  _hosts(actor, { activeOnly = false } = {}) {
    const db = this._db();
    let rows = db.prepare(`SELECT id,name,daemon_type,is_active,is_default,last_seen_at,
      conn_state,conn_reachable,conn_paused FROM docker_hosts ORDER BY is_default DESC,name`).all();
    const visible = new Set(this._permissions.filterVisibleHosts(
      actor?.userId, _isAdmin(actor), rows.map(row => row.id)
    ));
    rows = rows.filter(row => visible.has(row.id));
    if (activeOnly) rows = rows.filter(row => !!row.is_active);
    return rows.map(row => ({ ...row, daemon_type: row.daemon_type || 'docker' }));
  }

  _workloads(hosts) {
    const db = this._db();
    const ids = hosts.map(host => host.id);
    const defaultVisible = hosts.some(host => host.is_default);
    if (!ids.length) {
      return {
        virtualMachines: { count: 0, state: 'unavailable', evidence: 'no_permitted_endpoint' },
        containers: { count: 0, state: 'unavailable', evidence: 'no_permitted_endpoint' },
        kubernetes: { count: 0, state: 'unavailable', evidence: 'no_permitted_endpoint' },
      };
    }
    let virtualMachines = 0;
    if (_tableExists(db, 'provider_resource_snapshots')) {
      virtualMachines = db.prepare(`SELECT COUNT(*) count FROM provider_resource_snapshots
        WHERE resource_kind = 'virtualMachine' AND host_id IN (${_placeholders(ids)})`).get(...ids).count;
    }
    let containers = 0;
    if (_tableExists(db, 'container_stats')) {
      const hostClause = defaultVisible
        ? `(host_id IN (${_placeholders(ids)}) OR host_id = 0)`
        : `host_id IN (${_placeholders(ids)})`;
      containers = db.prepare(`SELECT COUNT(DISTINCT container_id) count FROM container_stats
        WHERE ${hostClause} AND recorded_at >= datetime('now','-10 minutes')`).get(...ids).count;
    }
    const kubernetesHosts = hosts.filter(host => host.daemon_type === 'kubernetes');
    let kubernetesSnapshots = 0;
    if (kubernetesHosts.length && _tableExists(db, 'kubernetes_unified_evidence_snapshots')) {
      const kubeIds = kubernetesHosts.map(host => host.id);
      kubernetesSnapshots = db.prepare(`SELECT COUNT(DISTINCT host_id) count
        FROM kubernetes_unified_evidence_snapshots WHERE evidence_kind = 'topology'
        AND host_id IN (${_placeholders(kubeIds)})`).get(...kubeIds).count;
    }
    return {
      virtualMachines: {
        count: virtualMachines,
        state: hosts.some(host => VM_DAEMONS.has(host.daemon_type)) ? (virtualMachines ? 'observed' : 'unknown') : 'unavailable',
        evidence: 'persisted_provider_inventory',
      },
      containers: {
        count: containers,
        state: hosts.some(host => CONTAINER_DAEMONS.has(host.daemon_type)) ? (containers ? 'observed' : 'unknown') : 'unavailable',
        evidence: 'recent_telemetry_10m',
      },
      kubernetes: {
        count: kubernetesHosts.length,
        state: !kubernetesHosts.length ? 'unavailable' : (kubernetesSnapshots === kubernetesHosts.length ? 'observed' : 'partial'),
        evidence: { endpoints: kubernetesHosts.length, topologySnapshots: kubernetesSnapshots },
      },
    };
  }

  _cost() {
    const db = this._db();
    if (!_tableExists(db, 'finops_rating_runs')) {
      return { state: 'unavailable', amount: null, currency: null, billingTransactionCreated: false };
    }
    const row = db.prepare(`SELECT total_cost,currency,period_start,period_end,created_at
      FROM finops_rating_runs ORDER BY created_at DESC,id DESC LIMIT 1`).get();
    if (!row) return { state: 'unknown', amount: null, currency: null, billingTransactionCreated: false };
    return {
      state: 'rated', amount: row.total_cost, currency: row.currency,
      periodStart: row.period_start, periodEnd: row.period_end,
      observedAt: row.created_at, billingTransactionCreated: false,
    };
  }

  home(actor = {}) {
    const hosts = this._hosts(actor);
    const visibleIds = new Set(hosts.map(host => host.id));
    const operations = this._operations.list({ limit: 100 })
      .filter(operation => visibleIds.has(operation.provider?.endpointId));
    const providerCounts = {};
    const health = { healthy: 0, unhealthy: 0, unknown: 0, disabled: 0 };
    for (const host of hosts) {
      providerCounts[host.daemon_type] = (providerCounts[host.daemon_type] || 0) + 1;
      health[_statusForHost(host)] += 1;
    }
    const failed = operations.filter(operation => ['failed', 'unknown'].includes(operation.state));
    const active = operations.filter(operation => ACTIVE_OPERATION_STATES.has(operation.state));
    const risks = failed.slice(0, 10).map(operation => ({
      kind: 'provider_operation', severity: operation.state === 'unknown' ? 'critical' : 'warning',
      title: `${operation.action || operation.type} is ${operation.state}`,
      hostId: operation.provider.endpointId, operationId: operation.id,
      deepLink: `#/activity/${operation.id}`,
    }));
    if (_isAdmin(actor) && _tableExists(this._db(), 'edge_disaster_declarations')) {
      const disasters = this._db().prepare(`SELECT d.id,d.severity,d.reason,s.slug site_slug
        FROM edge_disaster_declarations d JOIN edge_sites s ON s.id=d.site_id
        WHERE d.state='active' ORDER BY d.declared_at DESC LIMIT 10`).all();
      risks.unshift(...disasters.map(item => ({
        kind: 'edge_disaster', severity: item.severity === 'critical' ? 'critical' : 'warning',
        title: `Edge site ${item.site_slug}: ${item.reason}`, declarationId: item.id, deepLink: '#/edge-platform',
      })));
    }
    const recentChanges = operations.slice(0, 10).map(operation => ({
      id: operation.id, action: operation.action || operation.type, state: operation.state,
      provider: operation.provider, resource: operation.resource, updatedAt: operation.updatedAt,
      deepLink: `#/activity/${operation.id}`, resourceLink: _resourceLink(operation),
    }));
    return {
      schemaVersion: '1.0', observedAt: new Date().toISOString(),
      endpoints: { total: hosts.length, providers: providerCounts, health },
      workloads: this._workloads(hosts),
      operations: { active: active.length, failedOrUnknown: failed.length },
      risks: { count: risks.length, items: risks },
      cost: this._cost(), recentChanges,
      coverage: { liveCallsMade: false, hostPermissionFiltered: true, secretsExported: false },
    };
  }

  navigation(actor = {}) {
    const hosts = this._hosts(actor, { activeOnly: true });
    const liveTypes = new Set(hosts.filter(host => !LIVE_BLOCKED_STATES.has(host.conn_state)).map(host => host.daemon_type));
    const rules = [
      ['containers', ['docker', 'podman']], ['images', ['docker', 'podman']], ['volumes', ['docker', 'podman']],
      ['networks', ['docker', 'podman']], ['virtual-machines', ['proxmox', 'vsphere', 'xen']],
      ['high-availability', ['proxmox', 'vsphere', 'xen']], ['storage-posture', ['proxmox', 'vsphere', 'xen']],
      ['network-posture', ['proxmox', 'vsphere', 'xen']], ['provider-security-posture', ['proxmox', 'vsphere', 'xen']],
      ['placement-advisor', ['proxmox', 'vsphere', 'xen']], ['activity', ['proxmox', 'vsphere', 'xen']],
      ['kubernetes-resources', ['kubernetes']], ['incus-instances', ['incus', 'lxd']], ['nomad-jobs', ['nomad']],
    ];
    const pages = rules.map(([page, daemonTypes]) => {
      const matched = daemonTypes.filter(type => liveTypes.has(type));
      return {
        page, available: matched.length > 0, daemonTypes, matchedDaemonTypes: matched,
        source: 'permitted_active_endpoints',
        reason: matched.length ? `Available through ${matched.join(', ')}` : `Requires a healthy permitted ${daemonTypes.join(' or ')} endpoint`,
      };
    });
    return { schemaVersion: '1.0', observedAt: new Date().toISOString(), pages };
  }

  async actionAvailability(actor, { hostId, resourceKind, resourceState } = {}) {
    hostId = Number(hostId);
    if (!Number.isInteger(hostId) || hostId <= 0) throw Object.assign(new Error('Valid hostId required'), { code: 'INVALID_HOST', status: 400 });
    const host = this._hosts(actor).find(item => item.id === hostId);
    if (!host) throw Object.assign(new Error('Host is unavailable or not permitted'), { code: 'HOST_ACCESS_DENIED', status: 403 });
    const actions = ACTIONS[resourceKind];
    if (!actions) throw Object.assign(new Error('Unsupported resource kind'), { code: 'INVALID_RESOURCE_KIND', status: 400 });
    const level = _isAdmin(actor) ? 'admin' : this._permissions.resolveEffectivePermission(actor.userId, hostId, false);
    const policy = this._policy.evaluate({ providerType: host.daemon_type, hostId });
    let capabilities = { probe: { status: 'reachable' }, features: {} };
    if (VM_DAEMONS.has(host.daemon_type)) capabilities = await this._registry.capabilitiesForHost(host);
    const decisions = actions.map(([action, label, capability]) => {
      const blockers = [];
      if (!['operate', 'admin'].includes(level) && !['logs', 'console'].includes(action)) {
        blockers.push({ source: 'permission', code: 'HOST_OPERATE_REQUIRED', message: 'Operate access to this endpoint is required.' });
      }
      if (!policy.allowed && !['logs', 'console'].includes(action)) {
        blockers.push({ source: 'policy', code: policy.code, message: policy.reason });
      }
      if (capabilities.probe?.status !== 'reachable') {
        blockers.push({ source: 'state', code: 'PROVIDER_UNREACHABLE', message: 'The provider capability probe is not reachable.' });
      }
      const evidence = capability ? capabilities.features?.[capability] : null;
      if (capability && !['supported', 'conditional'].includes(evidence?.state)) {
        blockers.push({ source: 'capability', code: 'CAPABILITY_UNAVAILABLE', message: evidence?.reason || `${capability} is not supported by this endpoint.` });
      }
      if (action === 'start' && ['running', 'poweredOn'].includes(resourceState)) {
        blockers.push({ source: 'state', code: 'ALREADY_RUNNING', message: 'The resource is already running.' });
      }
      if (['stop', 'reboot'].includes(action) && ['stopped', 'poweredOff'].includes(resourceState)) {
        blockers.push({ source: 'state', code: 'RESOURCE_STOPPED', message: 'The resource is not running.' });
      }
      return { action, label, available: blockers.length === 0, capability, blockers };
    });
    return {
      schemaVersion: '1.0', observedAt: new Date().toISOString(), hostId,
      providerType: host.daemon_type, resourceKind, resourceState: resourceState || null,
      decisions,
    };
  }
}

const service = new InfrastructureExperienceService();
module.exports = service;
module.exports.InfrastructureExperienceService = InfrastructureExperienceService;
module.exports._internals = { _isAdmin, _statusForHost, _resourceLink, VM_DAEMONS, ACTIONS };
