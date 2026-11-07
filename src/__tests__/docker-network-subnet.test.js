'use strict';

const { findOverlaps, parseSubnet } = require('../utils/docker-network-subnet');

test('checks contained and containing address pools within the intended network scope', () => {
  const net = (Name, Scope, Subnet) => ({ Name, Scope, IPAM: { Config: [{ Subnet }] } });
  const networks = [
    net('bridge', 'local', '10.20.1.0/24'), net('swarm', 'swarm', '10.20.0.0/16'),
    net('ipv6', 'local', 'fd00:1::/64'), net('unrelated', 'local', '192.168.0.0/24'),
  ];
  expect(findOverlaps(networks, parseSubnet('10.20.0.0/16'), 'local')).toEqual([{ name: 'bridge', subnet: '10.20.1.0/24' }]);
  expect(findOverlaps(networks, parseSubnet('fd00:1::4/126'), 'local')).toEqual([{ name: 'ipv6', subnet: 'fd00:1::/64' }]);
  expect(parseSubnet('10.20.0.0/33')).toBeNull();
  expect(parseSubnet('fd00::/129')).toBeNull();
});
