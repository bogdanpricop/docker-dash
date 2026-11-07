'use strict';

const { BlockList, isIP } = require('node:net');

function parseSubnet(value) {
  if (typeof value !== 'string' || value.length > 72) return null;
  const [address, prefix, extra] = value.split('/');
  const version = isIP(address);
  if (!version || extra !== undefined || !/^\d{1,3}$/.test(prefix || '') || address.includes('%')) return null;
  const length = Number(prefix);
  if (length > (version === 4 ? 32 : 128)) return null;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  const range = new BlockList();
  range.addSubnet(address, length, family);
  return { address, version, includes: candidate => isIP(candidate) === version && range.check(candidate, family) };
}

function findOverlaps(networks, subnet, scope) {
  return networks.filter(network => network.Scope === scope).flatMap(network =>
    (network.IPAM?.Config || []).flatMap(({ Subnet }) => {
      const other = parseSubnet(Subnet);
      return other && (subnet.includes(other.address) || other.includes(subnet.address))
        ? [{ name: network.Name, subnet: Subnet }] : [];
    }));
}

module.exports = { parseSubnet, findOverlaps };
