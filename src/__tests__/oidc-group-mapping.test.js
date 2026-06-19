'use strict';

// v8.7.6 — OIDC group → role resolver (issue #11, Entra ID / any OIDC IdP).
// Pure function; pin the precedence + matching semantics.

process.env.APP_SECRET = 'test-oidc-group';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const { _resolveRoleFromGroups } = require('../routes/auth');

const ADMIN_GUID = '11111111-1111-1111-1111-111111111111';
const OP_GUID = '22222222-2222-2222-2222-222222222222';
const VIEW_GUID = '33333333-3333-3333-3333-333333333333';

const cfg = {
  groupClaim: 'groups',
  adminGroups: [ADMIN_GUID, 'DockerDashAdmins'],
  operatorGroups: [OP_GUID, 'DockerDashOperators'],
  viewerGroups: [VIEW_GUID, 'DockerDashViewers'],
};

describe('_resolveRoleFromGroups', () => {
  it('returns null when no group lists are configured (mapping disabled)', () => {
    expect(_resolveRoleFromGroups({ groups: ['anything'] }, { adminGroups: [], operatorGroups: [], viewerGroups: [] })).toBeNull();
  });

  it('returns null when group lists exist but user is in none of them', () => {
    expect(_resolveRoleFromGroups({ groups: ['Other'] }, cfg)).toBeNull();
  });

  it('matches by Entra group GUID (case-insensitive)', () => {
    expect(_resolveRoleFromGroups({ groups: [ADMIN_GUID.toUpperCase()] }, cfg)).toBe('admin');
  });

  it('matches by display name (case-insensitive)', () => {
    expect(_resolveRoleFromGroups({ groups: ['dockerdashadmins'] }, cfg)).toBe('admin');
  });

  it('admin wins over operator and viewer when user is in multiple groups', () => {
    expect(_resolveRoleFromGroups({ groups: ['DockerDashViewers', 'DockerDashAdmins', 'DockerDashOperators'] }, cfg)).toBe('admin');
  });

  it('operator wins over viewer', () => {
    expect(_resolveRoleFromGroups({ groups: ['DockerDashViewers', 'DockerDashOperators'] }, cfg)).toBe('operator');
  });

  it('viewer when only viewer group matches', () => {
    expect(_resolveRoleFromGroups({ groups: ['DockerDashViewers'] }, cfg)).toBe('viewer');
  });

  it('reads from the configured custom claim name (e.g. "roles")', () => {
    const custom = { ...cfg, groupClaim: 'roles' };
    expect(_resolveRoleFromGroups({ roles: ['DockerDashAdmins'], groups: ['x'] }, custom)).toBe('admin');
  });

  it('handles a non-array claim value (single string) by wrapping it', () => {
    expect(_resolveRoleFromGroups({ groups: 'DockerDashOperators' }, cfg)).toBe('operator');
  });

  it('handles missing claims object gracefully', () => {
    expect(_resolveRoleFromGroups({}, cfg)).toBeNull();
    expect(_resolveRoleFromGroups(null, cfg)).toBeNull();
  });

  it('handles missing config gracefully (defensive)', () => {
    expect(_resolveRoleFromGroups({ groups: ['x'] }, null)).toBeNull();
  });

  it('still resolves when only one of the three lists is configured', () => {
    const adminOnly = { groupClaim: 'groups', adminGroups: ['DockerDashAdmins'], operatorGroups: [], viewerGroups: [] };
    expect(_resolveRoleFromGroups({ groups: ['DockerDashAdmins'] }, adminOnly)).toBe('admin');
    expect(_resolveRoleFromGroups({ groups: ['Other'] }, adminOnly)).toBeNull();
  });
});

// v8.7.8 (security fix) — the helper that prevents silent admin demotion
// when the IdP returns no groups claim. Distinguishes "IdP didn't tell us"
// from "user has groups, just not the ones we care about".
const { _hasUsableGroupsClaim } = require('../routes/auth');

describe('_hasUsableGroupsClaim — the demotion guard', () => {
  const cfg = { groupClaim: 'groups', adminGroups: ['A'], operatorGroups: [], viewerGroups: [] };

  it('true when the array claim is present and non-empty', () => {
    expect(_hasUsableGroupsClaim({ groups: ['anything'] }, cfg)).toBe(true);
  });
  it('false when the claim is entirely absent (the bug case — Entra Token config regression / scope strip)', () => {
    expect(_hasUsableGroupsClaim({ sub: 'x' }, cfg)).toBe(false);
  });
  it('false when the claim is an empty array', () => {
    expect(_hasUsableGroupsClaim({ groups: [] }, cfg)).toBe(false);
  });
  it('false on Entra "groups overage" indicator (>200 groups → Graph lookup required)', () => {
    expect(_hasUsableGroupsClaim({
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/...' } },
    }, cfg)).toBe(false);
  });
  it('respects a custom claim name (Entra app-roles via OIDC_GROUP_CLAIM=roles)', () => {
    const c = { ...cfg, groupClaim: 'roles' };
    expect(_hasUsableGroupsClaim({ roles: ['admin'] }, c)).toBe(true);
    expect(_hasUsableGroupsClaim({ groups: ['admin'] }, c)).toBe(false);
  });
  it('handles a single-string claim value (some IdPs emit one-of-many as a bare string)', () => {
    expect(_hasUsableGroupsClaim({ groups: 'A' }, cfg)).toBe(true);
    expect(_hasUsableGroupsClaim({ groups: '' }, cfg)).toBe(false);
  });
  it('defensive against null inputs', () => {
    expect(_hasUsableGroupsClaim(null, cfg)).toBe(false);
    expect(_hasUsableGroupsClaim({}, null)).toBe(false);
  });
});
