'use strict';

const { FEATURE_KEYS } = require('../services/provider-sdk/catalog');
const {
  evidence, completeFeatures, buildEnvelope, validateEnvelope,
} = require('../services/provider-sdk/schema');

const host = { id: 7, name: 'pool-a', daemon_type: 'xen' };

describe('Provider SDK capability schema', () => {
  it('builds a complete, versioned envelope', () => {
    const envelope = buildEnvelope({
      host,
      provider: { type: 'xen', variant: 'xapi', product: 'XCP-ng', version: '8.3' },
      probe: { status: 'reachable', durationMs: 12 },
      features: { 'inventory.vm': evidence('supported', { source: 'live' }) },
    });
    expect(envelope.schemaVersion).toBe('1.0');
    expect(envelope.provider).toEqual(expect.objectContaining({ endpointId: 7, variant: 'xapi' }));
    expect(Object.keys(envelope.features)).toHaveLength(FEATURE_KEYS.length);
    expect(envelope.features['inventory.vm'].state).toBe('supported');
    expect(envelope.features['vm.create']).toEqual(expect.objectContaining({ state: 'unknown', source: 'fallback' }));
    expect(validateEnvelope(envelope)).toBe(true);
  });

  it('rejects unknown keys and invalid states', () => {
    expect(() => completeFeatures({ 'invented.feature': evidence('supported') })).toThrow(/Unknown/);
    expect(() => evidence('maybe')).toThrow(/state/);
    expect(() => evidence('supported', { source: 'marketing' })).toThrow(/source/);
  });

  it('bounds reasons and strips unsafe constraint keys', () => {
    const item = evidence('conditional', {
      reason: `line one\n${'x'.repeat(400)}`,
      constraints: JSON.parse('{"safe":true,"__proto__":{"polluted":true},"values":["a","b"]}'),
    });
    expect(item.reason).not.toContain('\n');
    expect(item.reason.length).toBeLessThanOrEqual(240);
    expect(item.constraints.safe).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(item.constraints, '__proto__')).toBe(false);
  });

  it('rejects malformed envelopes', () => {
    expect(() => validateEnvelope(null)).toThrow(/envelope must be an object/i);
    expect(() => validateEnvelope({ schemaVersion: '0.1' })).toThrow(/schemaVersion/);
  });
});
