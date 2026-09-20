'use strict';

const crypto = require('crypto');
const net = require('net');
const { getDb } = require('../db');

const MAX_NETWORKS = 200;
const MAX_RESERVED_CIDRS = 500;
const MAX_TOTAL_CIDRS = 1000;
const MAX_FINDINGS = 2000;
const KEY = /^[a-zA-Z][a-zA-Z0-9_.:/@+-]{0,199}$/;
const FORBIDDEN = /password|credential|private.?key|authorization|cookie|secret.?value|access.?token/i;

class NetworkIntentValidationError extends Error {
  constructor(message, code = 'NETWORK_INTENT_ERROR', status = 400) {
    super(message);
    this.name = 'NetworkIntentValidationError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code = 'NETWORK_INTENT_ERROR', status = 400) {
  throw new NetworkIntentValidationError(message, code, status);
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
function exact(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is invalid`, 'INVALID_INPUT');
  const unexpected = Object.keys(value).filter(name => !allowed.includes(name));
  if (unexpected.length) {
    const secret = unexpected.find(name => FORBIDDEN.test(name));
    fail(secret ? `${field}.${secret} may not contain secret material`
      : `Unexpected ${field} fields: ${unexpected.join(', ')}`, secret ? 'SECRET_FIELD' : 'UNEXPECTED_FIELD');
  }
  return value;
}
function text(value, field, max = 200) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) fail(`${field} is invalid`, 'INVALID_INPUT');
  return result;
}
function key(value, field) {
  const result = text(value, field);
  if (!KEY.test(result)) fail(`${field} is invalid`, 'INVALID_INPUT');
  return result;
}
function integer(value, field, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${field} is invalid`, 'INVALID_INPUT');
  return result;
}
function bool(value, field) {
  if (typeof value !== 'boolean') fail(`${field} is invalid`, 'INVALID_INPUT');
  return value;
}
function array(value, field, max, mapper) {
  if (!Array.isArray(value) || value.length > max) fail(`${field} is invalid`, 'INVALID_INPUT');
  return value.map((item, index) => mapper(item, index));
}
function unique(values, field) {
  if (new Set(values).size !== values.length) fail(`${field} contains duplicates`, 'DUPLICATE_VALUE');
  return values;
}
function instant(value, field) {
  const result = text(value, field, 40);
  if (!Number.isFinite(Date.parse(result))) fail(`${field} is invalid`, 'INVALID_INPUT');
  return new Date(result).toISOString();
}

function ipv4Value(address) {
  return address.split('.').reduce((result, part) => (result << 8n) + BigInt(Number(part)), 0n);
}
function ipv6Groups(address) {
  let source = address.toLowerCase();
  if (source.includes('.')) {
    const lastColon = source.lastIndexOf(':');
    const value = ipv4Value(source.slice(lastColon + 1));
    source = `${source.slice(0, lastColon)}:${Number((value >> 16n) & 0xffffn).toString(16)}:${Number(value & 0xffffn).toString(16)}`;
  }
  const halves = source.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array(zeros).fill('0'), ...right].map(part => Number.parseInt(part || '0', 16));
}
function ipValue(address) {
  const family = net.isIP(address);
  if (!family) fail('IP address is invalid', 'INVALID_IP');
  const bits = family === 4 ? 32 : 128;
  const value = family === 4 ? ipv4Value(address)
    : ipv6Groups(address).reduce((result, group) => (result << 16n) + BigInt(group), 0n);
  return { family, bits, value };
}
function formatIp(value, family) {
  if (family === 4) return [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n)).join('.');
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn));
  let bestStart = -1; let bestLength = 0;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== 0) { start += 1; continue; }
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - start > bestLength) { bestStart = start; bestLength = end - start; }
    start = end;
  }
  if (bestLength < 2) return groups.map(group => group.toString(16)).join(':');
  const left = groups.slice(0, bestStart).map(group => group.toString(16)).join(':');
  const right = groups.slice(bestStart + bestLength).map(group => group.toString(16)).join(':');
  return `${left}::${right}`;
}
function parseCidr(input, field) {
  const value = text(input, field, 90);
  const parts = value.split('/');
  if (parts.length !== 2) fail(`${field} is invalid`, 'INVALID_CIDR');
  const address = ipValue(parts[0]);
  const prefix = Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) fail(`${field} is invalid`, 'INVALID_CIDR');
  const hostBits = address.bits - prefix;
  const start = (address.value >> BigInt(hostBits)) << BigInt(hostBits);
  const size = 1n << BigInt(hostBits);
  return { family: address.family, prefix, start, end: start + size - 1n,
    canonical: `${formatIp(start, address.family)}/${prefix}`, hostBitsSet: start !== address.value };
}
function parseIp(input, field) {
  const source = text(input, field, 80);
  const parsed = ipValue(source);
  return { ...parsed, canonical: formatIp(parsed.value, parsed.family) };
}
function contains(range, address) {
  return range.family === address.family && address.value >= range.start && address.value <= range.end;
}
function overlaps(left, right) {
  return left.family === right.family && left.start <= right.end && right.start <= left.end;
}
function unsafeDns(address) {
  if (address.value === 0n) return true;
  if (address.family === 4) return address.value === 0xffffffffn || (address.value >> 28n) === 0xen;
  return (address.value >> 120n) === 0xffn;
}

function normalizeIntent(body) {
  exact(body, 'networkIntent', ['scopeKey', 'intentVersion', 'inventoryComplete', 'requirements', 'networks', 'reservedCidrs']);
  exact(body.requirements, 'requirements', ['requireGateway', 'requireDns', 'requireVlan', 'requireVni']);
  const requirements = { requireGateway: bool(body.requirements.requireGateway, 'requirements.requireGateway'),
    requireDns: bool(body.requirements.requireDns, 'requirements.requireDns'),
    requireVlan: bool(body.requirements.requireVlan, 'requirements.requireVlan'),
    requireVni: bool(body.requirements.requireVni, 'requirements.requireVni') };
  let cidrCount = 0;
  const networks = array(body.networks, 'networks', MAX_NETWORKS, (item, index) => {
    const field = `networks[${index}]`;
    exact(item, field, ['networkKey', 'fabricKey', 'l2DomainKey', 'cidrs', 'gateways', 'dnsServers', 'vlanId', 'vni', 'routes', 'evidence']);
    exact(item.evidence, `${field}.evidence`, ['source', 'observedAt', 'complete', 'fresh']);
    const cidrs = array(item.cidrs || [], `${field}.cidrs`, 16, (entry, cidrIndex) => {
      cidrCount += 1; return parseCidr(entry, `${field}.cidrs[${cidrIndex}]`);
    });
    unique(cidrs.map(entry => entry.canonical), `${field}.cidrs`);
    const gateways = unique(array(item.gateways || [], `${field}.gateways`, 8,
      (entry, gatewayIndex) => parseIp(entry, `${field}.gateways[${gatewayIndex}]`).canonical), `${field}.gateways`)
      .map(entry => parseIp(entry, `${field}.gateways`));
    const dnsServers = unique(array(item.dnsServers || [], `${field}.dnsServers`, 16,
      (entry, dnsIndex) => parseIp(entry, `${field}.dnsServers[${dnsIndex}]`).canonical), `${field}.dnsServers`)
      .map(entry => parseIp(entry, `${field}.dnsServers`));
    const routes = array(item.routes || [], `${field}.routes`, 64, (route, routeIndex) => {
      exact(route, `${field}.routes[${routeIndex}]`, ['destination', 'nextHop', 'metric']);
      return { destination: parseCidr(route.destination, `${field}.routes[${routeIndex}].destination`),
        nextHop: parseIp(route.nextHop, `${field}.routes[${routeIndex}].nextHop`),
        metric: integer(route.metric, `${field}.routes[${routeIndex}].metric`, 0, 65535) };
    });
    return { networkKey: key(item.networkKey, `${field}.networkKey`), fabricKey: key(item.fabricKey, `${field}.fabricKey`),
      l2DomainKey: key(item.l2DomainKey, `${field}.l2DomainKey`), cidrs, gateways, dnsServers,
      vlanId: item.vlanId === null || item.vlanId === undefined ? null : integer(item.vlanId, `${field}.vlanId`, 1, 4094),
      vni: item.vni === null || item.vni === undefined ? null : integer(item.vni, `${field}.vni`, 1, 16777215),
      routes, evidence: { source: key(item.evidence.source, `${field}.evidence.source`),
        observedAt: instant(item.evidence.observedAt, `${field}.evidence.observedAt`),
        complete: bool(item.evidence.complete, `${field}.evidence.complete`), fresh: bool(item.evidence.fresh, `${field}.evidence.fresh`) } };
  });
  unique(networks.map(item => item.networkKey), 'networks.networkKey');
  const reservedCidrs = array(body.reservedCidrs || [], 'reservedCidrs', MAX_RESERVED_CIDRS, (item, index) => {
    exact(item, `reservedCidrs[${index}]`, ['cidr', 'ownerKey', 'purpose']);
    cidrCount += 1;
    return { range: parseCidr(item.cidr, `reservedCidrs[${index}].cidr`), ownerKey: key(item.ownerKey, 'reservedCidr.ownerKey'),
      purpose: text(item.purpose, 'reservedCidr.purpose', 200) };
  });
  if (cidrCount > MAX_TOTAL_CIDRS) fail(`Network intent exceeds ${MAX_TOTAL_CIDRS} total CIDRs`, 'INTENT_TOO_LARGE', 413);
  return { scopeKey: key(body.scopeKey, 'scopeKey'), intentVersion: text(body.intentVersion, 'intentVersion', 120),
    inventoryComplete: bool(body.inventoryComplete, 'inventoryComplete'), requirements, networks, reservedCidrs };
}

function validateNormalized(value) {
  const findings = [];
  let findingCount = 0;
  const add = (code, severity, resourceKeys, field, message) => {
    findingCount += 1;
    if (findings.length < MAX_FINDINGS) findings.push({ code, severity, resourceKeys: [...new Set(resourceKeys)].slice(0, 4), field, message });
  };
  if (!value.inventoryComplete) add('INVENTORY_INCOMPLETE', 'unknown', [value.scopeKey], 'inventoryComplete', 'Cross-resource inventory is incomplete.');
  if (!value.networks.length) add('NETWORK_REQUIRED', 'fail', [value.scopeKey], 'networks', 'At least one network is required.');
  const vlanOwners = new Map(); const vniOwners = new Map(); const gatewayOwners = new Map();
  const allRanges = [];
  for (const network of value.networks) {
    if (!network.evidence.complete) add('EVIDENCE_INCOMPLETE', 'unknown', [network.networkKey], 'evidence.complete', 'Network evidence is incomplete.');
    if (!network.evidence.fresh) add('EVIDENCE_STALE', 'unknown', [network.networkKey], 'evidence.fresh', 'Network evidence is stale.');
    if (!network.cidrs.length) add('CIDR_REQUIRED', 'fail', [network.networkKey], 'cidrs', 'At least one network CIDR is required.');
    if (value.requirements.requireGateway && !network.gateways.length) add('GATEWAY_REQUIRED', 'fail', [network.networkKey], 'gateways', 'A gateway is required.');
    if (value.requirements.requireDns && !network.dnsServers.length) add('DNS_REQUIRED', 'fail', [network.networkKey], 'dnsServers', 'At least one DNS server is required.');
    if (value.requirements.requireVlan && network.vlanId === null) add('VLAN_REQUIRED', 'fail', [network.networkKey], 'vlanId', 'A VLAN ID is required.');
    if (value.requirements.requireVni && network.vni === null) add('VNI_REQUIRED', 'fail', [network.networkKey], 'vni', 'A VNI is required.');
    for (const range of network.cidrs) {
      if (range.hostBitsSet) add('CIDR_HOST_BITS_SET', 'fail', [network.networkKey], 'cidrs', `CIDR must use canonical network boundary ${range.canonical}.`);
      allRanges.push({ ...range, resourceKey: network.networkKey, ownerKey: network.networkKey, kind: 'network' });
    }
    for (const gateway of network.gateways) {
      const local = network.cidrs.find(range => contains(range, gateway));
      if (!local) add('GATEWAY_OUTSIDE_CIDR', 'fail', [network.networkKey], 'gateways', `Gateway ${gateway.canonical} is outside declared CIDRs.`);
      else if (gateway.family === 4 && local.prefix <= 30 && (gateway.value === local.start || gateway.value === local.end)) {
        add('GATEWAY_UNUSABLE_ADDRESS', 'fail', [network.networkKey], 'gateways', `Gateway ${gateway.canonical} is a network or broadcast address.`);
      }
      const owner = gatewayOwners.get(`${gateway.family}:${gateway.value}`);
      if (owner && owner !== network.networkKey) add('GATEWAY_DUPLICATE', 'fail', [owner, network.networkKey], 'gateways', `Gateway ${gateway.canonical} is assigned to multiple networks.`);
      gatewayOwners.set(`${gateway.family}:${gateway.value}`, network.networkKey);
    }
    for (const server of network.dnsServers) if (unsafeDns(server)) add('DNS_ADDRESS_UNSAFE', 'fail', [network.networkKey], 'dnsServers', `DNS server ${server.canonical} is not a usable unicast address.`);
    const routes = new Map();
    for (const route of network.routes) {
      if (route.destination.hostBitsSet) add('ROUTE_DESTINATION_HOST_BITS_SET', 'fail', [network.networkKey], 'routes', `Route destination must use ${route.destination.canonical}.`);
      if (!network.cidrs.some(range => contains(range, route.nextHop))) add('ROUTE_NEXT_HOP_OFFLINK', 'fail', [network.networkKey], 'routes', `Route next hop ${route.nextHop.canonical} is not on-link.`);
      const routeKey = `${route.destination.family}:${route.destination.start}/${route.destination.prefix}`;
      const previous = routes.get(routeKey);
      if (previous) add(previous.nextHop.value === route.nextHop.value && previous.metric === route.metric ? 'ROUTE_DUPLICATE' : 'ROUTE_CONFLICT',
        'fail', [network.networkKey], 'routes', `Route destination ${route.destination.canonical} is declared more than once.`);
      routes.set(routeKey, route);
    }
    if (network.vlanId !== null) {
      const id = `${network.l2DomainKey}:${network.vlanId}`; const owner = vlanOwners.get(id);
      if (owner && owner !== network.networkKey) add('VLAN_COLLISION', 'fail', [owner, network.networkKey], 'vlanId', `VLAN ${network.vlanId} is reused in L2 domain ${network.l2DomainKey}.`);
      vlanOwners.set(id, network.networkKey);
    }
    if (network.vni !== null) {
      const id = `${network.fabricKey}:${network.vni}`; const owner = vniOwners.get(id);
      if (owner && owner !== network.networkKey) add('VNI_COLLISION', 'fail', [owner, network.networkKey], 'vni', `VNI ${network.vni} is reused in fabric ${network.fabricKey}.`);
      vniOwners.set(id, network.networkKey);
    }
  }
  for (const reserved of value.reservedCidrs) {
    if (reserved.range.hostBitsSet) add('RESERVED_CIDR_HOST_BITS_SET', 'fail', [reserved.ownerKey], 'reservedCidrs', `Reserved CIDR must use ${reserved.range.canonical}.`);
    allRanges.push({ ...reserved.range, resourceKey: reserved.ownerKey, ownerKey: reserved.ownerKey, kind: 'reserved' });
  }
  const ordered = allRanges.sort((left, right) => left.family - right.family
    || (left.start < right.start ? -1 : left.start > right.start ? 1 : left.end > right.end ? -1 : 1));
  const active = [];
  for (const current of ordered) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].family !== current.family || active[index].end < current.start) active.splice(index, 1);
    }
    for (const previous of active) {
      if (!overlaps(previous, current) || previous.ownerKey === current.ownerKey) continue;
      const code = previous.kind === 'reserved' || current.kind === 'reserved' ? 'RESERVED_CIDR_CONFLICT' : 'CIDR_OVERLAP';
      add(code, 'fail', [previous.resourceKey, current.resourceKey], 'cidrs', `${previous.canonical} overlaps ${current.canonical}.`);
      if (findings.length >= MAX_FINDINGS) break;
    }
    active.push(current);
  }
  const failed = findings.filter(item => item.severity === 'fail').length;
  const unknown = findings.filter(item => item.severity === 'unknown').length;
  const verdict = failed ? 'fail' : unknown ? 'unknown' : 'pass';
  return { findings, verdict, summary: { networks: value.networks.length, cidrs: value.networks.reduce((sum, item) => sum + item.cidrs.length, 0),
    reservedCidrs: value.reservedCidrs.length, failed, unknown, totalFindings: findingCount, findingsTruncated: findingCount > findings.length } };
}

function publicIntent(value) {
  return { scopeKey: value.scopeKey, intentVersion: value.intentVersion, inventoryComplete: value.inventoryComplete,
    requirements: value.requirements, networks: value.networks.map(network => ({
      networkKey: network.networkKey, fabricKey: network.fabricKey, l2DomainKey: network.l2DomainKey,
      cidrs: network.cidrs.map(item => item.canonical), gateways: network.gateways.map(item => item.canonical),
      dnsServers: network.dnsServers.map(item => item.canonical), vlanId: network.vlanId, vni: network.vni,
      routes: network.routes.map(route => ({ destination: route.destination.canonical, nextHop: route.nextHop.canonical, metric: route.metric })),
      evidence: network.evidence,
    })), reservedCidrs: value.reservedCidrs.map(item => ({ cidr: item.range.canonical, ownerKey: item.ownerKey, purpose: item.purpose })) };
}

class NetworkIntentValidator {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) fail('Authentication required', 'AUTHENTICATION_REQUIRED', 401);
    if (actor.role !== 'admin' && !actor.roles?.includes('admin')) fail('Administrator required', 'ADMIN_REQUIRED', 403);
  }
  validate(body, actor) {
    this._admin(actor);
    const normalized = normalizeIntent(body);
    const intent = publicIntent(normalized);
    const validation = validateNormalized(normalized);
    const intentHash = digest(intent);
    const validationHash = digest({ intentHash, findings: validation.findings, verdict: validation.verdict });
    const db = this._db();
    const existing = db.prepare('SELECT id FROM network_intent_validations WHERE validation_hash=?').get(validationHash);
    const id = existing?.id || Number(db.prepare(`INSERT INTO network_intent_validations
      (scope_key,intent_version,intent_json,findings_json,summary_json,verdict,intent_hash,validation_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(intent.scopeKey, intent.intentVersion, stable(intent), stable(validation.findings),
      stable(validation.summary), validation.verdict, intentHash, validationHash, actor.id).lastInsertRowid);
    return { id, duplicate: Boolean(existing), ...intent, findings: validation.findings, summary: validation.summary,
      verdict: validation.verdict, intentHash, validationHash, providerMutationsStarted: 0, networkCallsStarted: 0,
      executeEndpoint: null, executorGate: { acceptableVerdict: 'pass', requiredIntentHash: intentHash,
        requiredValidationHash: validationHash } };
  }
}

const service = new NetworkIntentValidator();
module.exports = service;
module.exports.NetworkIntentValidator = NetworkIntentValidator;
module.exports.NetworkIntentValidationError = NetworkIntentValidationError;
module.exports._internals = { ipValue, formatIp, parseIp, parseCidr, contains, overlaps, unsafeDns,
  normalizeIntent, validateNormalized, publicIntent, CONTROL_LIMITS: { MAX_NETWORKS, MAX_RESERVED_CIDRS, MAX_TOTAL_CIDRS, MAX_FINDINGS } };
