'use strict';

// v8.14 — Platform (hypervisor) firewall WRITE, Phase C (Incus / LXD).
// Incus is the LOWEST lockout risk of the three: a network ACL doesn't filter
// anything until it is ATTACHED to a NIC/network, and docker-dash does NOT manage
// attachment. It still rides the SAME commit-confirmed pipeline (validate →
// snapshot → provisional → confirm/revert/auto-revert) for reversibility.
//
// The IncusClient (in-memory ACLs) and the platform read are mocked so nothing
// hits the network.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.DD_PLATFORM_CONFIRM_MINUTES = '5';

const pw = require('../services/firewall/platform-write');
const incus = require('../services/incus');
const platform = require('../services/firewall/platform');
const { getDb } = require('../db');

// ─────────────────────────────────────────────────────────────────────────────
describe('validateIncusRule', () => {
  test('accepts a basic ingress allow tcp/443 and defaults state=enabled', () => {
    expect(pw.validateIncusRule({ direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '443' }))
      .toEqual({ direction: 'ingress', rule: { action: 'allow', state: 'enabled', protocol: 'tcp', destination_port: '443' } });
  });

  test('accepts an egress drop scoped by source CIDR', () => {
    expect(pw.validateIncusRule({ direction: 'egress', action: 'drop', source: '10.0.0.0/8' }))
      .toEqual({ direction: 'egress', rule: { action: 'drop', state: 'enabled', source: '10.0.0.0/8' } });
  });

  test('accepts an icmp4 rule and a logged state', () => {
    expect(pw.validateIncusRule({ direction: 'ingress', action: 'allow', protocol: 'icmp4', state: 'logged', source: '1.2.3.4' }))
      .toEqual({ direction: 'ingress', rule: { action: 'allow', state: 'logged', protocol: 'icmp4', source: '1.2.3.4' } });
  });

  test('accepts an ACL-name reference as source (non-CIDR safe token)', () => {
    const r = pw.validateIncusRule({ direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '5432', source: 'web' });
    expect(r.rule.source).toBe('web');
  });

  test('accepts a comma/range destination port', () => {
    const r = pw.validateIncusRule({ direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '80,443,8000-8010' });
    expect(r.rule.destination_port).toBe('80,443,8000-8010');
  });

  test('rejects a bad action', () => {
    expect(() => pw.validateIncusRule({ direction: 'ingress', action: 'nuke', protocol: 'tcp', destination_port: '1' }))
      .toThrow(/Invalid action/);
  });

  test('rejects a bad direction', () => {
    expect(() => pw.validateIncusRule({ direction: 'sideways', action: 'allow', protocol: 'tcp', destination_port: '1' }))
      .toThrow(/Invalid direction/);
  });

  test('rejects a bad state', () => {
    expect(() => pw.validateIncusRule({ direction: 'ingress', action: 'allow', state: 'maybe', protocol: 'tcp', destination_port: '1' }))
      .toThrow(/Invalid state/);
  });

  test('rejects a bad protocol', () => {
    expect(() => pw.validateIncusRule({ direction: 'ingress', action: 'allow', protocol: 'sctp', source: '1.2.3.4' }))
      .toThrow(/Invalid protocol/);
  });

  test('rejects a bad destination port', () => {
    expect(() => pw.validateIncusRule({ direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '70000' }))
      .toThrow(/Invalid destination_port/);
  });

  test('rejects a port without tcp/udp protocol', () => {
    expect(() => pw.validateIncusRule({ direction: 'ingress', action: 'allow', protocol: 'icmp4', destination_port: '443' }))
      .toThrow(/Ports require protocol tcp or udp/);
  });

  test('rejects an unsafe source token (shell metacharacters)', () => {
    expect(() => pw.validateIncusRule({ direction: 'ingress', action: 'drop', source: '10.0.0.1; rm -rf /' }))
      .toThrow(/Invalid source/);
  });

  test('rejects an unconstrained rule (action/state only)', () => {
    expect(() => pw.validateIncusRule({ direction: 'ingress', action: 'drop' }))
      .toThrow(/must constrain at least/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('lockoutCheckIncus (LIGHT — attachment is out of scope)', () => {
  test('is PERMISSIVE for an unattached ACL (unscoped inbound drop is allowed)', () => {
    expect(() => pw.lockoutCheckIncus({
      change: { direction: 'ingress', rule: { action: 'drop', state: 'enabled' }, aclName: 'web' },
      aclUsedBy: [],
    })).not.toThrow();
  });

  test('is PERMISSIVE for an outbound drop even when attached', () => {
    expect(() => pw.lockoutCheckIncus({
      change: { direction: 'egress', rule: { action: 'drop', state: 'enabled' }, aclName: 'web' },
      aclUsedBy: ['/1.0/instances/db'],
    })).not.toThrow();
  });

  test('is PERMISSIVE for an attached inbound drop that IS source-scoped', () => {
    expect(() => pw.lockoutCheckIncus({
      change: { direction: 'ingress', rule: { action: 'drop', state: 'enabled', source: '10.0.0.0/8' }, aclName: 'web' },
      aclUsedBy: ['/1.0/instances/db'],
    })).not.toThrow();
  });

  test('WARNS for an unscoped inbound drop on an ATTACHED ACL', () => {
    expect(() => pw.lockoutCheckIncus({
      change: { direction: 'ingress', rule: { action: 'drop', state: 'enabled' }, aclName: 'web' },
      aclUsedBy: ['/1.0/instances/db'],
    })).toThrow(/attached/);
  });

  test('WARNS for an unscoped inbound reject on an ATTACHED ACL', () => {
    expect(() => pw.lockoutCheckIncus({
      change: { direction: 'ingress', rule: { action: 'reject', state: 'enabled' }, aclName: 'web' },
      aclUsedBy: ['/1.0/instances/db'],
    })).toThrow(/attached/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Incus apply / revert / sweep pipeline (mocked IncusClient + platform read)', () => {
  let db, hostId, host, aclState;
  const calls = [];
  const deep = (v) => JSON.parse(JSON.stringify(v));

  const fakeClient = {
    async getNetworkAcl(name) {
      const a = aclState[name];
      if (!a) { const e = new Error(`ACL ${name} not found`); e.status = 404; throw e; }
      return deep(a);
    },
    async listNetworkAcls() { return Object.values(aclState).map(deep); },
    async updateNetworkAcl(name, body) {
      calls.push(['put', name, deep(body)]);
      const a = aclState[name];
      if (!a) throw new Error(`ACL ${name} not found`);
      a.description = body.description;
      a.ingress = body.ingress;
      a.egress = body.egress;
      a.config = body.config;
      return { status_code: 200 };
    },
  };

  beforeAll(() => {
    db = getDb();
    const info = db.prepare("INSERT INTO docker_hosts (name, connection_type, daemon_type, is_active) VALUES ('incus1','socket','incus',1)").run();
    hostId = info.lastInsertRowid;
    host = { id: hostId, daemonType: 'incus' };
  });

  beforeEach(() => {
    db.prepare('DELETE FROM platform_firewall_changes').run();
    db.prepare('DELETE FROM firewall_snapshots').run();
    calls.length = 0;
    aclState = {
      web: {
        name: 'web', description: 'web tier', config: {}, used_by: [],
        ingress: [{ action: 'allow', state: 'enabled', protocol: 'tcp', destination_port: '443' }],
        egress: [],
      },
      attached: {
        name: 'attached', description: '', config: {}, used_by: ['/1.0/instances/db'],
        ingress: [], egress: [],
      },
    };
    jest.spyOn(incus, 'fromHostRow').mockReturnValue(fakeClient);
    jest.spyOn(platform, 'getPlatformFirewall').mockResolvedValue({ platform: 'incus', available: true, groups: [], raw: '[]' });
  });

  afterEach(() => jest.restoreAllMocks());

  test('acl-add-rule appends to the right direction + records provisional + incus snapshot + PUT', async () => {
    const r = await pw.applyPlatformRule(host, {
      operation: 'acl-add-rule', aclName: 'web', direction: 'ingress',
      action: 'allow', protocol: 'tcp', destination_port: '8080', source: '10.0.0.0/8',
    }, { username: 'admin', id: 1 }, '1.2.3.4');

    expect(r).toMatchObject({ ok: true, provisional: true, operation: 'acl-add-rule', scope: 'web' });
    expect(r.revertAt).toBeTruthy();

    const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(r.changeId);
    expect(row.state).toBe('provisional');
    expect(row.platform).toBe('incus');
    expect(row.scope).toBe('web');
    expect(row.revert_at).toBeTruthy();
    expect(row.pre_snapshot_id).toBeTruthy();

    const snap = db.prepare('SELECT * FROM firewall_snapshots WHERE id = ?').get(row.pre_snapshot_id);
    expect(snap.backend).toBe('incus');
    expect(snap.reason).toBe('pre-platform-apply');

    // The rule landed in ingress (not egress) via a full-ACL PUT.
    expect(aclState.web.ingress).toHaveLength(2);
    expect(aclState.web.ingress[1]).toMatchObject({ action: 'allow', protocol: 'tcp', destination_port: '8080', source: '10.0.0.0/8' });
    expect(aclState.web.egress).toHaveLength(0);
    expect(calls.some(c => c[0] === 'put' && c[1] === 'web')).toBe(true);
  });

  test('an attached ACL + unscoped inbound drop (port-constrained, no source) is refused BEFORE any mutation or snapshot', async () => {
    // The rule is valid (constrained by protocol/port) but has no SOURCE scope, so
    // the light lockout guard warns because the ACL is attached (in use).
    await expect(pw.applyPlatformRule(host, {
      operation: 'acl-add-rule', aclName: 'attached', direction: 'ingress', action: 'drop', protocol: 'tcp', destination_port: '22',
    }, { username: 'admin' }, '1.2.3.4')).rejects.toThrow(/attached/);
    expect(db.prepare('SELECT COUNT(*) c FROM platform_firewall_changes').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM firewall_snapshots').get().c).toBe(0);
    expect(calls.length).toBe(0);
  });

  test('a missing ACL fails closed (no snapshot, no mutation)', async () => {
    await expect(pw.applyPlatformRule(host, {
      operation: 'acl-add-rule', aclName: 'ghost', direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '1',
    }, { username: 'admin' }, '1.2.3.4')).rejects.toThrow(/not found/);
    expect(db.prepare('SELECT COUNT(*) c FROM firewall_snapshots').get().c).toBe(0);
    expect(calls.length).toBe(0);
  });

  test('acl-remove-rule removes the rule at the given index', async () => {
    aclState.web.ingress = [
      { action: 'allow', state: 'enabled', protocol: 'tcp', destination_port: '443' },
      { action: 'allow', state: 'enabled', protocol: 'tcp', destination_port: '80' },
    ];
    const r = await pw.applyPlatformRule(host, {
      operation: 'acl-remove-rule', aclName: 'web', direction: 'ingress', index: 0,
    }, { username: 'admin' }, '1.2.3.4');
    expect(r).toMatchObject({ ok: true, provisional: true, operation: 'acl-remove-rule', scope: 'web' });
    expect(aclState.web.ingress).toHaveLength(1);
    expect(aclState.web.ingress[0].destination_port).toBe('80');
  });

  test('acl-remove-rule with an out-of-range index is rejected (no mutation)', async () => {
    await expect(pw.applyPlatformRule(host, {
      operation: 'acl-remove-rule', aclName: 'web', direction: 'ingress', index: 9,
    }, { username: 'admin' }, '1.2.3.4')).rejects.toThrow(/No ingress rule at index/);
    expect(calls.length).toBe(0);
  });

  test('a write failure records a failed row and rethrows (snapshot still taken)', async () => {
    jest.spyOn(fakeClient, 'updateNetworkAcl').mockRejectedValueOnce(new Error('incus PUT rejected'));
    await expect(pw.applyPlatformRule(host, {
      operation: 'acl-add-rule', aclName: 'web', direction: 'egress', action: 'allow', protocol: 'udp', destination_port: '53',
    }, { username: 'admin' }, '1.2.3.4')).rejects.toThrow(/incus PUT rejected/);
    const row = db.prepare("SELECT * FROM platform_firewall_changes WHERE state='failed'").get();
    expect(row).toBeTruthy();
    expect(row.platform).toBe('incus');
    expect(row.error).toMatch(/incus PUT rejected/);
    expect(db.prepare('SELECT COUNT(*) c FROM firewall_snapshots').get().c).toBe(1);
  });

  test('confirm clears revert_at and marks confirmed', async () => {
    const r = await pw.applyPlatformRule(host, {
      operation: 'acl-add-rule', aclName: 'web', direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '9000',
    }, { username: 'admin' }, '1.2.3.4');
    const res = pw.confirmPlatformChange(r.changeId, { username: 'admin' });
    expect(res).toMatchObject({ ok: true, state: 'confirmed' });
    const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(r.changeId);
    expect(row.state).toBe('confirmed');
    expect(row.revert_at).toBeNull();
  });

  test('revert of acl-add-rule restores the ingress array from the snapshot', async () => {
    const r = await pw.applyPlatformRule(host, {
      operation: 'acl-add-rule', aclName: 'web', direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '8080',
    }, { username: 'admin' }, '1.2.3.4');
    expect(aclState.web.ingress).toHaveLength(2);
    await pw.revertPlatformChange(r.changeId, { username: 'admin' }, {});
    expect(aclState.web.ingress).toHaveLength(1);
    expect(aclState.web.ingress[0].destination_port).toBe('443');
    expect(db.prepare('SELECT state FROM platform_firewall_changes WHERE id = ?').get(r.changeId).state).toBe('reverted');
  });

  test('revert of acl-remove-rule restores the removed rule from the snapshot', async () => {
    const r = await pw.applyPlatformRule(host, {
      operation: 'acl-remove-rule', aclName: 'web', direction: 'ingress', index: 0,
    }, { username: 'admin' }, '1.2.3.4');
    expect(aclState.web.ingress).toHaveLength(0);
    await pw.revertPlatformChange(r.changeId, { username: 'admin' }, {});
    expect(aclState.web.ingress).toHaveLength(1);
    expect(aclState.web.ingress[0].destination_port).toBe('443');
  });

  test('revert restores ONLY the affected direction (leaves the other untouched)', async () => {
    aclState.web.egress = [{ action: 'allow', state: 'enabled', protocol: 'tcp', destination_port: '25' }];
    const r = await pw.applyPlatformRule(host, {
      operation: 'acl-add-rule', aclName: 'web', direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '8080',
    }, { username: 'admin' }, '1.2.3.4');
    // Concurrent-ish change to egress after apply — revert must not clobber it.
    aclState.web.egress.push({ action: 'drop', state: 'enabled', protocol: 'udp', destination_port: '123' });
    await pw.revertPlatformChange(r.changeId, { username: 'admin' }, {});
    expect(aclState.web.ingress).toHaveLength(1);
    expect(aclState.web.egress).toHaveLength(2); // untouched by the ingress revert
  });

  test('sweepExpiredProvisional auto-reverts an overdue Incus change', async () => {
    const r = await pw.applyPlatformRule(host, {
      operation: 'acl-add-rule', aclName: 'web', direction: 'ingress', action: 'allow', protocol: 'tcp', destination_port: '8080',
    }, { username: 'admin' }, '1.2.3.4');
    expect(aclState.web.ingress).toHaveLength(2);
    db.prepare("UPDATE platform_firewall_changes SET revert_at = datetime('now','-1 minute') WHERE id = ?").run(r.changeId);

    const swept = await pw.sweepExpiredProvisional();
    expect(swept.reverted).toBe(1);
    expect(aclState.web.ingress).toHaveLength(1);
    expect(db.prepare('SELECT state FROM platform_firewall_changes WHERE id = ?').get(r.changeId).state).toBe('reverted');
  });

  test('removePlatformRule rejects for incus (rules are removed by direction/index)', async () => {
    await expect(pw.removePlatformRule(host, { pos: 0, scope: 'web' }, { username: 'admin' }, '1.2.3.4'))
      .rejects.toThrow(/removed by \(direction, index\)/);
  });

  test('supportsWrite is true for incus and lxd', () => {
    expect(pw.supportsWrite('incus')).toBe(true);
    expect(pw.supportsWrite('lxd')).toBe(true);
    expect(pw.supportsWrite('docker')).toBe(false);
  });
});
