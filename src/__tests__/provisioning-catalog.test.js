'use strict';

// v8.15.0 (Onboarding — Phase 1) — module catalog + dependency resolution.

process.env.APP_SECRET = 'test-secret-key-for-jest-provisioning';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const catalog = require('../services/provisioning/catalog');

describe('module catalog', () => {
  it('lists the Phase-1 modules with labels + requires', () => {
    const keys = catalog.listModules().map((m) => m.key);
    for (const k of ['hosts', 'firewall', 'posture', 'reconciler', 'copilot', 'registries', 'git', 'teams']) {
      expect(keys).toContain(k);
    }
    const firewall = catalog.listModules().find((m) => m.key === 'firewall');
    expect(firewall.requires).toEqual(['hosts']);
    expect(typeof firewall.label).toBe('string');
  });

  it('listModules returns copies (mutating a result does not corrupt the catalog)', () => {
    const first = catalog.listModules();
    first[0].requires.push('bogus');
    const second = catalog.listModules();
    expect(second[0].requires).not.toContain('bogus');
  });

  it('validateModuleKey accepts known and rejects unknown keys', () => {
    expect(catalog.validateModuleKey('firewall')).toBe('firewall');
    expect(() => catalog.validateModuleKey('nope')).toThrow(/unknown module key/);
    expect(() => catalog.validateModuleKey(123)).toThrow(/unknown module key/);
  });

  it('resolveDependencies closes the dependency graph (firewall -> hosts)', () => {
    const closure = catalog.resolveDependencies(['firewall']);
    expect(closure).toContain('firewall');
    expect(closure).toContain('hosts');
  });

  it('resolveDependencies de-dupes and returns catalog order', () => {
    const closure = catalog.resolveDependencies(['firewall', 'posture', 'firewall']);
    // catalog order: hosts before firewall before posture
    expect(closure).toEqual(['hosts', 'firewall', 'posture']);
    expect(new Set(closure).size).toBe(closure.length);
  });

  it('resolveDependencies throws on an unknown key and rejects non-arrays', () => {
    expect(() => catalog.resolveDependencies(['firewall', 'bogus'])).toThrow(/unknown module key/);
    expect(() => catalog.resolveDependencies('firewall')).toThrow(/array/);
  });

  it('modules with no deps resolve to just themselves', () => {
    expect(catalog.resolveDependencies(['git', 'registries'])).toEqual(['registries', 'git']);
  });
});
