'use strict';

const crypto = require('crypto');
const net = require('net');
const { getDb } = require('../db');

class ConnectorMarketplaceError extends Error {
  constructor(message, status = 400, code = 'CONNECTOR_MARKETPLACE_ERROR', details) {
    super(message); this.name = 'ConnectorMarketplaceError'; this.status = status; this.code = code; this.details = details;
  }
}
const fail = (message, status, code, details) => new ConnectorMarketplaceError(message, status, code, details);
const DOMAINS = new Set(['cmdb','itsm','siem','secrets','ipam_dns','backup','monitoring','event_bus','openapi']);
const SUPPORT = new Set(['official','partner','community']);
const CONNECTOR_KEY = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const FIELD = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HASH = /^[a-f0-9]{64}$/;
const FORBIDDEN_FIELD = /password|credential|private.?key|authorization|cookie|secret.?value|raw.?secret/i;
const SCHEMA_VERSION = '1.0';

const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const canonicalPayload = manifest => Buffer.from(stable(manifest), 'utf8');
const string = (value, field, max = 300) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw fail(`${field} is invalid`);
  return result;
};
const key = (value, field) => { const result = string(value, field, 80); if (!FIELD.test(result)) throw fail(`${field} is invalid`); return result; };
const instant = (value, field) => { const result = new Date(value); if (Number.isNaN(result.getTime())) throw fail(`${field} is invalid`); return result.toISOString(); };
const choice = (value, field, values) => { const result = String(value || ''); if (!values.includes(result)) throw fail(`${field} is invalid`); return result; };
function exactKeys(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${field} is invalid`);
  const unexpected = Object.keys(value).filter(item => !allowed.includes(item));
  if (unexpected.length) {
    const secret = unexpected.find(item => FORBIDDEN_FIELD.test(item));
    throw fail(secret ? `${field}.${secret} may not contain secret material` : `Unexpected ${field} fields: ${unexpected.join(', ')}`,
      400, secret ? 'SECRET_FIELD' : 'UNEXPECTED_FIELD');
  }
  return value;
}
function safeObject(value, field, maxBytes = 64 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${field} is invalid`);
  if (Buffer.byteLength(stable(value)) > maxBytes) throw fail(`${field} is too large`, 413);
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [childKey, child] of Object.entries(node)) {
      if (FORBIDDEN_FIELD.test(childKey)) throw fail(`${path}.${childKey} may not contain secret material`, 400, 'SECRET_FIELD');
      walk(child, `${path}.${childKey}`);
    }
  };
  walk(value, field); return canonical(value);
}
function fieldList(value, field, max = 64) {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length) throw fail(`${field} is invalid`);
  return value.map(item => key(item, field));
}
function httpsUrl(value, field) {
  let url; try { url = new URL(value); } catch { throw fail(`${field} must be an HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail(`${field} must be an HTTPS URL without credentials or fragment`);
  return url;
}
function schemaRef(value, field) {
  const result = string(value, field, 500);
  if (result.startsWith('urn:')) return result;
  return httpsUrl(result, field).toString();
}

class ConnectorMarketplaceService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) { if (!actor?.id) throw fail('Authentication required', 401); if (actor.role !== 'admin') throw fail('Administrator required', 403); }
  _entry(connectorKeyValue, domain, product) {
    const connectorKey = String(connectorKeyValue || '').toLowerCase();
    const row = this._db().prepare('SELECT * FROM connector_marketplace_entries WHERE connector_key=?').get(connectorKey);
    if (!row) throw fail('Connector marketplace entry not found', 404);
    if (domain && !parse(row.domains_json, []).includes(domain)) throw fail(`Connector does not declare ${domain}`, 409, 'DOMAIN_NOT_DECLARED');
    if (product && !parse(row.products_json, []).includes(product)) throw fail(`Connector does not declare product ${product}`, 409, 'PRODUCT_NOT_DECLARED');
    return row;
  }
  _endpoint(row, value, field = 'endpointOrigin') {
    const url = httpsUrl(value, field); const allowed = parse(row.allowed_hosts_json, []);
    if (!allowed.includes(url.hostname.toLowerCase())) throw fail(`${field} host is not signed into the connector allowlist`, 403, 'HOST_DENIED');
    return url.origin;
  }
  register(body, actor) {
    this._admin(actor); exactKeys(body, 'marketplace', ['manifest','publicKeyPem','signatureBase64']);
    const manifest = safeObject(body.manifest, 'manifest');
    exactKeys(manifest, 'manifest', ['schemaVersion','connectorKey','name','version','publisher','supportLevel','domains','products','allowedHosts','docsUrl']);
    if (manifest.schemaVersion !== SCHEMA_VERSION || !CONNECTOR_KEY.test(manifest.connectorKey || '') || !VERSION.test(manifest.version || '')) throw fail('Connector manifest identity or version is invalid', 400, 'INVALID_MANIFEST');
    const name = string(manifest.name, 'manifest.name', 120); const publisher = string(manifest.publisher, 'manifest.publisher', 120);
    const supportLevel = choice(manifest.supportLevel, 'manifest.supportLevel', [...SUPPORT]);
    if (!Array.isArray(manifest.domains) || !manifest.domains.length || manifest.domains.length > DOMAINS.size || new Set(manifest.domains).size !== manifest.domains.length || manifest.domains.some(item => !DOMAINS.has(item))) throw fail('manifest.domains is invalid', 400, 'INVALID_MANIFEST');
    const products = fieldList(manifest.products, 'manifest.products', 64).map(item => item.toLowerCase());
    if (!products.length) throw fail('manifest.products is invalid', 400, 'INVALID_MANIFEST');
    if (!Array.isArray(manifest.allowedHosts) || manifest.allowedHosts.length > 64 || new Set(manifest.allowedHosts).size !== manifest.allowedHosts.length || manifest.allowedHosts.some(item => !HOST.test(String(item).toLowerCase()))) throw fail('manifest.allowedHosts is invalid', 400, 'INVALID_MANIFEST');
    const allowedHosts = manifest.allowedHosts.map(item => String(item).toLowerCase()); httpsUrl(manifest.docsUrl, 'manifest.docsUrl');
    const publicKeyPem = String(body.publicKeyPem || '').trim(); const signatureBase64 = String(body.signatureBase64 || '').trim(); let publicKey; let signature;
    try { publicKey = crypto.createPublicKey(publicKeyPem); signature = Buffer.from(signatureBase64, 'base64'); } catch { throw fail('Signature material is invalid', 400, 'INVALID_SIGNATURE'); }
    if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !crypto.verify(null, canonicalPayload(manifest), publicKey, signature)) throw fail('Connector manifest signature verification failed', 400, 'INVALID_SIGNATURE');
    const manifestHash = hash(manifest);
    this._db().prepare(`INSERT INTO connector_marketplace_entries (connector_key,name,version,publisher,support_level,domains_json,products_json,allowed_hosts_json,manifest_json,public_key_pem,signature_base64,manifest_hash,signature_state,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connector_key) DO UPDATE SET name=excluded.name,version=excluded.version,publisher=excluded.publisher,support_level=excluded.support_level,domains_json=excluded.domains_json,products_json=excluded.products_json,allowed_hosts_json=excluded.allowed_hosts_json,manifest_json=excluded.manifest_json,public_key_pem=excluded.public_key_pem,signature_base64=excluded.signature_base64,manifest_hash=excluded.manifest_hash,signature_state='verified',created_by=excluded.created_by,updated_at=datetime('now')`).run(manifest.connectorKey, name, manifest.version, publisher, supportLevel, stable(manifest.domains), stable(products), stable(allowedHosts), stable(manifest), publicKeyPem, signatureBase64, manifestHash, 'verified', actor.id);
    return { connectorKey: manifest.connectorKey, version: manifest.version, publisher, supportLevel, domains: manifest.domains, products, allowedHosts, manifestHash, signatureState: 'verified' };
  }
  planCmdbSync(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'cmdbSync', ['product','direction','resourceType','resourceRef','ownershipRules','changes','conflicts']);
    const product = key(body.product, 'product').toLowerCase(); const row = this._entry(connectorKeyValue, 'cmdb', product);
    const direction = choice(body.direction, 'direction', ['import','export','bidirectional']); const resourceType = key(body.resourceType, 'resourceType'); const resourceRef = string(body.resourceRef, 'resourceRef', 200);
    const ownershipRules = safeObject(body.ownershipRules, 'ownershipRules', 16 * 1024); for (const [field, owner] of Object.entries(ownershipRules)) { key(field, 'ownershipRules field'); choice(owner, `ownershipRules.${field}`, ['docker-dash','cmdb','manual']); }
    if (!Array.isArray(body.changes) || body.changes.length > 100) throw fail('changes is invalid');
    const changes = body.changes.map((change, index) => { exactKeys(change, `changes[${index}]`, ['field','operation','owner','valueHash']); const field = key(change.field, `changes[${index}].field`); const owner = choice(change.owner, `changes[${index}].owner`, ['docker-dash','cmdb','manual']); if (ownershipRules[field] !== owner) throw fail(`Change owner for ${field} does not match the ownership rule`, 409, 'OWNERSHIP_MISMATCH'); if (!HASH.test(change.valueHash || '')) throw fail(`changes[${index}].valueHash is invalid`); return { field, operation: choice(change.operation, `changes[${index}].operation`, ['set','clear']), owner, valueHash: change.valueHash }; });
    if (!Array.isArray(body.conflicts) || body.conflicts.length > 100) throw fail('conflicts is invalid'); const conflicts = body.conflicts.map((item, index) => string(item, `conflicts[${index}]`, 300));
    const state = conflicts.length ? 'blocked' : 'ready'; const plan = { connectorKey: row.connector_key, product, direction, resourceType, resourceRef, ownershipRules, changes, conflicts, state }; const planHash = hash(plan);
    const saved = this._db().prepare('INSERT OR IGNORE INTO cmdb_connector_syncs (connector_id,direction,resource_type,resource_ref,ownership_rules_json,changes_json,conflicts_json,state,plan_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id, direction, resourceType, resourceRef, stable(ownershipRules), stable(changes), stable(conflicts), state, planHash, actor.id);
    return { id: Number(saved.lastInsertRowid) || null, ...plan, planHash, externalMutationsStarted: 0 };
  }
  linkItsmChange(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'itsmChange', ['product','ticketRef','ticketUrl','windowStart','windowEnd','approvalState','evidenceLinks','evaluatedAt']);
    const product = key(body.product, 'product').toLowerCase(); const row = this._entry(connectorKeyValue, 'itsm', product); const ticketRef = string(body.ticketRef, 'ticketRef', 120); const ticketUrl = httpsUrl(body.ticketUrl, 'ticketUrl').toString(); const windowStart = instant(body.windowStart, 'windowStart'); const windowEnd = instant(body.windowEnd, 'windowEnd'); if (windowEnd <= windowStart) throw fail('Change window end must be after start'); const approvalState = choice(body.approvalState, 'approvalState', ['pending','approved','rejected']); const evaluatedAt = instant(body.evaluatedAt || new Date(), 'evaluatedAt');
    if (!Array.isArray(body.evidenceLinks) || body.evidenceLinks.length > 32) throw fail('evidenceLinks is invalid'); const evidenceLinks = body.evidenceLinks.map((item, index) => httpsUrl(item, `evidenceLinks[${index}]`).toString()); let gateState = approvalState === 'rejected' ? 'rejected' : approvalState !== 'approved' ? 'approval_required' : evaluatedAt < windowStart || evaluatedAt >= windowEnd ? 'outside_window' : 'ready'; const evidenceHash = hash({ connectorKey: row.connector_key, ticketRef, ticketUrl, windowStart, windowEnd, approvalState, evidenceLinks, evaluatedAt, gateState });
    const saved = this._db().prepare('INSERT OR IGNORE INTO itsm_connector_changes (connector_id,ticket_ref,ticket_url,window_start,window_end,approval_state,evidence_links_json,gate_state,evidence_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id, ticketRef, ticketUrl, windowStart, windowEnd, approvalState, stable(evidenceLinks), gateState, evidenceHash, actor.id);
    return { id: Number(saved.lastInsertRowid) || null, connectorKey: row.connector_key, product, ticketRef, ticketUrl, windowStart, windowEnd, approvalState, evidenceLinks, evaluatedAt, gateState, evidenceHash };
  }
  normalizeSiemEvent(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'siemEvent', ['product','eventType','occurredAt','severity','resourceRef','correlationId','attributes']);
    const product = key(body.product, 'product').toLowerCase(); const row = this._entry(connectorKeyValue, 'siem', product); const eventType = key(body.eventType, 'eventType'); const occurredAt = instant(body.occurredAt, 'occurredAt'); const severity = choice(body.severity, 'severity', ['info','warning','high','critical']); const resourceRef = string(body.resourceRef, 'resourceRef', 200); const correlationId = string(body.correlationId, 'correlationId', 120); const attributes = safeObject(body.attributes || {}, 'attributes', 32 * 1024); const envelope = { schemaRef: 'urn:docker-dash:event:1.0', eventType, occurredAt, severity, resourceRef, correlationId, attributes }; const envelopeHash = hash(envelope); const eventId = `dd-${envelopeHash.slice(0, 32)}`;
    const saved = this._db().prepare('INSERT OR IGNORE INTO siem_connector_events (connector_id,destination_kind,schema_ref,event_id,occurred_at,severity,envelope_json,envelope_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(row.id, product, envelope.schemaRef, eventId, occurredAt, severity, stable(envelope), envelopeHash, actor.id);
    return { id: Number(saved.lastInsertRowid) || null, connectorKey: row.connector_key, destinationKind: product, eventId, envelope, envelopeHash, deliveryState: 'normalized', rawPayloadStored: false };
  }
  bindSecretReference(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'secretReference', ['product','referenceUri','purpose','scopes']); const product = key(body.product, 'product').toLowerCase(); const row = this._entry(connectorKeyValue, 'secrets', product); const prefixes = { vault: 'vault://', key_vault: 'azurekv://', secrets_manager: 'aws-sm://', onepassword: 'op://' }; if (!prefixes[product]) throw fail('Unsupported secret manager product'); const referenceUri = string(body.referenceUri, 'referenceUri', 500); if (!referenceUri.startsWith(prefixes[product]) || /[?#].*(?:token|secret|password)=/i.test(referenceUri)) throw fail('Secret reference URI is invalid', 400, 'INVALID_SECRET_REFERENCE'); const purpose = key(body.purpose, 'purpose'); const scopes = fieldList(body.scopes, 'scopes', 32); if (!scopes.length) throw fail('scopes is invalid'); const referenceHash = hash({ connectorKey: row.connector_key, product, referenceUri, purpose, scopes }); const saved = this._db().prepare('INSERT OR IGNORE INTO secret_manager_references (connector_id,provider_kind,reference_uri,purpose,scopes_json,reference_hash,created_by) VALUES (?,?,?,?,?,?,?)').run(row.id, product, referenceUri, purpose, stable(scopes), referenceHash, actor.id);
    return { id: Number(saved.lastInsertRowid) || this._db().prepare('SELECT id FROM secret_manager_references WHERE reference_hash=?').get(referenceHash).id, connectorKey: row.connector_key, providerKind: product, referenceUri, purpose, scopes, referenceHash, secretMaterialStored: false };
  }
  planIpamDns(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'ipamDnsPlan', ['product','action','resourceRef','recordType','address','fqdn','ownershipToken','expectedVersion']); const product = key(body.product, 'product').toLowerCase(); const row = this._entry(connectorKeyValue, 'ipam_dns', product); const action = choice(body.action, 'action', ['allocate','reserve','release','create','update','delete']); const resourceRef = string(body.resourceRef, 'resourceRef', 200); const recordType = body.recordType ? choice(body.recordType, 'recordType', ['A','AAAA','PTR']) : null; const address = body.address ? string(body.address, 'address', 80) : null; if (address && !net.isIP(address)) throw fail('address is invalid'); const fqdn = body.fqdn ? string(body.fqdn, 'fqdn', 253).toLowerCase() : null; if (fqdn && !HOST.test(fqdn.replace(/\.$/, ''))) throw fail('fqdn is invalid'); if (['create','update','delete'].includes(action) && (!recordType || !fqdn)) throw fail('DNS lifecycle actions require recordType and fqdn'); if (['reserve','release'].includes(action) && !address) throw fail('reserve/release require address'); const ownershipToken = string(body.ownershipToken, 'ownershipToken', 200); const expectedVersion = string(body.expectedVersion, 'expectedVersion', 120); const plan = { connectorKey: row.connector_key, product, action, resourceRef, recordType, address, fqdn, ownershipToken, expectedVersion }; const planHash = hash(plan); const saved = this._db().prepare('INSERT OR IGNORE INTO ipam_dns_connector_plans (connector_id,provider_kind,action,resource_ref,record_type,address,fqdn,ownership_token,expected_version,plan_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id, product, action, resourceRef, recordType, address, fqdn, ownershipToken, expectedVersion, planHash, actor.id);
    return { id: Number(saved.lastInsertRowid) || null, ...plan, planHash, state: 'planned', externalMutationsStarted: 0 };
  }
  recordBackupObservation(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'backupObservation', ['product','jobRef','workloadRef','status','lastRunAt','recoveryPoints']); const product = key(body.product, 'product').toLowerCase(); const row = this._entry(connectorKeyValue, 'backup', product); const jobRef = string(body.jobRef, 'jobRef', 200); const workloadRef = string(body.workloadRef, 'workloadRef', 200); const status = choice(body.status, 'status', ['success','warning','failed','running','unknown']); const lastRunAt = instant(body.lastRunAt, 'lastRunAt'); if (!Array.isArray(body.recoveryPoints) || body.recoveryPoints.length > 500) throw fail('recoveryPoints is invalid'); const recoveryPoints = body.recoveryPoints.map((point, index) => { exactKeys(point, `recoveryPoints[${index}]`, ['id','createdAt','type','verified','sizeBytes']); const sizeBytes = Number(point.sizeBytes || 0); if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw fail(`recoveryPoints[${index}].sizeBytes is invalid`); return { id: string(point.id, `recoveryPoints[${index}].id`, 160), createdAt: instant(point.createdAt, `recoveryPoints[${index}].createdAt`), type: choice(point.type, `recoveryPoints[${index}].type`, ['full','incremental','snapshot']), verified: point.verified === true, sizeBytes }; }); const evidenceHash = hash({ connectorKey: row.connector_key, product, jobRef, workloadRef, status, lastRunAt, recoveryPoints }); const saved = this._db().prepare('INSERT OR IGNORE INTO backup_connector_observations (connector_id,provider_kind,job_ref,workload_ref,status,last_run_at,recovery_points_json,evidence_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(row.id, product, jobRef, workloadRef, status, lastRunAt, stable(recoveryPoints), evidenceHash, actor.id);
    return { id: Number(saved.lastInsertRowid) || null, connectorKey: row.connector_key, providerKind: product, jobRef, workloadRef, status, lastRunAt, recoveryPoints, evidenceHash, visibilityOnly: true };
  }
  saveMonitoringTarget(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'monitoringTarget', ['product','endpointOrigin','mode','metricAllowlist','labelAllowlist','secretReferenceId']); const product = key(body.product, 'product').toLowerCase(); const row = this._entry(connectorKeyValue, 'monitoring', product); const endpointOrigin = this._endpoint(row, body.endpointOrigin); const mode = choice(body.mode, 'mode', ['pull','push','dashboard']); const metricAllowlist = fieldList(body.metricAllowlist, 'metricAllowlist', 128); const labelAllowlist = fieldList(body.labelAllowlist || [], 'labelAllowlist', 64); if (!metricAllowlist.length) throw fail('metricAllowlist is invalid'); let secretReferenceId = null; if (body.secretReferenceId != null) { secretReferenceId = Number(body.secretReferenceId); if (!Number.isSafeInteger(secretReferenceId) || !this._db().prepare('SELECT id FROM secret_manager_references WHERE id=?').get(secretReferenceId)) throw fail('secretReferenceId is invalid'); } const targetHash = hash({ connectorKey: row.connector_key, product, endpointOrigin, mode, metricAllowlist, labelAllowlist, secretReferenceId }); const saved = this._db().prepare('INSERT OR IGNORE INTO monitoring_connector_targets (connector_id,provider_kind,endpoint_origin,mode,metric_allowlist_json,label_allowlist_json,secret_reference_id,target_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?)').run(row.id, product, endpointOrigin, mode, stable(metricAllowlist), stable(labelAllowlist), secretReferenceId, targetHash, actor.id);
    return { id: Number(saved.lastInsertRowid) || null, connectorKey: row.connector_key, providerKind: product, endpointOrigin, mode, metricAllowlist, labelAllowlist, secretReferenceId, targetHash, enabled: false, networkCallsStarted: 0 };
  }
  planEventPublish(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'eventPublication', ['product','channel','schemaRef','event']); const product = key(body.product, 'product').toLowerCase(); const row = this._entry(connectorKeyValue, 'event_bus', product); const channel = string(body.channel, 'channel', 240); const eventSchemaRef = schemaRef(body.schemaRef, 'schemaRef'); const event = safeObject(body.event, 'event', 64 * 1024); exactKeys(event, 'event', ['eventType','occurredAt','subject','data']); const envelope = { specVersion: '1.0', schemaRef: eventSchemaRef, eventType: key(event.eventType, 'event.eventType'), occurredAt: instant(event.occurredAt, 'event.occurredAt'), subject: string(event.subject, 'event.subject', 200), data: safeObject(event.data || {}, 'event.data', 48 * 1024) }; const envelopeHash = hash(envelope); const eventId = `dd-${envelopeHash.slice(0, 32)}`; const saved = this._db().prepare('INSERT OR IGNORE INTO event_bus_connector_publications (connector_id,provider_kind,channel,schema_ref,event_id,envelope_json,envelope_hash,created_by) VALUES (?,?,?,?,?,?,?,?)').run(row.id, product, channel, eventSchemaRef, eventId, stable(envelope), envelopeHash, actor.id);
    return { id: Number(saved.lastInsertRowid) || null, connectorKey: row.connector_key, providerKind: product, channel, eventId, envelope, envelopeHash, deliveryState: 'planned', externalPublishesStarted: 0 };
  }
  registerOpenApiOperation(connectorKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'openapiOperation', ['operationKey','endpointOrigin','method','path','risk','allowedQuery','allowedBody','responseSchemaHash']); const row = this._entry(connectorKeyValue, 'openapi'); const operationKey = key(body.operationKey, 'operationKey'); const endpointOrigin = this._endpoint(row, body.endpointOrigin); const method = choice(String(body.method || '').toUpperCase(), 'method', ['GET','POST','PUT','PATCH','DELETE']); const risk = choice(body.risk, 'risk', ['read','action']); if ((method === 'GET') !== (risk === 'read')) throw fail('GET operations must be read; mutating methods must be action', 400, 'RISK_MISMATCH'); const path = string(body.path, 'path', 500); if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('?') || path.includes('#') || /[{}]/.test(path)) throw fail('path must be a concrete allowlisted API path'); const allowedQuery = fieldList(body.allowedQuery || [], 'allowedQuery', 64); const allowedBody = fieldList(body.allowedBody || [], 'allowedBody', 128); if (!HASH.test(body.responseSchemaHash || '')) throw fail('responseSchemaHash is invalid'); const operationHash = hash({ connectorKey: row.connector_key, operationKey, endpointOrigin, method, path, risk, allowedQuery, allowedBody, responseSchemaHash: body.responseSchemaHash }); this._db().prepare(`INSERT INTO openapi_connector_operations (connector_id,operation_key,endpoint_origin,method,path,risk,allowed_query_json,allowed_body_json,response_schema_hash,operation_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connector_id,operation_key) DO UPDATE SET endpoint_origin=excluded.endpoint_origin,method=excluded.method,path=excluded.path,risk=excluded.risk,allowed_query_json=excluded.allowed_query_json,allowed_body_json=excluded.allowed_body_json,response_schema_hash=excluded.response_schema_hash,operation_hash=excluded.operation_hash,created_by=excluded.created_by,created_at=datetime('now')`).run(row.id, operationKey, endpointOrigin, method, path, risk, stable(allowedQuery), stable(allowedBody), body.responseSchemaHash, operationHash, actor.id);
    return { connectorKey: row.connector_key, operationKey, endpointOrigin, method, path, risk, allowedQuery, allowedBody, responseSchemaHash: body.responseSchemaHash, operationHash };
  }
  prototypeOpenApiRequest(connectorKeyValue, operationKeyValue, body, actor) {
    this._admin(actor); exactKeys(body, 'prototypeRequest', ['query','body']); const row = this._entry(connectorKeyValue, 'openapi'); const operationKey = key(operationKeyValue, 'operationKey'); const operation = this._db().prepare('SELECT * FROM openapi_connector_operations WHERE connector_id=? AND operation_key=?').get(row.id, operationKey); if (!operation) throw fail('OpenAPI operation is not allowlisted', 404, 'OPERATION_NOT_ALLOWED'); const query = safeObject(body.query || {}, 'query', 16 * 1024); const requestBody = safeObject(body.body || {}, 'body', 32 * 1024); const allowedQuery = parse(operation.allowed_query_json, []); const allowedBody = parse(operation.allowed_body_json, []); const denied = [...Object.keys(query).filter(item => !allowedQuery.includes(item)), ...Object.keys(requestBody).filter(item => !allowedBody.includes(item))]; if (denied.length) throw fail(`Prototype fields are not allowlisted: ${denied.join(', ')}`, 403, 'FIELD_DENIED'); if (Object.values(query).some(value => !['string','number','boolean'].includes(typeof value))) throw fail('Query values must be scalar'); const requestHash = hash({ operationHash: operation.operation_hash, query, body: requestBody }); return { connectorKey: row.connector_key, operationKey, request: { method: operation.method, url: `${operation.endpoint_origin}${operation.path}`, risk: operation.risk, queryKeys: Object.keys(query).sort(), queryHash: hash(query), bodyKeys: Object.keys(requestBody).sort(), bodyHash: hash(requestBody) }, requestHash, allowlistEnforced: true, networkCallsStarted: 0, responsePayloadReturned: false };
  }
  overview(actor) {
    this._admin(actor); const db = this._db(); const entries = db.prepare('SELECT * FROM connector_marketplace_entries ORDER BY connector_key').all().map(row => ({ connectorKey: row.connector_key, name: row.name, version: row.version, publisher: row.publisher, supportLevel: row.support_level, domains: parse(row.domains_json, []), products: parse(row.products_json, []), allowedHosts: parse(row.allowed_hosts_json, []), manifestHash: row.manifest_hash, signatureState: row.signature_state })); const tables = { cmdb: 'cmdb_connector_syncs', itsm: 'itsm_connector_changes', siem: 'siem_connector_events', secrets: 'secret_manager_references', ipamDns: 'ipam_dns_connector_plans', backup: 'backup_connector_observations', monitoring: 'monitoring_connector_targets', eventBus: 'event_bus_connector_publications', openapi: 'openapi_connector_operations' }; const summary = Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]));
    return { capabilities: { connectorMarketplaceRegistry: true, cmdbConnector: true, itsmChangeConnector: true, siemConnectorPack: true, secretsManagerConnectors: true, ipamDnsConnectorPack: true, backupVendorConnectorApi: true, monitoringConnectorPack: true, eventBusIntegration: true, genericOpenApiConnector: true }, contract: { schemaVersion: SCHEMA_VERSION, signedMetadata: 'Ed25519', secretMaterialStored: false, externalNetworkCallsStarted: 0, endpointPolicy: 'signed exact HTTPS host allowlist', openApiPolicy: 'operation + field allowlist' }, entries, summary };
  }
}

const service = new ConnectorMarketplaceService();
module.exports = service;
module.exports.ConnectorMarketplaceService = ConnectorMarketplaceService;
module.exports.ConnectorMarketplaceError = ConnectorMarketplaceError;
module.exports.canonicalPayload = canonicalPayload;
module.exports.DOMAINS = DOMAINS;
