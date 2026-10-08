'use strict';

// Unit tests for src/services/egress-filter.js (v6.7 alpha.1)

process.env.APP_SECRET = 'test-secret-for-egress-filter';
process.env.APP_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'EgressTest123!';
process.env.DD_EGRESS_POLICY_PATH = require('os').tmpdir() + '/dd-egress-test-' + Date.now() + '/policy.json';

const { getDb } = require('../db');
getDb();  // triggers migrations (including 054)

const egressFilter = require('../services/egress-filter');

it('re-enables a removed scope with the new allowlist while preserving policy identity', () => {
  const scope = { scopeType: 'container', scopeKey: 'revocation-recreate', preset: 'custom' };
  const original = egressFilter.createPolicy({ ...scope, customAllowlist: ['old.example.com'] });
  egressFilter.removePolicy(original.policyId);
  expect(egressFilter.getPolicyForScope(scope)).toBeNull();
  const restored = egressFilter.createPolicy({ ...scope, customAllowlist: ['new.example.com'] });
  expect(restored.policyId).toBe(original.policyId);
  expect(egressFilter.getPolicyForScope(scope)).toMatchObject({ active: true, allowlist: ['new.example.com'] });
  egressFilter.removePolicy(restored.policyId);
});

// ─── canApplyFilter ───────────────────────────────────

describe('canApplyFilter', () => {
  const mk = (hc = {}) => ({ HostConfig: { NetworkMode: 'bridge', Privileged: false, CapAdd: [], CapDrop: ['NET_RAW'], ...hc } });

  it('allows a bridge container with NET_RAW explicitly dropped', () => {
    expect(egressFilter.canApplyFilter(mk()).ok).toBe(true);
  });

  it.each([undefined, null, [], ['CHOWN']])('refuses default NET_RAW when CapDrop is %j', CapDrop => {
    const result = egressFilter.canApplyFilter(mk({ CapDrop }));
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('NET_RAW') });
  });
  it.each(['NET_RAW', 'net_raw', 'CAP_NET_RAW'])('refuses explicitly added %s even with ALL dropped', cap => {
    expect(egressFilter.canApplyFilter(mk({ CapDrop: ['ALL'], CapAdd: [cap] })).ok).toBe(false);
  });
  it.each(['ALL', 'all', 'CAP_NET_RAW', 'net_raw'])('accepts explicit drop %s', cap => {
    expect(egressFilter.canApplyFilter(mk({ CapDrop: [cap] })).ok).toBe(true);
  });
  it('permits namespace inspection and removal for legacy default-capability containers', () => {
    expect(egressFilter.canInspectFilter(mk({ CapDrop: [] })).ok).toBe(true);
    expect(egressFilter.canInspectFilter(mk({ CapDrop: [], Privileged: true })).ok).toBe(false);
  });

  it('refuses privileged', () => {
    const r = egressFilter.canApplyFilter(mk({ Privileged: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/privileged/i);
  });

  it('refuses NET_ADMIN', () => {
    const r = egressFilter.canApplyFilter(mk({ CapAdd: ['NET_ADMIN'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/NET_ADMIN/);
  });

  it('refuses SYS_ADMIN', () => {
    const r = egressFilter.canApplyFilter(mk({ CapAdd: ['SYS_ADMIN'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SYS_ADMIN/);
  });

  it.each(['ALL', 'all', 'CAP_NET_ADMIN', 'cap_sys_admin', 'net_admin'])('refuses capability alias %s', cap => {
    expect(egressFilter.canApplyFilter(mk({ CapAdd: [cap] })).ok).toBe(false);
  });

  it('refuses network_mode=host', () => {
    const r = egressFilter.canApplyFilter(mk({ NetworkMode: 'host' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/host/);
  });

  it('refuses network_mode=none (nothing to filter)', () => {
    const r = egressFilter.canApplyFilter(mk({ NetworkMode: 'none' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already has no network access/);
  });

  it('refuses network_mode=container:<id>', () => {
    const r = egressFilter.canApplyFilter(mk({ NetworkMode: 'container:abc' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/namespace/);
  });

  it('allows benign capabilities like SYS_NICE', () => {
    expect(egressFilter.canApplyFilter(mk({ CapAdd: ['SYS_NICE'] })).ok).toBe(true);
  });
});

// ─── listPresets ──────────────────────────────────────

describe('listPresets', () => {
  it('returns the preset catalog with resolved allowlists', () => {
    const presets = egressFilter.listPresets();
    const ids = presets.map(p => p.id);
    expect(ids).toEqual(expect.arrayContaining(['registry-only', 'registries-github', 'lockdown', 'custom', 'audit-only']));
  });

  it('registries-github preset resolves to include both sets', () => {
    const rg = egressFilter.listPresets().find(p => p.id === 'registries-github');
    expect(rg.resolvedAllowlist).toEqual(expect.arrayContaining(['docker.io', 'github.com']));
  });

  it('lockdown preset has empty allowlist', () => {
    const l = egressFilter.listPresets().find(p => p.id === 'lockdown');
    expect(l.resolvedAllowlist).toEqual([]);
  });
});

// ─── Allowlist validation ─────────────────────────────

describe('allowlist validation', () => {
  const { validateAllowlistEntry } = egressFilter._internals;

  it('accepts basic hostname', () => {
    expect(validateAllowlistEntry('registry.npmjs.org')).toBeNull();
  });

  it('accepts wildcard hostname', () => {
    expect(validateAllowlistEntry('*.github.com')).toBeNull();
  });

  it('rejects raw IP', () => {
    expect(validateAllowlistEntry('1.2.3.4')).toMatch(/IP addresses not allowed/);
  });

  it('rejects IMDS endpoint (always-blocked invariant)', () => {
    expect(validateAllowlistEntry('169.254.169.254')).toMatch(/always blocked|IP addresses/);
  });

  it('rejects garbage', () => {
    expect(validateAllowlistEntry('not a hostname!')).toMatch(/Invalid hostname/);
  });

  it('rejects ambiguous wildcards, invalid DNS labels and metadata variants', () => {
    for (const entry of ['*example.com', 'bad-.example.com', 'a..example.com', `${'a'.repeat(64)}.example.com`,
      'METADATA.GOOGLE.INTERNAL.', '169.254.169.254.', 'fd00:ec2::254']) {
      expect(validateAllowlistEntry(entry)).not.toBeNull();
    }
    expect(validateAllowlistEntry('*.Example.COM.')).toBeNull();
  });

  it('rejects single-label names (no dot)', () => {
    expect(validateAllowlistEntry('docker')).toMatch(/Invalid hostname/);
  });
});

// ─── Policy CRUD ──────────────────────────────────────

describe('createPolicy', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM egress_policies').run();
  });

  it('creates a new policy for a container', () => {
    const r = egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'a1b2c3d4e5f6',
      preset: 'registry-only',
    });
    expect(r.updated).toBe(false);
    expect(r.policyId).toBeGreaterThan(0);
    expect(r.mode).toBe('enforce');
    expect(r.allowlist).toEqual(expect.arrayContaining(['docker.io']));
  });

  it('upserts when a policy for the same scope already exists', () => {
    const r1 = egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'a1b2c3d4e5f6',
      preset: 'registry-only',
    });
    const r2 = egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'a1b2c3d4e5f6',
      preset: 'lockdown',
    });
    expect(r2.updated).toBe(true);
    expect(r2.policyId).toBe(r1.policyId);
    expect(r2.allowlist).toEqual([]);  // lockdown
  });

  it('rejects unknown preset', () => {
    expect(() => egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'a1b2c3d4e5f6',
      preset: 'nonesuch',
    })).toThrow(/Unknown preset/);
  });

  it('rejects custom allowlist with invalid entries', () => {
    expect(() => egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'a1b2c3d4e5f6',
      preset: 'custom',
      customAllowlist: ['1.2.3.4'],  // IP not allowed
    })).toThrow(/IP addresses not allowed/);
  });

  it('audit-only preset flips mode to audit-only', () => {
    const r = egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'a1b2c3d4e5f6',
      preset: 'audit-only', mode: 'enforce',  // caller's mode ignored for audit-only preset
    });
    expect(r.mode).toBe('audit-only');
  });

  it('accepts stack scope', () => {
    const r = egressFilter.createPolicy({
      scopeType: 'stack', scopeKey: 'myapp',
      preset: 'registries-github',
    });
    expect(r.allowlist).toEqual(expect.arrayContaining(['docker.io', 'github.com']));
  });
});

describe('listPolicies / getPolicy / removePolicy', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM egress_policies').run();
  });

  it('list returns only active policies', () => {
    egressFilter.createPolicy({ scopeType: 'container', scopeKey: 'aaaaaaaaaaaa', preset: 'registry-only' });
    egressFilter.createPolicy({ scopeType: 'stack', scopeKey: 'app1', preset: 'lockdown' });
    expect(egressFilter.listPolicies()).toHaveLength(2);

    const first = egressFilter.listPolicies()[0];
    egressFilter.removePolicy(first.id, { reason: 'test' });
    expect(egressFilter.listPolicies()).toHaveLength(1);
  });

  it('getPolicy returns null for unknown id', () => {
    expect(egressFilter.getPolicy(999999)).toBeNull();
  });

  it('getPolicyForScope finds by tuple', () => {
    egressFilter.createPolicy({ scopeType: 'container', scopeKey: 'aaaaaaaaaaaa', preset: 'registry-only' });
    const p = egressFilter.getPolicyForScope({ scopeType: 'container', scopeKey: 'aaaaaaaaaaaa' });
    expect(p).toBeTruthy();
    expect(p.preset).toBe('registry-only');
  });
});

describe('updatePolicy', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM egress_policies').run();
  });

  it('changes preset and re-resolves allowlist', () => {
    const { policyId } = egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'aaaaaaaaaaaa', preset: 'registry-only',
    });
    const updated = egressFilter.updatePolicy(policyId, { preset: 'lockdown' });
    expect(updated.preset).toBe('lockdown');
    expect(updated.allowlist).toEqual([]);
  });

  it('can switch mode audit-only ↔ enforce', () => {
    const { policyId } = egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'aaaaaaaaaaaa', preset: 'registry-only',
    });
    expect(egressFilter.updatePolicy(policyId, { mode: 'audit-only' }).mode).toBe('audit-only');
    expect(egressFilter.updatePolicy(policyId, { mode: 'enforce' }).mode).toBe('enforce');
  });

  it('rejects invalid mode changes without modifying the existing policy', () => {
    const { policyId } = egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'aaaaaaaaaaaa', preset: 'registry-only',
    });
    expect(() => egressFilter.updatePolicy(policyId, { mode: 'typo' })).toThrow(/Invalid mode/);
    expect(egressFilter.getPolicy(policyId).mode).toBe('enforce');
  });

  it('throws on unknown policy', () => {
    expect(() => egressFilter.updatePolicy(999999, {})).toThrow(/not found/);
  });
});

// ─── Block log ────────────────────────────────────────

describe('block log', () => {
  let policyId;
  beforeEach(() => {
    getDb().prepare('DELETE FROM egress_block_log').run();
    getDb().prepare('DELETE FROM egress_policies').run();
    policyId = egressFilter.createPolicy({
      scopeType: 'container', scopeKey: 'aaaaaaaaaaaa', preset: 'registry-only',
    }).policyId;
  });

  it('records and returns entries', () => {
    egressFilter.recordBlockedAttempt({ policyId, containerId: 'aaaaaaaaaaaa', hostname: 'evil.com', port: 443, proto: 'tcp', reason: 'not-in-allowlist' });
    egressFilter.recordBlockedAttempt({ policyId, containerId: 'aaaaaaaaaaaa', hostname: 'bad.io', port: 80, proto: 'tcp', reason: 'not-in-allowlist' });

    const log = egressFilter.getBlockLog(policyId);
    expect(log).toHaveLength(2);
    expect(log[0].hostname).toBe('bad.io');  // DESC order
  });

  it('filters by sinceId for incremental polling', () => {
    egressFilter.recordBlockedAttempt({ policyId, containerId: 'a', hostname: 'x.com', port: 443, proto: 'tcp' });
    egressFilter.recordBlockedAttempt({ policyId, containerId: 'a', hostname: 'y.com', port: 443, proto: 'tcp' });
    const first = egressFilter.getBlockLog(policyId);
    egressFilter.recordBlockedAttempt({ policyId, containerId: 'a', hostname: 'z.com', port: 443, proto: 'tcp' });
    const after = egressFilter.getBlockLog(policyId, { sinceId: first[0].id });
    expect(after).toHaveLength(1);
    expect(after[0].hostname).toBe('z.com');
  });

  it('cascades delete when policy is removed', () => {
    egressFilter.recordBlockedAttempt({ policyId, containerId: 'a', hostname: 'x.com', port: 443, proto: 'tcp' });
    expect(egressFilter.getBlockLog(policyId)).toHaveLength(1);

    // Hard-delete the policy to trigger FK cascade (removePolicy is soft-delete which doesn't cascade)
    getDb().prepare('DELETE FROM egress_policies WHERE id = ?').run(policyId);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM egress_block_log WHERE policy_id = ?').get(policyId).n).toBe(0);
  });

  it('rejects incomplete records', () => {
    expect(() => egressFilter.recordBlockedAttempt({ policyId })).toThrow(/missing required/);
  });

  it('groups by hostname with count + last_seen (v6.9.1)', () => {
    egressFilter.recordBlockedAttempt({ policyId, containerId: '', hostname: 'evil.com', port: 443, proto: 'tcp' });
    egressFilter.recordBlockedAttempt({ policyId, containerId: '', hostname: 'evil.com', port: 80, proto: 'tcp' });
    egressFilter.recordBlockedAttempt({ policyId, containerId: '', hostname: 'evil.com', port: 443, proto: 'tcp' });
    egressFilter.recordBlockedAttempt({ policyId, containerId: '', hostname: 'bad.io', port: 443, proto: 'tcp' });

    const groups = egressFilter.getBlockLogGrouped(policyId, { sinceHours: 24, limit: 50 });
    expect(groups).toHaveLength(2);
    // Sorted by count DESC
    expect(groups[0].hostname).toBe('evil.com');
    expect(groups[0].count).toBe(3);
    expect(groups[0].ports).toMatch(/443/);
    expect(groups[0].ports).toMatch(/80/);
    expect(groups[1].hostname).toBe('bad.io');
    expect(groups[1].count).toBe(1);
  });

  it('prunes old entries', () => {
    egressFilter.recordBlockedAttempt({ policyId, containerId: 'a', hostname: 'x.com', port: 443, proto: 'tcp' });
    getDb().prepare(`UPDATE egress_block_log SET blocked_at = datetime('now', '-40 days') WHERE id = (SELECT MIN(id) FROM egress_block_log)`).run();
    egressFilter.recordBlockedAttempt({ policyId, containerId: 'a', hostname: 'y.com', port: 443, proto: 'tcp' });
    egressFilter.pruneOldBlockLog({ keepDays: 30 });
    const log = egressFilter.getBlockLog(policyId);
    expect(log).toHaveLength(1);
    expect(log[0].hostname).toBe('y.com');
  });
});

// ─── Quick-action: allowHostnameOnPolicy (v6.9.1) ─────

describe('allowHostnameOnPolicy', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM egress_policies').run();
  });

  it('adds a hostname to a custom policy and persists', () => {
    const { policyId } = egressFilter.createPolicy({
      scopeType: 'stack', scopeKey: 's1', preset: 'custom',
      customAllowlist: ['docker.io'],
    });
    const r = egressFilter.allowHostnameOnPolicy(policyId, 'registry.npmjs.org');
    expect(r.added).toBe(true);
    expect(r.policy.allowlist).toEqual(expect.arrayContaining(['docker.io', 'registry.npmjs.org']));
  });

  it('switches preset to "custom" when adding to a preset-based policy', () => {
    const { policyId } = egressFilter.createPolicy({
      scopeType: 'stack', scopeKey: 's1', preset: 'registry-only',
    });
    const r = egressFilter.allowHostnameOnPolicy(policyId, 'example.com');
    expect(r.added).toBe(true);
    expect(r.policy.preset).toBe('custom');
    expect(r.policy.allowlist).toEqual(expect.arrayContaining(['docker.io', 'example.com']));
  });

  it('idempotent: adding an already-listed hostname is a no-op', () => {
    const { policyId } = egressFilter.createPolicy({
      scopeType: 'stack', scopeKey: 's1', preset: 'custom',
      customAllowlist: ['docker.io'],
    });
    const r = egressFilter.allowHostnameOnPolicy(policyId, 'docker.io');
    expect(r.added).toBe(false);
    expect(r.reason).toBe('already-in-allowlist');
  });

  it('rejects invalid hostnames', () => {
    const { policyId } = egressFilter.createPolicy({
      scopeType: 'stack', scopeKey: 's1', preset: 'custom', customAllowlist: [],
    });
    expect(() => egressFilter.allowHostnameOnPolicy(policyId, '1.2.3.4')).toThrow(/IP addresses/);
    expect(() => egressFilter.allowHostnameOnPolicy(policyId, '169.254.169.254')).toThrow(/always blocked|IP/);
    expect(() => egressFilter.allowHostnameOnPolicy(policyId, 'not a host!')).toThrow(/Invalid hostname/);
  });

  it('rejects unknown policy id', () => {
    expect(() => egressFilter.allowHostnameOnPolicy(999999, 'docker.io')).toThrow(/not found/);
  });

  it('requires hostname', () => {
    const { policyId } = egressFilter.createPolicy({
      scopeType: 'stack', scopeKey: 's1', preset: 'custom', customAllowlist: [],
    });
    expect(() => egressFilter.allowHostnameOnPolicy(policyId, '')).toThrow(/hostname required/);
  });
});

// ─── Sidecar policy.json writer (v6.7.0-alpha.2) ───────

describe('writePolicyFile + _buildAggregatePolicy', () => {
  const fs = require('fs');

  beforeEach(() => {
    getDb().prepare('DELETE FROM egress_policies').run();
    try { fs.unlinkSync(process.env.DD_EGRESS_POLICY_PATH); } catch {}
  });

  it('aggregates no policies → empty allowlist, enforce mode, version 0', () => {
    const p = egressFilter._internals._buildAggregatePolicy();
    expect(p.version).toBe(0);
    expect(p.mode).toBe('enforce');
    expect(p.allowlist).toEqual([]);
  });

  it('requires source authorization even for one policy', () => {
    egressFilter.createPolicy({ scopeType: 'stack', scopeKey: 's1', preset: 'registry-only' });
    const p = egressFilter._internals._buildAggregatePolicy();
    expect(p.mode).toBe('enforce');
    expect(p.schema_version).toBe(2);
    expect(p.allowlist).toEqual([]);
  });

  it('never exports an allowlist union for unrelated stacks', () => {
    egressFilter.createPolicy({ scopeType: 'stack', scopeKey: 's1', preset: 'registry-only', mode: 'enforce' });
    egressFilter.createPolicy({ scopeType: 'stack', scopeKey: 's2', preset: 'audit-only' });  // audit-only preset forces mode
    const p = egressFilter._internals._buildAggregatePolicy();
    expect(p.mode).toBe('enforce');
    expect(p.schema_version).toBe(2);
    expect(p.allowlist).toEqual([]);
  });

  it('does not turn unmatched sources into audit-only when all policies are audit-only', () => {
    egressFilter.createPolicy({ scopeType: 'stack', scopeKey: 's1', preset: 'audit-only' });
    egressFilter.createPolicy({ scopeType: 'stack', scopeKey: 's2', preset: 'audit-only' });
    const p = egressFilter._internals._buildAggregatePolicy();
    expect(p.mode).toBe('enforce');
    expect(p.schema_version).toBe(2);
    expect(p.allowlist).toEqual([]);
  });

  it('writes policy.json atomically and calls onPolicyWritten', () => {
    const spy = jest.fn();
    egressFilter.setOnPolicyWritten(spy);

    egressFilter.createPolicy({ scopeType: 'stack', scopeKey: 's1', preset: 'lockdown' });

    const onDisk = JSON.parse(fs.readFileSync(process.env.DD_EGRESS_POLICY_PATH, 'utf8'));
    expect(onDisk.mode).toBe('enforce');
    expect(onDisk.allowlist).toEqual([]);
    expect(spy).toHaveBeenCalled();
    egressFilter.setOnPolicyWritten(null);
  });

  it('rewrites after update + remove', () => {
    const { policyId } = egressFilter.createPolicy({ scopeType: 'stack', scopeKey: 's1', preset: 'lockdown' });
    egressFilter.updatePolicy(policyId, { preset: 'registry-only' });
    let onDisk = JSON.parse(fs.readFileSync(process.env.DD_EGRESS_POLICY_PATH, 'utf8'));
    expect(onDisk.schema_version).toBe(2);
    expect(onDisk.allowlist).toEqual([]);

    egressFilter.removePolicy(policyId);
    onDisk = JSON.parse(fs.readFileSync(process.env.DD_EGRESS_POLICY_PATH, 'utf8'));
    expect(onDisk.allowlist).toEqual([]);
  });
});
