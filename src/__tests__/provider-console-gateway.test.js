'use strict';

process.env.APP_SECRET = 'provider-console-gateway-test-secret';
process.env.ENCRYPTION_KEY = 'provider-console-gateway-test-key';

const config = require('../config');
const gateway = require('../services/provider-console/gateway');

const internals = gateway._internals;

afterEach(() => {
  internals.reset();
  config.providerConsole.maxActivePerUser = 3;
  config.providerConsole.maxActivePerIp = 5;
});

describe('provider console gateway guards', () => {
  test('reads the one-time token only from a dedicated WebSocket subprotocol', () => {
    const token = 'A'.repeat(43);
    const req = { headers: { 'sec-websocket-protocol': `binary, dd-console.${token}` } };
    expect(internals._protocols(req)).toEqual(['binary', `dd-console.${token}`]);
    expect(internals._launchToken(req)).toBe(token);
  });

  test('requires an explicit same-origin WebSocket origin by default', () => {
    const headers = { host: 'dash.example.test', origin: 'https://dash.example.test' };
    expect(internals._originAllowed({ headers })).toBe(true);
    expect(internals._originAllowed({ headers: { ...headers, origin: 'https://attacker.test' } })).toBe(false);
    expect(internals._originAllowed({ headers: { host: headers.host } })).toBe(false);
  });

  test('enforces active console limits before consuming another token', () => {
    config.providerConsole.maxActivePerUser = 2;
    config.providerConsole.maxActivePerIp = 2;
    internals.active.set('one', { user: { id: 7 }, ip: '10.0.0.1' });
    expect(internals._connectionCapacity(7, '10.0.0.2')).toMatchObject({
      allowed: true, userCount: 1, ipCount: 0,
    });
    internals.active.set('two', { user: { id: 7 }, ip: '10.0.0.1' });
    expect(internals._connectionCapacity(7, '10.0.0.2')).toMatchObject({
      allowed: false, userCount: 2, ipCount: 0,
    });
    expect(internals._connectionCapacity(8, '10.0.0.1')).toMatchObject({
      allowed: false, userCount: 0, ipCount: 2,
    });
  });

  test('emergency termination respects host and VM scope', () => {
    const closed = [];
    const add = (id, hostId, resourceId) => internals.active.set(id, {
      session: { host_id: hostId, resource_id: resourceId },
      ws: { close: code => closed.push([id, code]) },
      finalize: code => closed.push([id, code]),
    });
    add('one', 1, 'ddr_vm_aaa');
    add('two', 1, 'ddr_vm_bbb');
    add('three', 2, 'ddr_vm_aaa');

    expect(gateway.terminateSessions({ hostId: 1, resourceId: 'ddr_vm_aaa' })).toBe(1);
    expect(closed).toEqual([['one', 4003], ['one', 'access_locked']]);
  });
});
