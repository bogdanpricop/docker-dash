'use strict';

const Database = require('better-sqlite3');
const { InfrastructureExperienceService } = require('../services/infrastructure-experience');

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE docker_hosts (
      id INTEGER PRIMARY KEY, name TEXT, daemon_type TEXT, is_active INTEGER,
      is_default INTEGER DEFAULT 0, last_seen_at TEXT, conn_state TEXT,
      conn_reachable INTEGER, conn_paused INTEGER DEFAULT 0
    );
    CREATE TABLE provider_resource_snapshots (
      canonical_id TEXT PRIMARY KEY, host_id INTEGER, resource_kind TEXT
    );
    CREATE TABLE container_stats (
      id INTEGER PRIMARY KEY, host_id INTEGER, container_id TEXT, recorded_at TEXT
    );
    CREATE TABLE kubernetes_unified_evidence_snapshots (
      id INTEGER PRIMARY KEY, host_id INTEGER, evidence_kind TEXT
    );
    CREATE TABLE finops_rating_runs (
      id INTEGER PRIMARY KEY, total_cost REAL, currency TEXT, period_start TEXT,
      period_end TEXT, created_at TEXT
    );
  `);
  return db;
}

function service(db, overrides = {}) {
  return new InfrastructureExperienceService({
    dbProvider: () => db,
    hostPermissions: {
      filterVisibleHosts: (_userId, _admin, ids) => ids,
      resolveEffectivePermission: () => 'operate',
      ...overrides.hostPermissions,
    },
    operations: { list: () => [], ...overrides.operations },
    registry: { capabilitiesForHost: jest.fn(async () => ({ probe: { status: 'reachable' }, features: {} })), ...overrides.registry },
    policy: { evaluate: () => ({ allowed: true }), ...overrides.policy },
  });
}

describe('B351-B355 infrastructure experience', () => {
  it('B351 aggregates provider, VM, container, Kubernetes, risk, cost and recent-change evidence', () => {
    const db = database();
    db.exec(`
      INSERT INTO docker_hosts VALUES (1,'docker-a','docker',1,1,NULL,'ok',1,0);
      INSERT INTO docker_hosts VALUES (2,'pve-a','proxmox',1,0,NULL,'ok',1,0);
      INSERT INTO docker_hosts VALUES (3,'kube-a','kubernetes',1,0,NULL,'unknown',NULL,0);
      INSERT INTO provider_resource_snapshots VALUES ('vm-1',2,'virtualMachine');
      INSERT INTO container_stats VALUES (1,1,'container-1',datetime('now'));
      INSERT INTO kubernetes_unified_evidence_snapshots VALUES (1,3,'topology');
      INSERT INTO finops_rating_runs VALUES (1,42.5,'EUR','2026-07-01','2026-08-01','2026-07-29');
    `);
    const operation = {
      id: `op_${'a'.repeat(26)}`, action: 'migrate', state: 'failed', updatedAt: '2026-07-29',
      provider: { type: 'proxmox', endpointId: 2 }, resource: { kind: 'virtualMachine', id: 'vm-1' },
    };
    const result = service(db, { operations: { list: () => [operation] } }).home({ userId: 7 });
    expect(result.endpoints).toEqual(expect.objectContaining({ total: 3, providers: { docker: 1, proxmox: 1, kubernetes: 1 } }));
    expect(result.workloads.virtualMachines.count).toBe(1);
    expect(result.workloads.containers.count).toBe(1);
    expect(result.workloads.kubernetes.state).toBe('observed');
    expect(result.cost).toEqual(expect.objectContaining({ state: 'rated', amount: 42.5, billingTransactionCreated: false }));
    expect(result.risks.items[0].deepLink).toBe(`#/activity/${operation.id}`);
    expect(result.coverage).toEqual({ liveCallsMade: false, hostPermissionFiltered: true, secretsExported: false });
    db.close();
  });

  it('B352 navigation exposes only pages backed by healthy permitted active endpoints and gives reasons', () => {
    const db = database();
    db.exec(`
      INSERT INTO docker_hosts VALUES (1,'docker-a','docker',1,1,NULL,'ok',1,0);
      INSERT INTO docker_hosts VALUES (2,'pve-a','proxmox',1,0,NULL,'auth_failed',1,1);
    `);
    const pages = service(db).navigation({ userId: 7 }).pages;
    expect(pages.find(page => page.page === 'containers')).toEqual(expect.objectContaining({ available: true }));
    expect(pages.find(page => page.page === 'virtual-machines')).toEqual(expect.objectContaining({
      available: false, reason: expect.stringContaining('healthy permitted'),
    }));
    db.close();
  });

  it('B354 explains independent permission, policy, state and capability blockers', async () => {
    const db = database();
    db.exec("INSERT INTO docker_hosts VALUES (2,'pve-a','proxmox',1,0,NULL,'ok',1,0)");
    const experience = service(db, {
      hostPermissions: { resolveEffectivePermission: () => 'view' },
      policy: { evaluate: () => ({ allowed: false, code: 'PROVIDER_READ_ONLY', reason: 'Maintenance freeze' }) },
      registry: { capabilitiesForHost: jest.fn(async () => ({
        probe: { status: 'reachable' }, features: {
          'vm.power.start': { state: 'supported' }, 'vm.snapshot.create': { state: 'unsupported', reason: 'No snapshot adapter' },
        },
      })) },
    });
    const result = await experience.actionAvailability({ userId: 7 }, {
      hostId: 2, resourceKind: 'virtualMachine', resourceState: 'poweredOn',
    });
    const start = result.decisions.find(item => item.action === 'start');
    expect(start.blockers.map(item => item.source)).toEqual(expect.arrayContaining(['permission', 'policy', 'state']));
    const snapshot = result.decisions.find(item => item.action === 'snapshot');
    expect(snapshot.blockers.map(item => item.source)).toEqual(expect.arrayContaining(['permission', 'policy', 'capability']));
    expect(snapshot.blockers.find(item => item.source === 'capability').message).toBe('No snapshot adapter');
    db.close();
  });
});
