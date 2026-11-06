'use strict';

const crypto = require('crypto');
const net = require('net');
const { getDb } = require('../db');

const KEY = /^[A-Za-z][A-Za-z0-9_.:/@+-]{0,199}$/;
const HOST = /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/;
const SECRET = /password|credential|private.?key|authorization|cookie|secret.?value|access.?token/i;
const MAX_NODES = 5000;
const MAX_SOURCE_ROWS = 100;
const MAX_SOURCE_ENTRIES = 50000;
const MAX_BYTES = 2 * 1024 * 1024;

class NetworkDependencyMapError extends Error {
  constructor(message, code = 'NETWORK_DEPENDENCY_MAP_ERROR', status = 400, details = null) {
    super(message); this.name = 'NetworkDependencyMapError'; this.code = code; this.status = status; this.details = details;
  }
}

function fail(message, code = 'INVALID_NETWORK_DEPENDENCY_INPUT', status = 400, details = null) {
  throw new NetworkDependencyMapError(message, code, status, details);
}
function exact(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is invalid`);
  const unexpected = Object.keys(value).filter(name => !allowed.includes(name));
  if (unexpected.length) {
    const secret = unexpected.find(name => SECRET.test(name));
    fail(secret ? `${field}.${secret} may not contain secret material` : `Unexpected ${field} fields: ${unexpected.join(', ')}`,
      secret ? 'SECRET_FIELD' : 'UNEXPECTED_FIELD');
  }
}
function text(value, field, max = 300) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) fail(`${field} is invalid`);
  return result;
}
function key(value, field) { const result = text(value, field, 200); if (!KEY.test(result)) fail(`${field} is invalid`); return result; }
function integer(value, field, min, max, fallback) {
  const result = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${field} is invalid`);
  return result;
}
function instant(value, field) {
  const result = text(value, field, 40); const parsed = Date.parse(result);
  if (!Number.isFinite(parsed)) fail(`${field} is invalid`);
  return new Date(parsed).toISOString();
}
function normalizedInstant(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function address(value, field) { const result = text(value, field, 80); if (!net.isIP(result)) fail(`${field} is invalid`); return result; }
function fqdn(value, field) {
  const result = text(value, field, 253).toLowerCase().replace(/\.$/, '');
  if (!HOST.test(result)) fail(`${field} is invalid`); return result;
}
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value; }
function stable(value) { return JSON.stringify(canonical(value)); }
function hash(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex'); }
function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function publicSnapshot(row) {
  if (!row) return null;
  return { schemaVersion: '1.0', id: Number(row.id), scopeKey: row.scope_key, builtAt: row.built_at,
    freshnessCutoffAt: row.freshness_cutoff_at, parameters: parse(row.parameters_json, {}),
    nodes: parse(row.nodes_json, []), edges: parse(row.edges_json, []), summary: parse(row.summary_json, {}),
    sourceCursor: parse(row.source_cursor_json, {}), snapshotHash: row.snapshot_hash,
    providerMutationsStarted: 0, networkCallsStarted: 0, createdAt: row.created_at };
}

class NetworkDependencyMapService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db(options = {}) { return options.database || this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) fail('Authentication required', 'AUTH_REQUIRED', 401);
    if (actor.role !== 'admin') fail('Administrator required', 'ADMIN_REQUIRED', 403);
  }
  recordAddressObservation(body = {}, actor, options = {}) {
    this._admin(actor); exact(body, 'addressObservation', ['source', 'providerHostId', 'observedAt', 'coverage', 'addresses']);
    const source = key(body.source, 'source'); const providerHostId = body.providerHostId == null ? null
      : integer(body.providerHostId, 'providerHostId', 1, Number.MAX_SAFE_INTEGER);
    const observedAt = instant(body.observedAt, 'observedAt'); exact(body.coverage, 'coverage', ['complete', 'reason']);
    if (typeof body.coverage.complete !== 'boolean') fail('coverage.complete is invalid');
    const coverage = { complete: body.coverage.complete, reason: text(body.coverage.reason, 'coverage.reason', 500) };
    if (!Array.isArray(body.addresses) || !body.addresses.length || body.addresses.length > 5000) fail('addresses is invalid');
    const addresses = body.addresses.map((item, index) => {
      exact(item, `addresses[${index}]`, ['address', 'resourceKey', 'resourceKind', 'displayName', 'source']);
      return { address: address(item.address, 'address'), resourceKey: key(item.resourceKey, 'resourceKey'),
        resourceKind: key(item.resourceKind, 'resourceKind'), displayName: text(item.displayName, 'displayName', 300),
        source: key(item.source, 'address.source') };
    }).sort((a, b) => a.address.localeCompare(b.address) || a.resourceKey.localeCompare(b.resourceKey));
    if (new Set(addresses.map(item => `${item.address}|${item.resourceKey}|${item.source}`)).size !== addresses.length) {
      fail('addresses contain duplicate evidence');
    }
    const observationHash = hash({ source, providerHostId, observedAt, coverage, addresses }); const database = this._db(options);
    const found = database.prepare('SELECT id FROM network_dependency_address_observations WHERE observation_hash=?').get(observationHash);
    const id = found?.id || Number(database.prepare(`INSERT INTO network_dependency_address_observations
      (source,provider_host_id,observed_at,coverage_json,addresses_json,observation_hash,created_by)
      VALUES (?,?,?,?,?,?,?)`).run(source, providerHostId, observedAt, stable(coverage), stable(addresses), observationHash, actor.id).lastInsertRowid);
    return { id, source, providerHostId, observedAt, coverage, addressCount: addresses.length,
      observationHash, duplicate: !!found, networkCallsStarted: 0, providerMutationsStarted: 0 };
  }
  recordDnsObservation(body = {}, actor, options = {}) {
    this._admin(actor); exact(body, 'dnsObservation', ['source', 'observedAt', 'expiresAt', 'records']);
    const source = key(body.source, 'source'); const observedAt = instant(body.observedAt, 'observedAt');
    const expiresAt = instant(body.expiresAt, 'expiresAt');
    if (Date.parse(expiresAt) <= Date.parse(observedAt)) fail('expiresAt must be after observedAt');
    if (!Array.isArray(body.records) || !body.records.length || body.records.length > 5000) fail('records is invalid');
    const records = body.records.map((item, index) => {
      exact(item, `records[${index}]`, ['fqdn', 'type', 'address', 'resourceKey']);
      const type = String(item.type || '').toUpperCase(); if (!['A', 'AAAA', 'PTR'].includes(type)) fail('record.type is invalid');
      const ip = address(item.address, 'record.address');
      if ((type === 'A' && net.isIP(ip) !== 4) || (type === 'AAAA' && net.isIP(ip) !== 6)) fail('DNS record address family is invalid');
      return { fqdn: fqdn(item.fqdn, 'record.fqdn'), type, address: ip,
        resourceKey: item.resourceKey == null ? null : key(item.resourceKey, 'record.resourceKey') };
    }).sort((a, b) => a.fqdn.localeCompare(b.fqdn) || a.type.localeCompare(b.type) || a.address.localeCompare(b.address));
    if (new Set(records.map(item => `${item.fqdn}|${item.type}|${item.address}|${item.resourceKey || ''}`)).size !== records.length) {
      fail('records contain duplicate evidence');
    }
    const observationHash = hash({ source, observedAt, expiresAt, records }); const database = this._db(options);
    const found = database.prepare('SELECT id FROM network_dependency_dns_observations WHERE observation_hash=?').get(observationHash);
    const id = found?.id || Number(database.prepare(`INSERT INTO network_dependency_dns_observations
      (source,observed_at,expires_at,records_json,observation_hash,created_by) VALUES (?,?,?,?,?,?)`)
      .run(source, observedAt, expiresAt, stable(records), observationHash, actor.id).lastInsertRowid);
    return { id, source, observedAt, expiresAt, recordCount: records.length, observationHash,
      duplicate: !!found, networkCallsStarted: 0, providerMutationsStarted: 0 };
  }
  _sources(database, now) {
    const oldest = new Date(now.getTime() - 30 * 86400000).toISOString();
    return {
      addresses: database.prepare(`SELECT * FROM network_dependency_address_observations
        WHERE datetime(observed_at)>=datetime(?) AND datetime(observed_at)<=datetime(?)
        ORDER BY observed_at DESC,id DESC LIMIT ?`).all(oldest, now.toISOString(), MAX_SOURCE_ROWS),
      dns: database.prepare(`SELECT * FROM network_dependency_dns_observations
        WHERE datetime(expires_at)>datetime(?) AND datetime(observed_at)<=datetime(?)
        ORDER BY observed_at DESC,id DESC LIMIT ?`).all(now.toISOString(), now.toISOString(), MAX_SOURCE_ROWS),
      flows: tableExists(database, 'network_flow_log_batches') ? database.prepare(`SELECT * FROM network_flow_log_batches
        WHERE datetime(retention_until)>datetime(?) AND datetime(observed_at)<=datetime(?)
        ORDER BY observed_at DESC,id DESC LIMIT ?`).all(now.toISOString(), now.toISOString(), MAX_SOURCE_ROWS) : [],
      graphs: tableExists(database, 'resource_relationship_graphs') ? database.prepare(`SELECT * FROM resource_relationship_graphs
        WHERE datetime(observed_at)>=datetime(?) AND datetime(observed_at)<=datetime(?)
        ORDER BY observed_at DESC,id DESC LIMIT 5`).all(oldest, now.toISOString()) : [],
      metadata: tableExists(database, 'custom_metadata_values') ? database.prepare(`SELECT v.*,s.sensitivity FROM custom_metadata_values v
        JOIN custom_metadata_schemas s ON s.schema_key=v.schema_key
        WHERE v.schema_key IN ('dependency.upstream','dependency.requires') AND s.sensitivity!='confidential'
        ORDER BY v.resource_key,v.schema_key`).all() : [],
    };
  }
  build(body = {}, actor, options = {}) {
    this._admin(actor); exact(body, 'dependencySnapshot', ['scopeKey', 'freshnessHours', 'maxEdges', 'includeDenied']);
    const scopeKey = key(body.scopeKey || 'global', 'scopeKey');
    if (scopeKey !== 'global') fail('Only the global evidence scope is currently supported', 'UNSUPPORTED_DEPENDENCY_SCOPE');
    const parameters = { freshnessHours: integer(body.freshnessHours, 'freshnessHours', 1, 720, 24),
      maxEdges: integer(body.maxEdges, 'maxEdges', 1, 5000, 5000), includeDenied: body.includeDenied === true };
    if (body.includeDenied !== undefined && typeof body.includeDenied !== 'boolean') fail('includeDenied is invalid');
    const nowInput = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    if (Number.isNaN(nowInput.getTime())) fail('now is invalid');
    const now = new Date(nowInput);
    const freshnessCutoffAt = new Date(now.getTime() - parameters.freshnessHours * 3600000).toISOString();
    const database = this._db(options); const sources = this._sources(database, now);
    const nodes = new Map(); const edgeMap = new Map(); const ambiguousAddresses = new Set();
    let addressEntries = 0; let dnsEntries = 0;
    const ensureNode = (resourceKey, details = {}) => {
      if (!resourceKey) return null;
      if (!nodes.has(resourceKey)) {
        if (nodes.size >= MAX_NODES) return null;
        nodes.set(resourceKey, { id: resourceKey, kind: details.kind || 'unknown',
          displayName: details.displayName || resourceKey, addresses: new Set(), aliases: new Set(),
          evidenceTypes: new Set(), observedAt: details.observedAt || null,
          ownershipState: details.ownershipState || 'known' });
      }
      const node = nodes.get(resourceKey);
      if (details.kind && node.kind === 'unknown') node.kind = details.kind;
      if (details.displayName && node.displayName === node.id) node.displayName = details.displayName;
      if (details.address) node.addresses.add(details.address);
      if (details.alias) node.aliases.add(details.alias);
      if (details.evidenceType) node.evidenceTypes.add(details.evidenceType);
      if (details.observedAt && (!node.observedAt || details.observedAt > node.observedAt)) node.observedAt = details.observedAt;
      if (details.ownershipState === 'ambiguous') node.ownershipState = 'ambiguous';
      return node;
    };
    const addEdge = (source, target, evidence) => {
      if (!source || !target || source === target) return;
      const edgeKey = `${source}|${target}`; let edge = edgeMap.get(edgeKey);
      if (!edge) {
        if (edgeMap.size >= parameters.maxEdges) return;
        edge = { source, target, relationships: new Set(), evidenceTypes: new Set(), evidence: [],
          firstSeenAt: evidence.observedAt, lastSeenAt: evidence.observedAt, confidence: 0,
          causality: 'unproven', impactEligible: false, flow: { events: 0, bytes: 0, packets: 0, protocols: new Set(), destinationPorts: new Set() } };
        edgeMap.set(edgeKey, edge);
      }
      edge.relationships.add(evidence.relationship); edge.evidenceTypes.add(evidence.type);
      edge.firstSeenAt = !edge.firstSeenAt || evidence.observedAt < edge.firstSeenAt ? evidence.observedAt : edge.firstSeenAt;
      edge.lastSeenAt = !edge.lastSeenAt || evidence.observedAt > edge.lastSeenAt ? evidence.observedAt : edge.lastSeenAt;
      edge.confidence = Math.max(edge.confidence, evidence.confidence);
      if (evidence.declared) { edge.causality = 'declared'; edge.impactEligible = true; }
      if (edge.evidence.length < 20) edge.evidence.push({ type: evidence.type, reference: evidence.reference,
        observedAt: evidence.observedAt, confidence: evidence.confidence, causality: evidence.declared ? 'declared' : 'unproven' });
      if (evidence.flow) {
        edge.flow.events += 1; edge.flow.bytes += evidence.flow.bytes; edge.flow.packets += evidence.flow.packets;
        edge.flow.protocols.add(evidence.flow.protocol);
        if (edge.flow.destinationPorts.size < 20) edge.flow.destinationPorts.add(evidence.flow.destinationPort);
      }
    };

    const owners = new Map();
    addressRows: for (const row of sources.addresses) {
      for (const item of parse(row.addresses_json, [])) {
        if (addressEntries >= MAX_SOURCE_ENTRIES) break addressRows;
        addressEntries += 1;
        const set = owners.get(item.address) || new Set(); set.add(item.resourceKey); owners.set(item.address, set);
        ensureNode(item.resourceKey, { kind: item.resourceKind, displayName: item.displayName, address: item.address,
          evidenceType: 'ip_observation', observedAt: normalizedInstant(row.observed_at) });
      }
    }
    const endpointFor = ip => {
      const candidates = owners.get(ip) || new Set();
      if (candidates.size === 1) return { id: [...candidates][0], resolution: 'unique_ip_owner' };
      const id = `network-endpoint:${hash(ip).slice(0, 20)}`;
      ensureNode(id, { kind: 'networkEndpoint', displayName: ip, address: ip, evidenceType: 'flow_endpoint',
        ownershipState: candidates.size > 1 ? 'ambiguous' : 'unowned' });
      if (candidates.size > 1) ambiguousAddresses.add(ip);
      return { id, resolution: candidates.size > 1 ? 'ambiguous_ip_owner' : 'unowned_address' };
    };
    dnsRows: for (const row of sources.dns) {
      for (const record of parse(row.records_json, [])) {
        if (dnsEntries >= MAX_SOURCE_ENTRIES) break dnsRows;
        dnsEntries += 1;
        const owner = record.resourceKey || (owners.get(record.address)?.size === 1 ? [...owners.get(record.address)][0] : null);
        const resolved = owner || endpointFor(record.address).id;
        ensureNode(resolved, { alias: record.fqdn, address: record.address, evidenceType: 'dns_observation',
          observedAt: normalizedInstant(row.observed_at) });
      }
    }
    let graphEntries = 0;
    for (const row of sources.graphs) {
      const resources = parse(row.resources_json, []); const edges = parse(row.edges_json, []);
      const observedAt = normalizedInstant(row.observed_at);
      for (const resource of resources) ensureNode(resource.resourceKey, { kind: resource.kind,
        displayName: resource.name, evidenceType: 'relationship_graph', observedAt });
      for (const edge of edges) {
        if (++graphEntries > 20000) break;
        ensureNode(edge.source, { evidenceType: 'relationship_graph', observedAt });
        ensureNode(edge.target, { evidenceType: 'relationship_graph', observedAt });
        addEdge(edge.source, edge.target, { type: 'relationship_graph', reference: row.graph_hash,
          relationship: edge.relationship, observedAt, confidence: 1, declared: true });
      }
    }
    for (const row of sources.metadata) {
      const upstream = parse(row.value_json, null);
      if (typeof upstream !== 'string' || !KEY.test(upstream) || upstream === row.resource_key) continue;
      const observedAt = normalizedInstant(row.updated_at);
      ensureNode(upstream, { evidenceType: 'dependency_metadata', observedAt });
      ensureNode(row.resource_key, { kind: row.resource_type, evidenceType: 'dependency_metadata', observedAt });
      addEdge(upstream, row.resource_key, { type: 'dependency_metadata', reference: row.value_hash,
        relationship: row.schema_key, observedAt, confidence: 0.85, declared: true });
    }
    let flowEntries = 0;
    flowRows: for (const row of sources.flows) {
      for (const entry of parse(row.entries_json, [])) {
        if (flowEntries >= MAX_SOURCE_ENTRIES) break flowRows;
        flowEntries += 1;
        if (entry.action !== 'allow' && !parameters.includeDenied) continue;
        const sourceResolved = entry.sourceResourceKey
          ? { id: entry.sourceResourceKey, resolution: 'explicit_resource' } : endpointFor(entry.sourceAddress);
        const destinationResolved = entry.destinationResourceKey
          ? { id: entry.destinationResourceKey, resolution: 'explicit_resource' } : endpointFor(entry.destinationAddress);
        const observedAt = normalizedInstant(entry.occurredAt);
        ensureNode(sourceResolved.id, { evidenceType: 'flow_observation', observedAt });
        ensureNode(destinationResolved.id, { evidenceType: 'flow_observation', observedAt });
        const explicit = sourceResolved.resolution === 'explicit_resource' && destinationResolved.resolution === 'explicit_resource';
        const resolved = !sourceResolved.resolution.includes('ambiguous') && !destinationResolved.resolution.includes('ambiguous');
        const confidence = entry.action !== 'allow' ? 0.2 : explicit ? 0.65 : resolved ? 0.5 : 0.3;
        addEdge(destinationResolved.id, sourceResolved.id, { type: 'flow_batch', reference: row.batch_hash,
          relationship: entry.action === 'allow' ? 'observed_communication' : 'observed_denial',
          observedAt, confidence, declared: false,
          flow: { bytes: entry.bytes, packets: entry.packets, protocol: entry.protocol,
            destinationPort: entry.destinationPort } });
      }
    }
    const publicNodes = [...nodes.values()].map(node => ({ id: node.id, kind: node.kind,
      displayName: node.displayName, addresses: [...node.addresses].sort().slice(0, 20),
      aliases: [...node.aliases].sort().slice(0, 20), evidenceTypes: [...node.evidenceTypes].sort(),
      observedAt: node.observedAt, ownershipState: node.ownershipState })).sort((a, b) => a.id.localeCompare(b.id));
    const publicEdges = [...edgeMap.values()].map(edge => ({ source: edge.source, target: edge.target,
      relationships: [...edge.relationships].sort(), evidenceTypes: [...edge.evidenceTypes].sort(),
      evidence: edge.evidence.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.type.localeCompare(b.type)),
      firstSeenAt: edge.firstSeenAt, lastSeenAt: edge.lastSeenAt,
      freshness: edge.lastSeenAt >= freshnessCutoffAt ? 'fresh' : 'stale',
      confidence: Number(edge.confidence.toFixed(2)), causality: edge.causality,
      impactEligible: edge.impactEligible, flow: edge.flow.events ? { events: edge.flow.events,
        bytes: edge.flow.bytes, packets: edge.flow.packets, protocols: [...edge.flow.protocols].sort(),
        destinationPorts: [...edge.flow.destinationPorts].sort((a, b) => a - b) } : null,
    })).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
    const summary = { nodes: publicNodes.length, edges: publicEdges.length,
      declaredEdges: publicEdges.filter(edge => edge.impactEligible).length,
      observedCandidateEdges: publicEdges.filter(edge => !edge.impactEligible).length,
      freshEdges: publicEdges.filter(edge => edge.freshness === 'fresh').length,
      staleEdges: publicEdges.filter(edge => edge.freshness === 'stale').length,
      ambiguousAddressResolutions: ambiguousAddresses.size, truncated: edgeMap.size >= parameters.maxEdges || nodes.size >= MAX_NODES,
      causalityInferredFromTemporalProximity: 0 };
    const sourceCursor = { addressObservationIds: sources.addresses.map(row => row.id),
      dnsObservationIds: sources.dns.map(row => row.id), flowBatchIds: sources.flows.map(row => row.id),
      relationshipGraphIds: sources.graphs.map(row => row.id), metadataValueHashes: sources.metadata.map(row => row.value_hash),
      processed: { addressEntries, dnsEntries, graphEdges: graphEntries, flowEntries } };
    const snapshotHash = hash({ scopeKey, parameters, nodes: publicNodes, edges: publicEdges, sourceCursor });
    const encoded = stable({ publicNodes, publicEdges, summary, sourceCursor });
    if (Buffer.byteLength(encoded) > MAX_BYTES) fail('Dependency snapshot exceeds the encoded size limit', 'DEPENDENCY_SNAPSHOT_TOO_LARGE', 413);
    const found = database.prepare('SELECT * FROM network_dependency_snapshots WHERE snapshot_hash=?').get(snapshotHash);
    if (found) return { ...publicSnapshot(found), duplicate: true };
    const saved = database.prepare(`INSERT INTO network_dependency_snapshots
      (scope_key,built_at,freshness_cutoff_at,parameters_json,nodes_json,edges_json,summary_json,source_cursor_json,
       snapshot_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(scopeKey, now.toISOString(), freshnessCutoffAt,
      stable(parameters), stable(publicNodes), stable(publicEdges), stable(summary), stable(sourceCursor), snapshotHash, actor.id);
    return { ...publicSnapshot(database.prepare('SELECT * FROM network_dependency_snapshots WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  latest(options = {}) {
    const database = this._db(options); const row = options.scopeKey
      ? database.prepare('SELECT * FROM network_dependency_snapshots WHERE scope_key=? ORDER BY built_at DESC,id DESC LIMIT 1').get(options.scopeKey)
      : database.prepare('SELECT * FROM network_dependency_snapshots ORDER BY built_at DESC,id DESC LIMIT 1').get();
    return publicSnapshot(row);
  }
  overview(options = {}) {
    const database = this._db(options); const latest = this.latest({ ...options, database });
    const recent = database.prepare(`SELECT id,scope_key,built_at,summary_json,snapshot_hash,created_at
      FROM network_dependency_snapshots ORDER BY built_at DESC,id DESC LIMIT 20`).all().map(row => ({
      id: Number(row.id), scopeKey: row.scope_key, builtAt: row.built_at, summary: parse(row.summary_json, {}),
      snapshotHash: row.snapshot_hash, createdAt: row.created_at,
    }));
    return { schemaVersion: '1.0', latest, recent, capabilities: { sourceCorrelation: true,
      declaredImpactTraversal: true, observedCandidatesExcludedFromImpact: true,
      activeNetworkProbes: false, providerMutations: false } };
  }
  impact(snapshotId, resourceKeyInput, actor, options = {}) {
    this._admin(actor);
    const database = this._db(options); const id = integer(snapshotId, 'snapshotId', 1, Number.MAX_SAFE_INTEGER);
    const resourceKey = key(resourceKeyInput, 'resourceKey'); const maxDepth = integer(options.maxDepth, 'maxDepth', 1, 10, 5);
    const row = database.prepare('SELECT * FROM network_dependency_snapshots WHERE id=?').get(id);
    if (!row) fail('Dependency snapshot was not found', 'NETWORK_DEPENDENCY_SNAPSHOT_NOT_FOUND', 404);
    const snapshot = publicSnapshot(row); const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
    if (!byId.has(resourceKey)) fail('Resource was not found in dependency snapshot', 'NETWORK_DEPENDENCY_RESOURCE_NOT_FOUND', 404);
    const declared = snapshot.edges.filter(edge => edge.impactEligible); const traverse = direction => {
      const adjacency = new Map();
      for (const edge of declared) {
        const from = direction === 'downstream' ? edge.source : edge.target;
        const to = direction === 'downstream' ? edge.target : edge.source;
        if (!adjacency.has(from)) adjacency.set(from, []); adjacency.get(from).push({ resourceKey: to, edge });
      }
      const queue = [{ resourceKey, depth: 0, path: [] }]; const seen = new Set([resourceKey]); const items = [];
      while (queue.length) {
        const current = queue.shift();
        for (const next of adjacency.get(current.resourceKey) || []) {
          if (seen.has(next.resourceKey)) continue; seen.add(next.resourceKey);
          const item = { resource: byId.get(next.resourceKey), depth: current.depth + 1,
            path: [...current.path, { source: next.edge.source, target: next.edge.target,
              relationships: next.edge.relationships }] };
          items.push(item); if (item.depth < maxDepth) queue.push({ resourceKey: next.resourceKey,
            depth: item.depth, path: item.path });
        }
      }
      return items;
    };
    const observedCandidates = snapshot.edges.filter(edge => !edge.impactEligible
      && (edge.source === resourceKey || edge.target === resourceKey));
    return { schemaVersion: '1.0', snapshotId: id, snapshotHash: snapshot.snapshotHash,
      resource: byId.get(resourceKey), upstream: traverse('upstream'), downstream: traverse('downstream'),
      observedCandidates, candidatesIncludedInImpact: false, cyclesSuppressed: true, maxDepth,
      providerMutationsStarted: 0, networkCallsStarted: 0 };
  }
}

const service = new NetworkDependencyMapService();
module.exports = service;
module.exports.NetworkDependencyMapService = NetworkDependencyMapService;
module.exports.NetworkDependencyMapError = NetworkDependencyMapError;
module.exports._internals = { exact, key, address, fqdn, normalizedInstant, stable, hash, publicSnapshot };
