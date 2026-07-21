'use strict';

// v8.11 — Platform (hypervisor) firewall WRITE, Phase A (Proxmox).
// Covers the SECURITY-CRITICAL pieces: Proxmox rule validation, the extended
// lockout guard, and the commit-confirmed auto-revert pipeline (provisional
// apply → snapshot → confirm/revert/auto-revert). The ProxmoxClient and the
// getPlatformFirewall reader are mocked so nothing hits the network.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.DD_PLATFORM_CONFIRM_MINUTES = '5';

const pw = require('../services/firewall/platform-write');
const proxmox = require('../services/proxmox');
const platform = require('../services/firewall/platform');
const { getDb } = require('../db');

// ── A fake ProxmoxClient that keeps rules/options in memory ──────────────────
function _reindex(rules) { rules.forEach((r, i) => { r.pos = i; }); }
function makeFakeClient(initial = {}) {
  const state = {
    clusterRules: (initial.clusterRules || []).map((r, i) => ({ pos: i, ...r })),
    clusterOptions: initial.clusterOptions || { enable: 0 },
    nodeRules: (initial.nodeRules || []).map((r, i) => ({ pos: i, ...r })),
    nodeOptions: initial.nodeOptions || { enable: 0 },
    calls: [],
  };
  return {
    _state: state,
    async getClusterFirewallRules() { return state.clusterRules.map(r => ({ ...r })); },
    async getClusterFirewallOptions() { return state.clusterOptions; },
    async getNodeFirewallRules() { return state.nodeRules.map(r => ({ ...r })); },
    async getNodeFirewallOptions() { return state.nodeOptions; },
    async createClusterFirewallRule(rule) { state.calls.push(['createCluster', rule]); state.clusterRules.unshift({ ...rule }); _reindex(state.clusterRules); },
    async deleteClusterFirewallRule(pos) { state.calls.push(['deleteCluster', Number(pos)]); state.clusterRules = state.clusterRules.filter(r => Number(r.pos) !== Number(pos)); _reindex(state.clusterRules); },
    async setClusterFirewallOptions(opts) { state.calls.push(['setClusterOptions', opts]); state.clusterOptions = { ...state.clusterOptions, ...opts }; },
    async createNodeFirewallRule(n, rule) { state.calls.push(['createNode', n, rule]); state.nodeRules.unshift({ ...rule }); _reindex(state.nodeRules); },
    async deleteNodeFirewallRule(n, pos) { state.calls.push(['deleteNode', n, Number(pos)]); state.nodeRules = state.nodeRules.filter(r => Number(r.pos) !== Number(pos)); _reindex(state.nodeRules); },
    async setNodeFirewallOptions(n, opts) { state.calls.push(['setNodeOptions', n, opts]); state.nodeOptions = { ...state.nodeOptions, ...opts }; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('validateProxmoxRule', () => {
  test('accepts a well-formed inbound ACCEPT rule and normalizes case', () => {
    const r = pw.validateProxmoxRule({ type: 'IN', action: 'accept', proto: 'TCP', dport: '22', source: '1.2.3.4' });
    expect(r).toEqual({ type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '22', source: '1.2.3.4' });
  });

  test('accepts a dport range n:m', () => {
    const r = pw.validateProxmoxRule({ type: 'in', action: 'ACCEPT', dport: '8000:8010' });
    expect(r.dport).toBe('8000:8010');
  });

  test('sanitizes the comment', () => {
    const r = pw.validateProxmoxRule({ type: 'in', action: 'ACCEPT', dport: '22', comment: 'note; rm -rf /' });
    expect(r.comment).toBe('note rm -rf /'); // dangerous chars stripped by sanitizeReason
  });

  test('rejects a bad action', () => {
    expect(() => pw.validateProxmoxRule({ type: 'in', action: 'PERMIT', dport: '22' })).toThrow(/Invalid action/);
  });

  test('rejects a bad type', () => {
    expect(() => pw.validateProxmoxRule({ type: 'sideways', action: 'ACCEPT', dport: '22' })).toThrow(/Invalid rule type/);
  });

  test('rejects an unconstrained rule (no dport, source or dest)', () => {
    expect(() => pw.validateProxmoxRule({ type: 'in', action: 'DROP' })).toThrow(/unconstrained rule/);
  });

  test('rejects an inverted dport range', () => {
    expect(() => pw.validateProxmoxRule({ type: 'in', action: 'ACCEPT', dport: '30:20' })).toThrow(/Invalid destination port/);
  });

  test('rejects a dport range with an out-of-range end', () => {
    expect(() => pw.validateProxmoxRule({ type: 'in', action: 'ACCEPT', dport: '8000:70000' })).toThrow(/Invalid destination port/);
  });

  test('rejects a malformed source', () => {
    expect(() => pw.validateProxmoxRule({ type: 'in', action: 'ACCEPT', dport: '22', source: 'not-an-ip' })).toThrow(/Invalid source/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('lockoutCheckProxmox', () => {
  test('refuses enabling the firewall when no ACCEPT protects mgmt for the requester', () => {
    expect(() => pw.lockoutCheckProxmox({
      enableFirewall: true, requesterIp: '1.2.3.4', currentRules: [], currentOptions: { enable: 0 },
    })).toThrow(/no ACCEPT rule protects SSH \(22\) \/ PVE web \(8006\)/);
  });

  test('allows enabling the firewall when ACCEPT rules cover 22 AND 8006 for the requester', () => {
    const rules = [
      { type: 'in', action: 'ACCEPT', dport: '22', source: '1.2.3.4', enable: 1, pos: 0 },
      { type: 'in', action: 'ACCEPT', dport: '8006', source: '1.2.3.4', enable: 1, pos: 1 },
    ];
    expect(() => pw.lockoutCheckProxmox({
      enableFirewall: true, requesterIp: '1.2.3.4', currentRules: rules, currentOptions: { enable: 0 },
    })).not.toThrow();
  });

  test('still refuses enabling when only 22 is covered (8006 missing)', () => {
    const rules = [{ type: 'in', action: 'ACCEPT', dport: '22', source: '1.2.3.4', enable: 1, pos: 0 }];
    expect(() => pw.lockoutCheckProxmox({
      enableFirewall: true, requesterIp: '1.2.3.4', currentRules: rules, currentOptions: { enable: 0 },
    })).toThrow(/locked out/);
  });

  test('refuses a DROP rule that would drop SSH (22) for everyone (no scoped source)', () => {
    expect(() => pw.lockoutCheckProxmox({
      rule: { type: 'in', action: 'DROP', dport: '22' }, requesterIp: '1.2.3.4', currentRules: [],
    })).toThrow(/drop SSH \(22\) \/ PVE web \(8006\) for everyone/);
  });

  test('refuses a REJECT rule that matches PVE web (8006) for everyone', () => {
    expect(() => pw.lockoutCheckProxmox({
      rule: { type: 'in', action: 'REJECT', dport: '8006' }, requesterIp: '1.2.3.4', currentRules: [],
    })).toThrow(/for everyone/);
  });

  test('refuses a DROP range that spans a mgmt port (1:1024) for everyone', () => {
    expect(() => pw.lockoutCheckProxmox({
      rule: { type: 'in', action: 'DROP', dport: '1:1024' }, requesterIp: '1.2.3.4', currentRules: [],
    })).toThrow(/for everyone/);
  });

  test('treats an explicit 0.0.0.0/0 source as unscoped — refuses DROP of SSH', () => {
    expect(() => pw.lockoutCheckProxmox({
      rule: { type: 'in', action: 'DROP', dport: '22', source: '0.0.0.0/0' }, requesterIp: '1.2.3.4', currentRules: [],
    })).toThrow(/for everyone/);
  });

  test('treats an explicit ::/0 source as unscoped — refuses DROP of PVE web', () => {
    expect(() => pw.lockoutCheckProxmox({
      rule: { type: 'in', action: 'DROP', dport: '8006', source: '::/0' }, requesterIp: '1.2.3.4', currentRules: [],
    })).toThrow(/for everyone/);
  });

  test('allows a safe scoped ACCEPT rule', () => {
    expect(() => pw.lockoutCheckProxmox({
      rule: { type: 'in', action: 'ACCEPT', dport: '22', source: '1.2.3.4' }, requesterIp: '1.2.3.4', currentRules: [],
    })).not.toThrow();
  });

  test('allows a DROP on a non-management port with no source', () => {
    expect(() => pw.lockoutCheckProxmox({
      rule: { type: 'in', action: 'DROP', dport: '3306' }, requesterIp: '1.2.3.4', currentRules: [],
    })).not.toThrow();
  });

  test('refuses (via the base guard) a DROP whose scoped source is the requester IP', () => {
    expect(() => pw.lockoutCheckProxmox({
      rule: { type: 'in', action: 'DROP', dport: '3306', source: '9.9.9.9' }, requesterIp: '9.9.9.9', currentRules: [],
    })).toThrow(/your own/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('applyPlatformRule pipeline (mocked client + getPlatformFirewall)', () => {
  let db, hostId, host, fakeClient;

  beforeAll(() => {
    db = getDb();
    const info = db.prepare("INSERT INTO docker_hosts (name, connection_type, daemon_type, is_active) VALUES ('pve1','socket','proxmox',1)").run();
    hostId = info.lastInsertRowid;
    host = { id: hostId, daemonType: 'proxmox' };
  });

  beforeEach(() => {
    db.prepare('DELETE FROM platform_firewall_changes').run();
    db.prepare('DELETE FROM firewall_snapshots').run();
    fakeClient = makeFakeClient();
    jest.spyOn(proxmox, 'fromHostRow').mockReturnValue(fakeClient);
    jest.spyOn(platform, 'getPlatformFirewall').mockResolvedValue({ platform: 'proxmox', available: true, groups: [], raw: '{}' });
  });

  afterEach(() => jest.restoreAllMocks());

  test('add-rule happy path: provisional row + revert_at + snapshot + client call', async () => {
    const r = await pw.applyPlatformRule(host, { type: 'in', action: 'ACCEPT', dport: '22', source: '1.2.3.4', scope: 'cluster' }, { username: 'admin', id: 1 }, '1.2.3.4');
    expect(r).toMatchObject({ ok: true, provisional: true, operation: 'add-rule', scope: 'cluster' });
    expect(r.changeId).toBeTruthy();
    expect(r.revertAt).toBeTruthy();

    const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(r.changeId);
    expect(row.state).toBe('provisional');
    expect(row.revert_at).toBeTruthy();
    expect(row.pre_snapshot_id).toBeTruthy();

    // Snapshot was taken (getPlatformFirewall called; snapshot row exists).
    expect(platform.getPlatformFirewall).toHaveBeenCalled();
    const snap = db.prepare('SELECT * FROM firewall_snapshots WHERE id = ?').get(row.pre_snapshot_id);
    expect(snap.backend).toBe('proxmox');
    expect(snap.reason).toBe('pre-platform-apply');

    // The client actually created the rule with a sane body.
    const created = fakeClient._state.calls.find(c => c[0] === 'createCluster');
    expect(created).toBeTruthy();
    expect(created[1]).toMatchObject({ type: 'in', action: 'ACCEPT', dport: '22', source: '1.2.3.4', enable: 1 });
  });

  test('a rule that would lock out mgmt is refused BEFORE any mutation or snapshot', async () => {
    await expect(pw.applyPlatformRule(host, { type: 'in', action: 'DROP', dport: '22', scope: 'cluster' }, { username: 'admin' }, '1.2.3.4'))
      .rejects.toThrow(/for everyone/);
    expect(db.prepare('SELECT COUNT(*) c FROM platform_firewall_changes').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM firewall_snapshots').get().c).toBe(0);
    expect(fakeClient._state.calls.length).toBe(0);
  });

  test('a client write failure records a failed row and rethrows', async () => {
    fakeClient.createClusterFirewallRule = async () => { throw new Error('pve API 500'); };
    await expect(pw.applyPlatformRule(host, { type: 'in', action: 'ACCEPT', dport: '2222', source: '1.2.3.4', scope: 'cluster' }, { username: 'admin' }, '1.2.3.4'))
      .rejects.toThrow(/pve API 500/);
    const row = db.prepare("SELECT * FROM platform_firewall_changes WHERE state='failed'").get();
    expect(row).toBeTruthy();
    expect(row.error).toMatch(/pve API 500/);
    // A snapshot was still taken (fail-safe: never mutate without a recorded pre-state).
    expect(db.prepare('SELECT COUNT(*) c FROM firewall_snapshots').get().c).toBe(1);
  });

  test('confirm clears revert_at and marks confirmed', async () => {
    const r = await pw.applyPlatformRule(host, { type: 'in', action: 'ACCEPT', dport: '22', source: '1.2.3.4', scope: 'cluster' }, { username: 'admin' }, '1.2.3.4');
    const res = pw.confirmPlatformChange(r.changeId, { username: 'admin' });
    expect(res).toMatchObject({ ok: true, state: 'confirmed' });
    const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(r.changeId);
    expect(row.state).toBe('confirmed');
    expect(row.revert_at).toBeNull();
    expect(row.confirmed_at).toBeTruthy();
  });

  test('revert of an add-rule deletes the created rule and marks reverted', async () => {
    const r = await pw.applyPlatformRule(host, { type: 'in', action: 'ACCEPT', dport: '22', source: '1.2.3.4', scope: 'cluster' }, { username: 'admin' }, '1.2.3.4');
    expect(fakeClient._state.clusterRules.length).toBe(1);

    const res = await pw.revertPlatformChange(r.changeId, { username: 'admin' }, { reason: 'test' });
    expect(res).toMatchObject({ ok: true, state: 'reverted' });
    // The created rule was deleted from the host.
    expect(fakeClient._state.calls.some(c => c[0] === 'deleteCluster')).toBe(true);
    expect(fakeClient._state.clusterRules.length).toBe(0);
    const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(r.changeId);
    expect(row.state).toBe('reverted');
    expect(row.reverted_at).toBeTruthy();
    expect(row.revert_at).toBeNull();
  });

  test('remove-rule is provisional and its revert re-creates the deleted rule', async () => {
    // Seed a rule to remove.
    fakeClient._state.clusterRules = [{ pos: 0, type: 'in', action: 'ACCEPT', dport: '9999', source: '5.6.7.8', enable: 1 }];
    const r = await pw.removePlatformRule(host, { pos: 0, scope: 'cluster' }, { username: 'admin' }, '1.2.3.4');
    expect(r).toMatchObject({ ok: true, provisional: true, operation: 'remove-rule' });
    expect(fakeClient._state.clusterRules.length).toBe(0);

    await pw.revertPlatformChange(r.changeId, { username: 'admin' }, {});
    // The rule came back.
    expect(fakeClient._state.clusterRules.length).toBe(1);
    expect(fakeClient._state.clusterRules[0]).toMatchObject({ type: 'in', action: 'ACCEPT', dport: '9999', source: '5.6.7.8' });
  });

  test('sweepExpiredProvisional reverts an overdue provisional change and leaves a confirmed one alone', async () => {
    // Change A — provisional, made overdue.
    const a = await pw.applyPlatformRule(host, { type: 'in', action: 'ACCEPT', dport: '2201', source: '1.1.1.1', scope: 'cluster' }, { username: 'admin' }, '1.1.1.1');
    // Change B — provisional then confirmed (must NOT be swept).
    const b = await pw.applyPlatformRule(host, { type: 'in', action: 'ACCEPT', dport: '2202', source: '2.2.2.2', scope: 'cluster' }, { username: 'admin' }, '2.2.2.2');
    pw.confirmPlatformChange(b.changeId, { username: 'admin' });

    // Force A's deadline into the past.
    db.prepare("UPDATE platform_firewall_changes SET revert_at = datetime('now','-1 minute') WHERE id = ?").run(a.changeId);

    const before = fakeClient._state.clusterRules.length; // both rules present
    expect(before).toBe(2);

    const swept = await pw.sweepExpiredProvisional();
    expect(swept.reverted).toBe(1);

    const rowA = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(a.changeId);
    const rowB = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(b.changeId);
    expect(rowA.state).toBe('reverted');
    expect(rowB.state).toBe('confirmed'); // untouched
    // A's rule (dport 2201) was deleted; B's rule (dport 2202) remains.
    expect(fakeClient._state.clusterRules.some(r => r.dport === '2202')).toBe(true);
    expect(fakeClient._state.clusterRules.some(r => r.dport === '2201')).toBe(false);
  });

  test('getPendingChanges returns only provisional changes with parsed spec', async () => {
    const a = await pw.applyPlatformRule(host, { type: 'in', action: 'ACCEPT', dport: '22', source: '1.2.3.4', scope: 'cluster' }, { username: 'admin' }, '1.2.3.4');
    const b = await pw.applyPlatformRule(host, { type: 'in', action: 'ACCEPT', dport: '8006', source: '1.2.3.4', scope: 'cluster' }, { username: 'admin' }, '1.2.3.4');
    pw.confirmPlatformChange(b.changeId, { username: 'admin' });

    const pending = pw.getPendingChanges(hostId);
    expect(pending.pending.length).toBe(1);
    expect(pending.pending[0].id).toBe(a.changeId);
    expect(pending.pending[0].spec.rule).toMatchObject({ type: 'in', action: 'ACCEPT', dport: '22' });
  });
});
