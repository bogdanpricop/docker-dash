'use strict';

const crypto = require('crypto');
const net = require('net');
const { getDb } = require('../db');

const KEY = /^[A-Za-z][A-Za-z0-9_.:/@+-]{0,199}$/;
const HOST = /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/;
const HASH = /^[a-f0-9]{64}$/;
const SECRET = /password|credential|private.?key|authorization|cookie|secret.?value|access.?token/i;
const MAX_SOURCE_ROWS = 100;
const MAX_FLOW_ENTRIES = 50000;

class NetworkReachabilityError extends Error {
  constructor(message, code = 'NETWORK_REACHABILITY_ERROR', status = 400, details = null) {
    super(message); this.name = 'NetworkReachabilityError'; this.code = code; this.status = status; this.details = details;
  }
}

function fail(message, code = 'INVALID_NETWORK_REACHABILITY_INPUT', status = 400, details = null) {
  throw new NetworkReachabilityError(message, code, status, details);
}
function exact(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is invalid`);
  const unexpected = Object.keys(value).filter(name => !allowed.includes(name));
  if (unexpected.length) {
    const secret = unexpected.find(name => SECRET.test(name));
    fail(secret ? `${field}.${secret} may not contain secret material`
      : `Unexpected ${field} fields: ${unexpected.join(', ')}`, secret ? 'SECRET_FIELD' : 'UNEXPECTED_FIELD');
  }
}
function text(value, field, max) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) fail(`${field} is invalid`);
  return result;
}
function key(value, field) { const result = text(value, field, 200); if (!KEY.test(result)) fail(`${field} is invalid`); return result; }
function optionalKey(value, field) { return value == null ? null : key(value, field); }
function address(value, field) { const result = text(value, field, 80); if (!net.isIP(result)) fail(`${field} is invalid`); return result; }
function instant(value, field) {
  const result = text(value, field, 40); const parsed = Date.parse(result);
  if (!Number.isFinite(parsed)) fail(`${field} is invalid`); return new Date(parsed).toISOString();
}
function integer(value, field, min, max, fallback) {
  const result = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${field} is invalid`);
  return result;
}
function choice(value, field, values) { const result = String(value || ''); if (!values.includes(result)) fail(`${field} is invalid`); return result; }
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value; }
function stable(value) { return JSON.stringify(canonical(value)); }
function hash(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex'); }
function tableExists(database, name) { return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }

function endpoint(value, field, allowHostname = false) {
  exact(value, field, allowHostname
    ? ['resourceKey', 'address', 'hostname', 'networkKey'] : ['resourceKey', 'address', 'networkKey']);
  const result = {
    resourceKey: key(value.resourceKey, `${field}.resourceKey`),
    address: value.address == null ? null : address(value.address, `${field}.address`),
    networkKey: optionalKey(value.networkKey, `${field}.networkKey`),
  };
  if (allowHostname) {
    result.hostname = value.hostname == null ? null : (() => {
      const hostname = text(value.hostname, `${field}.hostname`, 253).toLowerCase().replace(/\.$/, '');
      if (!HOST.test(hostname)) fail(`${field}.hostname is invalid`); return hostname;
    })();
    if (Boolean(result.address) === Boolean(result.hostname)) fail('destination requires exactly one address or hostname');
  } else if (!result.address) fail('source.address is required');
  return result;
}

function signal(value, field, states, observedAt, cutoff) {
  exact(value, field, ['state', 'source', 'evidenceHash', 'observedAt']);
  const rawState = choice(value.state, `${field}.state`, states);
  const timestamp = instant(value.observedAt, `${field}.observedAt`);
  const evidenceHash = String(value.evidenceHash || '').toLowerCase();
  if (!HASH.test(evidenceHash)) fail(`${field}.evidenceHash is invalid`);
  if (Date.parse(timestamp) > Date.parse(observedAt)) fail(`${field}.observedAt cannot be in the future`);
  const fresh = Date.parse(timestamp) >= Date.parse(cutoff);
  return {
    rawState, state: fresh ? rawState : 'unknown', source: key(value.source, `${field}.source`),
    evidenceHash, observedAt: timestamp, freshness: fresh ? 'fresh' : 'stale',
  };
}

function dnsEvidence(database, destination, observedAt) {
  if (destination.address) return {
    state: 'pass', addresses: [destination.address], sourceRows: [],
    reason: 'Destination is an explicit IP address',
  };
  if (!tableExists(database, 'network_dependency_dns_observations')) return {
    state: 'unknown', addresses: [], sourceRows: [], reason: 'No normalized DNS evidence table is available',
  };
  const rows = database.prepare(`SELECT id,observed_at,records_json FROM network_dependency_dns_observations
    WHERE datetime(observed_at)<=datetime(?) AND datetime(expires_at)>datetime(?)
    ORDER BY observed_at DESC,id DESC LIMIT ?`).all(observedAt, observedAt, MAX_SOURCE_ROWS);
  const matches = [];
  for (const row of rows) {
    for (const record of parse(row.records_json, [])) {
      if (record.fqdn !== destination.hostname || !['A', 'AAAA'].includes(record.type)
        || !net.isIP(record.address)) continue;
      matches.push({ address: record.address, resourceKey: record.resourceKey || null,
        observationId: Number(row.id), observedAt: row.observed_at });
    }
  }
  const addresses = [...new Set(matches.map(item => item.address))].sort();
  const conflicts = destination.resourceKey
    ? matches.filter(item => item.resourceKey && item.resourceKey !== destination.resourceKey) : [];
  if (conflicts.length && !matches.some(item => item.resourceKey === destination.resourceKey)) return {
    state: 'fail', addresses, sourceRows: [...new Set(matches.map(item => item.observationId))],
    reason: 'DNS evidence maps the hostname to a different canonical resource',
  };
  return addresses.length ? {
    state: 'pass', addresses, sourceRows: [...new Set(matches.map(item => item.observationId))],
    reason: 'Current normalized DNS evidence resolved the hostname',
  } : { state: 'unknown', addresses: [], sourceRows: rows.map(row => Number(row.id)),
    reason: 'No current normalized DNS evidence resolves the hostname' };
}

function flowEvidence(database, request, destinationAddresses, cutoff) {
  const empty = { state: 'not_observed', matched: 0, allowed: 0, denied: 0, lastAction: null,
    lastObservedAt: null, ruleKeys: [], batchIds: [], truncated: false };
  if (!destinationAddresses.length || !tableExists(database, 'network_flow_log_batches')) return empty;
  const rows = database.prepare(`SELECT id,observed_at,entries_json FROM network_flow_log_batches
    WHERE datetime(observed_at)>=datetime(?) AND datetime(observed_at)<=datetime(?)
      AND datetime(retention_until)>datetime(?) ORDER BY observed_at DESC,id DESC LIMIT ?`)
    .all(cutoff, request.observedAt, request.observedAt, MAX_SOURCE_ROWS);
  const destinations = new Set(destinationAddresses); const matches = []; let inspected = 0; let truncated = false;
  outer: for (const row of rows) {
    for (const entry of parse(row.entries_json, [])) {
      if (inspected >= MAX_FLOW_ENTRIES) { truncated = true; break outer; }
      inspected += 1;
      if (entry.sourceAddress !== request.source.address || !destinations.has(entry.destinationAddress)
        || entry.protocol !== request.protocol || Number(entry.destinationPort) !== request.destinationPort) continue;
      const occurredAt = Date.parse(entry.occurredAt);
      if (!Number.isFinite(occurredAt) || occurredAt < Date.parse(cutoff) || occurredAt > Date.parse(request.observedAt)) continue;
      matches.push({ action: entry.action, occurredAt: new Date(occurredAt).toISOString(),
        ruleKey: entry.ruleKey || null, batchId: Number(row.id) });
    }
  }
  matches.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.batchId - a.batchId);
  if (!matches.length) return { ...empty, batchIds: rows.map(row => Number(row.id)), truncated };
  const allowed = matches.filter(item => item.action === 'allow').length;
  const denied = matches.length - allowed;
  return {
    state: matches[0].action === 'allow' ? 'observed_allowed' : 'observed_denied',
    matched: matches.length, allowed, denied, lastAction: matches[0].action,
    lastObservedAt: matches[0].occurredAt,
    ruleKeys: [...new Set(matches.map(item => item.ruleKey).filter(Boolean))].sort().slice(0, 50),
    batchIds: [...new Set(matches.map(item => item.batchId))].sort((a, b) => a - b), truncated,
  };
}

function verdict(signals, dns) {
  const failures = [];
  if (signals.route.state === 'fail') failures.push('route_unreachable');
  if (signals.policy.state === 'deny') failures.push('policy_denied');
  if (signals.attachment.state === 'absent') failures.push('source_attachment_absent');
  if (signals.providerSimulation.state === 'deny') failures.push('provider_simulation_denied');
  if (dns.state === 'fail') failures.push('dns_identity_mismatch');
  if (failures.length) return { verdict: 'fail', interpretation: 'predicted_blocked', confidence: 'high', failures };
  const endpointReady = signals.attachment.state === 'present' && dns.state === 'pass';
  const modeledAllow = signals.providerSimulation.state === 'allow'
    || (signals.route.state === 'pass' && signals.policy.state === 'allow');
  if (endpointReady && modeledAllow) return {
    verdict: 'pass', interpretation: 'predicted_reachable',
    confidence: signals.providerSimulation.state === 'allow' ? 'high' : 'medium', failures: [],
  };
  return { verdict: 'unknown', interpretation: 'insufficient_evidence', confidence: 'low', failures: [] };
}

function publicAssessment(row) {
  return {
    id: Number(row.id), scopeKey: row.scope_key, mode: row.mode, protocol: row.protocol,
    destinationPort: Number(row.destination_port), source: parse(row.source_json, {}),
    destination: parse(row.destination_json, {}), evidence: parse(row.evidence_json, {}),
    summary: parse(row.summary_json, {}), verdict: row.verdict,
    assessmentHash: row.assessment_hash, networkCallsStarted: 0,
    providerMutationsStarted: 0, createdAt: row.created_at,
  };
}

class NetworkReachabilityService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db(options = {}) { return options.database || this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) fail('Authentication required', 'AUTH_REQUIRED', 401);
    if (actor.role !== 'admin') fail('Administrator required', 'ADMIN_REQUIRED', 403);
  }
  assess(body = {}, actor, options = {}) {
    this._admin(actor);
    exact(body, 'reachabilityAssessment', ['scopeKey', 'mode', 'observedAt', 'freshnessMinutes',
      'source', 'destination', 'protocol', 'destinationPort', 'evidence']);
    const scopeKey = key(body.scopeKey, 'scopeKey');
    const mode = choice(body.mode, 'mode', ['simulation']);
    const observedAt = instant(body.observedAt, 'observedAt');
    const freshnessMinutes = integer(body.freshnessMinutes, 'freshnessMinutes', 1, 10080, 60);
    const cutoff = new Date(Date.parse(observedAt) - freshnessMinutes * 60000).toISOString();
    const source = endpoint(body.source, 'source', false);
    const destination = endpoint(body.destination, 'destination', true);
    const protocol = choice(body.protocol, 'protocol', ['tcp', 'udp', 'icmp', 'icmpv6']);
    const destinationPort = integer(body.destinationPort, 'destinationPort', 0, 65535);
    if (['tcp', 'udp'].includes(protocol) && destinationPort === 0) fail('TCP/UDP destinationPort must be 1-65535');
    if (['icmp', 'icmpv6'].includes(protocol) && destinationPort !== 0) fail('ICMP destinationPort must be 0');
    if (protocol === 'icmp' && net.isIP(source.address) !== 4) fail('ICMP requires an IPv4 source');
    if (protocol === 'icmpv6' && net.isIP(source.address) !== 6) fail('ICMPv6 requires an IPv6 source');
    exact(body.evidence, 'evidence', ['route', 'policy', 'attachment', 'providerSimulation']);
    const signals = {
      route: signal(body.evidence.route, 'evidence.route', ['pass', 'fail', 'unknown'], observedAt, cutoff),
      policy: signal(body.evidence.policy, 'evidence.policy', ['allow', 'deny', 'unknown'], observedAt, cutoff),
      attachment: signal(body.evidence.attachment, 'evidence.attachment', ['present', 'absent', 'unknown'], observedAt, cutoff),
      providerSimulation: signal(body.evidence.providerSimulation, 'evidence.providerSimulation',
        ['allow', 'deny', 'unknown', 'not_available'], observedAt, cutoff),
    };
    if (signals.providerSimulation.state === 'not_available') signals.providerSimulation.state = 'unknown';
    const database = this._db(options);
    const dns = dnsEvidence(database, destination, observedAt);
    if (destination.address && net.isIP(source.address) !== net.isIP(destination.address)) {
      dns.state = 'fail'; dns.reason = 'Source and literal destination address families differ';
    }
    const outcome = verdict(signals, dns);
    const flow = flowEvidence(database, { source, protocol, destinationPort, observedAt }, dns.addresses, cutoff);
    const summary = {
      ...outcome, observedAt, freshnessMinutes,
      freshSignals: Object.values(signals).filter(item => item.freshness === 'fresh').length,
      staleSignals: Object.values(signals).filter(item => item.freshness === 'stale').length,
      dnsState: dns.state, flowState: flow.state,
      activeProbe: {
        state: 'not_run', supported: false,
        reason: 'Active probes require an approved allowlisted runner, source ownership and destination policy',
      },
      limitations: [
        'Pass means predicted reachability from normalized control-plane evidence, not a data-plane connectivity proof.',
        'Historical flow evidence is corroboration only and never upgrades unknown simulation evidence to pass.',
      ],
    };
    const evidence = { signals, dns, flow, sourceCutoffAt: cutoff };
    const assessmentHash = hash({ scopeKey, mode, observedAt, freshnessMinutes, source, destination,
      protocol, destinationPort, evidence, verdict: outcome.verdict });
    const found = database.prepare('SELECT id FROM network_reachability_assessments WHERE assessment_hash=?').get(assessmentHash);
    const id = found?.id || Number(database.prepare(`INSERT INTO network_reachability_assessments
      (scope_key,mode,protocol,destination_port,source_json,destination_json,evidence_json,summary_json,verdict,assessment_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(scopeKey, mode, protocol, destinationPort, stable(source), stable(destination),
      stable(evidence), stable(summary), outcome.verdict, assessmentHash, actor.id).lastInsertRowid);
    return {
      id, scopeKey, mode, source, destination, protocol, destinationPort, evidence, summary,
      verdict: outcome.verdict, assessmentHash, duplicate: !!found,
      networkCallsStarted: 0, providerMutationsStarted: 0, executeEndpoint: null,
    };
  }
  overview(options = {}) {
    const database = this._db(options);
    if (!tableExists(database, 'network_reachability_assessments')) return { count: 0, assessments: [] };
    const assessments = database.prepare('SELECT * FROM network_reachability_assessments ORDER BY id DESC LIMIT 50')
      .all().map(publicAssessment);
    return { count: Number(database.prepare('SELECT COUNT(*) count FROM network_reachability_assessments').get().count),
      assessments };
  }
}

module.exports = new NetworkReachabilityService();
module.exports.NetworkReachabilityService = NetworkReachabilityService;
module.exports.NetworkReachabilityError = NetworkReachabilityError;
module.exports._internals = {
  exact, endpoint, signal, dnsEvidence, flowEvidence, verdict, stable, hash, publicAssessment,
};
