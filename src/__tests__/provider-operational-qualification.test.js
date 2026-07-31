'use strict';

const Database = require('better-sqlite3');
const qualification = require('../services/provider-sdk/operational-qualification');

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE provider_vm_snapshots (canonical_id TEXT PRIMARY KEY);
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
  `);
  require('../db/migrations/107_provider_operations').up(db);
  require('../db/migrations/153_provider_inventory_views').up(db);
  require('../db/migrations/154_provider_snapshot_risk').up(db);
  require('../db/migrations/155_storage_repository_health').up(db);
  require('../db/migrations/157_provider_vm_action_schedules').up(db);
  require('../db/migrations/158_network_dependency_map').up(db);
  require('../db/migrations/159_network_mtu_assessments').up(db);
  require('../db/migrations/160_network_bond_health').up(db);
  require('../db/migrations/161_network_load_balancer_inventory').up(db);
  require('../db/migrations/163_provider_vm_nic_safety').up(db);
  require('../db/migrations/164_network_reachability_assessments').up(db);
  return db;
}

describe('provider operational qualification', () => {
  let db;
  afterEach(() => db?.close());

  it('qualifies exactly ten released features without running external work', () => {
    db = database();
    db.exec('INSERT INTO users(id) VALUES (9); INSERT INTO docker_hosts(id) VALUES (7);');
    db.prepare(`INSERT INTO provider_inventory_views
      (user_id,name,resource_type,provider_host_id,filters_json,columns_json,sort_json)
      VALUES (?,?,?,?,?,?,?)`).run(9, 'Running VMs', 'virtual-machines', 7, '{}', '[]', '{}');
    db.prepare(`INSERT INTO network_reachability_assessments
      (scope_key,protocol,destination_port,source_json,destination_json,evidence_json,summary_json,
       verdict,assessment_hash) VALUES (?,?,?,?,?,?,?,?,?)`).run('provider:7', 'tcp', 443, '{}', '{}',
      '{}', '{}', 'unknown', 'a'.repeat(64));

    const first = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db });
    const second = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db });

    expect(first.items.map(item => item.featureId)).toEqual([
      'B015', 'B045', 'B090', 'B096', 'B104', 'B118', 'B119', 'B120', 'B121', 'B123',
    ]);
    expect(first.summary).toEqual(expect.objectContaining({ featureCount: 10, schemaReady: 10,
      runtimeObserved: 2, executeFlagsEnabled: 0, browserSmokeRecorded: 0 }));
    expect(first.items.find(item => item.featureId === 'B015').runtime).toEqual(
      expect.objectContaining({ state: 'observed', recordCount: 1, scope: 'current-user' }));
    expect(first.items.find(item => item.featureId === 'B119').runtime).toEqual(
      expect.objectContaining({ state: 'observed', networkCallsStarted: 0,
        providerMutationsStarted: 0 }));
    expect(first.items.every(item => item.qualificationSafety.providerMutationsStarted === 0)).toBe(true);
    expect(first.items.find(item => item.featureId === 'B104').runtime.executeFlag.enabled).toBe(false);
    expect(first.evidenceHash).toBe(second.evidenceHash);
    expect(first.limitations.join(' ')).toContain('not a browser test');
  });

  it('reports missing schema and never upgrades absent evidence to success', () => {
    db = new Database(':memory:');
    const result = qualification.qualificationForHost({ id: 7, daemon_type: 'xen' },
      { actorId: 9, database: db });
    expect(result.summary).toEqual(expect.objectContaining({ schemaReady: 0, runtimeObserved: 0 }));
    expect(result.items.every(item => item.schema.state === 'missing')).toBe(true);
    expect(result.items.every(item => item.runtime.state === 'not_observed')).toBe(true);
  });

  it('rejects missing host and actor identity', () => {
    db = new Database(':memory:');
    expect(() => qualification.qualificationForHost(null, { actorId: 9, database: db }))
      .toThrow('Valid provider host required');
    expect(() => qualification.qualificationForHost({ id: 7 }, { database: db }))
      .toThrow('Valid actor required');
  });
});
