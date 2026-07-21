'use strict';

// v8.12 — Platform (hypervisor) firewall WRITE, Phase B (ESXi / vSphere).
// SECURITY-CRITICAL: a bad `esxcli network firewall` change over SSH can lock
// docker-dash out of the host. Covers ESXi rule validation, the ESXi lockout
// guard (protecting the SSH management ruleset), and the commit-confirmed
// auto-revert pipeline. The vsphere-ssh WRITE module and the firewall READ
// (getFirewall) are mocked so nothing hits the network.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.DD_PLATFORM_CONFIRM_MINUTES = '5';

const pw = require('../services/firewall/platform-write');
const vsphere = require('../services/vsphere');
const vsphereSsh = require('../services/vsphere-ssh');
const vsphereSshWrite = require('../services/vsphere-ssh-write');
const platform = require('../services/firewall/platform');
const { getDb } = require('../db');

const KNOWN = ['sshServer', 'vSphereClient', 'dns'];

// ─────────────────────────────────────────────────────────────────────────────
describe('validateEsxiChange', () => {
  test('accepts ruleset-set-enabled', () => {
    expect(pw.validateEsxiChange({ operation: 'ruleset-set-enabled', rulesetId: 'dns', enabled: true }, KNOWN))
      .toEqual({ operation: 'ruleset-set-enabled', rulesetId: 'dns', enabled: true });
  });

  test('accepts allowedip-add with a CIDR', () => {
    expect(pw.validateEsxiChange({ operation: 'allowedip-add', rulesetId: 'vSphereClient', ipAddress: '10.0.0.0/24' }, KNOWN))
      .toEqual({ operation: 'allowedip-add', rulesetId: 'vSphereClient', ipAddress: '10.0.0.0/24' });
  });

  test('accepts ruleset-set-allowedall and coerces "false" string', () => {
    expect(pw.validateEsxiChange({ operation: 'ruleset-set-allowedall', rulesetId: 'dns', allowedAll: 'false' }, KNOWN))
      .toEqual({ operation: 'ruleset-set-allowedall', rulesetId: 'dns', allowedAll: false });
  });

  test('rejects an unknown ruleset (defence-in-depth)', () => {
    expect(() => pw.validateEsxiChange({ operation: 'allowedip-add', rulesetId: 'nope', ipAddress: '1.2.3.4' }, KNOWN))
      .toThrow(/Unknown ESXi ruleset/);
  });

  test('rejects a bad IP', () => {
    expect(() => pw.validateEsxiChange({ operation: 'allowedip-add', rulesetId: 'dns', ipAddress: 'not-an-ip' }, KNOWN))
      .toThrow(/Invalid IP/);
  });

  test('rejects a bad operation', () => {
    expect(() => pw.validateEsxiChange({ operation: 'flush-everything', rulesetId: 'dns' }, KNOWN))
      .toThrow(/Invalid ESXi operation/);
  });

  test('rejects a ruleset id with shell metacharacters', () => {
    expect(() => pw.validateEsxiChange({ operation: 'ruleset-set-enabled', rulesetId: 'ssh; rm -rf /', enabled: false }))
      .toThrow(/Invalid ESXi ruleset id/);
  });

  test('rejects a non-boolean enabled', () => {
    expect(() => pw.validateEsxiChange({ operation: 'ruleset-set-enabled', rulesetId: 'dns', enabled: 'maybe' }, KNOWN))
      .toThrow(/must be a boolean/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('lockoutCheckEsxi', () => {
  const view = {
    rulesets: [
      { name: 'sshServer', enabled: true, allowedIps: ['1.2.3.4', '10.0.0.0/8'] },
      { name: 'vSphereClient', enabled: true, allowedIps: ['All'] },
    ],
  };

  test('REFUSES disabling the sshServer (management) ruleset', () => {
    expect(() => pw.lockoutCheckEsxi({
      change: { operation: 'ruleset-set-enabled', rulesetId: 'sshServer', enabled: false },
      requesterIp: '1.2.3.4', firewallView: view,
    })).toThrow(/would be locked out/);
  });

  test('REFUSES removing the requester IP coverage from the mgmt ruleset', () => {
    const v = { rulesets: [{ name: 'sshServer', enabled: true, allowedIps: ['1.2.3.4'] }] };
    expect(() => pw.lockoutCheckEsxi({
      change: { operation: 'allowedip-remove', rulesetId: 'sshServer', ipAddress: '1.2.3.4' },
      requesterIp: '1.2.3.4', firewallView: v,
    })).toThrow(/locked out/);
  });

  test('REFUSES allowed-all=false on the mgmt ruleset when its list excludes the requester', () => {
    const v = { rulesets: [{ name: 'sshServer', enabled: true, allowedIps: ['9.9.9.9'] }] };
    expect(() => pw.lockoutCheckEsxi({
      change: { operation: 'ruleset-set-allowedall', rulesetId: 'sshServer', allowedAll: false },
      requesterIp: '1.2.3.4', firewallView: v,
    })).toThrow(/would not cover your IP/);
  });

  test('ALLOWS adding an allowed IP to a NON-mgmt ruleset', () => {
    expect(() => pw.lockoutCheckEsxi({
      change: { operation: 'allowedip-add', rulesetId: 'vSphereClient', ipAddress: '5.6.7.8' },
      requesterIp: '1.2.3.4', firewallView: view,
    })).not.toThrow();
  });

  test('ALLOWS disabling a NON-mgmt ruleset', () => {
    expect(() => pw.lockoutCheckEsxi({
      change: { operation: 'ruleset-set-enabled', rulesetId: 'vSphereClient', enabled: false },
      requesterIp: '1.2.3.4', firewallView: view,
    })).not.toThrow();
  });

  test('ALLOWS allowedip-remove on the mgmt ruleset when a remaining range still covers the requester', () => {
    const v = { rulesets: [{ name: 'sshServer', enabled: true, allowedIps: ['1.2.3.4', '10.0.0.0/8'] }] };
    expect(() => pw.lockoutCheckEsxi({
      change: { operation: 'allowedip-remove', rulesetId: 'sshServer', ipAddress: '1.2.3.4' },
      requesterIp: '10.1.1.1', firewallView: v,
    })).not.toThrow();
  });

  test('ALLOWS allowedip-remove on the mgmt ruleset when it is allowed-all', () => {
    const v = { rulesets: [{ name: 'sshServer', enabled: true, allowedIps: ['All'] }] };
    expect(() => pw.lockoutCheckEsxi({
      change: { operation: 'allowedip-remove', rulesetId: 'sshServer', ipAddress: '1.2.3.4' },
      requesterIp: '1.2.3.4', firewallView: v,
    })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ESXi apply / revert / sweep pipeline (mocked getFirewall + write module)', () => {
  let db, hostId, host, fwState;
  const calls = [];
  const rs = (name) => fwState.rulesets.find(r => r.name === name);
  const stripAll = (ips) => (ips || []).filter(x => !/^all$/i.test(String(x)));
  const isAll = (ruleset) => (ruleset.allowedIps || []).some(x => /^all$/i.test(String(x)));

  beforeAll(() => {
    db = getDb();
    const info = db.prepare("INSERT INTO docker_hosts (name, connection_type, daemon_type, is_active) VALUES ('esxi1','socket','vsphere',1)").run();
    hostId = info.lastInsertRowid;
    host = { id: hostId, daemonType: 'vsphere' };
  });

  beforeEach(() => {
    db.prepare('DELETE FROM platform_firewall_changes').run();
    db.prepare('DELETE FROM firewall_snapshots').run();
    calls.length = 0;
    fwState = {
      enabled: true, defaultAction: 'DROP', loaded: true,
      rulesets: [
        { name: 'sshServer', enabled: true, allowedIps: ['1.2.3.4'] }, // mgmt, restricted to requester
        { name: 'vSphereClient', enabled: true, allowedIps: ['All'] },  // non-mgmt, allowed-all
        { name: 'dns', enabled: false, allowedIps: ['All'] },           // non-mgmt
      ],
    };

    jest.spyOn(vsphere, 'decryptDaemonConfig').mockReturnValue({ sshConfig: { host: 'esxi.local', user: 'root', privateKey: 'KEY' } });
    jest.spyOn(vsphereSsh, 'getFirewall').mockImplementation(async () => JSON.parse(JSON.stringify(fwState)));
    jest.spyOn(platform, 'getPlatformFirewall').mockResolvedValue({ platform: 'esxi', available: true, groups: [], raw: '{}' });

    jest.spyOn(vsphereSshWrite, 'setRulesetEnabled').mockImplementation(async (_ssh, name, en) => {
      calls.push(['setEnabled', name, en]); const r = rs(name); if (r) r.enabled = en; return { ok: true };
    });
    jest.spyOn(vsphereSshWrite, 'setRulesetAllowedAll').mockImplementation(async (_ssh, name, all) => {
      calls.push(['setAllowedAll', name, all]); const r = rs(name);
      if (r) { r.allowedIps = all ? ['All'] : stripAll(r.allowedIps); }
      return { ok: true };
    });
    jest.spyOn(vsphereSshWrite, 'addAllowedIp').mockImplementation(async (_ssh, name, ip) => {
      calls.push(['addIp', name, ip]); const r = rs(name);
      if (r) { r.allowedIps = stripAll(r.allowedIps); if (!r.allowedIps.includes(ip)) r.allowedIps.push(ip); }
      return { ok: true };
    });
    jest.spyOn(vsphereSshWrite, 'removeAllowedIp').mockImplementation(async (_ssh, name, ip) => {
      calls.push(['removeIp', name, ip]); const r = rs(name);
      if (r) r.allowedIps = (r.allowedIps || []).filter(x => x !== ip);
      return { ok: true };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('add allowed IP to a non-mgmt ruleset: provisional row + esxi snapshot + write call', async () => {
    const r = await pw.applyPlatformRule(host, { operation: 'allowedip-add', rulesetId: 'vSphereClient', ipAddress: '5.6.7.8' }, { username: 'admin', id: 1 }, '1.2.3.4');
    expect(r).toMatchObject({ ok: true, provisional: true, operation: 'allowedip-add', scope: 'vSphereClient' });
    expect(r.revertAt).toBeTruthy();

    const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(r.changeId);
    expect(row.state).toBe('provisional');
    expect(row.platform).toBe('esxi');
    expect(row.revert_at).toBeTruthy();
    expect(row.pre_snapshot_id).toBeTruthy();

    const snap = db.prepare('SELECT * FROM firewall_snapshots WHERE id = ?').get(row.pre_snapshot_id);
    expect(snap.backend).toBe('esxi');
    expect(snap.reason).toBe('pre-platform-apply');

    expect(calls.some(c => c[0] === 'addIp' && c[1] === 'vSphereClient' && c[2] === '5.6.7.8')).toBe(true);
    expect(rs('vSphereClient').allowedIps).toContain('5.6.7.8');
  });

  test('a lockout change (disable sshServer) is refused BEFORE any mutation or snapshot', async () => {
    await expect(pw.applyPlatformRule(host, { operation: 'ruleset-set-enabled', rulesetId: 'sshServer', enabled: false }, { username: 'admin' }, '1.2.3.4'))
      .rejects.toThrow(/locked out/);
    expect(db.prepare('SELECT COUNT(*) c FROM platform_firewall_changes').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM firewall_snapshots').get().c).toBe(0);
    expect(calls.length).toBe(0);
  });

  test('an unknown ruleset is rejected (defence-in-depth) with no mutation', async () => {
    await expect(pw.applyPlatformRule(host, { operation: 'allowedip-add', rulesetId: 'bogus', ipAddress: '5.6.7.8' }, { username: 'admin' }, '1.2.3.4'))
      .rejects.toThrow(/Unknown ESXi ruleset/);
    expect(calls.length).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM platform_firewall_changes').get().c).toBe(0);
  });

  test('a write failure records a failed row and rethrows (snapshot still taken)', async () => {
    vsphereSshWrite.addAllowedIp.mockImplementation(async () => { throw new Error('esxcli exit 1'); });
    await expect(pw.applyPlatformRule(host, { operation: 'allowedip-add', rulesetId: 'dns', ipAddress: '5.6.7.8' }, { username: 'admin' }, '1.2.3.4'))
      .rejects.toThrow(/esxcli exit 1/);
    const row = db.prepare("SELECT * FROM platform_firewall_changes WHERE state='failed'").get();
    expect(row).toBeTruthy();
    expect(row.error).toMatch(/esxcli exit 1/);
    expect(db.prepare('SELECT COUNT(*) c FROM firewall_snapshots').get().c).toBe(1);
  });

  test('confirm clears revert_at and marks confirmed', async () => {
    const r = await pw.applyPlatformRule(host, { operation: 'allowedip-add', rulesetId: 'dns', ipAddress: '5.6.7.8' }, { username: 'admin' }, '1.2.3.4');
    const res = pw.confirmPlatformChange(r.changeId, { username: 'admin' });
    expect(res).toMatchObject({ ok: true, state: 'confirmed' });
    const row = db.prepare('SELECT * FROM platform_firewall_changes WHERE id = ?').get(r.changeId);
    expect(row.state).toBe('confirmed');
    expect(row.revert_at).toBeNull();
  });

  test('revert of allowedip-add removes the IP again', async () => {
    const r = await pw.applyPlatformRule(host, { operation: 'allowedip-add', rulesetId: 'dns', ipAddress: '5.6.7.8' }, { username: 'admin' }, '1.2.3.4');
    expect(rs('dns').allowedIps).toContain('5.6.7.8');
    await pw.revertPlatformChange(r.changeId, { username: 'admin' }, {});
    expect(rs('dns').allowedIps).not.toContain('5.6.7.8');
    expect(db.prepare('SELECT state FROM platform_firewall_changes WHERE id = ?').get(r.changeId).state).toBe('reverted');
  });

  test('revert of allowedip-remove adds the IP back', async () => {
    rs('dns').allowedIps = ['5.6.7.8', '9.9.9.9']; // explicit list on a non-mgmt ruleset
    const r = await pw.applyPlatformRule(host, { operation: 'allowedip-remove', rulesetId: 'dns', ipAddress: '5.6.7.8' }, { username: 'admin' }, '1.2.3.4');
    expect(rs('dns').allowedIps).not.toContain('5.6.7.8');
    await pw.revertPlatformChange(r.changeId, { username: 'admin' }, {});
    expect(rs('dns').allowedIps).toContain('5.6.7.8');
  });

  test('revert of ruleset-set-enabled restores the prior enabled state', async () => {
    // dns starts disabled → we enable it → revert must disable it again.
    const r = await pw.applyPlatformRule(host, { operation: 'ruleset-set-enabled', rulesetId: 'dns', enabled: true }, { username: 'admin' }, '1.2.3.4');
    expect(rs('dns').enabled).toBe(true);
    await pw.revertPlatformChange(r.changeId, { username: 'admin' }, {});
    expect(rs('dns').enabled).toBe(false);
  });

  test('revert of ruleset-set-allowedall restores prior allowed-all + the explicit IP list', async () => {
    rs('dns').allowedIps = ['5.6.7.8']; // prior: restricted (not allowed-all)
    const r = await pw.applyPlatformRule(host, { operation: 'ruleset-set-allowedall', rulesetId: 'dns', allowedAll: true }, { username: 'admin' }, '1.2.3.4');
    expect(isAll(rs('dns'))).toBe(true); // now allowed-all
    await pw.revertPlatformChange(r.changeId, { username: 'admin' }, {});
    expect(isAll(rs('dns'))).toBe(false);
    expect(rs('dns').allowedIps).toContain('5.6.7.8');
  });

  test('sweepExpiredProvisional auto-reverts an overdue ESXi change', async () => {
    const r = await pw.applyPlatformRule(host, { operation: 'allowedip-add', rulesetId: 'dns', ipAddress: '5.6.7.8' }, { username: 'admin' }, '1.2.3.4');
    expect(rs('dns').allowedIps).toContain('5.6.7.8');
    db.prepare("UPDATE platform_firewall_changes SET revert_at = datetime('now','-1 minute') WHERE id = ?").run(r.changeId);

    const swept = await pw.sweepExpiredProvisional();
    expect(swept.reverted).toBe(1);
    expect(rs('dns').allowedIps).not.toContain('5.6.7.8');
    expect(db.prepare('SELECT state FROM platform_firewall_changes WHERE id = ?').get(r.changeId).state).toBe('reverted');
  });

  test('removePlatformRule rejects for vsphere (ESXi has no positional rules)', async () => {
    await expect(pw.removePlatformRule(host, { pos: 0, scope: 'cluster' }, { username: 'admin' }, '1.2.3.4'))
      .rejects.toThrow(/no positional rules/);
  });
});
