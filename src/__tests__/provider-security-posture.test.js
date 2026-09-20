'use strict';
jest.mock('../services/provider-sdk/registry', () => ({ capabilitiesForHost: jest.fn() }));
const registry = require('../services/provider-sdk/registry'); const posture = require('../services/provider-sdk/security-posture');
describe('provider security posture', () => {
  it('summarizes declared capability states without a scan', async () => {
    registry.capabilitiesForHost.mockResolvedValue({ provider: { type: 'xen', endpointId: 7 }, observedAt: '2026-07-29T00:00:00.000Z', features: { 'a.read': { state: 'supported', readOnly: true }, 'a.mutate': { state: 'conditional' }, 'b.read': { state: 'unsupported' } } });
    const result = await posture.postureForHost({ id: 7 });
    expect(result.coverage).toEqual({ declaredFeatureCount: 3, states: { supported: 1, conditional: 1, unsupported: 1, unknown: 0 }, readOnly: 1 });
    expect(result.safeguards).toEqual({ declaredPrivilegedFeatureCount: 0, approvalRequired: 0, typedConfirmation: 0, revalidation: 0, postVerification: 0, durableTasks: 0 });
    expect(result.recovery.declaredFeatureCount).toBe(0);
    expect(result.consoleExposure.state).toBe('unknown');
    expect(result.limitations.join(' ')).toContain('not a security scan');
  });
});
