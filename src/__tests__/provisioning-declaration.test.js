'use strict';

// v8.15.0 (Onboarding — Phase 1) — declaration validator + secret handling.

process.env.APP_SECRET = 'test-secret-key-for-jest-provisioning';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const {
  validateDeclaration, redactDeclaration, fingerprintDeclaration, revealSecret,
} = require('../services/provisioning/declaration');

const base = () => ({
  version: 1,
  kind: 'onboarding-declaration',
  tenant: { slug: 'acme', name: 'Acme', kind: 'client' },
  mode: 'production',
  modules: [{ key: 'firewall' }],
  hosts: [],
  users: [],
  permissions: [],
});

describe('validateDeclaration', () => {
  it('accepts and normalizes a valid declaration', () => {
    const out = validateDeclaration(base());
    expect(out.version).toBe(1);
    expect(out.kind).toBe('onboarding-declaration');
    expect(out.tenant).toEqual({ slug: 'acme', name: 'Acme', kind: 'client' });
    expect(out.mode).toBe('production');
    expect(out.modules).toEqual([{ key: 'firewall', enabled: true }]);
  });

  it('rejects non-object / wrong version / wrong kind', () => {
    expect(() => validateDeclaration(null)).toThrow(/object/);
    expect(() => validateDeclaration({ version: 2, tenant: { slug: 'a', name: 'A' } })).toThrow(/version/);
    expect(() => validateDeclaration({ version: 1, kind: 'nope', tenant: { slug: 'a', name: 'A' } })).toThrow(/kind/);
  });

  it('REJECTS wire-supplied tenant_id / tenantId / org_id (top-level)', () => {
    expect(() => validateDeclaration({ ...base(), tenant_id: 5 })).toThrow(/tenant_id is not allowed/);
    expect(() => validateDeclaration({ ...base(), tenantId: 5 })).toThrow(/tenantId is not allowed/);
    expect(() => validateDeclaration({ ...base(), org_id: 'x' })).toThrow(/org_id is not allowed/);
  });

  it('REJECTS wire-supplied tenant.id / tenant.tenant_id (nested)', () => {
    expect(() => validateDeclaration({ ...base(), tenant: { slug: 'a', name: 'A', id: 9 } })).toThrow(/tenant\.id/);
    expect(() => validateDeclaration({ ...base(), tenant: { slug: 'a', name: 'A', tenant_id: 9 } })).toThrow(/tenant\.tenant_id/);
  });

  it('rejects a malformed slug (traversal / uppercase / meta chars)', () => {
    for (const slug of ['../etc', 'Acme', 'a', 'has space', "a'b"]) {
      expect(() => validateDeclaration({ ...base(), tenant: { slug, name: 'A' } })).toThrow(/slug/);
    }
  });

  it('rejects unknown tenant.kind and invalid mode', () => {
    expect(() => validateDeclaration({ ...base(), tenant: { slug: 'ok', name: 'A', kind: 'evil' } })).toThrow(/kind/);
    expect(() => validateDeclaration({ ...base(), mode: 'staging' })).toThrow(/mode/);
  });

  it('rejects prototype-pollution keys anywhere', () => {
    const bad = JSON.parse('{"version":1,"tenant":{"slug":"a","name":"A"},"regional":{"__proto__":{"x":1}}}');
    expect(() => validateDeclaration(bad)).toThrow(/forbidden key/);
  });

  it('least-privilege: rejects admin role in demo/trial mode', () => {
    const doc = { ...base(), mode: 'demo', users: [{ username: 'u', role: 'admin', password: 'Str0ng-P@ss!xx' }] };
    expect(() => validateDeclaration(doc)).toThrow(/admin.*not permitted/);
  });

  it('allows admin role in production mode', () => {
    const doc = { ...base(), users: [{ username: 'u', role: 'admin', isOwner: true, password: 'Str0ng-P@ss!xx' }] };
    expect(() => validateDeclaration(doc)).not.toThrow();
  });

  it('rejects more than one is_owner per run', () => {
    const doc = { ...base(), users: [
      { username: 'a', role: 'admin', isOwner: true, password: 'Str0ng-P@ss!xx' },
      { username: 'b', role: 'admin', isOwner: true, password: 'Str0ng-P@ss!yy' },
    ] };
    expect(() => validateDeclaration(doc)).toThrow(/one.*owner/i);
  });

  it('validates roles and permission enums', () => {
    expect(() => validateDeclaration({ ...base(), users: [{ username: 'u', role: 'root', password: 'Str0ng-P@ss!xx' }] })).toThrow(/role/);
    expect(() => validateDeclaration({ ...base(), permissions: [{ username: 'u', hostName: 'h', permission: 'god' }] })).toThrow(/permission/);
  });

  it('rejects duplicate host names and duplicate usernames', () => {
    expect(() => validateDeclaration({ ...base(), hosts: [
      { name: 'h', connectionType: 'tcp', host: '10.0.0.1' },
      { name: 'h', connectionType: 'tcp', host: '10.0.0.2' },
    ] })).toThrow(/duplicate host/);
    expect(() => validateDeclaration({ ...base(), users: [
      { username: 'u', role: 'viewer', password: 'Str0ng-P@ss!xx' },
      { username: 'U', role: 'viewer', password: 'Str0ng-P@ss!yy' },
    ] })).toThrow(/duplicate username/);
  });

  it('enforces per-connection-type required fields', () => {
    expect(() => validateDeclaration({ ...base(), hosts: [{ name: 'h', connectionType: 'tcp' }] })).toThrow(/host address is required/);
    expect(() => validateDeclaration({ ...base(), hosts: [{ name: 'h', connectionType: 'ssh', sshHost: '10.0.0.1' }] })).toThrow(/sshUsername/);
  });

  it('enforces volume caps (too many hosts)', () => {
    const hosts = Array.from({ length: 101 }, (_, i) => ({ name: `h${i}`, connectionType: 'tcp', host: '10.0.0.1' }));
    expect(() => validateDeclaration({ ...base(), hosts })).toThrow(/too many hosts/);
  });

  it('normalizes modules given as strings or {key,enabled}', () => {
    const out = validateDeclaration({ ...base(), modules: ['hosts', { key: 'git', enabled: false }, 'hosts'] });
    expect(out.modules).toEqual([{ key: 'hosts', enabled: true }, { key: 'git', enabled: false }]);
  });

  it('drops unknown regional keys but keeps whitelisted ones + validates unitSystem', () => {
    const out = validateDeclaration({ ...base(), regional: { locale: 'en', evil: 'x', unitSystem: 'metric' } });
    expect(out.regional).toEqual({ locale: 'en', unitSystem: 'metric' });
    expect(() => validateDeclaration({ ...base(), regional: { unitSystem: 'furlongs' } })).toThrow(/unitSystem/);
  });
});

describe('secret handling', () => {
  it('encrypts host + user secrets INLINE ({_enc}), never plaintext', () => {
    const doc = {
      ...base(),
      hosts: [{ name: 'h', connectionType: 'ssh', sshHost: '10.0.0.1', sshUsername: 'root', secret: { sshPrivateKey: 'PLAINTEXT-KEY' } }],
      users: [{ username: 'u', role: 'viewer', password: 'PLAINTEXT-PASS-9!x' }],
    };
    const out = validateDeclaration(doc);
    const json = JSON.stringify(out);
    expect(json).not.toContain('PLAINTEXT-KEY');
    expect(json).not.toContain('PLAINTEXT-PASS-9!x');
    expect(out.hosts[0].secret.sshPrivateKey._enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:/);
    expect(out.users[0].password._enc).toMatch(/^[0-9a-f]+:[0-9a-f]+:/);
  });

  it('revealSecret round-trips the encrypted marker', () => {
    const out = validateDeclaration({ ...base(), users: [{ username: 'u', role: 'viewer', password: 'Round-Trip-9!xx' }] });
    expect(revealSecret(out.users[0].password)).toBe('Round-Trip-9!xx');
    expect(revealSecret(undefined)).toBeUndefined();
  });

  it('redactDeclaration replaces every secret with <redacted> and keeps structure', () => {
    const out = validateDeclaration({
      ...base(),
      hosts: [{ name: 'h', connectionType: 'ssh', sshHost: '10.0.0.1', sshUsername: 'root', secret: { sshPrivateKey: 'SECRET-K' } }],
      users: [{ username: 'u', role: 'viewer', password: 'Secret-Pass9!x' }],
    });
    const red = redactDeclaration(out);
    const json = JSON.stringify(red);
    expect(json).not.toMatch(/SECRET-K|Secret-Pass9/);
    expect(red.hosts[0].secret.sshPrivateKey).toBe('<redacted>');
    expect(red.users[0].password).toBe('<redacted>');
    expect(red.hosts[0].name).toBe('h'); // non-secret fields preserved
  });
});

describe('fingerprintDeclaration', () => {
  it('is stable across re-encryption (secrets excluded) and differs for different logical content', () => {
    const a1 = validateDeclaration({ ...base(), users: [{ username: 'u', role: 'viewer', password: 'AAAA-pass9!xx' }] });
    const a2 = validateDeclaration({ ...base(), users: [{ username: 'u', role: 'viewer', password: 'BBBB-pass9!yy' }] });
    // same logical decl, different secret values (different ciphertext) → same fingerprint
    expect(fingerprintDeclaration(a1)).toBe(fingerprintDeclaration(a2));
    const b = validateDeclaration({ ...base(), tenant: { slug: 'other', name: 'Other' } });
    expect(fingerprintDeclaration(a1)).not.toBe(fingerprintDeclaration(b));
  });
});

// ── nomenclatures block (v8.16.0, Phase 2) ──────────────────────────────────
describe('declaration.nomenclatures', () => {
  it('defaults to an empty array and normalizes sort/meta', () => {
    expect(validateDeclaration(base()).nomenclatures).toEqual([]);
    const out = validateDeclaration({
      ...base(),
      nomenclatures: [
        { kind: 'environment', code: 'dev', label: 'Dev' },
        { kind: 'severity', code: 'sev1', label: 'SEV1', sort: '3', meta: { color: 'red' } },
      ],
    });
    expect(out.nomenclatures[0]).toEqual({ kind: 'environment', code: 'dev', label: 'Dev', sort: 0 });
    expect(out.nomenclatures[1]).toEqual({ kind: 'severity', code: 'sev1', label: 'SEV1', sort: 3, meta: { color: 'red' } });
  });

  it('rejects unknown kinds, bad codes, duplicates, non-arrays and over-cap volumes', () => {
    const withNoms = (nomenclatures) => validateDeclaration({ ...base(), nomenclatures });
    expect(() => withNoms('nope')).toThrow(/must be an array/);
    expect(() => withNoms([{ kind: 'bogus', code: 'a', label: 'A' }])).toThrow(/unknown nomenclature kind/);
    expect(() => withNoms([{ kind: 'environment', code: '../x', label: 'A' }])).toThrow(/invalid characters/);
    expect(() => withNoms([{ kind: 'environment', code: 'dev', label: '' }])).toThrow(/label is required/);
    expect(() => withNoms([{ kind: 'environment', code: 'dev', label: 'A' }, { kind: 'environment', code: 'DEV', label: 'B' }])).toThrow(/duplicate/);
    expect(() => withNoms([{ kind: 'environment', code: 'dev', label: 'A', sort: 'x' }])).toThrow(/must be an integer/);
    expect(() => withNoms(Array.from({ length: 501 }, (_, i) => ({ kind: 'environment', code: `c${i}`, label: 'L' })))).toThrow(/too many nomenclatures/);
  });

  it('folds nomenclatures into the fingerprint', () => {
    const a = validateDeclaration({ ...base(), nomenclatures: [{ kind: 'environment', code: 'dev', label: 'Dev' }] });
    const b = validateDeclaration({ ...base(), nomenclatures: [{ kind: 'environment', code: 'dev', label: 'Development' }] });
    expect(fingerprintDeclaration(a)).not.toBe(fingerprintDeclaration(b));
  });
});
