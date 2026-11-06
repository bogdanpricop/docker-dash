'use strict';

const net = require('net');
const crypto = require('crypto');
const YAML = require('yaml');

const SAFE_HOST_LABEL = /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const SAFE_DOMAIN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SAFE_TIMEZONE = /^(?=.{1,64}$)[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/;
const SAFE_USER = /^(?=.{1,32}$)[a-z_][a-z0-9_-]*$/;
const SAFE_INTERFACE = /^(?=.{1,32}$)[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SSH_KEY = /^(ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,3})(?: ([^\r\n]{1,256}))?$/;

class GuestCustomizationError extends Error {
  constructor(message, code = 'INVALID_GUEST_CUSTOMIZATION') {
    super(message); this.name = 'GuestCustomizationError'; this.code = code; this.status = 400;
  }
}

function _assertKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new GuestCustomizationError(`${field} contains unsupported field: ${unknown[0]}`);
}

function _text(value, max) {
  if (value === undefined || value === null || value === '') return null;
  const output = String(value).trim();
  if (!output || output.length > max || /[\u0000-\u001f\u007f]/.test(output)) {
    throw new GuestCustomizationError(`Guest customization value must contain 1-${max} printable characters`);
  }
  return output;
}

function _domain(value, field = 'domain') {
  const output = _text(value, 253);
  if (output && !SAFE_DOMAIN.test(output)) throw new GuestCustomizationError(`${field} must be a valid DNS name`);
  return output ? output.toLowerCase() : null;
}

function _array(value, max, field) {
  if (value === undefined || value === null || value === '') return [];
  const rows = Array.isArray(value) ? value : String(value).split(/[\r\n,]+/);
  const output = [...new Set(rows.map(item => String(item).trim()).filter(Boolean))];
  if (output.length > max) throw new GuestCustomizationError(`${field} accepts at most ${max} values`);
  return output;
}

function _sshKeys(value) {
  return _array(value, 10, 'sshAuthorizedKeys').map(key => {
    if (key.length > 4096) throw new GuestCustomizationError('An SSH public key exceeds 4096 characters');
    const match = SSH_KEY.exec(key);
    if (!match) throw new GuestCustomizationError('Only valid ssh-ed25519, ssh-rsa and ECDSA public keys are accepted');
    let decoded;
    try { decoded = Buffer.from(match[2], 'base64'); } catch { decoded = null; }
    const canonical = decoded?.toString('base64').replace(/=+$/, '') === match[2].replace(/=+$/, '');
    const algorithmLength = decoded?.length >= 4 ? decoded.readUInt32BE(0) : 0;
    const embeddedAlgorithm = algorithmLength > 0 && algorithmLength <= 64 && 4 + algorithmLength <= (decoded?.length || 0)
      ? decoded.subarray(4, 4 + algorithmLength).toString('ascii') : '';
    if (!decoded || !canonical || decoded.length < 32 || decoded.length > 4096 || embeddedAlgorithm !== match[1]) {
      throw new GuestCustomizationError('SSH public key payload is invalid');
    }
    return key;
  });
}

function _network(value) {
  const input = value === undefined || value === null ? {} : value;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GuestCustomizationError('network must be an object');
  }
  _assertKeys(input, new Set(['mode', 'interfaceName', 'address', 'gateway', 'dnsServers', 'searchDomains']), 'network');
  const mode = String(input.mode || 'dhcp').toLowerCase();
  if (!['dhcp', 'static'].includes(mode)) throw new GuestCustomizationError('network.mode must be dhcp or static');
  const interfaceName = _text(input.interfaceName || 'eth0', 32);
  if (!SAFE_INTERFACE.test(interfaceName)) throw new GuestCustomizationError('network.interfaceName is invalid');
  const dnsServers = _array(input.dnsServers, 3, 'network.dnsServers');
  if (dnsServers.some(address => net.isIP(address) === 0)) {
    throw new GuestCustomizationError('network.dnsServers must contain valid IP addresses');
  }
  const searchDomains = _array(input.searchDomains, 6, 'network.searchDomains').map(value => _domain(value, 'network.searchDomains'));
  let address = null; let gateway = null;
  if (mode === 'static') {
    const rawAddress = _text(input.address, 64);
    const match = /^([^/]+)\/(\d{1,3})$/.exec(rawAddress || '');
    if (!match || net.isIP(match[1]) !== 4 || Number(match[2]) < 1 || Number(match[2]) > 32) {
      throw new GuestCustomizationError('Static IPv4 address must use CIDR notation, for example 192.0.2.10/24');
    }
    gateway = _text(input.gateway, 64);
    if (net.isIP(gateway || '') !== 4) throw new GuestCustomizationError('Static IPv4 gateway is required');
    address = `${match[1]}/${Number(match[2])}`;
  }
  return { mode, interfaceName, address, gateway, dnsServers, searchDomains };
}

function normalize(value, options = {}) {
  if (value === undefined || value === null || value === false) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GuestCustomizationError('customization must be an object');
  }
  _assertKeys(value, new Set([
    'schemaVersion', 'osFamily', 'hostname', 'domain', 'timezone', 'user', 'sshAuthorizedKeys', 'network',
  ]), 'customization');
  if (value.schemaVersion !== undefined && value.schemaVersion !== '1.0') {
    throw new GuestCustomizationError('customization.schemaVersion must be 1.0');
  }
  const osFamily = String(value.osFamily || 'linux').toLowerCase();
  if (osFamily !== 'linux') {
    throw new GuestCustomizationError('This release accepts only Linux guest customization; Windows Sysprep profiles are a separate gated slice', 'GUEST_OS_CUSTOMIZATION_UNAVAILABLE');
  }
  const hostname = _text(value.hostname || options.vmName, 63);
  if (!hostname || !SAFE_HOST_LABEL.test(hostname)) {
    throw new GuestCustomizationError('customization.hostname must be a valid 1-63 character DNS host label');
  }
  const domain = _domain(value.domain);
  const timezone = _text(value.timezone, 64);
  if (timezone && !SAFE_TIMEZONE.test(timezone)) throw new GuestCustomizationError('customization.timezone must be an IANA-style timezone');
  const user = _text(value.user, 32);
  if (user && !SAFE_USER.test(user)) throw new GuestCustomizationError('customization.user must be a portable Linux account name');
  const sshAuthorizedKeys = _sshKeys(value.sshAuthorizedKeys);
  return {
    schemaVersion: '1.0', osFamily, hostname: hostname.toLowerCase(), domain,
    timezone, user, sshAuthorizedKeys, network: _network(value.network),
  };
}

function _fingerprint(key) {
  const payload = SSH_KEY.exec(key)?.[2] || '';
  return `SHA256:${crypto.createHash('sha256').update(Buffer.from(payload, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

function summary(customization) {
  if (!customization) return { enabled: false };
  return {
    enabled: true, schemaVersion: customization.schemaVersion, osFamily: customization.osFamily,
    hostname: customization.hostname, domain: customization.domain, timezone: customization.timezone,
    user: customization.user, sshKeyCount: customization.sshAuthorizedKeys.length,
    sshKeyFingerprints: customization.sshAuthorizedKeys.map(_fingerprint),
    network: { ...customization.network },
  };
}

function renderCloudConfig(customization) {
  if (!customization) return null;
  const config = {
    preserve_hostname: false,
    hostname: customization.hostname,
    ...(customization.domain ? { fqdn: `${customization.hostname}.${customization.domain}`, manage_etc_hosts: true } : {}),
    ...(customization.timezone ? { timezone: customization.timezone } : {}),
    disable_root: true,
    ssh_pwauth: false,
  };
  if (customization.user) {
    config.users = ['default', {
      name: customization.user, lock_passwd: true, sudo: 'ALL=(ALL) NOPASSWD:ALL',
      ...(customization.sshAuthorizedKeys.length ? { ssh_authorized_keys: customization.sshAuthorizedKeys } : {}),
    }];
  } else if (customization.sshAuthorizedKeys.length) {
    config.ssh_authorized_keys = customization.sshAuthorizedKeys;
  }
  return `#cloud-config\n${YAML.stringify(config, { lineWidth: 0 })}`;
}

function renderNetworkConfig(customization) {
  if (!customization) return null;
  const network = customization.network;
  const adapter = network.mode === 'dhcp'
    ? { dhcp4: true, dhcp6: false }
    : { dhcp4: false, dhcp6: false, addresses: [network.address], routes: [{ to: '0.0.0.0/0', via: network.gateway }] };
  if (network.dnsServers.length || network.searchDomains.length) {
    adapter.nameservers = {
      ...(network.dnsServers.length ? { addresses: network.dnsServers } : {}),
      ...(network.searchDomains.length ? { search: network.searchDomains } : {}),
    };
  }
  return YAML.stringify({ version: 2, ethernets: { [network.interfaceName]: adapter } }, { lineWidth: 0 });
}

function prefixToNetmask(prefix) {
  const bits = Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new GuestCustomizationError('Invalid IPv4 prefix');
  const value = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

module.exports = {
  GuestCustomizationError, normalize, summary, renderCloudConfig, renderNetworkConfig, prefixToNetmask,
  _internals: { _assertKeys, _text, _domain, _array, _sshKeys, _network, _fingerprint },
};
