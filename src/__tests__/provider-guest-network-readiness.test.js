'use strict';
const { assess } = require('../services/provider-sdk/guest-network-readiness');
describe('guest network readiness', () => { it('does not claim readiness without an observed address', () => { expect(assess({ id: 'v', displayName: 'vm' }, { nics: [{ attachment: { connected: true }, addresses: [] }] }).state).toBe('unknown'); expect(assess({ id: 'v', displayName: 'vm' }, { nics: [{ attachment: { connected: false }, addresses: [{ address: '10.0.0.1' }] }] }).state).toBe('not_ready'); }); });
