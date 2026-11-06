'use strict';

const { FEATURE_KEYS } = require('../services/provider-sdk/catalog');
const { supported, adapterNotImplemented } = require('../services/provider-sdk/adapters/helpers');
const manifests = require('../services/provider-conformance/manifests');
const fixtures = require('../services/provider-conformance/fixtures');

describe('Provider conformance contracts and fixtures', () => {
  it('validates every built-in compatibility manifest with a stable hash', () => {
    const list = manifests.listManifests();
    expect(list.map(item => item.providerType)).toEqual(['proxmox', 'vsphere', 'xen']);
    for (const manifest of list) {
      expect(manifests.validateManifest(manifest)).toBe(true);
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(manifests.manifestHash(manifest)).toBe(manifest.manifestHash);
      expect(manifest.owner).toEqual(expect.objectContaining({ service: 'virtualization', team: 'platform' }));
    }
  });

  it('covers all built-in providers and required provider failure modes', () => {
    expect(fixtures.validateCorpus()).toBe(true);
    expect(new Set(fixtures.CORPUS.map(item => item.providerType))).toEqual(new Set(['proxmox', 'vsphere', 'xen']));
    expect(fixtures.REQUIRED_FAULTS).toEqual(['timeout', 'auth_expiry', 'partial_response', 'redirect', 'task_loss']);
    for (const scenario of fixtures.REQUIRED_FAULTS) expect(fixtures.createFakeAdapter(scenario).type).toBe('fake_provider');
  });

  it('runs the reusable static adapter contract without a provider endpoint', async () => {
    jest.resetModules();
    const conformance = require('../services/provider-conformance');
    const features = Object.fromEntries(FEATURE_KEYS.map(key => [key,
      key === 'inventory.vm' ? supported() : adapterNotImplemented('Fixture provider')]));
    const adapter = {
      type: 'proxmox', declared: () => features,
      probe: async () => ({}), listResources: async () => [],
    };
    const checks = await conformance.certifyAdapter(adapter, { declaredFeatures: features });
    expect(checks.every(check => check.state === 'passed')).toBe(true);
    expect(checks.map(check => check.key)).toEqual(expect.arrayContaining([
      'adapter.contract', 'manifest.schema', 'capabilities.catalog',
      'fixtures.corpus', 'fault.taxonomy', 'operation.safety', 'evidence.secret_scan',
    ]));
  });

  it('rejects secret-like fixture data', () => {
    const bad = [{ ...fixtures.CORPUS[0], id: 'bad-fixture', password: 'do-not-store-this' }];
    expect(() => fixtures.validateCorpus(bad)).toThrow(/secret-like/);
  });
});
