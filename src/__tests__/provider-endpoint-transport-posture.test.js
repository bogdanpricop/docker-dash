'use strict';
jest.mock('../services/provider-sdk/registry', () => ({ capabilitiesForHost: jest.fn() }));
const registry = require('../services/provider-sdk/registry'); const posture = require('../services/provider-sdk/endpoint-transport-posture');
describe('endpoint transport posture', () => { it('uses the existing capability probe only', async () => { registry.capabilitiesForHost.mockResolvedValue({ provider: { type: 'xen', endpointId: 7 }, probe: { status: 'reachable', durationMs: 12 } }); const result = await posture.postureForHost({ id: 7 }); expect(result.state).toBe('observed_reachable'); expect(result.transport.durationMs).toBe(12); expect(registry.capabilitiesForHost).toHaveBeenCalledTimes(1); }); });
